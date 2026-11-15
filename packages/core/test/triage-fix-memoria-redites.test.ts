/**
 * Cache des redites de la passe sur les messages (findSemanticDuplicate) :
 * construit par pages AVANT la passe en rendant la main, vidé à la fin et à
 * chaque changement des faits en attente, candidats relus en base avant
 * d'être rendus. Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { newId, quantizeInt8, TriageBudget, type TriageHost, type UserMessagesReport } from '../src/index.js'
import { bagOfWords, ensureSource, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

/** Mots courts en plus : ignorés par les faux vecteurs (même sens), trop loin pour le quasi-doublon par les mots. */
const FILLER = 'oh la et tu en ok si on y va '
const textOf = (i: number): string => `Une app de covoiturage pour ${i} festivals`

/** Faits EN ATTENTE triés (idée) avec leur vecteur de tri, écrits en SQL d'après un fait modèle. */
function seedPendingVectors(n: number, text = textOf): string[] {
  const db = env.db()
  const model = env.m.storeFact({ instance: env.instance, content: 'Fait modèle fictif des tests de redites.' })
  const cols = (db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name)
  const own = ['id', 'fact', 'norm_hash', 'content_hash']
  const ins = db.prepare(
    `INSERT INTO facts (${cols.join(',')}) SELECT ${cols.map(c => (own.includes(c) ? '?' : c === 'lifecycle_state' ? "'dormant'" : c)).join(',')} FROM facts WHERE id = ?`,
  )
  const src = ensureSource(db, '/fictif/redites.jsonl')
  const item = db.prepare(
    "INSERT INTO memory_import_items (id, source_id, target_memory_id, target_type, proposed_scope_id, status, confidence) VALUES (?, ?, ?, 'fact', ?, 'pending', 0.8)",
  )
  const tri = db.prepare(
    "INSERT INTO fact_triage (fact_id, genre, auteur_source, amas_id, amas_size, triaged_at, sensible) VALUES (?, 'idee', 'llm', ?, 1, '2026-01-02T03:04:05.000Z', 0)",
  )
  const vec = db.prepare('INSERT INTO fact_triage_vectors (fact_id, model, dimensions, vector) VALUES (?, ?, ?, ?)')
  const ids: string[] = []
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `fx-${String(i).padStart(5, '0')}`
      const values = cols.filter(c => own.includes(c)).map(c => (c === 'id' ? id : c === 'fact' ? text(i) : `h-${c}-${id}`))
      ins.run(...values, model.id)
      item.run(newId(), src, id, model.scope_id)
      tri.run(id, id)
      vec.run(id, env.embedder.model, env.embedder.dimensions, quantizeInt8(bagOfWords(text(i))))
      ids.push(id)
    }
  })()
  return ids
}

const report = (facts_duplicate: number): UserMessagesReport => ({
  sessions_read: 0,
  messages_seen: 0,
  messages_known: 0,
  messages_sensitive: 0,
  messages_sent: 0,
  facts_created: 0,
  facts_duplicate,
  llm_calls: 0,
  spent_usd: 0,
  estimate_usd: null,
  stopped: null,
  errors: [],
})

/** Lance une vraie passe sur les messages (runUserMessages) dont le corps est `body`. */
async function inPass(body: (h: TriageHost) => void | Promise<void>): Promise<void> {
  env.m.registerUserMessagesPass(async h => {
    await body(h)
    return report(0)
  })
  await env.m.triage.runUserMessages({})
}

const dupOf = (h: TriageHost, text: string) => h.findSemanticDuplicate(env.instance, text, bagOfWords(text))
const cacheSize = (): number => (env.m as unknown as { triageVecCache: Map<string, unknown> }).triageVecCache.size

