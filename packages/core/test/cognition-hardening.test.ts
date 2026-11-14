/**
 * T30, zone cognition : défauts relevés à la contre-vérification.
 *
 *  - un fait DORMANT (en attente de validation) ne passe ni par la cognition
 *    ni par le rangement par thème ; il est repris après sa validation ;
 *  - l'expansion par le graphe ne traverse ni dormant ni fait « critical » ;
 *  - le rattrapage ne retraite pas un fait backfill déjà relié au graphe ;
 *  - rattrapage LLM sans LLM joignable, ou en pause : refus clair, rien n'est marqué ;
 *  - un rattrapage peut être annulé ;
 *  - le recalcul des amas rend la main et sa date ne dépend plus des oublis.
 *
 * Données fictives uniquement (Orion, Brumehost, Kestrel...).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClusterEngine, CognitionEngine, Memoria, type CompleteOptions, type LlmProvider } from '../src/index.js'

/** LLM d'extraction factice : compte les appels « graphe », peut échouer, traîner ou devenir injoignable. */
class GraphLlm implements LlmProvider {
  readonly name = 'openai'
  readonly model = 'gpt-4o-mini'
  available = true
  failGraph = false
  delayMs = 0
  graph = 0
  /** Appelé au début de chaque extraction (pour changer d'état en cours de route). */
  onGraph: (() => void) | null = null
  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available)
  }
  async complete(opts: CompleteOptions): Promise<string> {
    if ((opts.system ?? '').includes('knowledge graph')) {
      this.graph++
      this.onGraph?.()
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
  root = mkdtempSync(join(tmpdir(), 'memoria-coghard-'))
  llm = new GraphLlm()
  m = Memoria.init({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: withLlm ? llm : null },
    secretsVault: 'aes-vault',
  })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
  // Pas de passage différé surprise au milieu d'un comptage.
  m.cognitionDebounceMs = 60_000
}
function reopen(withLlm: boolean): void {
  m.close()
  rmSync(root, { recursive: true, force: true })
  open(withLlm)
}

