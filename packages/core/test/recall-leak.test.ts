/**
 * Rappel (T30) : aucun chemin d'accès annexe ne doit montrer ce que la
 * recherche directe cache. Les voisins de graphe et les noms de thème passent
 * par les mêmes filtres durs : actif, non supersédé, non expiré, sensibilité,
 * scopes, isolation client.
 *
 * Les états interdits sont posés directement en base APRÈS la passe de
 * cognition : le test ne dépend pas de ce que la cognition accepte de traiter.
 *
 * Données fictives uniquement (dépôt public).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria, type FtsHit, type RecallInput, type RecallResult } from '../src/index.js'

let root: string
let m: Memoria
let instance: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-leak-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

function privateDb(): Database {
  const path = m.registry.dbForInstance(instance)!.path
  return (m as unknown as { openContent(p: string): { db: Database } }).openContent(path).db
}

/** Rend un fait illisible d'une des façons que la recherche directe refuse. */
const HIDE: Record<string, (db: Database, id: string) => void> = {
  dormant: (db, id) => void db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(id),
  critical: (db, id) => void db.prepare("UPDATE facts SET sensitivity = 'critical' WHERE id = ?").run(id),
  'supersédé': (db, id) => void db.prepare('UPDATE facts SET superseded = 1 WHERE id = ?').run(id),
  'expiré': (db, id) => void db.prepare("UPDATE facts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id),
  'autre scope': (db, id) => void db.prepare("UPDATE facts SET scope_id = 'scope-non-autorise' WHERE id = ?").run(id),
  'autre client': (db, id) => void db.prepare("UPDATE facts SET client_org_id = 'org-client-fictif' WHERE id = ?").run(id),
}

describe('expansion par le graphe : mêmes filtres durs que la recherche', () => {
  async function seed(): Promise<{ seedId: string; neighborId: string }> {
    const seedFact = m.storeFact({ instance, content: 'Le portail Lumen est hébergé chez Brumehost' })
    const neighbor = m.storeFact({ instance, content: 'Brumehost facture Zephyrcorp 900 euros par mois' })
    await m.processCognition(instance)
    return { seedId: seedFact.id, neighborId: neighbor.id }
  }

  it('témoin : un voisin lisible remonte bien par le graphe', async () => {
    const { seedId, neighborId } = await seed()
    const res = m.recall({ instance, query: 'portail Lumen' })
    expect(res.items[0]!.id).toBe(seedId)
    expect(res.items.find(i => i.id === neighborId)?.matched_by).toEqual(['graph'])
  })

  // « dormant » et « critical » fuyaient ; les autres cas verrouillent le filtre commun.
  it.each(Object.keys(HIDE))('un voisin %s ne ressort jamais', async state => {
    const { seedId, neighborId } = await seed()
    HIDE[state]!(privateDb(), neighborId)

    const res = m.recall({ instance, query: 'portail Lumen' })
    expect(res.items.map(i => i.id)).toEqual([seedId])
    // Le contenu du voisin n'apparaît nulle part (ni item, ni lien, ni extrait).
    expect(JSON.stringify(res)).not.toContain('900 euros')
  })
})

/**
 * Le PONT : un fait caché relie deux entités (Brumehost et Zephyrcorp) que
 * rien de lisible ne relie. Avant, l'expansion suivait les arêtes entité-entité,
 * nées de la co-occurrence dans n'importe quel fait, et rendait le fait lisible
 * « siège de Zephyrcorp » avec via_entity « Zephyrcorp » : le contenu caché ne
 * sortait pas, mais son association, si.
 */
describe('pont par le graphe : aucun lien ne passe par un fait caché', () => {
  async function seed(): Promise<{ seedId: string; bridgeId: string; farId: string }> {
    const seedFact = m.storeFact({ instance, content: 'Le portail Lumen est hébergé chez Brumehost' })
    const bridge = m.storeFact({ instance, content: 'Brumehost facture Zephyrcorp 900 euros par mois' })
    const far = m.storeFact({ instance, content: 'Le siège de Zephyrcorp est à Lyon' })
    await m.processCognition(instance)
    return { seedId: seedFact.id, bridgeId: bridge.id, farId: far.id }
  }

  /** Ni le fait lointain, ni l'entité que seul le pont caché justifie, ni un lien vers l'un d'eux. */
  function expectNoBridge(res: RecallResult, bridgeId: string, farId: string): void {
    const ids = res.items.map(i => i.id)
    expect(ids).not.toContain(farId)
    expect(ids).not.toContain(bridgeId)
    expect(res.items.filter(i => i.via_entity === 'Zephyrcorp')).toEqual([])
    const linked = res.items.flatMap(i => (i.links ?? []).map(l => l.id))
    expect(linked).not.toContain(farId)
    expect(linked).not.toContain(bridgeId)
  }

  it('témoin : un pont lisible ramène le fait lointain au deuxième saut', async () => {
    const { seedId, bridgeId, farId } = await seed()
    const res = m.recall({ instance, query: 'portail Lumen', preview: true })
    expect(res.items[0]!.id).toBe(seedId)
    expect(res.items.find(i => i.id === bridgeId)).toMatchObject({ matched_by: ['graph'], via_entity: 'Brumehost' })
    // L'entité nommée est celle que le fait rendu partage avec le pont.
    expect(res.items.find(i => i.id === farId)).toMatchObject({ matched_by: ['graph'], via_entity: 'Zephyrcorp' })
  })

  /** Expiration notée dans le passé, mais avec un décalage positif : en texte, elle paraît future. */
  const pastWithPositiveOffset = (): string => {
    const local = new Date(Date.now() - 30 * 60_000 + 5 * 3_600_000).toISOString().slice(0, 19)
    return `${local}+05:00`
  }
  const HIDE_BRIDGE: Record<string, (db: Database, id: string) => void> = {
    ...HIDE,
    // Formats que Date.parse lit (et que le rappel juge expirés) mais qu'une
    // comparaison de texte en SQL jugerait vivants.
    'expiré (« Jan 1 2020 »)': (db, id) => void db.prepare("UPDATE facts SET expires_at = 'Jan 1 2020' WHERE id = ?").run(id),
    'expiré (décalage +05:00)': (db, id) => void db.prepare('UPDATE facts SET expires_at = ? WHERE id = ?').run(pastWithPositiveOffset(), id),
    'oublié (forget)': (_db, id) => void m.forget({ ids: [id] }),
    'supersédé (correctFact)': (_db, id) => void m.correctFact(instance, id, 'Brumehost facture Ardoise chaque mois'),
  }

  it.each(Object.keys(HIDE_BRIDGE))('un pont %s ne relie plus rien', async state => {
    const { bridgeId, farId } = await seed()
    HIDE_BRIDGE[state]!(privateDb(), bridgeId)

    expectNoBridge(m.recall({ instance, query: 'portail Lumen', preview: true }), bridgeId, farId)
    expectNoBridge(m.recall({ instance, query: 'portail Lumen', preview: true, links: true, format: 'blocks' }), bridgeId, farId)
  })

  it('le client du contexte actif garde son pont', async () => {
    const org = m.registry.createOrganization('Client Fictif A', 'client')
    const { bridgeId, farId } = await seed()
    privateDb().prepare('UPDATE facts SET client_org_id = ? WHERE id = ?').run(org.id, bridgeId)

    // Hors contexte : le pont appartient à un client, il ne relie rien.
    expectNoBridge(m.recall({ instance, query: 'portail Lumen', preview: true }), bridgeId, farId)
    // Dans le contexte de ce client : il est lisible, donc il relie.
    const res = m.recall({ instance, query: 'portail Lumen', preview: true, active_context: { client_org_id: org.id } })
    expect(res.items.find(i => i.id === farId)?.via_entity).toBe('Zephyrcorp')
  })
})

describe('thème : un nom n’est émis que si tous ses faits sont lisibles', () => {
  async function seed(): Promise<{ shown: string; other: string }> {
    const shown = m.storeFact({ instance, content: 'Le déploiement Brumehost utilise le compte Solstice' })
    const other = m.storeFact({ instance, content: 'Brumehost échoue quand le cache Solstice est corrompu' })
    await m.processCognition(instance)
    return { shown: shown.id, other: other.id }
  }
  // Recherche directe seule : on regarde le thème, pas les voisins.
  const q = () => ({ instance, query: 'déploiement compte', expand_graph: false, preview: true })

  it('témoin : les deux faits lisibles partagent un thème nommé', async () => {
    const { shown, other } = await seed()
    const db = privateDb()
    const topicOf = (id: string) => db.prepare('SELECT topic_id FROM fact_topics WHERE fact_id = ?').all(id)
    expect(topicOf(shown)).toEqual(topicOf(other))
    expect(m.recall(q()).items.find(i => i.id === shown)?.topic?.name).toBeTruthy()
  })

  it.each(['dormant', 'critical', 'supersédé', 'expiré', 'autre scope', 'autre client'])(
    'un fait %s dans le thème : le thème n’est plus nommé',
    async state => {
      const { shown, other } = await seed()
      HIDE[state]!(privateDb(), other)

      const res = m.recall({ ...q(), format: 'blocks' })
      const item = res.items.find(i => i.id === shown)!
      expect(item).toBeDefined()
      expect(item).not.toHaveProperty('topic')
      expect(res.blocks!.every(b => b.loose)).toBe(true)
    },
  )

  it('le client du contexte actif garde son thème', async () => {
    const org = m.registry.createOrganization('Client Fictif A', 'client')
    const { shown, other } = await seed()
    privateDb().prepare('UPDATE facts SET client_org_id = ? WHERE id = ?').run(org.id, other)
    const item = m.recall({ ...q(), active_context: { client_org_id: org.id } }).items.find(i => i.id === shown)!
    expect(item.topic?.name).toBeTruthy()
  })
})

describe('statut « replaces » : lecture indexée', () => {
  it('la migration pose un index partiel sur superseded_by, et la requête s’en sert', () => {
    const db = privateDb()
    const indexes = (db.pragma('index_list(facts)') as Array<{ name: string; partial: number }>).filter(
      i => i.name === 'idx_facts_superseded_by',
    )
    expect(indexes).toHaveLength(1)
    expect(indexes[0]!.partial).toBe(1)
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT DISTINCT superseded_by FROM facts WHERE superseded = 1 AND superseded_by IN (?, ?)')
      .all('a', 'b') as Array<{ detail: string }>
    expect(plan.map(p => p.detail).join(' | ')).toContain('idx_facts_superseded_by')
  })
})

describe('statut « expiring » : seulement une échéance proche', () => {
  it('dans 60 jours : pas de statut ; dans 29 jours : expiring', () => {
    const far = m.storeFact({ instance, content: 'Le local Tamaris est loué à la société Ardoise' })
    const near = m.storeFact({ instance, content: 'Le parking Tamaris est fermé pour travaux' })
    m.setExpiry(instance, far.id, new Date(Date.now() + 60 * 86_400_000).toISOString())
    m.setExpiry(instance, near.id, new Date(Date.now() + 29 * 86_400_000).toISOString())

    const items = m.recall({ instance, query: 'Tamaris' }).items
    expect(items.find(i => i.id === far.id)).not.toHaveProperty('status')
    expect(items.find(i => i.id === near.id)?.status).toBe('expiring')
  })
})

describe('dédoublonnage inter-bases : l’entité de passage suit la raison « graph »', () => {
  it('copie partagée trouvée par les mots, copie privée par le graphe : via_entity conservé', async () => {
    const text = 'Kestrel tourne sur la machine Halcyon avec le chantier Zephyr'
    m.storeFact({ instance, content: 'Le chantier Zephyr dépend du service Kestrel' })
    const privateCopy = m.storeFact({ instance, content: text })
    const sharedCopy = m.storeFact({ instance, scope: 'user', content: text })
    await m.processCognition(instance)

    // La copie privée est retirée des résultats de recherche (comme un fait
    // au-delà des 50 premiers) : elle ne revient que par le graphe.
    type Search = (store: { searchFacts(q: string, o: unknown): FtsHit[] }, query: string, opts: unknown) => FtsHit[]
    const performRecall = (m as unknown as { performRecall(i: RecallInput, s: Search): RecallResult }).performRecall.bind(m)
    const res = performRecall({ instance, query: 'chantier Zephyr', preview: true }, (store, query, opts) =>
      store.searchFacts(query, opts).filter(h => h.row.id !== privateCopy.id),
    )

    const kept = res.items.find(i => i.content === text)!
    expect(kept.id).toBe(sharedCopy.id) // la copie partagée gagne
    expect(res.items.some(i => i.id === privateCopy.id)).toBe(false)
    expect(kept.matched_by).toEqual(expect.arrayContaining(['text', 'graph']))
    expect(kept.via_entity).toBeTruthy()
  })
})