describe('cache des redites : dans une vraie passe', () => {
  it('une redite par le sens d’un fait en attente est trouvée ; le cache est vidé à la fin de la passe', async () => {
    env = setupTriage()
    const [p] = seedPendingVectors(1)
    let found: unknown = null
    await inPass(h => {
      found = dupOf(h, FILLER + textOf(0))
    })
    expect(found).toMatchObject({ fact_id: p, kind: 'meaning' })
    expect(cacheSize()).toBe(0)
  })

  it('candidat relu en base : supersédé, effacé ou activé après la construction du cache, il n’est plus rendu', async () => {
    env = setupTriage()
    const [p] = seedPendingVectors(1)
    const db = env.db()
    const seen: unknown[] = []
    await inPass(h => {
      seen.push(dupOf(h, FILLER + textOf(0))?.fact_id ?? null)
      // Changements faits sans passer par les méthodes qui vident le cache.
      db.prepare('UPDATE facts SET superseded = 1 WHERE id = ?').run(p)
      seen.push(dupOf(h, FILLER + textOf(0))?.fact_id ?? null)
      db.prepare("UPDATE facts SET superseded = 0, deleted_at = '2026-01-03T00:00:00.000Z' WHERE id = ?").run(p)
      seen.push(dupOf(h, FILLER + textOf(0))?.fact_id ?? null)
      db.prepare("UPDATE facts SET deleted_at = NULL, lifecycle_state = 'active' WHERE id = ?").run(p)
      seen.push(dupOf(h, FILLER + textOf(0))?.fact_id ?? null)
    })
    expect(seen).toEqual([p, null, null, null])
  })

  it('oubli pendant la passe : le fait oublié n’est plus une redite ; les autres faits en attente le restent', async () => {
    env = setupTriage()
    const [p, q] = seedPendingVectors(2)
    const seen: unknown[] = []
    await inPass(h => {
      seen.push(dupOf(h, FILLER + textOf(0))?.fact_id ?? null)
      env.m.forget({ ids: [p!] })
      seen.push(dupOf(h, FILLER + textOf(0))?.fact_id ?? null)
      seen.push(dupOf(h, FILLER + textOf(1))?.fact_id ?? null)
    })
    expect(seen).toEqual([p, null, q])
  })

  it('construit par pages AVANT la passe en rendant la main : complet dès le premier appel, plus ancien fait compris', async () => {
    env = setupTriage()
    const ids = seedPendingVectors(3000)
    let ticks = 0
    let running = true
    const tick = (): void => {
      ticks++
      if (running) setImmediate(tick)
    }
    setImmediate(tick)
    let ticksAtStart = -1
    let oldest: unknown = null
    await inPass(h => {
      ticksAtStart = ticks
      oldest = dupOf(h, FILLER + textOf(0))
    })
    running = false
    // 3 000 rowid en pages de 512 : la boucle d'événements a tourné entre les pages.
    expect(ticksAtStart).toBeGreaterThanOrEqual(4)
    expect(oldest).toMatchObject({ fact_id: ids[0], kind: 'meaning' })
  })
})

describe('cache des redites : hôte de test (hors passe) et invalidations', () => {
  function host(): TriageHost {
    return env.m.triage.createHost({ llm: env.llm, embeddings: env.embedder, budget: new TriageBudget({ budgetUsd: 1 }), stop: () => null })
  }

  it('fait écrit après la construction : trouvé ; oublié : plus rendu', async () => {
    env = setupTriage()
    await env.m.triage.estimate() // résout le profil (modèle de vecteurs du tri)
    const h = host()
    const text = 'Idée : une app de troc de graines entre jardiniers du quartier'
    expect(dupOf(h, 'texte sans rapport aucun')).toBeNull() // construit le cache
    const stored = h.storePendingTriaged({ instance: env.instance, content: text, triage: { genre: 'idee' }, source: { key: 'claude-code:fictif.jsonl' }, vector: bagOfWords(text) })
    expect(stored.created).toBe(true)
    expect(dupOf(h, FILLER + text)).toMatchObject({ fact_id: stored.fact_id, kind: 'meaning' })
    env.m.forget({ ids: [stored.fact_id] })
    expect(dupOf(h, FILLER + text)).toBeNull()
  })

  it('validation, partage, décision de revue et oubli vident le cache', async () => {
    env = setupTriage()
    const ids = seedPendingVectors(6)
    await env.m.triage.estimate()
    const h = host()
    // Une entrée par base lisible (privée, puis aussi la base partagée une fois créée).
    const rebuild = (): number => {
      dupOf(h, FILLER + textOf(5))
      return cacheSize()
    }
    expect(rebuild()).toBeGreaterThan(0)
    env.m.triage.promote({ fact_ids: [ids[0]!] })
    expect(cacheSize()).toBe(0)
    expect(rebuild()).toBeGreaterThan(0)
    env.m.shareFacts([ids[0]!], 'user')
    expect(cacheSize()).toBe(0)
    expect(rebuild()).toBeGreaterThan(0)
    const item = env.db().prepare('SELECT id FROM memory_import_items WHERE target_memory_id = ?').get(ids[1]) as { id: string }
    env.m.reviewDecision([item.id], 'accepted')
    expect(cacheSize()).toBe(0)
    expect(rebuild()).toBeGreaterThan(0)
    env.m.forget({ ids: [ids[2]!] })
    expect(cacheSize()).toBe(0)
  })
})