const store = () => m['openContent'](m.paths.assistantDb(instance))
const privateDb = (): Db => store().db as unknown as Db
const count = (db: Db, sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n
const marker = (db: Db, id: string): string | undefined =>
  (db.prepare('SELECT via FROM fact_cognition WHERE fact_id = ?').get(id) as { via: string } | undefined)?.via
const entities = (db: Db, id: string): number => count(db, 'SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?', id)
const topics = (db: Db, id: string): number => count(db, 'SELECT COUNT(*) AS n FROM fact_topics WHERE fact_id = ?', id)

const PROJECTS = ['Orion', 'Kestrel', 'Nimbus', 'Borealis']
const sentence = (name: string): string => `Le projet ${name} est suivi par l’agence Brumehost`

/** Faits dans l'état « d'avant la migration 11 » : marqués backfill, sans graphe ni thème. */
function seedBackfill(withLlm: boolean): string[] {
  reopen(withLlm)
  const ids = PROJECTS.map(name => m.storeFact({ instance, content: sentence(name) }).id)
  const db = privateDb()
  db.prepare('DELETE FROM fact_entities').run()
  db.prepare('DELETE FROM fact_topics').run()
  db.prepare('DELETE FROM fact_cognition').run()
  db.prepare(
    "INSERT INTO fact_cognition (fact_id, processed_at, via, entities) SELECT id, '2020-01-01T00:00:00.000Z', 'backfill', 0 FROM facts",
  ).run()
  return ids
}

beforeEach(() => open(false))

afterEach(() => {
  vi.restoreAllMocks()
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('faits dormants (en attente de validation)', () => {
  it('ni entité, ni thème, ni marqueur tant que le fait n’est pas validé', async () => {
    const active = m.storeFact({ instance, content: sentence('Kestrel') })
    m.setCaptureMode('review-first')
    const dormant = m.declareFact({ instance, content: 'L’agence Brumehost facture le client Zephyrcorp chaque mois' }).fact!
    expect(dormant.lifecycle_state).toBe('dormant')

    const r = await m.processCognition(instance)
    const db = privateDb()
    expect(r.processed).toBe(1)
    expect(entities(db, active.id)).toBeGreaterThan(0)
    // Le dormant reste hors du graphe : il n'est donc pas atteignable par un voisin.
    expect(marker(db, dormant.id)).toBeUndefined()
    expect(entities(db, dormant.id)).toBe(0)
    expect(topics(db, dormant.id)).toBe(0)
    expect(m.recall({ instance, query: 'Kestrel Brumehost' }).items.map(i => i.id)).not.toContain(dormant.id)

    // Même en rattrapage.
    await m.processCognition(instance, { includeBackfill: true })
    expect(entities(db, dormant.id)).toBe(0)
    expect(topics(db, dormant.id)).toBe(0)
  })

  it('repris après validation en revue, sans capture derrière', async () => {
    m.setCaptureMode('review-first')
    const dormant = m.declareFact({ instance, content: sentence('Orion') }).fact!
    await m.processCognition(instance)
    const db = privateDb()
    expect(entities(db, dormant.id)).toBe(0)

    // La validation planifie un passage (elle n'a pas de capture derrière elle)...
    const schedule = vi.spyOn(m as unknown as { scheduleCognition: () => void }, 'scheduleCognition')
    const item = m.listReview()[0]!
    expect(m.reviewDecision([item.id], 'accepted').updated).toBe(1)
    expect(schedule).toHaveBeenCalledTimes(1)
    // ... et ce passage relie le fait, resté sans marqueur.
    await m.processCognition(instance)
    expect(marker(db, dormant.id)).toBe('heuristic')
    expect(entities(db, dormant.id)).toBeGreaterThan(0)
    expect(topics(db, dormant.id)).toBe(1)
  })

  it('repris quand une redéclaration le réveille (activateFact)', async () => {
    m.setCaptureMode('review-first')
    const dormant = m.declareFact({ instance, content: sentence('Nimbus') }).fact!
    m.setCaptureMode('auto-private')
    const schedule = vi.spyOn(m as unknown as { scheduleCognition: () => void }, 'scheduleCognition')
    // Même contenu, hors revue : le fait existant est activé, aucun fait créé.
    expect(m.storeFact({ instance, content: sentence('Nimbus') }).id).toBe(dormant.id)
    expect(schedule).toHaveBeenCalledTimes(1)
    await m.processCognition(instance)
    const db = privateDb()
    expect(marker(db, dormant.id)).toBe('heuristic')
    expect(entities(db, dormant.id)).toBeGreaterThan(0)
  })

  it('expandEntities ne traverse ni un dormant ni un fait « critical » déjà reliés', async () => {
    const seed = m.storeFact({ instance, content: sentence('Orion') })
    const hidden = m.storeFact({ instance, content: sentence('Kestrel') })
    const secret = m.storeFact({ instance, content: sentence('Nimbus') })
    const visible = m.storeFact({ instance, content: sentence('Borealis') })
    const engine = new CognitionEngine({ store: store() })
    // Base héritée : ces faits ont été reliés avant d'être masqués.
    for (const f of [seed, hidden, secret, visible]) await engine.processFact(f.id)
    const db = privateDb()
    db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(hidden.id)
    db.prepare("UPDATE facts SET sensitivity = 'critical' WHERE id = ?").run(secret.id)

    const found = engine.expandEntities([seed.id], [seed.scope_id]).map(r => r.fact_id)
    expect(found).toContain(visible.id)
    expect(found).not.toContain(hidden.id)
    expect(found).not.toContain(secret.id)
  })
})

describe('rattrapage : seulement les faits backfill sans graphe', () => {
  it('un fait backfill déjà relié n’est pas retraité (compteurs inchangés)', async () => {
    const ids = PROJECTS.map(name => m.storeFact({ instance, content: sentence(name) }).id)
    await m.processCognition(instance)
    const db = privateDb()
    // État posé par la migration 11 sur une base qui avait déjà un graphe.
    db.prepare("UPDATE fact_cognition SET via = 'backfill', processed_at = '2020-01-01T00:00:00.000Z'").run()
    const mentions = (): unknown[] => db.prepare('SELECT name, mention_count FROM entities ORDER BY name').all()
    const before = mentions()
    const links = count(db, 'SELECT COUNT(*) AS n FROM fact_entities')

    const engine = new CognitionEngine({ store: store() })
    expect(engine.pendingFactIds(false, 2000, { includeBackfill: true })).toEqual([])
    const r = await m.processCognition(instance, { includeBackfill: true })
    expect(r.processed).toBe(0)
    expect(mentions()).toEqual(before)
    expect(count(db, 'SELECT COUNT(*) AS n FROM fact_entities')).toBe(links)
    for (const id of ids) expect(marker(db, id)).toBe('backfill')
  })
})

describe('rattrapage en mode LLM : jamais de dégradation silencieuse', () => {
  it('LLM injoignable : refus clair, aucun fait traité ni marqué', async () => {
    const ids = seedBackfill(true)
    llm.available = false
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 10 })).rejects.toThrow(/LLM/)
    const db = privateDb()
    expect(llm.graph).toBe(0)
    for (const id of ids) {
      expect(marker(db, id)).toBe('backfill')
      expect(entities(db, id)).toBe(0)
    }
    // Le refus ne bloque pas la file : le mode heuristique reste possible.
    const r = await m.processCognition(instance, { includeBackfill: true })
    expect(r.processed).toBe(4)
  })

  it('aucun moteur d’extraction configuré : même refus', async () => {
    seedBackfill(false)
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true })).rejects.toThrow(/LLM/)
    expect(count(privateDb(), "SELECT COUNT(*) AS n FROM fact_cognition WHERE via != 'backfill'")).toBe(0)
  })

  it('LLM qui tombe en cours de route : arrêt, aucun fait laissé « heuristic »', async () => {
    seedBackfill(true)
    llm.onGraph = () => {
      if (llm.graph >= 2) {
        llm.failGraph = true
        llm.available = false
      }
    }
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 10 })).rejects.toThrow(/injoignable/)
    const db = privateDb()
    // Un seul fait est passé par le LLM ; celui qui a essuyé la panne n'est pas
    // marqué « heuristic » (il repartirait au LLM au prochain passage ordinaire).
    expect(count(db, "SELECT COUNT(*) AS n FROM fact_cognition WHERE via = 'llm'")).toBe(1)
    expect(count(db, "SELECT COUNT(*) AS n FROM fact_cognition WHERE via = 'heuristic'")).toBe(0)
    expect(llm.graph).toBe(2)
    // Passage ordinaire, LLM revenu : aucun appel surprise.
    llm.failGraph = false
    llm.available = true
    llm.onGraph = null
    await m.processCognition(instance)
    expect(llm.graph).toBe(2)
  })

  it('extraction ratée mais LLM « joignable » : arrêt après 3 échecs d’affilée, faits intacts et repris ensuite', async () => {
    // Chez un fournisseur cloud, isAvailable() veut dire « clé présente » :
    // continuer brûlait chaque fait (marqué backfill du jour, jamais repris).
    const ids = seedBackfill(true)
    llm.failGraph = true
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 10 })).rejects.toThrow(/d’affilée/)
    expect(llm.graph).toBe(3)
    const db = privateDb()
    for (const id of ids) {
      expect(marker(db, id)).toBe('backfill')
      expect(entities(db, id)).toBe(0)
    }
    expect(count(db, "SELECT COUNT(*) AS n FROM fact_cognition WHERE processed_at != '2020-01-01T00:00:00.000Z'")).toBe(0)
    llm.failGraph = false
    const r = await m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 10 })
    expect(r.llm_facts).toBe(4)
  })

  it('Memoria en pause : le mode LLM est refusé, l’heuristique reste permise', async () => {
    seedBackfill(true)
    m.setEnabled(false)
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true })).rejects.toThrow(/pause/)
    expect(llm.graph).toBe(0)
    const r = await m.processCognition(instance, { includeBackfill: true })
    expect(r.processed).toBe(4)
    expect(llm.graph).toBe(0)
  })
})

