/**
 * Contrat « jamais de 500 pour une erreur d'utilisateur » :
 *  - entrée invalide → 400 avec un message qui dit QUOI corriger ;
 *  - identifiant inconnu → 404 ;
 * et rien de tout cela ne finit en stack dans le journal du daemon.
 *
 * Parcours fonctionnel du 27/08 : corps vide / contenu vide / sensibilité hors
 * enum / rôle inconnu / forget sans filtre / ids non-tableau / date d'expiration
 * invalide / scope, assistant, personne, instance, fait inconnus… répondaient
 * tous 500 (TypeError, contrainte SQLite ou Error métier remontée telle quelle)
 * — et l'outil MCP renvoyait le LLM vers « memoria doctor », qui disait OK.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon
let instanceId: string
let assistantId: string
let instanceToken: string
let factId: string
let userScopeId: string
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-validation-'))
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  daemon = await startDaemon({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: null },
    agentsHome: join(root, 'home'), // jamais le vrai HOME (config OpenClaw réelle)
  })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  instanceId = paired.assistant_instance_id
  assistantId = daemon.memoria.registry.getInstance(instanceId)!.assistant_id
  instanceToken = (await new DaemonClient(daemon.state).completePairing(paired.pairing_code)).instance_token
  factId = daemon.memoria.storeFact({ instance: instanceId, content: 'Le studio ferme le vendredi après-midi' }).id
  userScopeId = daemon.memoria.registry.getScopeByName('user')!.id
})

afterEach(async () => {
  await daemon.close()
  // Aucune de ces erreurs n'est une panne : le journal reste vide.
  expect(errorSpy).not.toHaveBeenCalled()
  errorSpy.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

type Reply = { status: number; error: string; json: Record<string, unknown> }

async function post(path: string, body: unknown, token: string): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, error: String(json['error'] ?? ''), json }
}
const agent = (path: string, body: unknown) => post(path, body, instanceToken)
const admin = (path: string, body: unknown) => post(path, body, daemon.state.admin_token)

describe('POST /v1/memory/store_fact — 400 explicites', () => {
  it('corps vide → 400 « content »', async () => {
    const r = await agent('/v1/memory/store_fact', {})
    expect(r.status).toBe(400)
    expect(r.error).toContain('content')
  })
  it('content vide → 400', async () => {
    const r = await agent('/v1/memory/store_fact', { content: '   ' })
    expect(r.status).toBe(400)
    expect(r.error).toContain('content')
  })
  it('sensitivity hors enum → 400 qui liste les valeurs', async () => {
    const r = await agent('/v1/memory/store_fact', { content: 'x', sensitivity: 'secret' })
    expect(r.status).toBe(400)
    expect(r.error).toMatch(/sensitivity.*normal.*sensitive.*critical/)
  })
  it('confidence hors [0,1] ou non numérique → 400', async () => {
    expect((await agent('/v1/memory/store_fact', { content: 'x', confidence: 42 })).status).toBe(400)
    expect((await agent('/v1/memory/store_fact', { content: 'x', confidence: 'haute' })).status).toBe(400)
  })
  it('tags non-tableau de chaînes → 400 ; catégorie/scope non-chaîne → 400', async () => {
    expect((await agent('/v1/memory/store_fact', { content: 'x', tags: 'a' })).status).toBe(400)
    expect((await agent('/v1/memory/store_fact', { content: 'x', tags: [1] })).status).toBe(400)
    expect((await agent('/v1/memory/store_fact', { content: 'x', category: 3 })).status).toBe(400)
    expect((await agent('/v1/memory/store_fact', { content: 'x', scope: {} })).status).toBe(400)
  })
  it('scope inconnu → 404 (inchangé)', async () => {
    expect((await agent('/v1/memory/store_fact', { content: 'x', scope: 'inexistant' })).status).toBe(404)
  })
  it('entrée valide → 200 (le contrat nominal n’a pas bougé)', async () => {
    const r = await agent('/v1/memory/store_fact', { content: 'Néto préfère les réponses courtes', sensitivity: 'sensitive', confidence: 0.9, tags: ['pref'] })
    expect(r.status).toBe(200)
  })
})

describe('POST /v1/memory/capture_turn — messages validés un par un', () => {
  it('rôle inconnu → 400 avec l’index et les rôles attendus', async () => {
    const r = await agent('/v1/memory/capture_turn', { messages: [{ role: 'user', content: 'ok' }, { role: 'system', content: 'x' }] })
    expect(r.status).toBe(400)
    expect(r.error).toMatch(/messages\[1\]\.role.*user\|assistant\|tool/)
  })
  it('rôle absent, content absent ou non-chaîne → 400', async () => {
    expect((await agent('/v1/memory/capture_turn', { messages: [{ content: 'x' }] })).status).toBe(400)
    expect((await agent('/v1/memory/capture_turn', { messages: [{ role: 'user' }] })).status).toBe(400)
    expect((await agent('/v1/memory/capture_turn', { messages: [{ role: 'user', content: 3 }] })).status).toBe(400)
    expect((await agent('/v1/memory/capture_turn', { messages: ['bonjour'] })).status).toBe(400)
  })
})

describe('POST /v1/memory/expiry, /pin, /merge — arguments et identifiants', () => {
  it('date invalide → 400 « ISO 8601 »', async () => {
    const r = await agent('/v1/memory/expiry', { fact_id: factId, expires_at: 'pas-une-date' })
    expect(r.status).toBe(400)
    expect(r.error).toContain('ISO 8601')
  })
  it('date valide → 200 updated:true ; null lève l’expiration', async () => {
    expect((await agent('/v1/memory/expiry', { fact_id: factId, expires_at: '2030-01-01T00:00:00.000Z' })).json).toEqual({ updated: true })
    expect((await agent('/v1/memory/expiry', { fact_id: factId, expires_at: null })).json).toEqual({ updated: true })
  })
  it('fait inconnu → 404 (expiry et pin)', async () => {
    const e = await agent('/v1/memory/expiry', { fact_id: 'inexistant', expires_at: null })
    expect(e.status).toBe(404)
    expect(e.error).toContain('inexistant')
    expect((await agent('/v1/memory/pin', { fact_id: 'inexistant', pinned: true })).status).toBe(404)
  })
  it('merge vers un fait conservé inconnu → 404', async () => {
    const r = await agent('/v1/memory/merge', { keep_fact_id: 'inexistant', merge_fact_ids: [factId] })
    expect(r.status).toBe(404)
    expect(r.error).toContain('inexistant')
  })
})

describe('POST /v1/admin/forget — gardes en 400', () => {
  it('filtre vide → 400', async () => {
    const r = await admin('/v1/admin/forget', {})
    expect(r.status).toBe(400)
    expect(r.error).toContain('filtre vide')
  })
  it('requête sans confirm_bulk → 400 qui nomme confirm_bulk', async () => {
    const r = await admin('/v1/admin/forget', { query: 'vendredi' })
    expect(r.status).toBe(400)
    expect(r.error).toContain('confirm_bulk')
  })
  it('ids non-tableau (ou tableau de non-chaînes) → 400', async () => {
    expect((await admin('/v1/admin/forget', { ids: 'x' })).status).toBe(400)
    expect((await admin('/v1/admin/forget', { ids: [1] })).status).toBe(400)
  })
  it('dry_run / confirm_bulk non booléens → 400', async () => {
    expect((await admin('/v1/admin/forget', { query: 'x', confirm_bulk: 'oui' })).status).toBe(400)
  })
  it('par ids valides → 200 (nominal)', async () => {
    expect((await admin('/v1/admin/forget', { ids: [factId], dry_run: true })).json).toEqual({ deleted: 0, matched: 1 })
  })
})

describe('POST /v1/admin/revoke — plus jamais ok:true pour rien', () => {
  it('sans identifiant → 400', async () => {
    const r = await admin('/v1/admin/revoke', {})
    expect(r.status).toBe(400)
    expect(r.error).toContain('assistant_instance_id')
  })
  it('instance inconnue → 404', async () => {
    expect((await admin('/v1/admin/revoke', { assistant_instance_id: 'inexistant' })).status).toBe(404)
  })
  it('instance connue (alias instance_id accepté) → revoked:true et le token ne passe plus', async () => {
    const r = await admin('/v1/admin/revoke', { instance_id: instanceId })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, revoked: true })
    expect((await agent('/v1/memory/recall', { query: 'vendredi' })).status).toBe(401)
  })
})

describe('routes admin — identifiants inconnus → 404, tableaux → 400', () => {
  it('share : scope cible inconnu → 404 ; fact_ids non-tableau → 400 ; vers un scope privé → 400', async () => {
    const unknown = await admin('/v1/admin/share', { fact_ids: [factId], target_scope: 'inexistant' })
    expect(unknown.status).toBe(404)
    expect(unknown.error).toContain('inexistant')
    expect((await admin('/v1/admin/share', { fact_ids: 'x', target_scope: 'user' })).status).toBe(400)
    expect((await admin('/v1/admin/share', { fact_ids: [factId], target_scope: `private:${instanceId}` })).status).toBe(400)
  })
  it('policy : assistant ou scope inconnu → 404 (plus de FOREIGN KEY en 500)', async () => {
    expect((await admin('/v1/admin/policy', { assistant_id: 'inexistant', scope_id: userScopeId, can_read: true })).status).toBe(404)
    expect((await admin('/v1/admin/policy', { assistant_id: assistantId, scope_id: 'inexistant', can_read: true })).status).toBe(404)
    expect((await admin('/v1/admin/policy', { assistant_id: assistantId, scope_id: userScopeId, can_read: true })).status).toBe(200)
  })
  it('person_identifier : personne inconnue → 404', async () => {
    const r = await admin('/v1/admin/person_identifier', { person_id: 'inexistant', kind: 'phone', value: '+594694000000' })
    expect(r.status).toBe(404)
    expect(r.error).toContain('personne')
  })
  it('adopt_legacy : instance inconnue → 404', async () => {
    expect((await admin('/v1/admin/adopt_legacy', { instance: 'inexistant' })).status).toBe(404)
  })
  it('review/approve et review/reject : ids non-tableau de chaînes → 400', async () => {
    expect((await admin('/v1/admin/review/reject', { ids: 'x' })).status).toBe(400)
    expect((await admin('/v1/admin/review/approve', { ids: [1] })).status).toBe(400)
    expect((await admin('/v1/admin/review/approve', { ids: [] })).json).toEqual({ updated: 0 })
  })
  it('openclaw_copy_key sans clé en clair (cas nominal OAuth / pas d’OpenClaw) → 404, pas 500', async () => {
    const r = await admin('/v1/admin/openclaw_copy_key', { provider: 'openai' })
    expect(r.status).toBe(404)
    expect(r.error).toContain('OpenClaw')
  })
})
