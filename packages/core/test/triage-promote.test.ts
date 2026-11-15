/**
 * Validation des faits triés (promotion) et écriture des faits en attente
 * de la passe sur les messages (storePendingTriaged). Données fictives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TriageBudget, type TriageHost } from '../src/index.js'
import { seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

const state = (id: string): Record<string, unknown> =>
  env.db().prepare('SELECT lifecycle_state, superseded, superseded_by, sensitivity, fact FROM facts WHERE id = ?').get(id) as Record<string, unknown>
const items = (id: string): string[] =>
  (env.db().prepare('SELECT status FROM memory_import_items WHERE target_memory_id = ?').all(id) as Array<{ status: string }>).map(r => r.status)

describe('promote', () => {
  it('active le représentant, clôt sa revue, supersède ses redites en attente, relance cognition et vecteurs', async () => {
    env = setupTriage()
    const path = '/fictif/session.jsonl'
    const member = seedPending(env, 'La pépinière pourrait vendre un abonnement de graines de saison aux jardineries de la région', { path })
    const rep = seedPending(env, 'La pépinière pourrait vendre un abonnement de graines de saison aux jardineries de la région entière', { path })
    await env.m.triage.run()
    const index = vi.spyOn(env.m, 'indexEmbeddings')
    const r = env.m.triage.promote({ fact_ids: [rep] })
    expect(r).toMatchObject({ promoted: 1, merged_members: 1, cognition_calls_estimate: 1 })
    expect(state(rep)).toMatchObject({ lifecycle_state: 'active', superseded: 0 })
    expect(items(rep)).toEqual(['accepted'])
    expect(state(member)).toMatchObject({ superseded: 1, superseded_by: rep })
    expect(items(member)).toEqual(['duplicate'])
    expect(index).toHaveBeenCalled()
    // Le rappel rend le représentant, une seule fois.
    const recall = env.m.recall({ instance: env.instance, query: 'abonnement graines jardineries' })
    expect(recall.items.map(i => i.id)).toEqual([rep])
  })

  it('saute les sensibles (comptés) ; avec allow_sensitive, les garde invisibles au rappel (critical) ; saute les faux', async () => {
    env = setupTriage()
    const pay = seedPending(env, 'Le salaire de Zorba passe à 2 100 euros')
    const wrong = seedPending(env, 'Le dossier 7 est rangé chez Nimbus')
    await env.m.triage.run()
    env.m.triage.setVerdict([wrong], 'faux')
    expect(env.m.triage.promote({ fact_ids: [pay, wrong] })).toMatchObject({ promoted: 0, skipped_sensitive: 1, skipped_faux: 1 })
    expect(state(pay).lifecycle_state).toBe('dormant')
    expect(env.m.triage.promote({ fact_ids: [pay], allow_sensitive: true }).promoted).toBe(1)
    expect(state(pay)).toMatchObject({ lifecycle_state: 'active', sensitivity: 'critical' })
    expect(env.m.recall({ instance: env.instance, query: 'salaire Zorba' }).items).toEqual([])
  })

  it('par filtre : en attente seulement, sans éphémères ni sensibles, plafonné', async () => {
    env = setupTriage()
    seedPending(env, 'Les 42 tests passent et le commit est poussé')
    seedPending(env, 'Le salaire de Zorba passe à 2 100 euros')
    for (let i = 0; i < 4; i++) seedPending(env, `Le dossier ${10 + i} est rangé chez Nimbus`)
    await env.m.triage.run()
    expect(env.m.triage.promote({ filter: {}, max: 3 }).promoted).toBe(3)
    expect(env.m.triage.promote({ filter: {} }).promoted).toBe(1)
    const active = env.db().prepare("SELECT fact FROM facts WHERE lifecycle_state = 'active'").all() as Array<{ fact: string }>
    expect(active).toHaveLength(4)
    expect(active.map(a => a.fact).every(f => f.startsWith('Le dossier'))).toBe(true)
  })

  it('une redite d’un actif est supersédée vers lui ; un secret resté en clair est masqué avant validation', async () => {
    env = setupTriage()
    const active = env.m.storeFact({ instance: env.instance, content: 'Le portail Lumen est hébergé chez Brumehost' }).id
    await env.m.indexEmbeddings()
    const twin = seedPending(env, 'Le portail Lumen est hébergé chez Brumehost depuis')
    const leaky = seedPending(env, 'Le jeton du service fictif est rangé dans le carnet')
    const secret = 'sk-ant-api03-' + 'A'.repeat(90)
    env.db().prepare('UPDATE facts SET fact = ? WHERE id = ?').run(`Le jeton du service fictif est ${secret}`, leaky)
    await env.m.triage.run()
    expect(triageRow(env.db(), twin)!.same_as_active).toBe(active)
    expect(triageRow(env.db(), leaky)!.secret_found).toBe(1)
    expect([...env.llm.prompts, ...env.embedder.texts].join('\n')).not.toContain(secret)
    const r = env.m.triage.promote({ fact_ids: [twin, leaky] })
    expect(r).toMatchObject({ promoted: 1, merged_into_active: 1, secrets_masked: 1 })
    expect(state(twin)).toMatchObject({ superseded: 1, superseded_by: active })
    expect(String(state(leaky).fact)).not.toContain(secret)
  })

  it('partage : le fait, sa ligne de tri et ses redites passent dans la base partagée', async () => {
    env = setupTriage()
    const path = '/fictif/session.jsonl'
    const member = seedPending(env, 'La pépinière pourrait vendre un abonnement de graines de saison aux jardineries de la région', { path })
    const rep = seedPending(env, 'La pépinière pourrait vendre un abonnement de graines de saison aux jardineries de la région entière', { path })
    await env.m.triage.run()
    const r = env.m.triage.promote({ fact_ids: [rep], share: true })
    expect(r.shared).toBe(2)
    expect(triageRow(env.db(), rep)).toBeUndefined()
    const listed = env.m.triage.list({ include_members: true }).items
    const moved = listed.find(i => i.fact_id === rep)!
    expect(moved).toMatchObject({ genre: 'idee', validated: true, source_db: 'shared/user.sqlite' })
    expect(listed.find(i => i.fact_id === member)).toBeUndefined() // supersédé : hors liste
  })
})

describe('storePendingTriaged (passe sur les messages)', () => {
  function host(): TriageHost {
    return env.m.triage.createHost({ llm: env.llm, embeddings: env.embedder, budget: new TriageBudget({ budgetUsd: 1 }), stop: () => null })
  }

  it('écrit un fait EN ATTENTE, sa ligne de tri et une source « user-messages », dans une transaction', () => {
    env = setupTriage()
    const r = host().storePendingTriaged({
      instance: env.instance,
      content: 'Le propriétaire veut une app de recettes de saison',
      triage: { genre: 'idee', sous_type: 'app', auteur: 'owner', titre: 'App de recettes de saison', citation: 'une app de recettes' },
      source: { key: 'session-fictive-1', path: '/fictif/s1.jsonl' },
    })
    expect(r.created).toBe(true)
    expect(state(r.fact_id).lifecycle_state).toBe('dormant')
    expect(triageRow(env.db(), r.fact_id)).toMatchObject({ genre: 'idee', auteur: 'owner', auteur_source: 'message', amas_id: r.fact_id })
    const src = env.db()
      .prepare('SELECT s.source_type FROM memory_import_items i JOIN memory_sources s ON s.id = i.source_id WHERE i.target_memory_id = ?')
      .get(r.fact_id)
    expect(src).toEqual({ source_type: 'user-messages' })
  })

  it('un texte identique à un fait en attente ne l’active jamais ; identique à un actif, rien n’est écrit', () => {
    env = setupTriage()
    const dormant = seedPending(env, 'Une app de recettes de saison')
    const active = env.m.storeFact({ instance: env.instance, content: 'Le studio facture au forfait' }).id
    const h = host()
    const a = h.storePendingTriaged({ instance: env.instance, content: 'Une app de recettes de saison', triage: { genre: 'idee' }, source: { key: 'k' } })
    expect(a).toEqual({ fact_id: dormant, created: false })
    expect(state(dormant).lifecycle_state).toBe('dormant')
    const b = h.storePendingTriaged({ instance: env.instance, content: 'Le studio facture au forfait', triage: { genre: 'fait' }, source: { key: 'k' } })
    expect(b).toEqual({ fact_id: active, created: false })
    expect(state(active).lifecycle_state).toBe('active')
    expect(triageRow(env.db(), active)).toBeUndefined()
  })
})
