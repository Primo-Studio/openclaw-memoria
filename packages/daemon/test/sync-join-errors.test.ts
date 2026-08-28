/**
 * POST /v1/admin/sync/join — le cas le plus courant pour un non-technicien
 * (mauvaise IP/port, hub pas démarré, pare-feu) remontait « fetch failed » en
 * 500 avec une stack dans le journal. Attendu : 502 explicite (adresse essayée
 * + piste), 400 pour une adresse mal formée, et un journal SANS stack.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-sync-join-'))
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
})

afterEach(async () => {
  await daemon.close()
  expect(errorSpy).not.toHaveBeenCalled()
  errorSpy.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

/** Un port qui vient d'être libéré : connexion refusée garantie, sans toucher un service réel. */
async function closedPort(): Promise<number> {
  return new Promise(resolve => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

async function join_(body: unknown): Promise<{ status: number; error: string }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}/v1/admin/sync/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.state.admin_token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, error: String(((await res.json()) as { error?: string }).error ?? '') }
}

describe('sync/join — erreurs réseau parlantes', () => {
  it('hub injoignable (port fermé) → 502 avec l’adresse essayée, la cause et la piste', async () => {
    const hub = `127.0.0.1:${await closedPort()}`
    const r = await join_({ hub, code: 'ABCD-EFGH' })
    expect(r.status).toBe(502)
    expect(r.error).toContain(hub)
    expect(r.error).toMatch(/injoignable/)
    expect(r.error).toMatch(/ECONNREFUSED/)
    expect(r.error).toMatch(/init-hub/)
  })

  it('adresse mal formée → 400 « hôte:port attendu »', async () => {
    const r = await join_({ hub: 'pas une adresse', code: 'ABCD-EFGH' })
    expect(r.status).toBe(400)
    expect(r.error).toMatch(/hôte:port/)
  })
})
