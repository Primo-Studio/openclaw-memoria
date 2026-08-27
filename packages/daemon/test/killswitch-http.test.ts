/**
 * Kill-switch (config.enabled = false, « Memoria en pause ») vu par les agents.
 *
 * Contrat : le daemon reste joignable, ne lit ni n'écrit AUCUNE mémoire, et
 * chaque route mémoire répond par un no-op ANNONCÉ (`disabled: true`). Bug :
 * seules recall/store_fact/capture_turn/feedback/capture_status l'honoraient ;
 * pin, correct, merge, expiry, identify_* tombaient en 404 « route mémoire
 * inconnue » — un agent (MCP memoria_pin…) croyait à une route cassée.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon
let instanceToken: string
let factId: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-killswitch-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
  instanceToken = done.instance_token
  const agent = new DaemonClient(daemon.state, instanceToken)
  const stored = (await agent.storeFact({ content: 'Le studio ferme le vendredi après-midi' })) as { fact: { id: string } }
  factId = stored.fact.id
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

async function call(path: string, body: unknown, token: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const MEMORY_ROUTES: Array<[string, unknown]> = [
  ['/v1/memory/recall', { query: 'vendredi' }],
  ['/v1/memory/store_fact', { content: 'ne doit pas être écrit' }],
  ['/v1/memory/capture_turn', { messages: [{ role: 'user', content: 'ne doit pas être capturé' }] }],
  ['/v1/memory/feedback', { fact_ids: ['x'], used: true }],
  ['/v1/memory/capture_status', { wal_ids: [1] }],
  ['/v1/memory/correct', { fact_id: 'x', content: 'corrigé' }],
  ['/v1/memory/merge', { keep_fact_id: 'x', merge_fact_ids: ['y'] }],
  ['/v1/memory/pin', { fact_id: 'x', pinned: true }],
  ['/v1/memory/expiry', { fact_id: 'x', expires_at: null }],
  ['/v1/memory/identify_interlocutor', { kind: 'phone', value: '+594' }],
  ['/v1/memory/identify_or_create_interlocutor', { kind: 'phone', value: '+594' }],
]

describe('Memoria en pause', () => {
  it('chaque route mémoire → 200 + disabled:true, et rien n’est écrit', async () => {
    // Témoin : capture_turn n'écrit pas dans `facts` mais dans le WAL — c'est
    // walPendingTotal() qui le voit (doctor() n'a pas de wal_pending racine,
    // l'ancienne assertion comparait 0 à 0). On prouve d'abord que la métrique
    // bouge quand Memoria est active, sinon le « rien n'est écrit » ne vaut rien.
    const walBeforeWitness = daemon.memoria.walPendingTotal()
    await call('/v1/memory/capture_turn', { messages: [{ role: 'user', content: 'témoin : capturé pendant que Memoria est active' }] }, instanceToken)
    expect(daemon.memoria.walPendingTotal()).toBeGreaterThan(walBeforeWitness)

    const off = await call('/v1/admin/enabled', { enabled: false }, daemon.state.admin_token)
    expect(off.status).toBe(200)
    const before = daemon.memoria.stats().facts
    const walBefore = daemon.memoria.walPendingTotal()

    for (const [path, body] of MEMORY_ROUTES) {
      const r = await call(path, body, instanceToken)
      expect(r.status, path).toBe(200)
      expect(r.json['disabled'], path).toBe(true)
    }
    // pin en pause : le fait n'a PAS été épinglé
    const pinned = await call('/v1/memory/pin', { fact_id: factId, pinned: true }, instanceToken)
    expect(pinned.json['updated']).toBe(false)
    expect(daemon.memoria.stats().facts).toBe(before)
    expect(daemon.memoria.walPendingTotal()).toBe(walBefore)

    // une route VRAIMENT inconnue reste un 404
    expect((await call('/v1/memory/inexistante', {}, instanceToken)).status).toBe(404)

    // l'état est visible côté admin
    const control = await fetch(`http://127.0.0.1:${daemon.state.port}/v1/admin/control`, {
      headers: { authorization: `Bearer ${daemon.state.admin_token}` },
    })
    expect(((await control.json()) as { enabled: boolean }).enabled).toBe(false)
  })

  it('après réactivation, le recall retrouve le fait', async () => {
    await call('/v1/admin/enabled', { enabled: false }, daemon.state.admin_token)
    expect((await call('/v1/memory/recall', { query: 'vendredi' }, instanceToken)).json['items']).toEqual([])
    await call('/v1/admin/enabled', { enabled: true }, daemon.state.admin_token)
    const r = await call('/v1/memory/recall', { query: 'vendredi' }, instanceToken)
    expect(r.json['disabled']).toBeUndefined()
    expect((r.json['items'] as unknown[]).length).toBe(1)
  })
})
