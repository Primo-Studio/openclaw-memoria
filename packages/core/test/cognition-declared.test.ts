/**
 * T30, zone cognition : un fait DÉCLARÉ (store_fact, partage) rejoint le
 * graphe, les thèmes et les amas sans attendre une capture.
 *
 * POURQUOI : processCognition n'était lancé qu'après captureTurn. Un agent qui
 * n'écrit que par store_fact laissait des souvenirs sans entité ni thème, donc
 * invisibles à l'expansion par le graphe et au rappel par blocs.
 *
 * Données fictives uniquement (Orion, Brumehost, Kestrel...).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CognitionEngine, Memoria, type CompleteOptions, type LlmProvider } from '../src/index.js'

/** LLM d'extraction factice : compte les appels « graphe », par fait, et peut échouer ou traîner. */
class GraphLlm implements LlmProvider {
  readonly name = 'openai'
  readonly model = 'gpt-4o-mini'
  available = true
  failGraph = false
  delayMs = 0
  graph = 0
  readonly perFact = new Map<string, number>()
  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available)
  }
  async complete(opts: CompleteOptions): Promise<string> {
    const sys = opts.system ?? ''
    if (sys.includes('knowledge graph')) {
      this.graph++
      this.perFact.set(opts.prompt, (this.perFact.get(opts.prompt) ?? 0) + 1)
      if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs))
      if (this.failGraph) throw new Error('délai dépassé (simulé)')
      return '{"entities":[{"name":"Orion","type":"project"}],"relations":[]}'
    }
    return 'Sujet Test'
  }
}

let root: string
let m: Memoria
let llm: GraphLlm
let instance: string

type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } }

function open(withLlm: boolean): void {
  root = mkdtempSync(join(tmpdir(), 'memoria-cogdecl-'))
  llm = new GraphLlm()
  m = Memoria.init({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: withLlm ? llm : null },
    secretsVault: 'aes-vault',
  })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
  // Par défaut dans ces tests : pas de passage différé surprise au milieu d'un comptage.
  m.cognitionDebounceMs = 60_000
}

