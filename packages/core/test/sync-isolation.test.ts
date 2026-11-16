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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Memoria,
  clusterPairingKey,
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
