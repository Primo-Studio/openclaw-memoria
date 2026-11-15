/**
 * Validation (promote) sans figer le daemon (ticket #27) : requête des
 * membres d'amas par l'index des amas, une transaction par tranche de 50,
 * requêtes préparées une fois. Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { newId } from '../src/index.js'
import { PROMOTE_MEMBERS_SQL } from '../src/engine/memoria.js'
import { ensureSource, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

/**
 * `n` faits EN ATTENTE (texte distinct, item de revue, ligne de tri), écrits
 * en SQL d'après un fait modèle : la déduplication de storeFact n'intervient pas.
 */
function seedTriaged(ids: string[], opts: { genre?: string; amasOf?: (id: string) => string } = {}): void {
  const db = env.db()
  const model = env.m.storeFact({ instance: env.instance, content: 'Fait modèle fictif des tests de validation.' })
  const cols = (db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name)
  const own = ['id', 'fact', 'norm_hash', 'content_hash']
  const ins = db.prepare(
    `INSERT INTO facts (${cols.join(',')}) SELECT ${cols.map(c => (own.includes(c) ? '?' : c === 'lifecycle_state' ? "'dormant'" : c)).join(',')} FROM facts WHERE id = ?`,
  )
  const src = ensureSource(db, '/fictif/validation.jsonl')
  const item = db.prepare(
    "INSERT INTO memory_import_items (id, source_id, target_memory_id, target_type, proposed_scope_id, status, confidence) VALUES (?, ?, ?, 'fact', ?, 'pending', 0.8)",
  )
  const tri = db.prepare(
    "INSERT INTO fact_triage (fact_id, genre, auteur_source, amas_id, amas_size, triaged_at, sensible) VALUES (?, ?, 'llm', ?, 1, '2026-01-02T03:04:05.000Z', 0)",
  )
  db.transaction(() => {
    ids.forEach((id, i) => {
      const values = cols.filter(c => own.includes(c)).map(c => (c === 'id' ? id : c === 'fact' ? `Idée fictive ${id} : un carnet de croquis pour le club ${i}` : `h-${c}-${id}`))
      ins.run(...values, model.id)
      item.run(newId(), src, id, model.scope_id)
      tri.run(id, opts.genre ?? 'idee', opts.amasOf?.(id) ?? id)
    })
  })()
}

const state = (id: string): { lifecycle_state: string; superseded: number; superseded_by: string | null } =>
  env.db().prepare('SELECT lifecycle_state, superseded, superseded_by FROM facts WHERE id = ?').get(id) as {
    lifecycle_state: string
    superseded: number
    superseded_by: string | null
  }

describe('promote : coût borné', () => {
  it('la requête des membres d’amas part de l’index des amas, jamais des dormants de facts', () => {
    env = setupTriage()
    const plan = (env.db().prepare(`EXPLAIN QUERY PLAN ${PROMOTE_MEMBERS_SQL}`).all('x', 'x') as Array<{ detail: string }>).map(r => r.detail)
    expect(plan[0]).toMatch(/^SEARCH t USING INDEX idx_fact_triage_amas/)
    expect(plan.join(' | ')).not.toMatch(/idx_facts_lifecycle/)
  })

  it('120 ids (trois tranches) : tous validés, items clos, redites supersédées vers leur représentant', () => {
    env = setupTriage()
    const reps = Array.from({ length: 120 }, (_, i) => `fx-rep-${String(i).padStart(3, '0')}`)
    const members = reps.map(id => `${id}-redite`)
    seedTriaged(reps)
    seedTriaged(members, { amasOf: id => id.replace(/-redite$/, '') })
    const r = env.m.triage.promote({ fact_ids: reps })
    expect(r).toMatchObject({ promoted: 120, merged_members: 120, not_found: 0, already_active: 0 })
    expect(reps.every(id => state(id).lifecycle_state === 'active')).toBe(true)
    expect(members.every((id, i) => state(id).superseded === 1 && state(id).superseded_by === reps[i])).toBe(true)
    const pending = env.db().prepare("SELECT COUNT(*) AS n FROM memory_import_items WHERE status = 'pending' AND target_memory_id LIKE 'fx-%'").get()
    expect(pending).toEqual({ n: 0 })
  })

  it('par filtre avec un plafond qui coupe une tranche : exactement `max` validés', () => {
    env = setupTriage()
    seedTriaged(Array.from({ length: 130 }, (_, i) => `fx-f-${String(i).padStart(3, '0')}`))
    expect(env.m.triage.promote({ filter: { genre: 'idee' }, max: 73 })).toMatchObject({ promoted: 73 })
    expect(env.db().prepare("SELECT COUNT(*) AS n FROM facts WHERE id LIKE 'fx-f-%' AND lifecycle_state = 'active'").get()).toEqual({ n: 73 })
  })

  it('un membre d’amas donné AVEC son représentant n’est pas validé après avoir été supersédé', () => {
    env = setupTriage()
    seedTriaged(['fx-a-rep'])
    seedTriaged(['fx-b-membre'], { amasOf: () => 'fx-a-rep' })
    const r = env.m.triage.promote({ fact_ids: ['fx-a-rep', 'fx-b-membre'] })
    expect(r).toMatchObject({ promoted: 1, merged_members: 1, not_found: 0 })
    expect(state('fx-b-membre')).toEqual({ lifecycle_state: 'dormant', superseded: 1, superseded_by: 'fx-a-rep' })
  })
})
