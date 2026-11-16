/**
 * Synchro d'équipe : ce qui ne doit JAMAIS partir, et ce qui ne doit jamais se
 * perdre. Tout passe par le vrai répartiteur du hub (`handleHttp`, celui du
 * daemon) ; les requêtes « hostiles » sont signées avec les vraies clés d'un
 * pair relié, pour éprouver le contrôle par pair et non l'authentification.
 *
 * Données FICTIVES uniquement (« Essai fictif … »).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Memoria,
  clusterPairingKey,
  contentHash,
  groupVaultKey,
  hubAddressesFor,
  keyFingerprint,
  lanIPv4,
  newNonce,
  normalizeSyncTypes,
  nowISO,
  resolveListenHost,
  setClusterPairingKey,
  setGroupVaultKey,
  signRequest,
  SyncScopeError,
  type FetchLike,
  type SyncHttpResponse,
} from '../src/index.js'

const HUB_ADDR = '10.20.30.40:47600'

let dir: string
const opened: Memoria[] = []

function mk(name: string): Memoria {
  const m = Memoria.init({ storageRoot: join(dir, name), configPath: join(dir, `${name}.toml`), llm: { extraction: null } })
  opened.push(m)
  return m
}

/** Rouvre une machine (redémarrage) sur le même stockage. */
function reopen(m: Memoria, name: string): Memoria {
  m.close()
  opened.splice(opened.indexOf(m), 1)
  return mk(name)
}

/** Le hub derrière le même répartiteur que le daemon. `fail` simule une panne sur une route. */
function hubFetch(hub: Memoria, opts: { fail?: (path: string) => boolean } = {}): FetchLike {
  return async (url, init) => {
    const u = new URL(url)
    if (opts.fail?.(u.pathname)) return { ok: false, status: 503, json: async () => ({ error: 'panne simulée' }) }
    const h = init.headers ?? {}
    const r = hub.sync.handleHttp({
      method: init.method,
      pathWithQuery: u.pathname + u.search,
      body: init.body ?? '',
      bearer: (h['authorization'] ?? '').replace(/^Bearer\s+/, ''),
      sig: h['x-memoria-sig'],
      ts: h['x-memoria-ts'],
      nonce: h['x-memoria-nonce'],
      remoteHost: '10.20.30.41',
    })
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  }
}

/** Requête signée avec les VRAIES clés d'un pair relié (pair d'équipe qui sortirait du rang). */
function asPeer(spoke: Memoria, hub: Memoria, method: 'GET' | 'POST', pathWithQuery: string, body: unknown = undefined): SyncHttpResponse {
  const hubPeer = spoke.registry.listPeers().find(p => p.role === 'hub')!
  const token = spoke.registry.getSetting(`sync.peer_token.${hubPeer.machine_id}`)!
  const payload = body === undefined ? '' : JSON.stringify(body)
  const ts = nowISO()
  const nonce = newNonce()
  const sig = signRequest(clusterPairingKey(spoke.secrets), { method, path: pathWithQuery, body: payload, ts, nonce })
  return hub.sync.handleHttp({ method, pathWithQuery, body: payload, bearer: token, sig, ts, nonce })
}

function orgOf(m: Memoria) {
  return m.registry.ownOrgScope()!
}
function userOf(m: Memoria) {
  return m.registry.listScopes().find(s => s.type === 'user')!
}

