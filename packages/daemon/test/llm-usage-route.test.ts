/**
 * GET /v1/admin/llm_usage — consommation des modèles par période, de bout en
 * bout par HTTP. Sans LLM configuré : rapport vide mais bien formé.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon

async function admin(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    headers: { authorization: `Bearer ${daemon.state.admin_token}` },
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-llmusage-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml') })
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

describe('GET /v1/admin/llm_usage', () => {
  it('sans token → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.state.port}/v1/admin/llm_usage`)
    expect(res.status).toBe(401)
  })

  it('défaut = 24 h, rapport vide bien formé', async () => {
    const res = await admin('/v1/admin/llm_usage')
    expect(res.status).toBe(200)
    const report = (await res.json()) as { period: string; since: string | null; rows: unknown[]; totals: { calls: number; estimated_cost_usd: number | null }; pricing_as_of: string }
    expect(report.period).toBe('24h')
    expect(report.since).not.toBeNull()
    expect(report.rows).toEqual([])
    expect(report.totals.calls).toBe(0)
    expect(report.totals.estimated_cost_usd).toBe(0)
    expect(report.pricing_as_of).toMatch(/^\d{4}-\d{2}$/)
  })

  it('?period=all → since null ; 7d/30d acceptés', async () => {
    const all = (await (await admin('/v1/admin/llm_usage?period=all')).json()) as { period: string; since: string | null }
    expect(all).toMatchObject({ period: 'all', since: null })
    for (const p of ['7d', '30d']) {
      const r = await admin(`/v1/admin/llm_usage?period=${p}`)
      expect(r.status).toBe(200)
      expect(((await r.json()) as { period: string }).period).toBe(p)
    }
  })

  it('période inconnue → 400 explicite', async () => {
    const res = await admin('/v1/admin/llm_usage?period=hier')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string; message?: string }
    expect(JSON.stringify(body)).toMatch(/period invalide/)
  })

  it('le doctor expose la même consommation (usage.period = 24h)', async () => {
    const res = await admin('/v1/admin/doctor')
    expect(res.status).toBe(200)
    const report = (await res.json()) as { usage: { period: string; rows: unknown[] } }
    expect(report.usage.period).toBe('24h')
    expect(Array.isArray(report.usage.rows)).toBe(true)
  })
})
