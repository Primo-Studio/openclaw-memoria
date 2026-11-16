/**
 * Schéma du tri (migrations 80, 81 et 82) et sort de la ligne de tri quand le
 * fait part : oubli, rejet en revue (effacés), partage (déplacée). Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ContentStore } from '../src/index.js'
import { seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'
import { join } from 'node:path'

let env: TriageEnv
afterEach(() => env?.close())

describe('migrations 80, 81 et 82', () => {
  it('créent fact_triage, fact_triage_vectors, user_message_state, style_pass_state et l’index de provenance ; idempotentes', () => {
    env = setupTriage()
    const path = join(env.root, 'seule.sqlite')
    const store = new ContentStore(path)
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toEqual(expect.arrayContaining(['fact_triage', 'fact_triage_vectors', 'user_message_state', 'style_pass_state', 'idx_import_items_target', 'idx_fact_triage_genre']))
    const versions = (store.db.prepare('SELECT version FROM schema_migrations WHERE version >= 80 AND version < 90').all() as Array<{ version: number }>).map(v => v.version)
    expect(versions).toEqual([80, 81, 82])
    store.close()
    const again = new ContentStore(path)
    expect(again.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (80, 81, 82)').get()).toEqual({ n: 3 })
    again.close()
  })
})

describe('la ligne de tri suit le fait', () => {
  it('oubli : la ligne et le vecteur de tri disparaissent avec le fait', async () => {
    env = setupTriage()
    const id = seedPending(env, 'Le dossier 1 est rangé chez Nimbus')
    await env.m.triage.run()
    expect(triageRow(env.db(), id)).toBeDefined()
    env.m.forget({ ids: [id] })
    expect(triageRow(env.db(), id)).toBeUndefined()
    expect(env.db().prepare('SELECT COUNT(*) AS n FROM fact_triage_vectors WHERE fact_id = ?').get(id)).toEqual({ n: 0 })
  })

  it('rejet en revue : la ligne disparaît', async () => {
    env = setupTriage()
    const id = seedPending(env, 'Le dossier 2 est rangé chez Nimbus')
    await env.m.triage.run()
    const item = env.db().prepare('SELECT id FROM memory_import_items WHERE target_memory_id = ?').get(id) as { id: string }
    env.m.reviewDecision([item.id], 'rejected')
    expect(triageRow(env.db(), id)).toBeUndefined()
  })

  it('partage (shareFacts, hors promotion) : la ligne et le vecteur de tri sont déplacés dans la base partagée', async () => {
    env = setupTriage()
    const id = seedPending(env, 'Le dossier 3 est rangé chez Nimbus')
    await env.m.triage.run()
    env.m.shareFacts([id], 'user')
    expect(triageRow(env.db(), id)).toBeUndefined()
    const shared = env.m.sharedContentStore(env.m.registry.getScopeByName('user')!.id)!
    expect(triageRow(shared.db, id)).toMatchObject({ genre: 'fait' })
    expect(shared.db.prepare('SELECT COUNT(*) AS n FROM fact_triage_vectors WHERE fact_id = ?').get(id)).toEqual({ n: 1 })
  })
})
