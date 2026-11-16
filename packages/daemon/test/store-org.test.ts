/**
 * store_fact vers l'espace d'équipe (`scope: "org"`) par la route du daemon :
 * 403 sans droit d'écriture, 403 pour un agent OpenClaw (même avec le droit
 * posé à la main), 200 avec le droit ; refus d'un fait sensible, d'un secret
 * et d'un fait écrit avec un client déclaré. Le Mac est réglé en `team`
 * (`[sharing] machine`) : Claude Code reçoit le droit à l'appairage.
 * Données fictives uniquement.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon

async function pairToken(type: 'claude-code' | 'codex' | 'openclaw'): Promise<{ token: string; assistantId: string }> {
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair(type)
  const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
  return { token: done.instance_token, assistantId: daemon.memoria.registry.getInstance(paired.assistant_instance_id)!.assistant_id }
}

async function post(path: string, body: unknown, token: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-store-org-'))
  writeFileSync(join(root, 'config.toml'), '[sharing]\nmachine = "team"\n')
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

describe('POST /v1/memory/store_fact avec scope « org »', () => {
  it('Mac d’équipe : Claude Code écrit (200) ; sans le droit → 403 qui nomme l’espace d’équipe', async () => {
    const { token, assistantId } = await pairToken('claude-code')
    const ok = await post('/v1/memory/store_fact', { content: 'Les masters du studio fictif sortent en ProRes 422', scope: 'org' }, token)
    expect(ok.status).toBe(200)
    const org = daemon.memoria.teamScope()!
    expect((ok.json['fact'] as { scope_id: string }).scope_id).toBe(org.id)

    const revoked = await post('/v1/admin/policy', { assistant_id: assistantId, scope_id: org.id, can_write: false }, daemon.state.admin_token)
    expect(revoked.status).toBe(200)
    const refused = await post('/v1/memory/store_fact', { content: 'Les miniatures se font en 1280 x 720', scope: 'org' }, token)
    expect(refused.status).toBe(403)
    expect(String(refused.json['error'])).toMatch(/espace d'équipe \(org\).*can_write/)
  })

  it('OpenClaw : 403, même après un droit d’écriture posé à la main', async () => {
    const { token, assistantId } = await pairToken('openclaw')
    const org = daemon.memoria.teamScope()!
    expect(daemon.memoria.registry.getPolicy(assistantId, org.id)).toBeNull()
    await post('/v1/admin/policy', { assistant_id: assistantId, scope_id: org.id, can_read: true, can_write: true }, daemon.state.admin_token)
    const r = await post('/v1/memory/store_fact', { content: 'Le serveur de rendu redémarre à minuit', scope: 'org' }, token)
    expect(r.status).toBe(403)
    expect(String(r.json['error'])).toContain('OpenClaw')
  })

  it('refuse un fait sensible, un secret et un client déclaré (403), sans rien écrire', async () => {
    const { token } = await pairToken('codex')
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ content: 'Le planning du tournage est partagé', sensitivity: 'sensitive' }, /un fait sensitive/],
      [{ content: 'Le salaire de Zorba passe à 2 100 euros' }, /sujet sensible/],
      [{ content: 'La clé du service de rendu est api_key=Zx9fictif00112233445566' }, /contient un secret/],
      [{ content: 'Le logo se livre en SVG', client_org_id: 'client-fictif' }, /un client est déclaré/],
    ]
    for (const [body, why] of cases) {
      const r = await post('/v1/memory/store_fact', { ...body, scope: 'org' }, token)
      expect(r.status).toBe(403)
      expect(String(r.json['error'])).toMatch(why)
      // Le message ne recopie jamais le contenu refusé.
      expect(String(r.json['error'])).not.toContain(String(body['content']))
    }
    expect(daemon.memoria.scopeFacts(daemon.memoria.teamScope()!.id)).toEqual([])
  })
})