function privateDb(): Db {
  return m['openContent'](m.paths.assistantDb(instance)).db as unknown as Db
}
const count = (db: Db, sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n
const marker = (db: Db, id: string): string | undefined =>
  (db.prepare('SELECT via FROM fact_cognition WHERE fact_id = ?').get(id) as { via: string } | undefined)?.via

/** Remet des faits dans l'état « d'avant la migration 11 » : marqués backfill, sans graphe ni thème. */
function markAsBackfill(db: Db): void {
  db.prepare('DELETE FROM fact_entities').run()
  db.prepare('DELETE FROM fact_topics').run()
  db.prepare('DELETE FROM fact_cognition').run()
  db.prepare(
    "INSERT INTO fact_cognition (fact_id, processed_at, via, entities) SELECT id, '2020-01-01T00:00:00.000Z', 'backfill', 0 FROM facts",
  ).run()
}

beforeEach(() => open(false))

afterEach(() => {
  vi.restoreAllMocks()
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('fait déclaré : cognition différée', () => {
  it('storeFact relie le fait au graphe et à un thème sans capture ni appel explicite', async () => {
    m.cognitionDebounceMs = 0
    const f = m.storeFact({ instance, content: 'Le site Orion est hébergé chez Brumehost depuis mars' })
    const db = privateDb()
    // L'écriture ne dépend pas de la cognition : le fait est là tout de suite.
    expect(count(db, 'SELECT COUNT(*) AS n FROM facts WHERE id = ?', f.id)).toBe(1)
    await vi.waitFor(() => expect(marker(db, f.id)).toBe('heuristic'))
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?', f.id)).toBeGreaterThan(0)
    await vi.waitFor(() => expect(count(db, 'SELECT COUNT(*) AS n FROM fact_topics WHERE fact_id = ?', f.id)).toBe(1))
  })

  it('une rafale de storeFact donne UN seul passage', async () => {
    m.cognitionDebounceMs = 0
    const spy = vi.spyOn(m as unknown as { runCognitionPass: () => Promise<unknown> }, 'runCognitionPass')
    const ids = ['Orion', 'Kestrel', 'Nimbus', 'Borealis', 'Brumehost'].map(
      name => m.storeFact({ instance, content: `Le projet ${name} démarre au printemps` }).id,
    )
    const db = privateDb()
    await vi.waitFor(() => expect(ids.every(id => marker(db, id) !== undefined)).toBe(true))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('un doublon (aucun fait créé) ne planifie rien', () => {
    m.storeFact({ instance, content: 'Le projet Kestrel exporte en ProRes' })
    const spy = vi.spyOn(m as unknown as { scheduleCognition: () => void }, 'scheduleCognition')
    m.storeFact({ instance, content: 'Le projet Kestrel exporte en ProRes' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('shareFacts : la base partagée refait la cognition des faits reçus', async () => {
    m.cognitionDebounceMs = 0
    const f = m.storeFact({ instance, content: 'Le client Borealis règle ses factures à trente jours' })
    await vi.waitFor(() => expect(marker(privateDb(), f.id)).toBeDefined())
    expect(m.shareFacts([f.id], 'user').shared).toBe(1)
    const scope = m.registry.getScopeByName('user')!
    const shared = m.sharedContentStore(scope.id)!.db as unknown as Db
    await vi.waitFor(() => expect(marker(shared, f.id)).toBe('heuristic'))
    expect(count(shared, 'SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?', f.id)).toBeGreaterThan(0)
    await vi.waitFor(() => expect(count(shared, 'SELECT COUNT(*) AS n FROM fact_topics WHERE fact_id = ?', f.id)).toBe(1))
  })

  it('close() annule le passage planifié (pas de travail sur une base fermée)', async () => {
    m.cognitionDebounceMs = 5
    const spy = vi.spyOn(m as unknown as { runCognitionPass: () => Promise<unknown> }, 'runCognitionPass')
    m.storeFact({ instance, content: 'Le projet Nimbus passe en abonnement' })
    m.close()
    await new Promise(r => setTimeout(r, 30))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('processCognition sérialisé', () => {
  it('trois appels simultanés : chaque fait part UNE fois au LLM, en deux passages au plus', async () => {
    m.close()
    rmSync(root, { recursive: true, force: true })
    open(true)
    llm.delayMs = 5
    for (const name of ['Orion', 'Kestrel', 'Nimbus', 'Borealis']) {
      m.storeFact({ instance, content: `Le projet ${name} change de serveur` })
    }
    const spy = vi.spyOn(m as unknown as { runCognitionPass: () => Promise<unknown> }, 'runCognitionPass')
    const first = m.processCognition(instance)
    // Laisse le premier passage démarrer : les deux suivants arrivent PENDANT qu'il tourne.
    await vi.waitFor(() => expect(llm.graph).toBeGreaterThan(0))
    const second = m.processCognition(instance)
    const third = m.processCognition(instance)
    // Le troisième rejoint le passage déjà en attente au lieu d'en ouvrir un autre.
    const [r1, r2, r3] = await Promise.all([first, second, third])
    expect(r3).toBe(r2)
    expect(r1.processed).toBe(4)
    expect(r1.llm_facts).toBe(4)
    expect(r2.processed).toBe(0)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(llm.graph).toBe(4)
    expect([...llm.perFact.values()].every(n => n === 1)).toBe(true)
  })

  it('rend la main à la boucle d’événements entre deux faits', async () => {
    for (let i = 0; i < 25; i++) m.storeFact({ instance, content: `Note numéro ${i} sur le chantier Kestrel lot ${i * 7}` })
    let turns = 0
    let watching = true
    const tick = (): void => {
      turns++
      if (watching) setImmediate(tick)
    }
    setImmediate(tick)
    const r = await m.processCognition(instance)
    watching = false
    expect(r.processed).toBe(25)
    // Sans retour à la boucle, tout le passage tiendrait en un ou deux tours.
    expect(turns).toBeGreaterThanOrEqual(25)
  })

  it('un passage en erreur ne bloque pas la file', async () => {
    m.storeFact({ instance, content: 'Le projet Orion garde son domaine' })
    const real = m['runCognitionPass'].bind(m)
    const spy = vi
      .spyOn(m as unknown as { runCognitionPass: (r: unknown) => Promise<unknown> }, 'runCognitionPass')
      .mockRejectedValueOnce(new Error('panne simulée'))
      .mockImplementation(r => real(r as never))
    await expect(m.processCognition(instance)).rejects.toThrow('panne simulée')
    const r = await m.processCognition(instance)
    expect(r.processed).toBe(1)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('échecs : jamais de fait perdu ni rejoué sans fin', () => {
  it('LLM en échec : le fait est écrit, relié par l’heuristique, et tenté UNE seule fois', async () => {
    m.close()
    rmSync(root, { recursive: true, force: true })
    open(true)
    llm.failGraph = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = m.storeFact({ instance, content: 'Le site Orion est hébergé chez Brumehost' })
    const r1 = await m.processCognition(instance)
    const db = privateDb()
    expect(r1.processed).toBe(1)
    expect(r1.llm_facts).toBe(0)
    expect(marker(db, f.id)).toBe('heuristic')
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?', f.id)).toBeGreaterThan(0)
    expect(llm.graph).toBe(1)
    expect(warn).toHaveBeenCalled()

    // Le marqueur « heuristic » + LLM disponible le remettait dans la liste à chaque passage.
    await m.processCognition(instance)
    await m.processCognition(instance)
    expect(llm.graph).toBe(1)
  })

  it('un fait qui fait planter le traitement est mis de côté, les suivants passent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = m.storeFact({ instance, content: 'Le projet Nimbus attend un devis' })
    const good = m.storeFact({ instance, content: 'Le projet Kestrel attend un export' })
    const original = CognitionEngine.prototype.processFact
    const spy = vi.spyOn(CognitionEngine.prototype, 'processFact').mockImplementation(function (this: CognitionEngine, id: string) {
      if (id === bad.id) return Promise.reject(new Error('ligne abîmée (simulé)'))
      return original.call(this, id)
    })
    const r1 = await m.processCognition(instance)
    expect(r1.errors).toBe(1)
    expect(r1.processed).toBe(1)
    expect(marker(privateDb(), good.id)).toBe('heuristic')
    expect(warn).toHaveBeenCalled()

    // Il ne revient pas en tête de liste au passage suivant.
    const r2 = await m.processCognition(instance)
    expect(r2.errors).toBe(0)
    expect(spy.mock.calls.filter(c => c[0] === bad.id)).toHaveLength(1)
  })
})

describe('rattrapage (includeBackfill)', () => {
  function seed(withLlm: boolean): string[] {
    m.close()
    rmSync(root, { recursive: true, force: true })
    open(withLlm)
    const ids = ['Orion', 'Kestrel', 'Nimbus', 'Borealis'].map(
      name => m.storeFact({ instance, content: `Le projet ${name} est suivi par l’agence Brumehost` }).id,
    )
    markAsBackfill(privateDb())
    return ids
  }

  it('pendingFactIds : les faits backfill ne sortent qu’avec includeBackfill', () => {
    const ids = seed(false)
    const engine = new CognitionEngine({ store: m['openContent'](m.paths.assistantDb(instance)) })
    expect(engine.pendingFactIds(true)).toEqual([])
    expect(engine.pendingFactIds(false, 2000, { includeBackfill: true }).sort()).toEqual([...ids].sort())
  })

  it('un passage ordinaire ne reprend pas les faits backfill', async () => {
    seed(true)
    const r = await m.processCognition(instance)
    expect(r.processed).toBe(0)
    expect(llm.graph).toBe(0)
  })

  it('défaut = heuristique seule : aucun appel LLM, ni pendant ni après, et rien à refaire', async () => {
    const ids = seed(true)
    const progress: number[] = []
    const r = await m.processCognition(instance, { includeBackfill: true, onProgress: p => progress.push(p.processed) })
    const db = privateDb()
    expect(r.processed).toBe(4)
    expect(r.llm_facts).toBe(0)
    expect(llm.graph).toBe(0)
    expect(progress.at(-1)).toBe(4)
    for (const id of ids) {
      // Le marqueur reste « backfill » : un passage ordinaire ne les enverra pas au LLM.
      expect(marker(db, id)).toBe('backfill')
      expect(count(db, 'SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?', id)).toBeGreaterThan(0)
      expect(count(db, 'SELECT COUNT(*) AS n FROM fact_topics WHERE fact_id = ?', id)).toBe(1)
    }
    // Amas recalculés en fin de rattrapage (les 4 faits partagent une entité).
    expect(r.clusters_rebuilt).toBeGreaterThanOrEqual(1)
    expect(m.listClusters(instance).length).toBeGreaterThan(0)

    await m.processCognition(instance)
    expect(llm.graph).toBe(0)

    // Un second rattrapage ne retraite rien (sinon mention_count et poids gonfleraient).
    const again = await m.processCognition(instance, { includeBackfill: true })
    expect(again.processed).toBe(0)
  })

  it('mode LLM : un appel par fait, borné par maxFacts, la suite au lancement suivant', async () => {
    const ids = seed(true)
    const r1 = await m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 3 })
    expect(r1.processed).toBe(3)
    expect(r1.llm_facts).toBe(3)
    expect(r1.capped).toBe(true)
    expect(llm.graph).toBe(3)

    const r2 = await m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 3 })
    expect(r2.processed).toBe(1)
    expect(r2.capped).toBeUndefined()
    expect(llm.graph).toBe(4)
    const db = privateDb()
    for (const id of ids) expect(marker(db, id)).toBe('llm')
  })

  it('sans instance : toutes les bases', async () => {
    seed(false)
    const r = await m.processCognition(undefined, { includeBackfill: true })
    expect(r.processed).toBe(4)
  })
})

describe('amas', () => {
  it('recalculés après un passage qui a traité des faits, puis au plus une fois par jour', async () => {
    const rebuild = vi.spyOn(m as unknown as { rebuildClustersAt: () => unknown }, 'rebuildClustersAt')
    for (const name of ['Orion', 'Kestrel', 'Nimbus']) {
      m.storeFact({ instance, content: `Le projet ${name} est suivi par l’agence Brumehost` })
    }
    const r1 = await m.processCognition(instance)
    expect(r1.clusters_rebuilt).toBe(1)

    m.storeFact({ instance, content: 'Le projet Borealis est suivi par l’agence Brumehost' })
    const r2 = await m.processCognition(instance)
    expect(r2.processed).toBe(1)
    expect(r2.clusters_rebuilt).toBe(0)
    expect(rebuild).toHaveBeenCalledTimes(1)

    // Le lendemain, un passage utile les refait.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000)
    m.storeFact({ instance, content: 'Le projet Zéphyr est suivi par l’agence Brumehost' })
    const r3 = await m.processCognition(instance)
    expect(r3.clusters_rebuilt).toBe(1)
  })

  it('un passage qui ne traite rien ne recalcule pas les amas', async () => {
    const r = await m.processCognition(instance)
    expect(r).toEqual({ processed: 0, llm_facts: 0, errors: 0, clusters_rebuilt: 0 })
  })
})
