/**
 * Contrat HTTP « jamais de mort silencieuse » côté daemon :
 *  - une erreur interne (500) est JOURNALISÉE (console.error) — avant, le catch
 *    global renvoyait {error} au client sans laisser la moindre trace dans
 *    daemon.log / memoria.err.log : `memoria doctor` et les logs restaient muets ;
 *  - un corps JSON qui n'est pas un objet (`null`, tableau, chaîne) → 400, pas
 *    un TypeError 500 « Cannot read properties of null » ;
 *  - un paramètre numérique invalide (`limit=abc`, `limit=-1`) → 400, pas un
 *    « datatype mismatch » SQLite en 500 ;
 *  - `enabled` doit être un booléen : `{}` mettait Memoria EN PAUSE (kill-switch
 *    persisté dans config.toml) au lieu de refuser.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-http-contract-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

function url(path: string): string {
  return `http://127.0.0.1:${daemon.state.port}${path}`
}

async function postRaw(path: string, raw: string, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw,
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function getAdmin(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url(path), { headers: { authorization: `Bearer ${daemon.state.admin_token}` } })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('GET /v1/health — identité du daemon', () => {
  it('expose pid, started_at, superviseur, build et stockage (distinguer « un daemon répond » de « LE daemon attendu »)', async () => {
    const res = await fetch(url('/v1/health'))
    const h = (await res.json()) as Record<string, unknown>
    expect(h['ok']).toBe(true)
    expect(h['pid']).toBe(process.pid)
    expect(h['started_at']).toBe(daemon.state.started_at)
    expect(h['supervisor']).toBeNull() // vitest n'est pas launchd
    expect(h['storage_root']).toBe(root)
    expect(h['config_path']).toBe(join(root, 'config.toml'))
    expect(h['built_sha'] === null || typeof h['built_sha'] === 'string').toBe(true)
  })
})

describe('corps JSON non-objet', () => {
  it('`null` → 400 « objet JSON attendu » (et non un TypeError 500)', async () => {
    const r = await postRaw('/v1/pairing/complete', 'null')
    expect(r.status).toBe(400)
    expect(String(r.json['error'])).toContain('objet JSON')
  })

  it('tableau et chaîne → 400', async () => {
    expect((await postRaw('/v1/pairing/complete', '[1]')).status).toBe(400)
    expect((await postRaw('/v1/pairing/complete', '"abc"')).status).toBe(400)
  })
})

describe('erreurs internes journalisées', () => {
  it('une exception non-HTTP → 500 ET console.error avec la route', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // adopt_legacy d'une instance inconnue : le moteur lève une Error brute
      const r = await postRaw('/v1/admin/adopt_legacy', JSON.stringify({ instance: 'fantome' }), daemon.state.admin_token)
      expect(r.status).toBe(500)
      expect(String(r.json['error'])).toContain('instance inconnue')
      expect(error).toHaveBeenCalledOnce()
      const line = String(error.mock.calls[0]?.[0])
      expect(line).toContain('POST /v1/admin/adopt_legacy')
      expect(line).toContain('500')
    } finally {
      error.mockRestore()
    }
  })

  it('une erreur HTTP attendue (401) n’est PAS journalisée comme panne', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await postRaw('/v1/admin/revoke', '{}')
      expect(r.status).toBe(401)
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})

describe('paramètres numériques', () => {
  it('limit=abc / limit=-1 → 400 ; limit=2 → au plus 2 résultats', async () => {
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('claude-code')
    const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
    const agent = new DaemonClient(daemon.state, done.instance_token)
    for (const c of ['alpha', 'beta', 'gamma']) await agent.storeFact({ content: `souvenir ${c} pour le test de limite` })

    const bad = await getAdmin('/v1/admin/facts?limit=abc')
    expect(bad.status).toBe(400)
    expect(String(bad.json['error'])).toContain('limit')
    expect((await getAdmin('/v1/admin/facts?limit=-1')).status).toBe(400)
    expect((await getAdmin('/v1/admin/search?q=souvenir&limit=1.5')).status).toBe(400)
    expect((await getAdmin(`/v1/admin/topics?instance=${paired.assistant_instance_id}&min_facts=x`)).status).toBe(400)

    const ok = await getAdmin('/v1/admin/facts?limit=2')
    expect(ok.status).toBe(200)
    expect((ok.json['facts'] as unknown[]).length).toBe(2)
  })
})

describe('booléens obligatoires', () => {
  it('POST /v1/admin/enabled sans booléen → 400, kill-switch inchangé', async () => {
    expect(daemon.memoria.isEnabled()).toBe(true)
    const r = await postRaw('/v1/admin/enabled', '{}', daemon.state.admin_token)
    expect(r.status).toBe(400)
    expect(String(r.json['error'])).toContain('enabled')
    expect((await postRaw('/v1/admin/enabled', JSON.stringify({ enabled: 'true' }), daemon.state.admin_token)).status).toBe(400)
    expect(daemon.memoria.isEnabled()).toBe(true)

    const off = await postRaw('/v1/admin/enabled', JSON.stringify({ enabled: false }), daemon.state.admin_token)
    expect(off.status).toBe(200)
    expect(daemon.memoria.isEnabled()).toBe(false)
  })
})
