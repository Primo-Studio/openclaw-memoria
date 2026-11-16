/**
 * Synchro d'équipe SUR HTTP RÉEL (deux daemons, vraies sockets, boucle locale) :
 * - après un join par la route admin, la synchro automatique part TOUTE SEULE,
 *   sans redémarrer le daemon du Mac de l'équipe ;
 * - l'état (`sync status`) montre les espaces de chaque pair (org seulement) ;
 * - init-hub refuse de partager `user` ; un départ prévient le hub.
 *
 * Ports libres tirés au hasard : jamais de collision avec une autre exécution.
 * Données FICTIVES uniquement.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startDaemon, type RunningDaemon } from '../src/index.js'

let dir: string
let hub: RunningDaemon
let spoke: RunningDaemon
let lanPort: number
let orgScopeId: string
let hubInstance: string

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

async function admin<T = Record<string, unknown>>(d: RunningDaemon, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${d.state.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${d.state.admin_token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as T }
}

async function until(cond: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-syncteam-'))
  lanPort = await freePort()
  writeFileSync(join(dir, 'hub.toml'), `[sync]\nenabled = true\nrole = "hub"\nlisten_lan = "127.0.0.1:${lanPort}"\nscopes = ["org"]\n`)
  hub = await startDaemon({ storageRoot: join(dir, 'hub'), configPath: join(dir, 'hub.toml'), llm: { extraction: null } })
  spoke = await startDaemon({ storageRoot: join(dir, 'spoke'), configPath: join(dir, 'spoke.toml'), llm: { extraction: null }, syncFirstTickMs: 400 })

  const a = hub.memoria.pairAssistant({ type: 'claude-code', display_name: 'Agent du hub' })
  hubInstance = a.assistant_instance_id
  orgScopeId = hub.memoria.registry.ownOrgScope()!.id
  hub.memoria.setScopeAccess(a.assistant_id, orgScopeId, { can_read: true, can_write: true })
  hub.memoria.storeFact({ instance: hubInstance, scope: orgScopeId, content: 'Essai fictif : process d’étalonnage de l’équipe' })
  hub.memoria.storeFact({ instance: hubInstance, scope: hub.memoria.registry.listScopes().find(s => s.type === 'user')!.id, content: 'Essai fictif : préférence personnelle' })
  await until(async () => (await admin<{ lan_listening: boolean }>(hub, 'GET', '/v1/admin/sync/status')).json.lan_listening)
})

afterEach(async () => {
  await hub.close()
  await spoke.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('synchro d’équipe par les routes admin', () => {
  it('après le join, la synchro automatique part sans redémarrage ; l’état montre org seulement ; le départ prévient le hub', async () => {
    const inv = await admin<{ code: string; hub_lan: string; scopes: string[] }>(hub, 'POST', '/v1/admin/sync/invite', { display_name: 'Mac de l’équipe' })
    expect(inv.status).toBe(200)
    expect(inv.json.hub_lan).toBe(`127.0.0.1:${lanPort}`)
    expect(inv.json.scopes).toEqual(['org'])

    const joined = await admin<{ facts: number; auto_sync: boolean }>(spoke, 'POST', '/v1/admin/sync/join', { hub: inv.json.hub_lan, code: inv.json.code })
    expect(joined.status).toBe(200)
    expect(joined.json.auto_sync).toBe(true)
    // une nouveauté du hub juste après le join : la 1re passe automatique doit la ramener
    hub.memoria.storeFact({ instance: hubInstance, scope: orgScopeId, content: 'Essai fictif : nouveauté écrite après le join' })

    const st = await admin<{ auto: { armed: boolean }; last_sync: unknown }>(spoke, 'GET', '/v1/admin/sync/status')
    expect(st.json.auto.armed).toBe(true)
    expect(await until(async () => (await admin<{ last_sync: unknown }>(spoke, 'GET', '/v1/admin/sync/status')).json.last_sync !== null)).toBe(true)
    const local = spoke.memoria.sharedContentStore(orgScopeId)!
    expect(local.db.prepare('SELECT 1 FROM facts WHERE fact = ?').get('Essai fictif : nouveauté écrite après le join')).toBeTruthy()
    // l'espace user du propriétaire n'est jamais arrivé
    expect(spoke.memoria.registry.getScope(hub.memoria.registry.listScopes().find(s => s.type === 'user')!.id)).toBeNull()

    // côté hub : le pair n'a que org, appairage confirmé
    const hs = await admin<{ scope_types: string[]; peers: Array<{ role: string; pending: boolean; allowed: Array<{ type: string }> }> }>(hub, 'GET', '/v1/admin/sync/status')
    expect(hs.json.scope_types).toEqual(['org'])
    const peer = hs.json.peers.find(p => p.role === 'spoke')!
    expect(peer.allowed.map(a => a.type)).toEqual(['org'])
    expect(peer.pending).toBe(false)

    // départ : le hub est prévenu et coupe ce Mac ; la minuterie s'arrête
    const left = await admin<{ hub_notified: boolean }>(spoke, 'POST', '/v1/admin/sync/leave', {})
    expect(left.json.hub_notified).toBe(true)
    expect((await admin<{ auto: { armed: boolean } }>(spoke, 'GET', '/v1/admin/sync/status')).json.auto.armed).toBe(false)
    expect(hub.memoria.registry.listPeers().filter(p => p.role === 'spoke')).toHaveLength(0)
  })

  it('init-hub refuse de partager user (400) et répond avec les espaces et l’état des clés', async () => {
    const bad = await admin<{ error: string }>(hub, 'POST', '/v1/admin/sync/init_hub', { listen_lan: `127.0.0.1:${lanPort}`, scopes: ['org', 'user'] })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toMatch(/ne se synchronise jamais/)
    const ok = await admin<{ scopes: string[]; keys: string }>(spoke, 'POST', '/v1/admin/sync/init_hub', {})
    expect(ok.status).toBe(200)
    expect(ok.json.scopes).toEqual(['org'])
    expect(ok.json.keys).toBe('new')
    expect(spoke.memoria.resolved.config.sync?.listen_lan).toBe('lan:47600')
  })
})