describe('annulation d’un rattrapage', () => {
  it('cancelCognitionCatchup arrête entre deux faits ; la suite reste à rattraper', async () => {
    const ids = seedBackfill(true)
    llm.delayMs = 5
    let asked = false
    const r = await m.processCognition(instance, {
      includeBackfill: true,
      llm: true,
      maxFacts: 10,
      onProgress: () => {
        if (!asked) {
          asked = true
          expect(m.cancelCognitionCatchup()).toBe(true)
        }
      },
    })
    expect(r.cancelled).toBe(true)
    expect(r.processed).toBe(1)
    expect(llm.graph).toBe(1)
    const db = privateDb()
    expect(ids.filter(id => marker(db, id) === 'backfill')).toHaveLength(3)

    // L'annulation ne colle pas au rattrapage suivant.
    const next = await m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 10 })
    expect(next.cancelled).toBeUndefined()
    expect(next.processed).toBe(3)
  })

  it('rien à annuler : false, et un passage ordinaire n’est jamais annulé', async () => {
    expect(m.cancelCognitionCatchup()).toBe(false)
    m.storeFact({ instance, content: sentence('Orion') })
    const p = m.processCognition(instance)
    expect(m.cancelCognitionCatchup()).toBe(false)
    expect((await p).processed).toBe(1)
  })
})

