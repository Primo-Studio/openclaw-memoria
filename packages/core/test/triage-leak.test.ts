/**
 * Lectures d'agent du tri (`ideasForInstance`, `stylesForInstance`) : jamais
 * un fait que le rappel cache. Le texte d'un fait en attente ne sort jamais
 * (seulement un compteur par genre) ; la garde « dormant » du rappel reste
 * entière après un passage. Données fictives.
 */
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

const HIDE: Record<string, (db: Database, id: string) => void> = {
  dormant: (db, id) => void db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(id),
  critical: (db, id) => void db.prepare("UPDATE facts SET sensitivity = 'critical' WHERE id = ?").run(id),
  sensible: (db, id) => void db.prepare('UPDATE fact_triage SET sensible = 1 WHERE fact_id = ?').run(id),
  faux: (db, id) => void db.prepare("UPDATE fact_triage SET verdict = 'faux' WHERE fact_id = ?").run(id),
  'supersédé': (db, id) => void db.prepare('UPDATE facts SET superseded = 1 WHERE id = ?').run(id),
  'expiré': (db, id) => void db.prepare("UPDATE facts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id),
  'autre scope': (db, id) => void db.prepare("UPDATE facts SET scope_id = 'scope-non-autorise' WHERE id = ?").run(id),
  'autre client': (db, id) => void db.prepare("UPDATE facts SET client_org_id = 'org-client-fictif' WHERE id = ?").run(id),
}

async function seedIdeas(): Promise<{ visible: string; hidden: string }> {
  const visible = env.m.storeFact({ instance: env.instance, content: 'On pourrait proposer une app de covoiturage pour festivals' }).id
  const hidden = env.m.storeFact({ instance: env.instance, content: 'On pourrait proposer une app de location de kayaks Brumeriver' }).id
  await env.m.triage.run()
  return { visible, hidden }
}

describe('ideasForInstance : mêmes filtres durs que le rappel', () => {
  it('témoin : deux idées validées sont rendues, marquées validées', async () => {
    env = setupTriage()
    const { visible, hidden } = await seedIdeas()
    const r = env.m.triage.ideasForInstance(env.instance, { genre: 'idee' })
    expect(r.items.map(i => i.id).sort()).toEqual([visible, hidden].sort())
    expect(r.items.every(i => i.validated === true && i.genre === 'idee')).toBe(true)
  })

  it.each(Object.keys(HIDE))('une idée %s ne ressort jamais, et son texte n’apparaît nulle part', async state => {
    env = setupTriage()
    const { visible, hidden } = await seedIdeas()
    HIDE[state]!(env.db(), hidden)
    const r = env.m.triage.ideasForInstance(env.instance, { genre: 'idee' })
    expect(r.items.map(i => i.id)).toEqual([visible])
    expect(JSON.stringify(r)).not.toContain('kayaks')
  })

  it('les faits en attente : un compteur par genre, jamais leur texte ; une autre instance ne voit rien du privé', async () => {
    env = setupTriage()
    seedPending(env, 'On pourrait proposer une app de location de kayaks Brumeriver')
    seedPending(env, 'Le salaire de Zorba passe à 2 100 euros')
    await env.m.triage.run()
    const r = env.m.triage.ideasForInstance(env.instance)
    expect(r.items).toEqual([])
    expect(r.pending_counts).toEqual({ idee: 1 })
    expect(JSON.stringify(r)).not.toMatch(/kayaks|salaire/)
    const other = env.m.pairAssistant({ type: 'codex' }).assistant_instance_id
    expect(env.m.triage.ideasForInstance(other)).toEqual({ items: [], pending_counts: {} })
  })

  it('après un passage, le rappel ne rend toujours aucun fait en attente', async () => {
    env = setupTriage()
    seedPending(env, 'On pourrait proposer une app de location de kayaks Brumeriver')
    await env.m.triage.run()
    expect(env.m.recall({ instance: env.instance, query: 'kayaks Brumeriver' }).items).toEqual([])
    expect((await env.m.recallSemantic({ instance: env.instance, query: 'kayaks Brumeriver' })).items).toEqual([])
  })
})

describe('stylesForInstance', () => {
  it('rend les styles VALIDÉS de la personne, du plus récent au plus ancien', async () => {
    env = setupTriage()
    const older = env.m.storeFact({ instance: env.instance, content: 'Le propriétaire écrit des messages courts sans ponctuation' }).id
    const newer = env.m.storeFact({ instance: env.instance, content: 'Le propriétaire dicte ses messages en marchant' }).id
    const pending = seedPending(env, 'Le propriétaire écrit des messages très longs le soir')
    await env.m.triage.run()
    const db = env.db()
    db.prepare("UPDATE fact_triage SET conversation_at = '2026-01-01T00:00:00.000Z' WHERE fact_id = ?").run(older)
    db.prepare("UPDATE fact_triage SET conversation_at = '2026-06-01T00:00:00.000Z' WHERE fact_id = ?").run(newer)
    const r = env.m.triage.stylesForInstance(env.instance)
    expect(r).toMatchObject({ person_id: null })
    expect(r.items.map(i => i.id)).toEqual([newer, older])
    expect(JSON.stringify(r)).not.toContain('très longs')
    void pending
    const person = env.m.createPerson({ display_name: 'Zorba Fictif' })
    expect(env.m.triage.stylesForInstance(env.instance, { person_id: person.id }).items).toEqual([])
  })
})
