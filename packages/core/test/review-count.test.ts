/**
 * Comptage de la file de revue (badge « Revue », règle n°27, 15/11). Le badge
 * relisait la liste entière toutes les 20 s : 150 à 353 ms de boucle figée sur
 * 72 538 éléments en attente, et un badge plafonné à 100. countReview doit
 * compter EXACTEMENT ce que listReview montrerait, sans plafond. Données fictives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../src/util.js'
import { ensureSource, seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv | undefined
afterEach(() => {
  env?.close()
  env = undefined
})

/** Tout ce que la liste montrerait, sans plafond utile. */
const listed = (e: TriageEnv) => e.m.listReview({ limit: 500 }).length

describe('countReview', () => {
  it('compte la file entière, sans le plafond de 100 de la liste', () => {
    env = setupTriage({ embedder: null })
    for (let i = 0; i < 130; i++) seedPending(env, `Fait en attente numéro ${i} sur le chantier ${i * 7}`)
    expect(env.m.countReview()).toBe(130)
    expect(listed(env)).toBe(130)
    expect(env.m.listReview()).toHaveLength(100) // la liste par défaut plafonne, pas le compte
  })

  it('même périmètre que la liste : oubli, validation, rejet, items hors file, autre base', () => {
    env = setupTriage({ embedder: null })
    const e = env
    const ids = [0, 1, 2, 3, 4, 5].map(i => seedPending(e, `Réglage en attente ${i} du routeur du studio`))
    expect(e.m.countReview()).toBe(6)

    // Fait oublié : son item reste `pending` mais la liste ne le montre plus.
    e.m.forget({ ids: [ids[0]!] })
    expect(e.m.countReview()).toBe(5)
    expect(listed(e)).toBe(5)

    const itemOf = (factId: string) => e.m.listReview({ limit: 500 }).find(i => i.fact_id === factId)!.id
    e.m.reviewDecision([itemOf(ids[1]!)], 'accepted')
    e.m.reviewDecision([itemOf(ids[2]!)], 'rejected')
    expect(e.m.countReview()).toBe(3)
    expect(listed(e)).toBe(3)

    // Hors file : item d'une procédure, item d'un fait déjà accepté.
    const db = e.db()
    const src = ensureSource(db, '/tmp/fictif.jsonl')
    const insert = db.prepare(
      `INSERT INTO memory_import_items (id, source_id, target_memory_id, target_type, proposed_scope_id, status, confidence)
       VALUES (?, ?, ?, ?, 'x', ?, 0.5)`,
    )
    insert.run(newId(), src, ids[3]!, 'procedure', 'pending')
    insert.run(newId(), src, ids[4]!, 'fact', 'accepted')
    expect(e.m.countReview()).toBe(3)
    expect(listed(e)).toBe(3)

    // Autre agent, autre base : compté aussi, comme dans la liste.
    const other = e.m.pairAssistant({ type: 'codex' }).assistant_instance_id
    seedPending(e, 'Préférence en attente de l’autre agent', undefined, other)
    expect(e.m.countReview()).toBe(4)
    expect(listed(e)).toBe(4)
  })

  it('lit l’index partiel de la file, pas la table entière', () => {
    env = setupTriage({ embedder: null })
    seedPending(env, 'Un fait en attente pour avoir une file')
    const db = env.db()
    const seen: string[] = []
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/COUNT\(\*\)/.test(sql) && /memory_import_items/.test(sql)) seen.push(sql)
      return prepare(sql)
    }) as typeof db.prepare)
    expect(env.m.countReview()).toBe(1)
    vi.restoreAllMocks()
    expect(seen).toHaveLength(1)
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${seen[0]!}`).all() as Array<{ detail: string }>
    expect(plan.map(p => p.detail).join(' | ')).toMatch(/SCAN i USING COVERING INDEX idx_import_items_pending/)
  })
})
