/**
 * GET /v1/admin/review/count : le compte seul de la file de revue, pour le
 * badge de l'interface (relu toutes les 20 s ; la liste entière figeait le
 * daemon 150 à 353 ms, règle n°27). Même authentification et même périmètre
 * que GET /v1/admin/review.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon
let instanceToken: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-review-count-http-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  instanceToken = (await new DaemonClient(daemon.state).completePairing(paired.pairing_code)).instance_token
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

async function call(path: string, token: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const admin = (path: string, body?: unknown) => call(path, daemon.state.admin_token, body)
const listed = async () => ((await admin('/v1/admin/review')).json['items'] as Array<{ id: string; fact_id: string }>)
const counted = async () => {
  const r = await admin('/v1/admin/review/count')
  expect(r.status).toBe(200)
  return r.json['count']
}

describe('GET /v1/admin/review/count', () => {
  it('compte ce que la liste montre : écritures en revue, oubli, validation', async () => {
    expect(await counted()).toBe(0)
    expect((await admin('/v1/admin/capture_mode', { mode: 'review-first' })).status).toBe(200)
    const ids: string[] = []
    for (const content of ['Le café du studio est un Nespresso', 'La salle B sert aux tournages', 'Le NAS sauvegarde la nuit']) {
      const stored = await call('/v1/memory/store_fact', instanceToken, { content })
      expect(stored.status).toBe(200)
      ids.push((stored.json['fact'] as { id: string }).id)
    }
    expect(await counted()).toBe(3)
    expect((await listed()).length).toBe(3)

    // Fait oublié : son item reste en attente mais ne figure plus dans la liste.
    expect((await admin('/v1/admin/forget', { ids: [ids[0]] })).status).toBe(200)
    expect(await counted()).toBe(2)
    expect((await listed()).length).toBe(2)

    const item = (await listed()).find(i => i.fact_id === ids[1])!
    expect((await admin('/v1/admin/review/approve', { ids: [item.id] })).status).toBe(200)
    expect(await counted()).toBe(1)
    expect((await listed()).length).toBe(1)
  })

  it('même authentification que la liste : token admin seulement', async () => {
    const none = await call('/v1/admin/review/count', null)
    expect(none.status).toBe(401)
    const agent = await call('/v1/admin/review/count', instanceToken)
    expect(agent.status).toBe(401)
    const wrong = await call('/v1/admin/review/count', 'pas-le-bon-token')
    expect(wrong.status).toBe(401)
    // La liste refuse les mêmes appels.
    expect((await call('/v1/admin/review', instanceToken)).status).toBe(401)
  })
})
