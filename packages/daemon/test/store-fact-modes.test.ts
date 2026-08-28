/**
 * POST /v1/memory/store_fact respecte le mode de capture (comme capture_turn) :
 * « Revue d'abord » → fait dormant + revue ; « Pause » → rien d'écrit, réponse
 * 200 annoncée `{ skipped: true, reason: 'paused' }`. Le kill-switch
 * (`enabled = false`) garde son `disabled: true`.
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
  root = mkdtempSync(join(tmpdir(), 'memoria-store-modes-http-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  instanceToken = (await new DaemonClient(daemon.state).completePairing(paired.pairing_code)).instance_token
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

async function call(path: string, body: unknown, token: string, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const admin = (path: string, body?: unknown) => call(path, body, daemon.state.admin_token, body === undefined ? 'GET' : 'POST')
const agent = (path: string, body: unknown) => call(path, body, instanceToken)

describe('store_fact × capture_mode', () => {
  it('review-first → fait dormant, absent du recall, présent dans la revue', async () => {
    expect((await admin('/v1/admin/capture_mode', { mode: 'review-first' })).status).toBe(200)

    const stored = await agent('/v1/memory/store_fact', { content: 'Le café du studio est un Nespresso' })
    expect(stored.status).toBe(200)
    const fact = stored.json['fact'] as { id: string; lifecycle_state: string }
    expect(fact.lifecycle_state).toBe('dormant')
    expect(stored.json['mode']).toBe('review-first')

    const recall = await agent('/v1/memory/recall', { query: 'café studio nespresso' })
    expect(recall.json['items']).toEqual([])

    const review = await admin('/v1/admin/review')
    const items = review.json['items'] as Array<{ fact_id: string }>
    expect(items.map(i => i.fact_id)).toEqual([fact.id])
  })

  it('incognito → 200 { skipped: true, reason: paused }, rien d’écrit', async () => {
    await admin('/v1/admin/capture_mode', { mode: 'incognito' })

    const stored = await agent('/v1/memory/store_fact', { content: 'Résultat d’analyse médicale : tout va bien' })
    expect(stored.status).toBe(200)
    expect(stored.json).toMatchObject({ fact: null, skipped: true, reason: 'paused', mode: 'incognito' })
    expect(stored.json['disabled']).toBeUndefined()

    expect((await agent('/v1/memory/recall', { query: 'analyse médicale' })).json['items']).toEqual([])
    expect(((await admin('/v1/admin/stats')).json as { facts: number }).facts).toBe(0)
  })

  it('kill-switch (enabled=false) garde disabled:true, sans skipped', async () => {
    await admin('/v1/admin/enabled', { enabled: false })
    const stored = await agent('/v1/memory/store_fact', { content: 'ne doit pas être écrit' })
    expect(stored.status).toBe(200)
    expect(stored.json).toMatchObject({ fact: null, disabled: true })
    expect(stored.json['skipped']).toBeUndefined()
  })
})
