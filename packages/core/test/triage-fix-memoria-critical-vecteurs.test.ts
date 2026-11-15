/**
 * Un fait sensible validé avec allow_sensitive (sensitivity = 'critical') ne
 * part JAMAIS au fournisseur de vecteurs. L'exclusion des faits critical de
 * l'indexeur vit dans vector/indexer.ts ; promote, de son côté, pose bien
 * critical sur un texte sensible même quand la ligne de tri dit sensible = 0.
 * Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

describe('allow_sensitive et vecteurs', () => {
  it('validé en critical (ligne corrigée, sensible = 0) : rien aux vecteurs après indexation', async () => {
    env = setupTriage()
    const id = seedPending(env, 'Le salaire du personnage fictif Quentar passe à 1 234 euros brut')
    env.m.triage.correct({ fact_id: id, importance: 3 })
    env.db().prepare('UPDATE fact_triage SET sensible = 0 WHERE fact_id = ?').run(id) // ligne triée sous un filtre plus étroit
    const before = env.embedder.texts.length
    expect(env.m.triage.promote({ fact_ids: [id], allow_sensitive: true })).toMatchObject({ promoted: 1 })
    expect(env.db().prepare('SELECT sensitivity FROM facts WHERE id = ?').get(id)).toEqual({ sensitivity: 'critical' })
    await env.m.indexEmbeddings()
    expect(env.embedder.texts.slice(before).filter(t => t.includes('Quentar'))).toEqual([])
  })
})