describe('amas : recalcul découpé, date fiable', () => {
  function seedGraph(): { engine: ClusterEngine; ids: string[] } {
    const ids = [...PROJECTS, 'Zéphyr', 'Halcyon'].map(name => m.storeFact({ instance, content: sentence(name) }).id)
    return { engine: new ClusterEngine({ store: store() }), ids }
  }
  const members = (db: Db): string[] =>
    (db.prepare('SELECT fact_id FROM cluster_members ORDER BY fact_id').all() as Array<{ fact_id: string }>).map(r => r.fact_id)

  it('rebuildAsync rend la main à la boucle d’événements et donne la même partition que rebuild', async () => {
    const { engine } = seedGraph()
    const sync = engine.rebuild()
    const db = privateDb()
    const expected = members(db)
    expect(expected.length).toBeGreaterThan(0)

    let ticks = 0
    let running = true
    const tick = (): void => {
      if (!running) return
      ticks++
      setImmediate(tick)
    }
    setImmediate(tick)
    const r = await engine.rebuildAsync({ sliceMs: 0, stepComparisons: 1 })
    running = false
    expect(ticks).toBeGreaterThan(0)
    expect(r).toEqual(sync)
    expect(members(db)).toEqual(expected)
  })

  it('un fait retiré pendant le calcul n’est pas écrit dans un amas', async () => {
    const { engine, ids } = seedGraph()
    const db = privateDb()
    const p = engine.rebuildAsync({ sliceMs: 0, stepComparisons: 1 })
    db.prepare('UPDATE facts SET superseded = 1 WHERE id = ?').run(ids[0])
    await p
    const got = members(db)
    expect(got.length).toBeGreaterThan(0)
    expect(got).not.toContain(ids[0])
  })

  it('un passage de cognition n’appelle plus le recalcul bloquant', async () => {
    const blocking = vi.spyOn(ClusterEngine.prototype, 'rebuild')
    for (const name of PROJECTS) m.storeFact({ instance, content: sentence(name) })
    const r = await m.processCognition(instance, { includeBackfill: true })
    expect(r.clusters_rebuilt).toBe(1)
    expect(m.listClusters(instance).length).toBeGreaterThan(0)
    expect(blocking).not.toHaveBeenCalled()
  })

  it('un oubli (updated_at d’un amas) ne repousse pas le recalcul quotidien', async () => {
    for (const name of PROJECTS) m.storeFact({ instance, content: sentence(name) })
    expect((await m.processCognition(instance)).clusters_rebuilt).toBe(1)

    // Le lendemain : un oubli vient de toucher un amas, puis un passage utile.
    const tomorrow = Date.now() + 25 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(tomorrow)
    privateDb().prepare('UPDATE fact_clusters SET updated_at = ?').run(new Date(tomorrow - 60_000).toISOString())
    m.storeFact({ instance, content: sentence('Zéphyr') })
    const r = await m.processCognition(instance)
    expect(r.processed).toBe(1)
    expect(r.clusters_rebuilt).toBe(1)
  })
})