/** Comptes seulement (jamais le texte) : faits d'un espace dans sa base partagée. */
function countIn(m: Memoria, scopeId: string, where = '1 = 1'): number {
  const store = m.sharedContentStore(scopeId)
  if (!store) return 0
  return (store.db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE scope_id = ? AND ${where}`).get(scopeId) as { c: number }).c
}

function hasFact(m: Memoria, scopeId: string, content: string): boolean {
  const store = m.sharedContentStore(scopeId)
  if (!store) return false
  return !!store.db.prepare('SELECT 1 FROM facts WHERE scope_id = ? AND fact = ? AND deleted_at IS NULL').get(scopeId, content)
}

/** Hub prêt : rôle hub (écoute locale), un agent qui écrit dans org, un fait org et un fait user fictifs. */
function makeHub(name = 'hub'): { hub: Memoria; agent: { assistant_id: string; assistant_instance_id: string } } {
  const hub = mk(name)
  hub.configureSyncHub('127.0.0.1:47600')
  const agent = hub.pairAssistant({ type: 'claude-code', display_name: 'Agent du hub' })
  hub.setScopeAccess(agent.assistant_id, orgOf(hub).id, { can_read: true, can_write: true })
  hub.storeFact({ instance: agent.assistant_instance_id, scope: orgOf(hub).id, content: 'Essai fictif : process d’export vidéo en H.265 pour l’équipe' })
  hub.storeFact({ instance: agent.assistant_instance_id, scope: userOf(hub).id, content: 'Essai fictif : préférence personnelle du propriétaire' })
  return { hub, agent }
}

async function joinTo(spoke: Memoria, hub: Memoria, fetchImpl: FetchLike = hubFetch(hub), scopes?: string[]) {
  const inv = hub.sync.invite('Mac de l’équipe', scopes)
  return spoke.sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-sync-iso-'))
})

afterEach(() => {
  for (const m of opened.splice(0)) m.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('espaces partagés par défaut', () => {
  it('invitation par défaut = org seulement, et l’espace user du Mac d’équipe n’est pas rebranché', async () => {
    const { hub } = makeHub()
    const spoke = mk('spoke')
    // le Mac de l'équipe a déjà un agent et un souvenir dans SON espace user
    const a = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent du collègue' })
    const spokeUserBefore = userOf(spoke).id
    spoke.storeFact({ instance: a.assistant_instance_id, scope: spokeUserBefore, content: 'Essai fictif : note personnelle du collègue' })

    const inv = hub.sync.invite()
    expect(inv.scopes).toEqual(['org'])
    await spoke.sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl: hubFetch(hub) })

    // côté hub : le pair n'a que l'espace org
    const peer = hub.sync.peers().find(p => p.role === 'spoke')!
    expect(peer.allowed.map(x => x.type)).toEqual(['org'])
    expect(peer.allowed_scopes).toEqual([orgOf(hub).id])
    // côté spoke : son user garde son identité, ne reçoit rien du propriétaire
    expect(userOf(spoke).id).toBe(spokeUserBefore)
    expect(userOf(spoke).id).not.toBe(userOf(hub).id)
    expect(spoke.registry.getScope(userOf(hub).id)).toBeNull()
    expect(countIn(spoke, spokeUserBefore)).toBe(1)
    expect(hasFact(spoke, spokeUserBefore, 'Essai fictif : préférence personnelle du propriétaire')).toBe(false)
    // org reçu
    expect(orgOf(spoke).id).toBe(orgOf(hub).id)
    expect(hasFact(spoke, orgOf(hub).id, 'Essai fictif : process d’export vidéo en H.265 pour l’équipe')).toBe(true)

    // et le user du collègue ne remonte jamais vers le hub
    await spoke.sync.syncAll(hubFetch(hub))
    expect(countIn(hub, userOf(hub).id)).toBe(1)
  })

  it('la liste des espaces refuse user, privé et quarantaine ; org par défaut', () => {
    expect(normalizeSyncTypes(undefined)).toEqual(['org'])
    expect(normalizeSyncTypes('org,project')).toEqual(['org', 'project'])
    for (const t of ['user', 'private', 'legacy_to_review']) expect(() => normalizeSyncTypes([t])).toThrow(SyncScopeError)
    expect(() => normalizeSyncTypes(['client'])).toThrow(SyncScopeError)
    const hub = mk('hub')
    expect(() => hub.configureSyncHub('127.0.0.1:47600', ['org', 'user'])).toThrow(SyncScopeError)
    hub.configureSyncHub('127.0.0.1:47600')
    expect(() => hub.sync.invite(undefined, ['project'])).toThrow(/ne synchronise pas/)
  })
})

describe('contrôle par pair côté hub', () => {
  it('pair limité à org : 403 sur user (et privé, inconnu) en snapshot, pull, push et secrets', async () => {
    const { hub, agent } = makeHub()
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const userId = userOf(hub).id
    const privateId = hub.registry.getScopeByName(`private:${agent.assistant_instance_id}`)!.id
    for (const id of [userId, privateId, 'inconnu-0000']) {
      const q = encodeURIComponent(id)
      expect(asPeer(spoke, hub, 'GET', `/v1/sync/snapshot?scope=${q}&since=0`).status).toBe(403)
      expect(asPeer(spoke, hub, 'GET', `/v1/sync/pull?scope=${q}&since=0`).status).toBe(403)
      expect(asPeer(spoke, hub, 'GET', `/v1/sync/secrets?scope=${q}`).status).toBe(403)
      expect(asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: id, facts: [], tombstones: [] }).status).toBe(403)
    }
    // org reste servi
    expect(asPeer(spoke, hub, 'GET', `/v1/sync/pull?scope=${encodeURIComponent(orgOf(hub).id)}&since=0`).status).toBe(200)

    // même un pair dont la liste contient user (appairage d'avant) n'y accède pas
    hub.registry.db.prepare('UPDATE sync_peers SET allowed_scopes = ? WHERE role = ?').run(JSON.stringify([orgOf(hub).id, userId]), 'spoke')
    expect(asPeer(spoke, hub, 'GET', `/v1/sync/pull?scope=${encodeURIComponent(userId)}&since=0`).status).toBe(403)
    // et un hub qui ne synchronise plus un type le coupe aussi aux pairs déjà reliés
    ;(hub.resolved.config.sync as { scopes?: string[] }).scopes = ['project']
    expect(asPeer(spoke, hub, 'GET', `/v1/sync/pull?scope=${encodeURIComponent(orgOf(hub).id)}&since=0`).status).toBe(403)
  })

  it('un envoi dont un fait déclare un autre espace que la route est refusé', async () => {
    const { hub } = makeHub()
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const machine = spoke.sync.machineId
    const now = nowISO()
    const sneaky = {
      id: 'fictif-0001', fact: 'Essai fictif : fait glissé dans un autre espace', category: 'general', fact_type: 'statement',
      confidence: 0.8, source: 'sync', scope_id: userOf(hub).id, sensitivity: 'normal', visibility: 'shared', tags: '[]',
      entity_ids: '[]', lifecycle_state: 'active', superseded: 0, superseded_by: null, origin_machine_id: machine,
      origin_rev: 1, content_hash: null, deleted_at: null, created_at: now, updated_at: now,
    }
    const r = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgOf(hub).id, facts: [sneaky], tombstones: [] })
    expect(r.status).toBe(200)
    const body = r.body as { applied: number; refused: { scope: number } }
    expect(body.applied).toBe(0)
    expect(body.refused.scope).toBe(1)
    expect(countIn(hub, userOf(hub).id)).toBe(1)
    expect(countIn(hub, orgOf(hub).id, "id = 'fictif-0001'")).toBe(0)
  })

  it('un pair ne peut ni écraser ni supprimer un fait né sur une autre machine ; ses propres faits, oui', async () => {
    const { hub } = makeHub()
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const orgId = orgOf(hub).id
    const hubStore = hub.sharedContentStore(orgId)!
    const owned = hubStore.db.prepare('SELECT * FROM facts WHERE scope_id = ? LIMIT 1').get(orgId) as Record<string, unknown>
    const forged = { ...owned, fact: 'Essai fictif : texte remplacé par un pair', origin_rev: Number(owned['origin_rev']) + 10, updated_at: nowISO() }

    // écrasement : refusé, que le pair garde l'origine du hub ou se l'attribue
    for (const origin of [owned['origin_machine_id'], spoke.sync.machineId]) {
      const r = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgId, facts: [{ ...forged, origin_machine_id: origin }], tombstones: [] })
      expect((r.body as { refused: { not_owner: number } }).refused.not_owner).toBe(1)
    }
    // suppression : refusée
    const tomb = { id: owned['id'], deleted_at: nowISO(), origin_machine_id: spoke.sync.machineId, origin_rev: Number(owned['origin_rev']) + 10, updated_at: nowISO() }
    const rt = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgId, facts: [], tombstones: [tomb] })
    expect((rt.body as { refused: { not_owner: number } }).refused.not_owner).toBe(1)
    const after = hubStore.db.prepare('SELECT fact, deleted_at FROM facts WHERE id = ?').get(owned['id']) as { fact: string; deleted_at: string | null }
    expect(after.fact).toBe(owned['fact'])
    expect(after.deleted_at).toBeNull()

    // l'écho tel quel (le pair renvoie ce qu'il a reçu) n'est pas un refus
    const echo = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgId, facts: [owned], tombstones: [] })
    expect((echo.body as { refused: { not_owner: number }; skipped_lww: number }).refused.not_owner).toBe(0)

    // ses propres faits : créés puis corrigés par lui, acceptés
    const a = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent du collègue' })
    spoke.setScopeAccess(a.assistant_id, orgId, { can_read: true, can_write: true })
    const mine = spoke.storeFact({ instance: a.assistant_instance_id, scope: orgId, content: 'Essai fictif : leçon d’équipe sur les sous-titres' })
    expect((await spoke.sync.push(orgId, hubFetch(hub))).applied).toBe(1)
    const row = spoke.sharedContentStore(orgId)!.db.prepare('SELECT * FROM facts WHERE id = ?').get(mine.id) as Record<string, unknown>
    const fix = { ...row, fact: 'Essai fictif : leçon d’équipe sur les sous-titres (corrigée)', origin_rev: Number(row['origin_rev']) + 1, updated_at: nowISO() }
    const rf = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgId, facts: [fix], tombstones: [] })
    expect((rf.body as { applied: number }).applied).toBe(1)
  })
})

describe('ce qui ne part jamais', () => {
  it('faits critical et dormants jamais envoyés ; fait marqué d’un client non synchronisé ; expiration transportée', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const store = hub.sharedContentStore(orgId)!
    const prov = (n: number) => ({ origin_machine_id: hub.sync.machineId, origin_rev: 1000 + n })
    store.insertFact({ fact: 'Essai fictif : fait critical', scope_id: orgId, sensitivity: 'critical', ...prov(1) })
    store.insertFact({ fact: 'Essai fictif : fait en revue', scope_id: orgId, lifecycle_state: 'dormant', ...prov(2) })
    store.insertFact({ fact: 'Essai fictif : fait d’un client', scope_id: orgId, client_org_id: 'client-fictif', ...prov(3) })
    const temp = store.insertFact({ fact: 'Essai fictif : consigne temporaire', scope_id: orgId, ...prov(4) })
    store.db.prepare('UPDATE facts SET expires_at = ? WHERE id = ?').run('2031-01-01T00:00:00.000Z', temp.id)

    // à l'envoi même : ni critical, ni dormant, ni client sur le réseau (le refus à l'arrivée n'est qu'une seconde couche)
    expect(hub.sync.collectDelta(orgId, '0').facts.map(f => f.fact).sort()).toEqual(
      ['Essai fictif : consigne temporaire', 'Essai fictif : process d’export vidéo en H.265 pour l’équipe'].sort(),
    )
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    expect(hasFact(spoke, orgId, 'Essai fictif : fait critical')).toBe(false)
    expect(hasFact(spoke, orgId, 'Essai fictif : fait en revue')).toBe(false)
    expect(hasFact(spoke, orgId, 'Essai fictif : fait d’un client')).toBe(false)
    const got = spoke.sharedContentStore(orgId)!.db.prepare('SELECT expires_at FROM facts WHERE id = ?').get(temp.id) as { expires_at: string | null }
    expect(got.expires_at).toBe('2031-01-01T00:00:00.000Z')

    // même chose dans l'autre sens : le spoke n'envoie ni critical, ni dormant, ni client
    const s = spoke.sharedContentStore(orgId)!
    const sp = (n: number) => ({ origin_machine_id: spoke.sync.machineId, origin_rev: 2000 + n })
    s.insertFact({ fact: 'Essai fictif : critical du collègue', scope_id: orgId, sensitivity: 'critical', ...sp(1) })
    s.insertFact({ fact: 'Essai fictif : dormant du collègue', scope_id: orgId, lifecycle_state: 'dormant', ...sp(2) })
    s.insertFact({ fact: 'Essai fictif : client du collègue', scope_id: orgId, client_org_id: 'client-fictif', ...sp(3) })
    const before = countIn(hub, orgId)
    await spoke.sync.syncAll(hubFetch(hub))
    expect(countIn(hub, orgId)).toBe(before)

    // et un pair qui forcerait l'envoi d'un critical est refusé
    const crit = s.db.prepare("SELECT * FROM facts WHERE sensitivity = 'critical' LIMIT 1").get() as Record<string, unknown>
    const r = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgId, facts: [crit], tombstones: [] })
    expect((r.body as { refused: { critical: number } }).refused.critical).toBe(1)
  })
})

/** Fait au format du réseau, prêt à être poussé par un pair (données fictives). */
function wireFact(scopeId: string, origin: string, id: string, fact: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowISO()
  return {
    id, fact, category: 'general', fact_type: 'statement', confidence: 0.8, source: 'sync', scope_id: scopeId,
    sensitivity: 'normal', visibility: 'shared', tags: '[]', entity_ids: '[]', lifecycle_state: 'active', superseded: 0,
    superseded_by: null, origin_machine_id: origin, origin_rev: 1, content_hash: null, deleted_at: null, created_at: now, updated_at: now,
    ...extra,
  }
}

const SALARY = 'Essai fictif : le salaire du monteur passe à 2 100 euros'
const SECRET = 'Essai fictif : la clé du service de rendu est api_key=Zx9fictif00112233445566'
const SECRET_REFERENCE = 'Essai fictif : le service de rendu utilise [secret:generic-token-1]'

describe('sensible et secrets : ni envoyés, ni acceptés (hub et Mac relié)', () => {
  it('le hub ne sert ni un fait sensitive, ni un sujet sensible, ni un secret', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const store = hub.sharedContentStore(orgId)!
    const prov = (n: number) => ({ origin_machine_id: hub.sync.machineId, origin_rev: 3000 + n })
    store.insertFact({ fact: 'Essai fictif : planning du tournage', scope_id: orgId, sensitivity: 'sensitive', ...prov(1) })
    store.insertFact({ fact: SALARY, scope_id: orgId, ...prov(2) })
    store.insertFact({ fact: SECRET, scope_id: orgId, ...prov(3) })
    store.insertFact({ fact: SECRET_REFERENCE, scope_id: orgId, ...prov(4) })
    // à l'envoi même (pas seulement au refus de l'arrivée) : rien de tout cela ne part sur le réseau
    const served = hub.sync.collectDelta(orgId, '0').facts.map(f => f.fact)
    expect(served).toEqual(['Essai fictif : process d’export vidéo en H.265 pour l’équipe'])
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    for (const c of ['Essai fictif : planning du tournage', SALARY, SECRET, SECRET_REFERENCE]) expect(hasFact(spoke, orgId, c)).toBe(false)
    // le fait ordinaire du hub, lui, est arrivé
    expect(countIn(spoke, orgId)).toBe(1)
    // le Mac relié n'envoie pas non plus les siens
    const s = spoke.sharedContentStore(orgId)!
    const sp = (n: number) => ({ origin_machine_id: spoke.sync.machineId, origin_rev: 4000 + n })
    s.insertFact({ fact: 'Essai fictif : planning du collègue', scope_id: orgId, sensitivity: 'sensitive', ...sp(1) })
    s.insertFact({ fact: SALARY + ' (collègue)', scope_id: orgId, ...sp(2) })
    s.insertFact({ fact: SECRET + ' (collègue)', scope_id: orgId, ...sp(3) })
    expect(spoke.sync.collectDelta(orgId, '0', { originOnly: spoke.sync.machineId }).facts).toEqual([])
    const before = countIn(hub, orgId)
    const r = await spoke.sync.syncAll(hubFetch(hub))
    expect(r.pushed).toBe(0)
    expect(countIn(hub, orgId)).toBe(before)
  })

  it('le hub refuse d’un pair un fait sensitive, un sujet sensible, un secret ou un dormant ; rien au coffre', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const vaulted = vi.spyOn(hub.secrets, 'set')
    const me = spoke.sync.machineId
    const facts = [
      wireFact(orgId, me, 'fictif-s1', 'Essai fictif : planning du collègue', { sensitivity: 'sensitive' }),
      wireFact(orgId, me, 'fictif-s2', SALARY),
      wireFact(orgId, me, 'fictif-s3', SECRET),
      wireFact(orgId, me, 'fictif-s4', SECRET_REFERENCE),
      wireFact(orgId, me, 'fictif-s5', 'Essai fictif : fait en attente de revue', { lifecycle_state: 'dormant' }),
      wireFact(orgId, me, 'fictif-s6', 'Essai fictif : fait archivé', { lifecycle_state: 'archived' }),
      wireFact(orgId, me, 'fictif-s7', 'Essai fictif : fait d’un client', { client_org_id: 'client-fictif' }),
    ]
    const before = countIn(hub, orgId)
    const r = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgId, facts, tombstones: [] })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ applied: 0, refused: { sensitive: 2, secret: 2, dormant: 2, client: 1, not_owner: 0 } })
    expect(countIn(hub, orgId)).toBe(before)
    expect(vaulted).not.toHaveBeenCalled()
    // témoin : un fait ordinaire du même pair passe
    const ok = asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: orgId, facts: [wireFact(orgId, me, 'fictif-s8', 'Essai fictif : leçon sur les sous-titres')], tombstones: [] })
    expect((ok.body as { applied: number }).applied).toBe(1)
  })

  it('le Mac relié écarte aussi ce qu’un hub d’avant lui servirait, et le compte', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const origin = hub.sync.machineId
    const forged = [
      wireFact(orgId, origin, 'fictif-h1', 'Essai fictif : planning du hub', { sensitivity: 'sensitive' }),
      wireFact(orgId, origin, 'fictif-h2', SALARY),
      wireFact(orgId, origin, 'fictif-h3', SECRET),
      wireFact(orgId, origin, 'fictif-h4', 'Essai fictif : dormant du hub', { lifecycle_state: 'dormant' }),
    ]
    // un hub sur un ancien code (ou modifié) glisserait ces faits dans sa réponse
    const inner = hubFetch(hub)
    const oldHub: FetchLike = async (url, init) => {
      const res = await inner(url, init)
      if (!new URL(url).pathname.endsWith('/pull')) return res
      const body = (await res.json()) as { facts: unknown[] }
      return { ...res, json: async () => ({ ...body, facts: [...body.facts, ...forged] }) }
    }
    const vaulted = vi.spyOn(spoke.secrets, 'set')
    const r = await spoke.sync.syncAll(oldHub)
    expect(r.refused_received).toBe(4)
    for (const id of ['fictif-h1', 'fictif-h2', 'fictif-h3', 'fictif-h4']) expect(countIn(spoke, orgId, `id = '${id}'`)).toBe(0)
    expect(vaulted).not.toHaveBeenCalled()
    expect(spoke.sync.lastRunStatus()).toMatchObject({ refused_received: 4 })
  })
})

describe('Mac relié : un fait né ailleurs ne se modifie pas ici', () => {
  it('corriger, dater ou fusionner un fait du hub : refus explicite, rien ne diverge ; ses propres faits partent corrigés', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const a = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent du collègue' })
    spoke.setScopeAccess(a.assistant_id, orgId, { can_read: true, can_write: true })
    const inst = a.assistant_instance_id
    const local = spoke.sharedContentStore(orgId)!
    const fromHub = (local.db.prepare('SELECT id FROM facts WHERE scope_id = ? LIMIT 1').get(orgId) as { id: string }).id
    const refusal = /^écriture refusée dans l'espace d'équipe \(org\) : ce fait vient d'un autre Mac/
    expect(() => spoke.correctFact(inst, fromHub, 'Essai fictif : process d’export vidéo en H.264 pour l’équipe')).toThrow(refusal)
    expect(() => spoke.setExpiry(inst, fromHub, '2031-01-01T00:00:00.000Z')).toThrow(refusal)
    const mine = spoke.storeFact({ instance: inst, scope: orgId, content: 'Essai fictif : leçon d’équipe sur les sous-titres' })
    expect(() => spoke.mergeFacts(inst, mine.id, [fromHub])).toThrow(refusal)
    // rien n'a bougé ici : pas de version locale qui divergerait du hub
    expect(local.db.prepare('SELECT superseded, expires_at FROM facts WHERE id = ?').get(fromHub)).toEqual({ superseded: 0, expires_at: null })
    expect(countIn(spoke, orgId)).toBe(2)
    // épingler reste permis (préférence locale)
    expect(spoke.setPinned(inst, fromHub, true)).toBe(true)

    // ses propres faits : la correction et l'expiration arrivent au hub
    await spoke.sync.syncAll(hubFetch(hub))
    const fixed = spoke.correctFact(inst, mine.id, 'Essai fictif : leçon d’équipe sur les sous-titres, corrigée').replacement!
    expect(spoke.setExpiry(inst, fixed.id, '2033-01-01T00:00:00.000Z')).toBe(true)
    const r = await spoke.sync.syncAll(hubFetch(hub))
    expect(r).toMatchObject({ refused: 0, errors: [] })
    const onHub = hub.sharedContentStore(orgId)!.db.prepare('SELECT id, superseded, expires_at FROM facts WHERE id IN (?, ?) ORDER BY superseded').all(fixed.id, mine.id)
    expect(onHub).toEqual([
      { id: fixed.id, superseded: 0, expires_at: '2033-01-01T00:00:00.000Z' },
      { id: mine.id, superseded: 1, expires_at: null },
    ])

    // après « leave », plus rien ne se synchronise : le Mac modifie librement sa copie
    await spoke.sync.leave(hubFetch(hub))
    expect(spoke.setExpiry(inst, fromHub, '2031-01-01T00:00:00.000Z')).toBe(true)
  })
})

describe('hub : le propriétaire modère un fait né chez un collègue', () => {
  it('corriger puis dater sur le hub un fait né sur le Mac relié : le Mac relié reçoit les deux, sans renvoi', async () => {
    const { hub, agent } = makeHub()
    const orgId = orgOf(hub).id
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const a = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent du collègue' })
    spoke.setScopeAccess(a.assistant_id, orgId, { can_read: true, can_write: true })
    const theirs = spoke.storeFact({ instance: a.assistant_instance_id, scope: orgId, content: 'Essai fictif : les rushes se rangent par date de tournage' })
    await spoke.sync.syncAll(hubFetch(hub))
    const hubStore = hub.sharedContentStore(orgId)!
    expect(hubStore.db.prepare('SELECT superseded FROM facts WHERE id = ?').get(theirs.id)).toEqual({ superseded: 0 })

    // sur le hub, l'agent du propriétaire corrige le fait du collègue, puis date la version corrigée
    const fixed = hub.correctFact(agent.assistant_instance_id, theirs.id, 'Essai fictif : les rushes se rangent par projet puis par date').replacement!
    expect(hub.setExpiry(agent.assistant_instance_id, fixed.id, '2034-01-01T00:00:00.000Z')).toBe(true)

    const r = await spoke.sync.syncAll(hubFetch(hub))
    expect(r.errors).toEqual([])
    const spokeStore = spoke.sharedContentStore(orgId)!
    const rows = spokeStore.db.prepare('SELECT id, superseded, expires_at FROM facts WHERE id IN (?, ?) ORDER BY superseded').all(fixed.id, theirs.id)
    expect(rows).toEqual([
      { id: fixed.id, superseded: 0, expires_at: '2034-01-01T00:00:00.000Z' },
      { id: theirs.id, superseded: 1, expires_at: null },
    ])
    // une passe de plus : rien ne fait l'aller-retour, le hub garde sa version
    const again = await spoke.sync.syncAll(hubFetch(hub))
    expect(again).toMatchObject({ pulled: 0, refused: 0, errors: [] })
    expect(hubStore.db.prepare('SELECT superseded FROM facts WHERE id = ?').get(theirs.id)).toEqual({ superseded: 1 })
  })
})

describe('identité d’un Mac relié', () => {
  it('un Mac invité ne reprend pas l’identifiant d’un Mac déjà relié ; un Mac coupé peut revenir (journalisé)', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const b = mk('mac-b')
    await joinTo(b, hub)
    const ab = b.pairAssistant({ type: 'claude-code', display_name: 'Agent de B' })
    b.setScopeAccess(ab.assistant_id, orgId, { can_read: true, can_write: true })
    b.storeFact({ instance: ab.assistant_instance_id, scope: orgId, content: 'Essai fictif : fait du Mac B' })
    await b.sync.syncAll(hubFetch(hub))

    // C se déclare sous l'identifiant de B, avec une invitation valide
    const c = mk('mac-c')
    c.registry.setSetting('sync.machine_id', b.sync.machineId)
    await expect(joinTo(c, hub)).rejects.toThrow(/pairing refusé par le hub \(400\)/)
    const spokes = hub.registry.listPeers().filter(p => p.role === 'spoke')
    expect(spokes).toHaveLength(1)
    expect(spokes[0]!.display_name).toBe('Mac de l’équipe')
    const why = hub.registry.db.prepare("SELECT reason FROM audit_log WHERE action = 'sync_pairing_refused' ORDER BY rowid DESC LIMIT 1").get() as { reason: string }
    expect(why.reason).toMatch(/déjà relié/)
    // B n'a rien perdu : sa synchro marche encore
    expect((await b.sync.syncAll(hubFetch(hub))).errors).toEqual([])

    // B coupé par le propriétaire : son identifiant se reprend, et c'est journalisé
    hub.registry.revokePeer(b.sync.machineId)
    await joinTo(c, hub)
    expect(hub.registry.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sync_peer_replaced'").get()).toEqual({ n: 1 })
  })

  it('le nom donné à l’invitation l’emporte sur celui que le Mac invité annonce', async () => {
    const { hub } = makeHub()
    const named = mk('mac-nomme')
    await joinTo(named, hub)
    const anonymous = mk('mac-anonyme')
    const inv = hub.sync.invite()
    await anonymous.sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl: hubFetch(hub) })
    const names = Object.fromEntries(hub.registry.listPeers().filter(p => p.role === 'spoke').map(p => [p.machine_id, p.display_name]))
    expect(names[named.sync.machineId]).toBe('Mac de l’équipe')
    // sans nom à l'invitation : l'identifiant du Mac
    expect(names[anonymous.sync.machineId]).toBe(anonymous.sync.machineId)
  })
})

describe('join sur un Mac qui a déjà des agents et des souvenirs', () => {
  it('réussit sans perte de faits ni de politiques, un seul org, et ses faits d’équipe partent au hub', async () => {
    const { hub } = makeHub()
    const spoke = mk('spoke')
    const a = spoke.pairAssistant({ type: 'codex', display_name: 'Agent du collègue' })
    const localOrg = orgOf(spoke)
    spoke.setScopeAccess(a.assistant_id, localOrg.id, { can_read: true, can_write: true })
    spoke.storeFact({ instance: a.assistant_instance_id, scope: localOrg.id, content: 'Essai fictif : process de publication sur le store' })
    spoke.storeFact({ instance: a.assistant_instance_id, scope: localOrg.id, content: 'Essai fictif : check-list de montage' })
    spoke.storeFact({ instance: a.assistant_instance_id, content: 'Essai fictif : note privée de l’agent' })
    // un fait partagé sans provenance (comme après un partage depuis la mémoire privée)
    spoke.sharedContentStore(localOrg.id)!.insertFact({ fact: 'Essai fictif : savoir partagé sans provenance', scope_id: localOrg.id })
    const policiesBefore = (spoke.registry.db.prepare('SELECT COUNT(*) AS c FROM assistant_scope_policy').get() as { c: number }).c

    await joinTo(spoke, hub)

    const newOrg = orgOf(spoke)
    expect(newOrg.id).toBe(orgOf(hub).id)
    expect(newOrg.name).toBe(localOrg.name) // nom et organisation locaux gardés
    expect(spoke.registry.getScope(localOrg.id)).toBeNull()
    expect(spoke.registry.listScopes().filter(s => s.type === 'org')).toHaveLength(1)
    // politiques : même nombre, la politique org suit le nouvel id
    expect((spoke.registry.db.prepare('SELECT COUNT(*) AS c FROM assistant_scope_policy').get() as { c: number }).c).toBe(policiesBefore)
    expect(spoke.registry.getPolicy(a.assistant_id, newOrg.id)?.can_write).toBe(true)
    expect(spoke.registry.getPolicy(a.assistant_id, localOrg.id)).toBeNull()
    expect(spoke.registry.dbForScope(newOrg.id)).not.toBeNull()
    // faits : les 3 locaux + celui du hub, tous sous le nouvel id
    expect(countIn(spoke, newOrg.id)).toBe(4)
    expect(countIn(spoke, localOrg.id)).toBe(0)
    // l'agent les rappelle toujours
    const rec = spoke.recall({ instance: a.assistant_instance_id, query: 'Essai fictif publication store' })
    expect(rec.items.some(i => i.content === 'Essai fictif : process de publication sur le store')).toBe(true)

    // ses faits d'équipe partent au hub (même celui sans provenance)
    await spoke.sync.syncAll(hubFetch(hub))
    for (const c of ['Essai fictif : process de publication sur le store', 'Essai fictif : check-list de montage', 'Essai fictif : savoir partagé sans provenance']) {
      expect(hasFact(hub, newOrg.id, c)).toBe(true)
    }
    const origin = hub.sharedContentStore(newOrg.id)!.db.prepare('SELECT origin_machine_id AS o FROM facts WHERE fact = ?').get('Essai fictif : savoir partagé sans provenance') as { o: string }
    expect(origin.o).toBe(spoke.sync.machineId)
    // et un agent du hub qui lit org les retrouve
    const hubReader = hub.pairAssistant({ type: 'claude-code', display_name: 'Lecteur du hub' })
    hub.setScopeAccess(hubReader.assistant_id, newOrg.id, { can_read: true })
    const hubRec = hub.recall({ instance: hubReader.assistant_instance_id, query: 'Essai fictif check-list montage' })
    expect(hubRec.items.some(i => i.content === 'Essai fictif : check-list de montage')).toBe(true)
  })

  it('arrêt brutal entre les deux transactions du premier join : réparé au démarrage, même sans [sync]', () => {
    let spoke = mk('spoke')
    const a = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent du collègue' })
    const org = orgOf(spoke)
    spoke.setScopeAccess(a.assistant_id, org.id, { can_read: true, can_write: true })
    spoke.storeFact({ instance: a.assistant_instance_id, scope: org.id, content: 'Essai fictif : process de publication sur le store' })
    // ce que laisse un arrêt au mauvais moment : marque posée, contenu déplacé, registre intact
    spoke.registry.setSetting('sync.scope_move', JSON.stringify({ from: org.id, to: 'org-du-hub-fictif', at: nowISO() }))
    ;(spoke as unknown as { moveScopeContent: (from: unknown, to: string) => void }).moveScopeContent(org, 'org-du-hub-fictif')
    expect(countIn(spoke, org.id)).toBe(0)
    spoke = reopen(spoke, 'spoke')
    expect(spoke.resolved.config.sync?.enabled).toBeUndefined()
    expect(spoke.registry.getSetting('sync.scope_move')).toBeNull()
    expect(countIn(spoke, org.id)).toBe(1)
    expect(spoke.recall({ instance: a.assistant_instance_id, query: 'publication store' }).items).toHaveLength(1)
  })

  it('un seul org après redémarrage (et après une nouvelle connexion d’agent)', async () => {
    const { hub } = makeHub()
    let spoke = mk('spoke')
    spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent du collègue' })
    await joinTo(spoke, hub)
    const hubOrg = orgOf(hub).id
    spoke = reopen(spoke, 'spoke')
    spoke.pairAssistant({ type: 'codex', display_name: 'Autre agent du collègue' })
    const orgs = spoke.registry.listScopes().filter(s => s.type === 'org')
    expect(orgs).toHaveLength(1)
    expect(orgs[0]!.id).toBe(hubOrg)
  })

  it('un join raté laisse le Mac propre, coupe le pair côté hub, et se relance avec le même code', async () => {
    const { hub } = makeHub()
    const spoke = mk('spoke')
    const keysBefore = { gvk: spoke.secrets.get('__group_vault_key'), cpk: spoke.secrets.get('__cluster_pairing_key') }
    const inv = hub.sync.invite('Mac de l’équipe')

    // panne pendant le bootstrap (secrets)
    let failing = true
    const flaky = hubFetch(hub, { fail: p => failing && p === '/v1/sync/secrets' })
    await expect(spoke.sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl: flaky })).rejects.toThrow(/503/)

    // Mac propre : pas de hub, pas de jeton, clés et config comme avant
    expect(spoke.registry.listPeers(true)).toHaveLength(0)
    expect(spoke.registry.db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'sync.peer_token.%'").get()).toEqual({ c: 0 })
    expect(spoke.secrets.get('__group_vault_key')).toBe(keysBefore.gvk)
    expect(spoke.secrets.get('__cluster_pairing_key')).toBe(keysBefore.cpk)
    expect(spoke.resolved.config.sync?.enabled).not.toBe(true)
    // hub : aucun pair à moitié actif
    expect(hub.registry.listPeers().filter(p => p.role === 'spoke')).toHaveLength(0)

    // relance avec le même code
    failing = false
    const r = await spoke.sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl: flaky })
    expect(r.scopes).toBe(1)
    // (les faits d'équipe reçus avant la panne étaient restés : la relance ne les double pas)
    expect(hasFact(spoke, orgOf(hub).id, 'Essai fictif : process d’export vidéo en H.265 pour l’équipe')).toBe(true)
    expect(countIn(spoke, orgOf(hub).id)).toBe(1)
    const peers = hub.sync.peers().filter(p => p.role === 'spoke')
    expect(peers).toHaveLength(1)
    expect(peers[0]!.pending).toBe(false)
    // code consommé après confirmation
    await expect(mk('autre').sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl: hubFetch(hub) })).rejects.toThrow(/pairing refusé/)
  })

  it('relier le Mac à un nouveau hub sans « leave » : un seul hub actif, la synchro parle au nouveau', async () => {
    const { hub: hub1 } = makeHub('hub1')
    const { hub: hub2, agent: agent2 } = makeHub('hub2')
    const spoke = mk('spoke')
    await joinTo(spoke, hub1)
    await joinTo(spoke, hub2, hubFetch(hub2))
    const hubs = spoke.registry.listPeers().filter(p => p.role === 'hub')
    expect(hubs).toHaveLength(1)
    expect(orgOf(spoke).id).toBe(orgOf(hub2).id)
    expect(spoke.registry.listScopes().filter(s => s.type === 'org')).toHaveLength(1)
    hub2.storeFact({ instance: agent2.assistant_instance_id, scope: orgOf(hub2).id, content: 'Essai fictif : nouveauté du second hub' })
    const r = await spoke.sync.syncAll(hubFetch(hub2))
    expect(r.errors).toEqual([])
    expect(hasFact(spoke, orgOf(hub2).id, 'Essai fictif : nouveauté du second hub')).toBe(true)
  })

  it('un appairage jamais confirmé (hub injoignable pour l’abandon) expire côté hub', async () => {
    const { hub } = makeHub()
    const spoke = mk('spoke')
    const inv = hub.sync.invite()
    // la confirmation et l'abandon n'arrivent jamais au hub
    const lossy = hubFetch(hub, { fail: p => p === '/v1/sync/pairing/confirm' || p === '/v1/sync/pairing/abort' })
    await expect(spoke.sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl: lossy })).rejects.toThrow()
    expect(hub.sync.peers().find(p => p.role === 'spoke')?.pending).toBe(true)
    // le délai passe
    hub.registry.db.prepare("UPDATE settings SET value = ? WHERE key LIKE 'sync.pairing_pending.%'").run('2000-01-01T00:00:00.000Z')
    hub.sync.expireStalePairings()
    expect(hub.registry.listPeers().filter(p => p.role === 'spoke')).toHaveLength(0)
  })
})

describe('curseur fiable', () => {
  it('trois Mac qui écrivent dans la même fenêtre : aucun fait perdu, même avec une horloge en retard', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const macs = [mk('mac-a'), mk('mac-b'), mk('mac-c')]
    for (const m of macs) await joinTo(m, hub)
    const write = (m: Memoria, content: string) => {
      const a = m.pairAssistant({ type: 'claude-code', display_name: 'Agent' })
      m.setScopeAccess(a.assistant_id, orgId, { can_read: true, can_write: true })
      return m.storeFact({ instance: a.assistant_instance_id, scope: orgId, content })
    }
    const [A, B, C] = macs as [Memoria, Memoria, Memoria]
    // C écrit d'abord… mais avec une horloge en retard, et n'envoie qu'après les autres
    const late = write(C, 'Essai fictif : fait du Mac C')
    C.sharedContentStore(orgId)!.db.prepare('UPDATE facts SET updated_at = ? WHERE id = ?').run('2001-01-01T00:00:00.000Z', late.id)
    write(A, 'Essai fictif : fait du Mac A')
    await A.sync.syncAll(hubFetch(hub))
    write(hub, 'Essai fictif : fait du hub')
    await B.sync.syncAll(hubFetch(hub)) // B est à jour… avant l'envoi de C
    write(B, 'Essai fictif : fait du Mac B')
    await C.sync.syncAll(hubFetch(hub))
    await B.sync.syncAll(hubFetch(hub))
    await A.sync.syncAll(hubFetch(hub))
    await C.sync.syncAll(hubFetch(hub))

    const all = ['A', 'B', 'C'].map(x => `Essai fictif : fait du Mac ${x}`).concat('Essai fictif : fait du hub')
    for (const m of [hub, ...macs]) for (const c of all) expect(hasFact(m, orgId, c)).toBe(true)
  })

  it('modifier ou oublier le fait le plus récent : le numéro ne redescend jamais, rien ne se perd (hub et Mac relié)', async () => {
    const { hub, agent } = makeHub()
    const orgId = orgOf(hub).id
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const expiresOn = (m: Memoria, id: string) =>
      (m.sharedContentStore(orgId)!.db.prepare('SELECT expires_at FROM facts WHERE id = ?').get(id) as { expires_at: string | null } | undefined)?.expires_at

    // hub : le fait le plus récent reçoit une expiration, puis il est oublié et un fait neuf le suit
    const last = hub.storeFact({ instance: agent.assistant_instance_id, scope: orgId, content: 'Essai fictif : dernier fait du hub' })
    await spoke.sync.pull(orgId, hubFetch(hub))
    expect(hasFact(spoke, orgId, 'Essai fictif : dernier fait du hub')).toBe(true)
    expect(hub.setExpiry(agent.assistant_instance_id, last.id, '2031-01-01T00:00:00.000Z')).toBe(true)
    await spoke.sync.pull(orgId, hubFetch(hub))
    expect(expiresOn(spoke, last.id)).toBe('2031-01-01T00:00:00.000Z')
    expect(hub.forget({ ids: [last.id] }).deleted).toBe(1)
    hub.storeFact({ instance: agent.assistant_instance_id, scope: orgId, content: 'Essai fictif : fait neuf du hub après oubli' })
    await spoke.sync.pull(orgId, hubFetch(hub))
    expect(hasFact(spoke, orgId, 'Essai fictif : fait neuf du hub après oubli')).toBe(true)

    // Mac relié : même chose à l'envoi
    const a = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent du collègue' })
    spoke.setScopeAccess(a.assistant_id, orgId, { can_read: true, can_write: true })
    const mine = spoke.storeFact({ instance: a.assistant_instance_id, scope: orgId, content: 'Essai fictif : dernier fait du collègue' })
    await spoke.sync.push(orgId, hubFetch(hub))
    expect(spoke.setExpiry(a.assistant_instance_id, mine.id, '2032-01-01T00:00:00.000Z')).toBe(true)
    await spoke.sync.push(orgId, hubFetch(hub))
    expect(expiresOn(hub, mine.id)).toBe('2032-01-01T00:00:00.000Z')
    expect(spoke.forget({ ids: [mine.id] }).deleted).toBe(1)
    spoke.storeFact({ instance: a.assistant_instance_id, scope: orgId, content: 'Essai fictif : fait neuf du collègue après oubli' })
    await spoke.sync.push(orgId, hubFetch(hub))
    expect(hasFact(hub, orgId, 'Essai fictif : fait neuf du collègue après oubli')).toBe(true)
  })
})

describe('clés de groupe et adresses', () => {
  it('init-hub tire des clés NEUVES (jamais celles qui traînaient au coffre) ; gardées quand des Mac sont reliés', async () => {
    const hub = mk('hub')
    // clés d'un ancien essai, déjà au coffre (coffre de test, jamais le Trousseau)
    setGroupVaultKey(hub.secrets, Buffer.alloc(32, 7))
    setClusterPairingKey(hub.secrets, Buffer.alloc(32, 9))
    const old = { gvk: keyFingerprint(Buffer.alloc(32, 7)), cpk: keyFingerprint(Buffer.alloc(32, 9)) }
    const r = hub.configureSyncHub('127.0.0.1:47600')
    expect(r.keys).toBe('new')
    expect(keyFingerprint(groupVaultKey(hub.secrets))).not.toBe(old.gvk)
    expect(keyFingerprint(clusterPairingKey(hub.secrets))).not.toBe(old.cpk)

    // un Mac relié reçoit les clés neuves
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    expect(keyFingerprint(clusterPairingKey(spoke.secrets))).toBe(keyFingerprint(clusterPairingKey(hub.secrets)))
    // relancer init-hub (changer l'adresse) ne coupe pas les Mac reliés
    const kept = keyFingerprint(clusterPairingKey(hub.secrets))
    expect(hub.configureSyncHub('127.0.0.1:47601').keys).toBe('kept')
    expect(keyFingerprint(clusterPairingKey(hub.secrets))).toBe(kept)
  })

  it('les clés du groupe restent en mémoire : une passe de synchro ne relit pas le coffre (règle n°27)', async () => {
    const { hub } = makeHub()
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    await spoke.sync.syncAll(hubFetch(hub))
    const reads = [vi.spyOn(spoke.secrets, 'get'), vi.spyOn(hub.secrets, 'get')]
    expect((await spoke.sync.syncAll(hubFetch(hub))).errors).toEqual([])
    for (const spy of reads) expect(spy).not.toHaveBeenCalled()
  })

  it('l’invitation donne une adresse joignable depuis un autre Mac, jamais 0.0.0.0', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun3: [{ address: '100.101.1.2', family: 'IPv4', internal: false }],
      en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '10.20.30.40', family: 'IPv4', internal: false }],
    } as unknown as Parameters<typeof lanIPv4>[0]
    expect(lanIPv4(ifaces)).toBe('10.20.30.40')
    for (const listen of ['0.0.0.0:47600', 'lan:47600', ':47600']) {
      const a = hubAddressesFor(listen, ifaces, 'mac-studio')
      expect(a.primary).toBe('10.20.30.40:47600')
      expect(a.alternatives).toEqual(['mac-studio.local:47600'])
      expect(JSON.stringify(a)).not.toContain('0.0.0.0')
    }
    expect(resolveListenHost('lan:47600', ifaces)).toEqual({ host: '10.20.30.40', port: 47600 })
    // pas de réseau local (Wi-Fi pas encore là) : pas d'adresse, jamais un repli sur 0.0.0.0
    expect(resolveListenHost('lan:47600', { lo0: ifaces!['lo0'] })).toEqual({ host: null, port: 47600 })
    // invitation réelle d'un hub configuré sur une adresse précise
    const hub = mk('hub')
    hub.configureSyncHub('127.0.0.1:47600')
    expect(hub.sync.invite().hub_lan).toBe('127.0.0.1:47600')
  })
})

describe('gardes de la synchro, une à une', () => {
  it('pair invité avec moins d’espaces que le hub : il n’a que les siens', async () => {
    const { hub } = makeHub()
    hub.configureSyncHub('127.0.0.1:47600', ['org', 'shared_topic'])
    const topic = hub.registry.ensureScope('shared_topic', 'sujet-fictif', {})
    const spoke = mk('spoke')
    await joinTo(spoke, hub, hubFetch(hub), ['org'])
    expect(hub.sync.peers().find(p => p.role === 'spoke')!.allowed.map(a => a.type)).toEqual(['org'])
    const q = encodeURIComponent(topic.id)
    expect(asPeer(spoke, hub, 'GET', `/v1/sync/pull?scope=${q}&since=0`).status).toBe(403)
    expect(asPeer(spoke, hub, 'POST', '/v1/sync/push', { scope_id: topic.id, facts: [], tombstones: [] }).status).toBe(403)
    // témoin : un pair invité sur les deux y accède
    const both = mk('spoke-2')
    await joinTo(both, hub, hubFetch(hub), ['org', 'shared_topic'])
    expect(asPeer(both, hub, 'GET', `/v1/sync/pull?scope=${q}&since=0`).status).toBe(200)
  })

  it('un hub d’avant qui propose `user` : le Mac invité ne le reprend pas, ni ne le demande', async () => {
    const { hub } = makeHub()
    const hubUser = userOf(hub)
    const inner = hubFetch(hub)
    const oldHub: FetchLike = async (url, init) => {
      const res = await inner(url, init)
      if (!new URL(url).pathname.endsWith('/pairing/complete')) return res
      const body = (await res.json()) as { scopes: unknown[] }
      return { ...res, json: async () => ({ ...body, scopes: [...body.scopes, { id: hubUser.id, type: 'user', name: 'user' }] }) }
    }
    const spoke = mk('spoke')
    const spokeUser = userOf(spoke).id
    await joinTo(spoke, hub, oldHub)
    expect(userOf(spoke).id).toBe(spokeUser)
    expect(spoke.registry.getScope(hubUser.id)).toBeNull()
    expect(spoke.registry.listPeers().find(p => p.role === 'hub')!.allowed_scopes).toEqual([orgOf(hub).id])
    expect(countIn(spoke, spokeUser)).toBe(0)
    // seconde couche : la reprise d'un espace interdit ne fait rien
    expect(spoke.registry.adoptScope({ id: hubUser.id, type: 'user', name: 'user' })).toBeNull()
    expect(userOf(spoke).id).toBe(spokeUser)
  })

  it('le Mac relié ne repousse pas un fait né ailleurs, même modifié chez lui', async () => {
    const { hub } = makeHub()
    const orgId = orgOf(hub).id
    const spoke = mk('spoke')
    await joinTo(spoke, hub)
    const local = spoke.sharedContentStore(orgId)!
    const fromHub = (local.db.prepare('SELECT id FROM facts WHERE scope_id = ? LIMIT 1').get(orgId) as { id: string }).id
    // modification locale directe (ancien code, outil externe) d'un fait du hub
    local.db.prepare('UPDATE facts SET fact = ?, updated_at = ? WHERE id = ?').run('Essai fictif : texte modifié sur le Mac relié', nowISO(), fromHub)
    expect(spoke.sync.collectDelta(orgId, '0', { originOnly: spoke.sync.machineId }).facts).toEqual([])
    expect(await spoke.sync.push(orgId, hubFetch(hub))).toEqual({ applied: 0, skipped_lww: 0, refused: 0 })
  })

  it('cinq codes faux annulent l’invitation ; le bon code ne sert plus', async () => {
    const { hub } = makeHub()
    const inv = hub.sync.invite('Mac de l’équipe')
    for (let i = 0; i < 5; i++) {
      expect(() => hub.sync.completePairing({ code: `FAUX-000${i}`, machine_id: 'mac-intrus-fictif' })).toThrow(/code de synchro invalide/)
    }
    expect(() => hub.sync.completePairing({ code: inv.code, machine_id: 'mac-equipe-fictif' })).toThrow(/aucune invitation/)
    expect(hub.registry.listPeers().filter(p => p.role === 'spoke')).toEqual([])
    expect(hub.registry.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sync_invite_cancelled'").get()).toEqual({ n: 1 })
  })

  it('le code est réservé au Mac qui l’a présenté le premier', () => {
    const { hub } = makeHub()
    const inv = hub.sync.invite('Mac de l’équipe')
    hub.sync.completePairing({ code: inv.code, machine_id: 'mac-equipe-fictif' })
    expect(() => hub.sync.completePairing({ code: inv.code, machine_id: 'mac-intrus-fictif' })).toThrow(/déjà utilisée par une autre machine/)
    // le même Mac peut le représenter (relance d'un join raté)
    expect(hub.sync.completePairing({ code: inv.code, machine_id: 'mac-equipe-fictif' }).peer_token).toBeTruthy()
    expect(hub.registry.listPeers().filter(p => p.role === 'spoke').map(p => p.machine_id)).toEqual(['mac-equipe-fictif'])
  })

  it('reprise de l’identité du hub : listes d’espaces des agents repointées, empreintes de contenu recalculées', async () => {
    const { hub } = makeHub()
    const hubOrg = orgOf(hub).id
    const spoke = mk('spoke')
    const a = spoke.pairAssistant({ type: 'codex', display_name: 'Agent du collègue' })
    const localOrg = orgOf(spoke).id
    spoke.setScopeAccess(a.assistant_id, localOrg, { can_read: true, can_write: true })
    spoke.registry.db.prepare('UPDATE assistants SET default_scopes = ? WHERE id = ?').run(JSON.stringify([localOrg]), a.assistant_id)
    const f = spoke.storeFact({ instance: a.assistant_instance_id, scope: localOrg, content: 'Essai fictif : check-list de montage' })
    await joinTo(spoke, hub)
    const row = spoke.registry.db.prepare('SELECT default_scopes FROM assistants WHERE id = ?').get(a.assistant_id) as { default_scopes: string }
    expect(JSON.parse(row.default_scopes)).toEqual([hubOrg])
    const hash = (spoke.sharedContentStore(hubOrg)!.db.prepare('SELECT content_hash FROM facts WHERE id = ?').get(f.id) as { content_hash: string }).content_hash
    expect(hash).toBe(contentHash({ fact: 'Essai fictif : check-list de montage', category: 'general', scope_id: hubOrg }))
    // et le fait part au hub sous l'identité de l'espace repris
    await spoke.sync.syncAll(hubFetch(hub))
    expect(hub.sharedContentStore(hubOrg)!.db.prepare('SELECT content_hash FROM facts WHERE id = ?').get(f.id)).toEqual({ content_hash: hash })
  })
})
