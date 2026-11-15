/**
 * Validation (promote) d'un fait SENSIBLE dont la ligne de tri porte
 * sensible = 0 (ligne créée par une correction avant tout passage, ou triée
 * avant un filtre plus large) : le texte est relu par le filtre sensible.
 * Règle du propriétaire : un fait de paie ne part jamais à une IA (LLM de
 * cognition, vecteurs) et ne sort pas au rappel, sauf s'il a levé la marque
 * lui-même. Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

const PAY = 'Le salaire du personnage fictif Quentar passe à 1 234 euros brut'
/**
 * Ligne de tri d'un texte sensible qui porte sensible = 0 : triée sous un
 * filtre plus étroit, ou créée par une correction avant que la correction ne
 * relise le filtre. C'est ce que promote doit rattraper en relisant le texte.
 */
const forceNotSensible = (id: string): void => {
  env.db().prepare('UPDATE fact_triage SET sensible = 0 WHERE fact_id = ?').run(id)
}
const state = (id: string): Record<string, unknown> =>
  env.db().prepare('SELECT lifecycle_state, sensitivity FROM facts WHERE id = ?').get(id) as Record<string, unknown>

/** Ce qui part aux IA après la validation (cognition et vecteurs), et ce que le rappel rend. */
async function afterPromote(run: () => unknown): Promise<{ toLlm: string[]; toVectors: string[]; recalled: boolean; result: unknown }> {
  const prompts = env.llm.prompts.length
  const texts = env.embedder.texts.length
  const result = run()
  await env.m.indexEmbeddings()
  await env.m.processCognition()
  return {
    toLlm: env.llm.prompts.slice(prompts).filter(p => p.includes('Quentar')),
    toVectors: env.embedder.texts.slice(texts).filter(t => t.includes('Quentar')),
    recalled: JSON.stringify(env.m.recall({ instance: env.instance, query: 'salaire Quentar' })).includes('Quentar'),
    result,
  }
}

describe('promote relit le filtre sensible sur le texte', () => {
  it('correction (importance) AVANT tout passage puis validation par id : sauté, rien aux IA, rien au rappel', async () => {
    env = setupTriage()
    const id = seedPending(env, PAY)
    expect(env.m.triage.correct({ fact_id: id, importance: 3 })).toEqual({ updated: true })
    await env.m.triage.run()
    const out = await afterPromote(() => env.m.triage.promote({ fact_ids: [id] }))
    expect(out.result).toMatchObject({ promoted: 0, skipped_sensitive: 1 })
    expect(state(id)).toMatchObject({ lifecycle_state: 'dormant' })
    expect(out.toLlm).toEqual([])
    expect(out.toVectors).toEqual([])
    expect(out.recalled).toBe(false)
  })

  it('ligne corrigée qui porte sensible = 0 : sautée par id, puis par filtre ; rien aux IA, rien au rappel', async () => {
    env = setupTriage()
    const id = seedPending(env, PAY)
    env.m.triage.correct({ fact_id: id, genre: 'fait', importance: 3 })
    forceNotSensible(id)
    expect(triageRow(env.db(), id)).toMatchObject({ sensible: 0, corrected_fields: '["genre","importance"]' })
    const out = await afterPromote(() => env.m.triage.promote({ fact_ids: [id] }))
    expect(out.result).toMatchObject({ promoted: 0, skipped_sensitive: 1 })
    // Le filtre (sensible = 0 en SQL) le sélectionne : le texte relu le saute.
    const byFilter = await afterPromote(() => env.m.triage.promote({ filter: { genre: 'fait' } }))
    expect(byFilter.result).toMatchObject({ promoted: 0, skipped_sensitive: 1 })
    expect(state(id)).toMatchObject({ lifecycle_state: 'dormant' })
    expect([...out.toLlm, ...out.toVectors, ...byFilter.toLlm, ...byFilter.toVectors]).toEqual([])
    expect(byFilter.recalled).toBe(false)
  })

  it('ligne triée (passage) qui porte sensible = 0 : sautée', async () => {
    env = setupTriage()
    const id = seedPending(env, PAY)
    await env.m.triage.run()
    forceNotSensible(id)
    const out = await afterPromote(() => env.m.triage.promote({ fact_ids: [id] }))
    expect(out.result).toMatchObject({ promoted: 0, skipped_sensitive: 1 })
    expect([...out.toLlm, ...out.toVectors]).toEqual([])
    expect(out.recalled).toBe(false)
  })

  it('allow_sensitive : validé en critical, jamais au LLM de cognition ni au rappel', async () => {
    env = setupTriage()
    const id = seedPending(env, PAY)
    env.m.triage.correct({ fact_id: id, importance: 3 })
    forceNotSensible(id)
    const out = await afterPromote(() => env.m.triage.promote({ fact_ids: [id], allow_sensitive: true }))
    expect(out.result).toMatchObject({ promoted: 1, skipped_sensitive: 0 })
    expect(state(id)).toEqual({ lifecycle_state: 'active', sensitivity: 'critical' })
    expect(out.toLlm).toEqual([])
    expect(out.recalled).toBe(false)
  })

  it('le propriétaire a levé la marque à la main (sensible: false) : son choix est respecté', async () => {
    env = setupTriage()
    const id = seedPending(env, PAY)
    expect(env.m.triage.correct({ fact_id: id, sensible: false })).toEqual({ updated: true })
    const r = env.m.triage.promote({ fact_ids: [id] })
    expect(r).toMatchObject({ promoted: 1, skipped_sensitive: 0 })
    expect(state(id)).toEqual({ lifecycle_state: 'active', sensitivity: 'normal' })
  })

  it('marque levée puis reposée (sensible: true) : sauté', () => {
    env = setupTriage()
    const id = seedPending(env, PAY)
    env.m.triage.correct({ fact_id: id, sensible: false })
    env.m.triage.correct({ fact_id: id, sensible: true })
    expect(env.m.triage.promote({ fact_ids: [id] })).toMatchObject({ promoted: 0, skipped_sensitive: 1 })
  })
})
