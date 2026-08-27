/**
 * store_fact avec `scope` (partage cross-modèle) : la route relaie le champ tel
 * quel au moteur, et traduit ses refus en codes HTTP parlants — 403 quand la
 * policy interdit l'écriture, 404 quand le scope n'existe pas — au lieu d'un
 * 500 générique que l'agent ne peut pas distinguer d'une panne.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon
let admin: DaemonClient
let agentToken: string
let assistantId: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-store-scope-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
  admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
  agentToken = done.instance_token
  assistantId = daemon.memoria.registry.getInstance(paired.assistant_instance_id)!.assistant_id
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

async function post(path: string, body: unknown, token: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('POST /v1/memory/store_fact avec scope', () => {
  it('scope « user » sans can_write → 403 (policy), puis 200 une fois le droit accordé', async () => {
    // Depuis la lane core (27/08), `user` est inscriptible PAR DÉFAUT pour les
    // assistants (décision produit : les souvenirs doivent circuler). On retire
    // donc le droit explicitement pour tester le refus.
    const userScope = daemon.memoria.registry.getScopeByName('user')!
    const revoked = await post('/v1/admin/policy', { assistant_id: assistantId, scope_id: userScope.id, can_write: false }, daemon.state.admin_token)
    expect(revoked.status).toBe(200)

    const refused = await post('/v1/memory/store_fact', { content: 'Néto préfère les réponses courtes', scope: 'user' }, agentToken)
    expect(refused.status).toBe(403)
    expect(String(refused.json['error'])).toContain('can_write')

    const granted = await post('/v1/admin/policy', { assistant_id: assistantId, scope_id: userScope.id, can_write: true }, daemon.state.admin_token)
    expect(granted.status).toBe(200)

    const ok = await post('/v1/memory/store_fact', { content: 'Néto préfère les réponses courtes', scope: 'user' }, agentToken)
    expect(ok.status).toBe(200)
    expect((ok.json['fact'] as { scope_id: string }).scope_id).toBe(userScope.id)
    // visible dans le scope partagé côté admin
    const shared = daemon.memoria.scopeFacts(userScope.id)
    expect(shared.some(f => f.fact.includes('réponses courtes'))).toBe(true)
  })

  it('scope inconnu → 404 net', async () => {
    const r = await post('/v1/memory/store_fact', { content: 'x', scope: 'scope-fantome' }, agentToken)
    expect(r.status).toBe(404)
    expect(String(r.json['error'])).toContain('scope inconnu')
  })
})
