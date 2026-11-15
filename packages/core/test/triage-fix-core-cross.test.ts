/**
 * Amas entre sources : un fait ACTIF n'est jamais membre d'un représentant en
 * attente (il disparaîtrait de memoria_ideas) ; un saut pour calcul trop long
 * est inscrit dans l'état du passage. Données fictives uniquement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => {
  env?.close()
  vi.restoreAllMocks()
})

const LONG = 'On pourrait proposer une app de covoiturage pour les festivals de musique en plein air'
const SHORT = 'On pourrait proposer une app de covoiturage pour festivals de musique plein air'

describe('amas entre sources et faits actifs', () => {
  it('une idée validée triée après sa redite en attente reste visible dans memoria_ideas (elle reste seule)', async () => {
    env = setupTriage()
    const pending = seedPending(env, LONG, { path: '/fictif/a.jsonl' })
    await env.m.triage.run()
    const active = env.m.storeFact({ instance: env.instance, content: SHORT }).id
    await env.m.triage.run()
    expect(triageRow(env.db(), active)!.amas_id).toBe(active)
    expect(triageRow(env.db(), pending)!.amas_id).toBe(pending)
    const ideas = env.m.triage.ideasForInstance(env.instance, { genre: 'idee' })
    expect(ideas.items.map(i => i.id)).toEqual([active])
  })

  it('un actif et sa redite en attente triés ensemble : l’actif représente l’amas, même au texte plus court', async () => {
    env = setupTriage()
    const active = env.m.storeFact({ instance: env.instance, content: SHORT }).id
    const pending = seedPending(env, LONG, { path: '/fictif/b.jsonl' })
    await env.m.triage.run()
    expect(triageRow(env.db(), active)).toMatchObject({ amas_id: active, amas_size: 2 })
    expect(triageRow(env.db(), pending)!.amas_id).toBe(active)
    expect(env.m.triage.ideasForInstance(env.instance, { genre: 'idee' }).items.map(i => i.id)).toEqual([active])
  })

  it('les faits en attente se regroupent toujours entre eux (aucun actif)', async () => {
    env = setupTriage()
    const first = seedPending(env, SHORT, { path: '/fictif/c1.jsonl' })
    await env.m.triage.run()
    const again = seedPending(env, LONG, { path: '/fictif/c2.jsonl' })
    await env.m.triage.run()
    expect(triageRow(env.db(), again)!.amas_id).toBe(first)
    expect(triageRow(env.db(), first)!.amas_size).toBe(2)
  })
})

describe('amas entre sources sauté', () => {
  it('le saut est inscrit dans l’état du passage (et persisté), pas seulement en console', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    env = setupTriage()
    const a = seedPending(env, SHORT, { path: '/fictif/d1.jsonl' })
    const b = seedPending(env, LONG, { path: '/fictif/d2.jsonl' })
    env.m.triage.crossSourceMaxComparisons = 0
    const s = await env.m.triage.run()
    expect(s.cross_source_skipped).toEqual([{ genre: 'idee', reps: 2, comparisons: 1 }])
    expect(env.m.triage.status().cross_source_skipped).toEqual([{ genre: 'idee', reps: 2, comparisons: 1 }])
    // Sauté : les deux redites restent séparées.
    expect(triageRow(env.db(), a)!.amas_id).toBe(a)
    expect(triageRow(env.db(), b)!.amas_id).toBe(b)
  })

  it('sous le plafond : rien de sauté, les redites de deux sessions se regroupent', async () => {
    env = setupTriage()
    seedPending(env, SHORT, { path: '/fictif/e1.jsonl' })
    const b = seedPending(env, LONG, { path: '/fictif/e2.jsonl' })
    const s = await env.m.triage.run()
    expect(s.cross_source_skipped).toEqual([])
    expect(triageRow(env.db(), b)!.amas_size).toBe(2)
  })
})
