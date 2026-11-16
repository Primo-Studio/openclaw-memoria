/**
 * SyncEngine — synchro inter-machines hub-and-spoke (SYNC-INTER-MACHINES.md).
 *
 * HUB (le Mac toujours allumé) : détient les espaces d'équipe canoniques, sert
 * `/v1/sync/*` sur le réseau local derrière peer_token + HMAC. SPOKE (Mac de
 * l'équipe) : copie locale, tire (pull) et pousse (push) vers le hub.
 *
 * Ce qui voyage : seulement les espaces d'ÉQUIPE (`org` par défaut). L'espace
 * `user` du propriétaire, les mémoires privées et la quarantaine ne sont
 * jamais servis ni acceptés (scopes.ts). Le hub contrôle CHAQUE requête d'un
 * pair : espace autorisé pour ce pair, faits du bon espace, et un pair ne
 * modifie que les faits venus de sa machine. Le contenu est contrôlé à
 * l'envoi ET à l'arrivée, sur le hub comme sur les Mac reliés : jamais un
 * fait `critical` ou `sensitive`, en attente de revue, marqué d'un client,
 * ni un texte qui touche un sujet sensible ou porte un secret (team-text.ts).
 *
 * Aucune valeur de secret en clair sur le réseau (enveloppes GVK). Best-effort :
 * jamais bloquant, jamais dans le chemin recall/store_fact.
 */
import type { ContentStore } from '../storage/content.js'
import { SCOPE_MOVE_KEY, type RegistryStore, type ScopeContentMover } from '../storage/registry.js'
import type { SecretProvider } from '../secrets/types.js'
import type { MemoryScope, SyncPeer } from '../types.js'
import { newToken, nowISO, sha256Hex } from '../util.js'
import {
  clusterPairingKey,
  groupVaultKey,
  restoreGroupKeys,
  setClusterPairingKey,
  setGroupVaultKey,
  snapshotGroupKeys,
  type GroupKeysSnapshot,
} from '../secrets/index.js'
import { reserveRevs } from './clock.js'
import { hubAddressesFor } from './lan.js'
import { applyDelta, contentHash, winner, type ApplyReport, type SyncFact, type Tombstone } from './merge.js'
import { newNonce, signRequest, verifyRequest, type SigParts } from './peer-auth.js'
import { SYNC_ALLOWED_TYPES, SYNC_FORBIDDEN_TYPES, effectiveSyncTypes, normalizeSyncTypes, SyncScopeError } from './scopes.js'
import { ensureSyncSeq, maxSyncSeq, parseSeq } from './seq.js'
import { teamTextRefusal } from './team-text.js'
import { openEnvelope, openGvk, sealGvk, sealValue, type Envelope } from './secrets-sync.js'

export interface SyncConfig {
  enabled?: boolean
  role?: 'hub' | 'spoke'
  machine_id?: string
  hub?: string
  listen_lan?: string
  interval_sec?: number
  tls?: boolean
  scopes?: string[]
  relay_path?: string
  discovery_file?: string
}

export interface SyncDeps {
  registry: RegistryStore
  secrets: SecretProvider
  machineId: string
  /** Config [sync] COURANTE, relue à chaque usage : join et leave la remplacent. */
  config: () => SyncConfig
  sharedStore: (scopeId: string) => ContentStore | null
  listSyncableScopes: (whitelist: readonly string[]) => MemoryScope[]
  persistConfig: () => void
  setSyncConfig: (patch: Record<string, unknown>) => void
  /** Remet la config [sync] telle qu'elle était (join raté). Absent : fusion avec setSyncConfig. */
  replaceSyncConfig?: (config: SyncConfig | undefined) => void
  /** Déplace le contenu d'un espace partagé vers un nouvel identifiant (reprise de l'identité du hub). */
  moveScopeContent?: ScopeContentMover
}

const INVITE_TTL_MS = 10 * 60_000
/** Délai laissé au Mac invité pour confirmer son appairage (bootstrap compris). */
const PAIRING_CONFIRM_TTL_MS = 15 * 60_000
/** Codes faux tolérés avant d'annuler l'invitation (le code fait ~40 bits). */
const MAX_PAIRING_ATTEMPTS = 5
/**
 * Faits par page (lecture et envoi). Mesuré sur données fictives : appliquer
 * 500 faits bloque 100 à 130 ms ; 250 garde la marge de la règle n°27 sur un
 * Mac plus lent (le réseau rend la main entre deux pages).
 */
const PAGE = 250
/** Faits sans provenance marqués par passe (borne de temps, règle n°27). */
const STAMP_BATCH = 500
const PENDING_INVITE_KEY = 'sync.pending_invite'
const PENDING_PAIRING_PREFIX = 'sync.pairing_pending.'
/** Délai d'un appel d'adieu au hub (abandon, départ) : il ne doit jamais bloquer. */
const FAREWELL_TIMEOUT_MS = 5_000

export interface SyncDelta {
  scope_id: string
  facts: SyncFact[]
  tombstones: Tombstone[]
  /** Numéro d'ordre du dernier fait parcouru, à renvoyer comme `since`. */
  next_cursor: string
  has_more: boolean
}

/** Faits refusés à l'arrivée, par motif (comptes seulement). */
export interface RefusedCounts {
  /** Le fait déclare un autre espace que celui de la requête. */
  scope: number
  /** Fait `critical` : ne voyage jamais. */
  critical: number
  /** Fait `sensitive`, ou texte qui touche un sujet sensible (paie, impôts, santé…). */
  sensitive: number
  /** Texte qui porte un secret (référence au coffre ou valeur en clair). */
  secret: number
  /** Fait marqué d'un client : ne voyage pas. */
  client: number
  /** Fait en attente de revue (dormant) ou archivé : la revue est locale, il resterait invisible. */
  dormant: number
  /** Le pair n'est pas la machine d'origine du fait (ni du fait qu'il remplacerait). */
  not_owner: number
  /** Forme invalide. */
  invalid: number
}

export interface IncomingReport extends ApplyReport {
  refused: RefusedCounts
  /** Plus haut numéro d'ordre de l'espace après application. */
  hub_watermark: string
}

export interface SyncRunReport {
  pulled: number
  pushed: number
  /** Faits refusés par le hub pendant l'envoi (voir le journal du hub pour les motifs). */
  refused: number
  /** Faits reçus du hub et écartés ici (sensible, secret, dormant, client…). */
  refused_received: number
  /** Une ligne par espace en échec (message court, sans contenu de souvenir). */
  errors: string[]
}

export interface SyncRunStatus extends SyncRunReport {
  at: string
  ok: boolean
}

/** Pair vu par l'écran et `sync status` : espaces autorisés lisibles + appairage en cours. */
export interface SyncPeerView extends SyncPeer {
  pending: boolean
  allowed: Array<{ id: string; type: string | null; name: string | null }>
}

/** Requête HTTP reçue sur le port LAN (le daemon la décode, le moteur décide). */
export interface SyncHttpRequest {
  method: string
  /** Chemin + requête, exactement ce qui a été signé. */
  pathWithQuery: string
  body: string
  bearer?: string | null
  sig?: string
  ts?: string
  nonce?: string
  /** Adresse de l'appelant (enregistrée comme hôte du pair à l'appairage). */
  remoteHost?: string
}

export interface SyncHttpResponse {
  status: number
  body: unknown
}

interface PendingInvite {
  code_hash: string
  expires_at: string
  display_name: string
  scopes: string[]
  /** Machine qui a présenté le bon code : elle seule peut le représenter (relance d'un join raté). */
  claimed_by: string | null
  attempts: number
}

export class SyncEngine {
  private lastRun: SyncRunStatus | null = null
  private lastLoggedError: string | null = null

  constructor(private readonly deps: SyncDeps) {}

  private get registry(): RegistryStore {
    return this.deps.registry
  }

  private get config(): SyncConfig {
    return this.deps.config()
  }

  get role(): 'hub' | 'spoke' {
    return this.config.role ?? 'spoke'
  }

  get machineId(): string {
    return this.deps.machineId
  }

  /** Types d'espaces que cette machine synchronise (liste blanche sans types interdits ; défaut `org`). */
  syncTypes(): string[] {
    return effectiveSyncTypes(this.config.scopes)
  }

  /** Espaces synchronisables locaux (jamais user, private ni la quarantaine). */
  syncScopes(): MemoryScope[] {
    return this.deps.listSyncableScopes(this.syncTypes())
  }

  /** Dernière passe de synchro (automatique ou « sync now ») : quand, combien, quelles erreurs. */
  lastRunStatus(): SyncRunStatus | null {
    return this.lastRun
  }

  // ============================================================ HUB : appairage & auth

  /**
   * (hub) Génère une invitation one-shot : code + adresse du hub joignable
   * depuis un autre Mac + espaces que ce Mac recevra (défaut : `org`).
   */
  invite(
    displayName?: string,
    scopes?: readonly string[] | string | null,
  ): { code: string; expires_at: string; hub_lan: string | null; hub_alternatives: string[]; scopes: string[] } {
    if (this.role !== 'hub') throw new SyncScopeError('cette machine n’est pas le hub : lance d’abord « memoria sync init-hub »')
    const hubTypes = this.syncTypes()
    const types = normalizeSyncTypes(scopes)
    const outside = types.filter(t => !hubTypes.includes(t))
    if (outside.length > 0) {
      throw new SyncScopeError(`ce hub ne synchronise pas ${outside.join(', ')} (espaces du hub : ${hubTypes.join(', ')}) — relance « memoria sync init-hub --scopes … »`)
    }
    this.expireStalePairings()
    const code = `${rand4()}-${rand4()}`
    const expires_at = new Date(Date.now() + INVITE_TTL_MS).toISOString()
    const invite: PendingInvite = { code_hash: sha256Hex(code), expires_at, display_name: displayName ?? 'machine', scopes: types, claimed_by: null, attempts: 0 }
    this.registry.setSetting(PENDING_INVITE_KEY, JSON.stringify(invite))
    const addr = hubAddressesFor(this.config.listen_lan)
    return { code, expires_at, hub_lan: addr.primary, hub_alternatives: addr.alternatives, scopes: types }
  }

  /**
   * (hub) Le spoke présente le code → on crée le pair (en attente de
   * confirmation) + on renvoie ses clés et SES espaces. Le même Mac peut
   * représenter le même code tant qu'il est valable : un join raté se relance.
   */
  completePairing(input: { code: string; machine_id: string; display_name?: string; host?: string }): {
    peer_token: string
    cpk: string
    sealed_gvk: string
    hub_machine_id: string
    scopes: Array<{ id: string; type: string; name: string }>
  } {
    const raw = this.registry.getSetting(PENDING_INVITE_KEY)
    if (!raw) throw new Error('aucune invitation de synchro en attente')
    const inv = parseInvite(raw)
    if (!inv) {
      this.registry.deleteSetting(PENDING_INVITE_KEY)
      throw new Error('aucune invitation de synchro en attente')
    }
    if (Date.parse(inv.expires_at) < Date.now()) {
      this.registry.deleteSetting(PENDING_INVITE_KEY)
      throw new Error('invitation de synchro expirée')
    }
    if (sha256Hex(input.code) !== inv.code_hash) {
      // Essais limités : au-delà, l'invitation est annulée (le hub en refera une).
      const attempts = inv.attempts + 1
      if (attempts >= MAX_PAIRING_ATTEMPTS) {
        this.registry.deleteSetting(PENDING_INVITE_KEY)
        this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: 'sync_invite_cancelled', target_id_hash: null, scope_id: null, reason: `attempts=${attempts}` })
      } else {
        this.registry.setSetting(PENDING_INVITE_KEY, JSON.stringify({ ...inv, attempts }))
      }
      throw new Error('code de synchro invalide')
    }
    const machineId = String(input.machine_id ?? '').trim()
    if (!machineId) throw new Error('identifiant de machine manquant')
    if (machineId === this.machineId) throw new Error('une machine ne peut pas se relier à elle-même')
    if (inv.claimed_by && inv.claimed_by !== machineId) throw new Error('invitation déjà utilisée par une autre machine')

    // Espaces de CE pair : ceux de l'invitation, encore synchronisés par le hub.
    const hubTypes = this.syncTypes()
    const types = inv.scopes.filter(t => hubTypes.includes(t))
    const scopes = this.syncScopes()
      .filter(s => types.includes(s.type))
      .map(s => ({ id: s.id, type: s.type, name: s.name }))

    const gvk = groupVaultKey(this.deps.secrets)
    const cpk = clusterPairingKey(this.deps.secrets)
    const peerToken = newToken()
    this.registry.addPeer({
      machine_id: machineId,
      display_name: input.display_name ?? inv.display_name,
      role: 'spoke',
      host: input.host ?? null,
      peer_token: peerToken,
      cpk_location: this.deps.secrets.locationFor('__cluster_pairing_key'),
      allowed_scopes: scopes.map(s => s.id),
    })
    // Le code reste réservé à CE Mac jusqu'à sa confirmation (ou l'expiration).
    this.registry.setSetting(PENDING_INVITE_KEY, JSON.stringify({ ...inv, claimed_by: machineId }))
    this.registry.setSetting(PENDING_PAIRING_PREFIX + machineId, new Date(Date.now() + PAIRING_CONFIRM_TTL_MS).toISOString())
    this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: 'sync_peer_paired', target_id_hash: sha256Hex(machineId), scope_id: null, reason: `scopes=${types.join(',')}` })
    return {
      peer_token: peerToken,
      cpk: cpk.toString('hex'),
      sealed_gvk: sealGvk(gvk, input.code),
      hub_machine_id: this.machineId,
      scopes,
    }
  }

  /** (hub) Le Mac invité a tout reçu : appairage définitif, code consommé. */
  confirmPairing(peer: SyncPeer): void {
    this.registry.deleteSetting(PENDING_PAIRING_PREFIX + peer.machine_id)
    const inv = parseInvite(this.registry.getSetting(PENDING_INVITE_KEY))
    if (inv?.claimed_by === peer.machine_id) this.registry.deleteSetting(PENDING_INVITE_KEY)
    this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: 'sync_peer_confirmed', target_id_hash: sha256Hex(peer.machine_id), scope_id: null, reason: null })
  }

  /** (hub) Le Mac invité a échoué ou s'en va : pair coupé, invitation de nouveau libre pour lui. */
  dropPeer(peer: SyncPeer, reason: 'abort' | 'leave'): void {
    this.registry.revokePeer(peer.machine_id)
    this.registry.deleteSetting(PENDING_PAIRING_PREFIX + peer.machine_id)
    const inv = parseInvite(this.registry.getSetting(PENDING_INVITE_KEY))
    if (inv?.claimed_by === peer.machine_id) this.registry.setSetting(PENDING_INVITE_KEY, JSON.stringify({ ...inv, claimed_by: null }))
    this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: reason === 'leave' ? 'sync_peer_left' : 'sync_peer_pairing_aborted', target_id_hash: sha256Hex(peer.machine_id), scope_id: null, reason: null })
  }

  /** (hub) Un appairage jamais confirmé dans le délai est coupé : pas de pair à moitié actif. */
  expireStalePairings(): void {
    const rows = this.registry.db
      .prepare('SELECT key, value FROM settings WHERE key LIKE ?')
      .all(`${PENDING_PAIRING_PREFIX}%`) as Array<{ key: string; value: string }>
    const now = Date.now()
    for (const r of rows) {
      if (!(Date.parse(r.value) < now)) continue
      const machineId = r.key.slice(PENDING_PAIRING_PREFIX.length)
      this.registry.revokePeer(machineId)
      this.registry.deleteSetting(r.key)
      this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: 'sync_peer_pairing_expired', target_id_hash: sha256Hex(machineId), scope_id: null, reason: null })
    }
  }

  private isPendingPairing(machineId: string): boolean {
    return this.registry.getSetting(PENDING_PAIRING_PREFIX + machineId) !== null
  }

  /**
   * (hub) Authentifie une requête `/v1/sync/*` : peer_token + HMAC + anti-rejeu.
   * Lève une erreur explicite si refusée. Renvoie le pair.
   */
  authenticate(peerToken: string | undefined, sig: string | undefined, parts: SigParts): SyncPeer {
    if (!peerToken) throw new SyncAuthError('peer_token requis')
    this.expireStalePairings()
    const peer = this.registry.verifyPeerToken(peerToken)
    if (!peer) throw new SyncAuthError('peer inconnu ou révoqué')
    if (!sig) throw new SyncAuthError('signature requise')
    const cpk = clusterPairingKey(this.deps.secrets)
    const result = verifyRequest(cpk, sig, parts, n => !this.registry.recordSyncNonce(n))
    if (!result.ok) throw new SyncAuthError(`signature refusée (${result.reason})`)
    this.registry.touchPeer(peer.machine_id, peer.host)
    return peer
  }

  /**
   * (hub) Contrôle d'accès PAR PAIR, à chaque requête : l'espace existe, son
   * type n'est pas interdit, le hub le synchronise encore (liste blanche
   * actuelle, pas celle du jour de l'appairage), et il est dans les espaces
   * autorisés de ce pair. Même réponse dans tous les cas : un pair n'apprend
   * pas si l'espace existe.
   */
  authorizeScope(peer: SyncPeer, scopeId: string | null | undefined): MemoryScope {
    const scope = scopeId ? this.registry.getScope(scopeId) : null
    const ok =
      !!scope &&
      !SYNC_FORBIDDEN_TYPES.includes(scope.type) &&
      this.syncTypes().includes(scope.type) &&
      peer.allowed_scopes.includes(scope.id)
    if (!ok) throw new SyncForbiddenError('espace non autorisé pour ce Mac')
    return scope
  }

  // ============================================================ HUB : routes LAN

  /**
   * (hub) Une requête du port LAN, de bout en bout : appairage, authentification
   * (401), contrôle d'accès par pair (403), puis la route. Le daemon et les
   * tests passent par ici : les contrôles éprouvés sont ceux qui tournent.
   */
  handleHttp(req: SyncHttpRequest): SyncHttpResponse {
    const url = new URL(req.pathWithQuery, 'http://lan')
    const path = url.pathname
    const method = req.method.toUpperCase()
    if (!path.startsWith('/v1/sync/')) return { status: 403, body: null }
    if (this.role !== 'hub') return { status: 403, body: { error: 'cette machine n’est pas un hub de synchro' } }

    // Appairage : pas de Bearer (le code one-shot TTL EST le secret).
    if (method === 'POST' && path === '/v1/sync/pairing/complete') {
      const parsed = parseJsonObject(req.body)
      if (!parsed) return { status: 400, body: { error: 'JSON invalide' } }
      try {
        return {
          status: 200,
          body: this.completePairing({
            code: String(parsed['code'] ?? ''),
            machine_id: String(parsed['machine_id'] ?? ''),
            display_name: typeof parsed['display_name'] === 'string' ? parsed['display_name'] : undefined,
            host: req.remoteHost || undefined,
          }),
        }
      } catch (err) {
        // Motif exact au journal d'audit seulement : la réponse ne dit pas à un
        // inconnu du réseau si une invitation est ouverte.
        this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: 'sync_pairing_refused', target_id_hash: null, scope_id: null, reason: (err as Error).message.slice(0, 120) })
        return { status: 400, body: { error: 'invitation refusée (code expiré, déjà utilisé ou erroné)' } }
      }
    }

    let peer: SyncPeer
    try {
      peer = this.authenticate(req.bearer ?? undefined, req.sig, {
        method,
        path: req.pathWithQuery,
        body: req.body,
        ts: req.ts ?? '',
        nonce: req.nonce ?? '',
      })
    } catch (err) {
      return { status: 401, body: { error: (err as Error).message } }
    }

    try {
      if (method === 'POST' && path === '/v1/sync/pairing/confirm') {
        this.confirmPairing(peer)
        return { status: 200, body: { ok: true } }
      }
      if (method === 'POST' && (path === '/v1/sync/pairing/abort' || path === '/v1/sync/leave')) {
        this.dropPeer(peer, path === '/v1/sync/leave' ? 'leave' : 'abort')
        return { status: 200, body: { ok: true } }
      }
      if (method === 'GET' && (path === '/v1/sync/snapshot' || path === '/v1/sync/pull')) {
        const scope = this.authorizeScope(peer, url.searchParams.get('scope'))
        return { status: 200, body: this.collectDelta(scope.id, url.searchParams.get('since') ?? '0') }
      }
      if (method === 'POST' && path === '/v1/sync/push') {
        const b = parseJsonObject(req.body)
        if (!b) return { status: 400, body: { error: 'JSON invalide' } }
        const scope = this.authorizeScope(peer, typeof b['scope_id'] === 'string' ? b['scope_id'] : null)
        // Identité = le pair AUTHENTIFIÉ, jamais `peer_machine_id` du corps.
        const facts = Array.isArray(b['facts']) ? (b['facts'] as unknown[]) : []
        const tombstones = Array.isArray(b['tombstones']) ? (b['tombstones'] as unknown[]) : []
        const report = this.applyFromPeer(peer, scope, facts, tombstones)
        const refused = sumRefused(report.refused)
        if (refused > 0) {
          this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: 'sync_push_refused', target_id_hash: sha256Hex(peer.machine_id), scope_id: scope.id, reason: refusedReason(report.refused) })
        }
        return { status: 200, body: report }
      }
      if (method === 'GET' && path === '/v1/sync/secrets') {
        const scope = this.authorizeScope(peer, url.searchParams.get('scope'))
        return { status: 200, body: { secrets: this.serveSecrets(scope.id).map(s => ({ name: s.name, env: s.env })) } }
      }
    } catch (err) {
      if (err instanceof SyncForbiddenError) return { status: 403, body: { error: err.message } }
      throw err
    }
    return { status: 404, body: { error: `route sync inconnue : ${method} ${path}` } }
  }

  // ============================================================ delta & snapshot

  /** Base partagée d'un espace synchronisable, avec sa table de numéros d'ordre. null si interdit/inconnu. */
  private storeFor(scopeId: string): ContentStore | null {
    const scope = this.registry.getScope(scopeId)
    if (!scope || SYNC_FORBIDDEN_TYPES.includes(scope.type)) return null
    const store = this.deps.sharedStore(scopeId)
    if (store) ensureSyncSeq(store.db)
    return store
  }

  /**
   * Faits d'un espace changés après le numéro `since` (pagination par numéro
   * d'ordre local). JAMAIS envoyés : les faits dormants (revue en attente),
   * `critical` ou `sensitive`, ceux marqués d'un client, et un texte qui
   * touche un sujet sensible ou porte un secret. `originOnly` : seulement les
   * faits nés sur cette machine (envoi d'un spoke : il ne repousse pas ceux
   * des autres). Le curseur avance aussi sur les faits écartés.
   */
  collectDelta(scopeId: string, since: string, opts: { limit?: number; originOnly?: string } = {}): SyncDelta {
    const sinceSeq = parseSeq(since)
    const empty: SyncDelta = { scope_id: scopeId, facts: [], tombstones: [], next_cursor: String(sinceSeq), has_more: false }
    const store = this.storeFor(scopeId)
    if (!store) return empty
    this.stampProvenance(store, scopeId)
    const limit = Math.max(1, opts.limit ?? PAGE)
    const params: unknown[] = [sinceSeq, scopeId]
    if (opts.originOnly) params.push(opts.originOnly)
    params.push(limit + 1)
    const rows = store.db
      .prepare(
        `SELECT f.*, s.seq AS sync_seq_no FROM sync_seq s JOIN facts f ON f.id = s.fact_id
         WHERE s.seq > ? AND f.scope_id = ?${opts.originOnly ? ' AND f.origin_machine_id = ?' : ''}
           AND (f.deleted_at IS NOT NULL OR (
             f.lifecycle_state = 'active' AND f.sensitivity = 'normal' AND COALESCE(f.client_org_id, '') = ''
           ))
         ORDER BY s.seq ASC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>
    const has_more = rows.length > limit
    const page = rows.slice(0, limit)
    const facts: SyncFact[] = []
    const tombstones: Tombstone[] = []
    for (const r of page) {
      if (r['deleted_at']) {
        tombstones.push({ id: String(r['id']), deleted_at: String(r['deleted_at']), origin_machine_id: (r['origin_machine_id'] as string) ?? null, origin_rev: Number(r['origin_rev'] ?? 0), updated_at: String(r['updated_at']) })
      } else if (teamTextRefusal(String(r['fact'] ?? '')) === null) {
        facts.push(toSyncFact(r))
      }
    }
    const last = page.at(-1)
    const next_cursor = last ? String(last['sync_seq_no']) : String(sinceSeq)
    return { scope_id: scopeId, facts, tombstones, next_cursor, has_more }
  }

  /** (hub) Snapshot complet d'un scope (bootstrap/réconciliation). */
  snapshot(scopeId: string, since = '0', limit = PAGE): SyncDelta {
    return this.collectDelta(scopeId, since, { limit })
  }

  /**
   * Pose la provenance (machine + révision + empreinte) des faits qui n'en ont
   * pas : le partage depuis une mémoire privée recopie la ligne sans elle. Un
   * fait sans origine dans un espace partagé de CETTE machine est né ici.
   * Bornée par passe (règle n°27) ; la suite à la passe suivante.
   */
  private stampProvenance(store: ContentStore, scopeId: string): void {
    const rows = store.db
      .prepare('SELECT id, fact, category FROM facts WHERE scope_id = ? AND origin_machine_id IS NULL AND deleted_at IS NULL LIMIT ?')
      .all(scopeId, STAMP_BATCH) as Array<{ id: string; fact: string; category: string }>
    if (rows.length === 0) return
    const first = reserveRevs(this.registry, rows.length)
    const upd = store.db.prepare('UPDATE facts SET origin_machine_id = ?, origin_rev = ?, content_hash = ? WHERE id = ? AND origin_machine_id IS NULL')
    store.db.transaction(() => {
      rows.forEach((r, i) => upd.run(this.machineId, first + i, contentHash({ fact: r.fact, category: r.category, scope_id: scopeId }), r.id))
    })()
  }

  /** (spoke) Applique ce que le hub envoie : forme contrôlée, espace forcé, mêmes refus de contenu qu'au hub. */
  applyIncoming(scopeId: string, facts: unknown[], tombstones: unknown[]): IncomingReport {
    return this.applyChecked(scopeId, facts, tombstones, null)
  }

  /** (hub) Applique l'envoi d'un pair : mêmes contrôles + il ne touche qu'aux faits nés sur sa machine. */
  applyFromPeer(peer: SyncPeer, scope: MemoryScope, facts: unknown[], tombstones: unknown[]): IncomingReport {
    return this.applyChecked(scope.id, facts, tombstones, peer.machine_id)
  }

  private applyChecked(scopeId: string, facts: unknown[], tombstones: unknown[], owner: string | null): IncomingReport {
    const refused: RefusedCounts = { scope: 0, critical: 0, sensitive: 0, secret: 0, client: 0, dormant: 0, not_owner: 0, invalid: 0 }
    const store = this.storeFor(scopeId)
    if (!store) return { applied: 0, skipped_lww: 0, deduped: 0, tombstoned: 0, refused, hub_watermark: '0' }
    const okFacts: SyncFact[] = []
    for (const raw of facts ?? []) {
      const checked = sanitizeIncomingFact(raw, scopeId)
      if ('reason' in checked) {
        refused[checked.reason]++
        continue
      }
      const f = checked.fact
      if (owner !== null) {
        const local = store.getMergeFields(f.id)
        // Écho d'un fait déjà là (le pair renvoie ce qu'il a reçu) : simple « déjà vu ».
        if (winner(local, f) === 'apply' && (f.origin_machine_id !== owner || (local && local.origin_machine_id !== owner))) {
          refused.not_owner++
          continue
        }
      }
      okFacts.push(f)
    }
    const okTombs: Tombstone[] = []
    for (const raw of tombstones ?? []) {
      const t = sanitizeTombstone(raw)
      if (!t) {
        refused.invalid++
        continue
      }
      if (owner !== null) {
        const local = store.getMergeFields(t.id)
        if (local && winner(local, t) === 'apply' && (t.origin_machine_id !== owner || local.origin_machine_id !== owner)) {
          refused.not_owner++
          continue
        }
      }
      okTombs.push(t)
    }
    const report = store.db.transaction(() => applyDelta(store, okFacts, okTombs))()
    return { ...report, refused, hub_watermark: String(maxSyncSeq(store.db)) }
  }

  // ============================================================ HUB : secrets

  /** (hub) Enveloppes chiffrées GVK des secrets partagés d'un scope (jamais de plaintext). */
  serveSecrets(scopeId: string): Array<{ ref_id: string; name: string; service: string | null; sensitivity: string; env: Envelope }> {
    const rows = this.registry.db
      .prepare(
        `SELECT sse.ref_id, sse.iv, sse.tag, sse.data, sr.name, sr.service, sr.sensitivity
         FROM shared_secret_envelopes sse JOIN secret_refs sr ON sr.id = sse.ref_id
         WHERE sse.scope_id = ? AND sse.syncable = 1`,
      )
      .all(scopeId) as Array<{ ref_id: string; iv: string; tag: string; data: string; name: string; service: string | null; sensitivity: string }>
    return rows.map(r => ({ ref_id: r.ref_id, name: r.name, service: r.service, sensitivity: r.sensitivity, env: { iv: r.iv, tag: r.tag, data: r.data } }))
  }

  /** (hub) Marque un secret existant comme partageable : scelle sa valeur en enveloppe GVK. */
  shareSecret(refId: string, scopeId: string, value: string, opts: { syncable?: boolean } = {}): void {
    const gvk = groupVaultKey(this.deps.secrets)
    const env = sealValue(value, gvk)
    this.registry.db
      .prepare(
        `INSERT INTO shared_secret_envelopes (ref_id, scope_id, syncable, iv, tag, data, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref_id) DO UPDATE SET scope_id=excluded.scope_id, syncable=excluded.syncable, iv=excluded.iv, tag=excluded.tag, data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(refId, scopeId, opts.syncable ? 1 : 0, env.iv, env.tag, env.data, nowISO())
  }

  // ============================================================ SPOKE : join / pull / push

  /**
   * (spoke) S'appaire au hub puis bootstrap (snapshot + secrets). 1 commande.
   * Un échec à n'importe quelle étape remet le Mac comme avant (clés, pair du
   * hub, config) et prévient le hub, qui coupe l'appairage : on peut relancer.
   * La reprise de l'identité de l'espace `org` reste faite : elle est sans
   * perte et sans effet tant qu'aucun hub n'est relié.
   */
  async join(opts: { hub: string; code: string; fetchImpl?: FetchLike }): Promise<{ scopes: number; facts: number; secrets: number }> {
    const f = opts.fetchImpl ?? globalFetch()
    this.registry.recoverScopeMove(this.deps.moveScopeContent)
    const keysBefore = snapshotGroupKeys(this.deps.secrets)
    const configBefore: SyncConfig = { ...this.config }
    const res = await f(`http://${opts.hub}/v1/sync/pairing/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: opts.code, machine_id: this.machineId, display_name: this.machineId }),
    })
    if (!res.ok) throw new Error(`pairing refusé par le hub (${res.status})`)
    const data = (await res.json()) as {
      peer_token: string; cpk: string; sealed_gvk: string; hub_machine_id: string
      scopes: Array<{ id: string; type: string; name: string }>
    }

    let hubRegistered = false
    // Un seul hub à la fois : un ancien hub encore actif (nouveau join sans
    // « leave ») est coupé, sinon les requêtes partiraient signées avec son
    // jeton. Rétabli si ce join échoue.
    const previousHubs = this.registry.listPeers().filter(p => p.role === 'hub' && p.machine_id !== data.hub_machine_id)
    try {
      for (const p of previousHubs) this.registry.revokePeer(p.machine_id)
      // installer les clés du groupe
      setClusterPairingKey(this.deps.secrets, Buffer.from(data.cpk, 'hex'))
      const gvk = openGvk(data.sealed_gvk, opts.code)
      if (!gvk) throw new Error('échec du descellement de la clé de coffre (code invalide ?)')
      setGroupVaultKey(this.deps.secrets, gvk)

      // Espaces d'équipe seulement, même si un hub d'avant propose `user`.
      const allowed = (data.scopes ?? []).filter(s => SYNC_ALLOWED_TYPES.includes(s.type) && !SYNC_FORBIDDEN_TYPES.includes(s.type))
      // Un seul espace d'équipe par Mac : un hub qui en proposerait deux (doublon
      // d'un ancien code) ferait reprendre deux fois l'identité de l'org local,
      // et les faits du premier n'arriveraient nulle part.
      const firstOrg = allowed.find(s => s.type === 'org')
      const offered = allowed.filter(s => s.type !== 'org' || s === firstOrg)

      // Le hub est enregistré tout de suite : l'abandon doit pouvoir être signé.
      this.registry.addPeer({
        machine_id: data.hub_machine_id,
        display_name: `hub (${opts.hub})`,
        role: 'hub',
        host: opts.hub,
        peer_token: data.peer_token,
        cpk_location: this.deps.secrets.locationFor('__cluster_pairing_key'),
        allowed_scopes: offered.map(s => s.id),
      })
      this.registry.setSetting(`sync.peer_token.${data.hub_machine_id}`, data.peer_token)
      hubRegistered = true

      // ADOPTER les scopes du hub → aligner les identités de scope entre machines
      for (const s of offered) {
        this.registry.adoptScope({ id: s.id, type: s.type as never, name: s.name }, { moveContent: this.deps.moveScopeContent })
      }

      this.deps.setSyncConfig({ enabled: true, role: 'spoke', hub: opts.hub })
      this.deps.persistConfig()

      const report = await this.bootstrap({ hub: opts.hub, scopes: offered.map(s => s.id), fetchImpl: f })
      await this.signedPost(opts.hub, '/v1/sync/pairing/confirm', {}, f)
      this.registry.audit({ actor_type: 'system', actor_id: 'sync', action: 'sync_joined', target_id_hash: sha256Hex(data.hub_machine_id), scope_id: null, reason: `scopes=${offered.map(s => s.type).join(',')}` })
      return report
    } catch (err) {
      if (hubRegistered) {
        try {
          await this.signedPost(opts.hub, '/v1/sync/pairing/abort', {}, f, FAREWELL_TIMEOUT_MS)
        } catch {
          // hub injoignable : il coupera seul l'appairage non confirmé (15 min)
        }
      }
      this.undoJoin(data.hub_machine_id, opts.hub, keysBefore, configBefore)
      for (const p of previousHubs) this.registry.restorePeer(p.machine_id)
      throw err
    }
  }

  /** (spoke) Défait un join raté : pair du hub, jeton, curseurs, clés et config d'avant. */
  private undoJoin(hubMachineId: string, hubHost: string, keys: GroupKeysSnapshot, configBefore: SyncConfig): void {
    this.registry.deletePeer(hubMachineId)
    this.registry.deleteSetting(`sync.peer_token.${hubMachineId}`)
    this.registry.deleteCursors(hubKey(hubHost))
    restoreGroupKeys(this.deps.secrets, keys)
    if (this.deps.replaceSyncConfig) this.deps.replaceSyncConfig(Object.keys(configBefore).length > 0 ? configBefore : undefined)
    else this.deps.setSyncConfig({ enabled: configBefore.enabled ?? false, role: configBefore.role, hub: configBefore.hub })
    this.deps.persistConfig()
  }

  /** (spoke) Récupère l'historique complet des scopes + les secrets (1re fois). */
  async bootstrap(opts: { hub: string; scopes: string[]; fetchImpl?: FetchLike }): Promise<{ scopes: number; facts: number; secrets: number }> {
    const f = opts.fetchImpl ?? globalFetch()
    let totalFacts = 0
    let totalSecrets = 0
    for (const scopeId of opts.scopes) {
      // snapshot paginé par numéro d'ordre du hub
      let cursor = '0'
      for (;;) {
        const delta = await this.signedGet<SyncDelta>(opts.hub, `/v1/sync/snapshot?scope=${encodeURIComponent(scopeId)}&since=${encodeURIComponent(cursor)}`, f)
        const r = this.applyIncoming(scopeId, delta.facts, delta.tombstones)
        totalFacts += r.applied
        const advanced = parseSeq(delta.next_cursor) > parseSeq(cursor)
        cursor = delta.next_cursor
        this.registry.setCursor(hubKey(opts.hub), scopeId, { watermark: cursor })
        if (!delta.has_more || !advanced) break
      }
      // secrets du scope
      const secrets = await this.signedGet<{ secrets: Array<{ name: string; env: Envelope }> }>(opts.hub, `/v1/sync/secrets?scope=${encodeURIComponent(scopeId)}`, f)
      const gvk = groupVaultKey(this.deps.secrets)
      for (const s of secrets.secrets) {
        const value = openEnvelope(s.env, gvk)
        if (value !== null) {
          this.deps.secrets.set(s.name, value)
          totalSecrets++
        }
      }
    }
    return { scopes: opts.scopes.length, facts: totalFacts, secrets: totalSecrets }
  }

  /**
   * (spoke) Tire les nouveautés d'un scope depuis le hub (curseur = numéro
   * d'ordre du hub). `refused` : faits reçus et écartés ici (comptés, jamais rangés).
   */
  async pull(scopeId: string, fetchImpl?: FetchLike): Promise<{ applied: number; refused: number }> {
    const hub = this.hubPeer()
    if (!hub?.host) return { applied: 0, refused: 0 }
    const f = fetchImpl ?? globalFetch()
    const cur = this.registry.getCursor(hubKey(hub.host), scopeId)
    let applied = 0
    let refused = 0
    let since = String(parseSeq(cur.watermark))
    for (;;) {
      const delta = await this.signedGet<SyncDelta>(hub.host, `/v1/sync/pull?scope=${encodeURIComponent(scopeId)}&since=${encodeURIComponent(since)}`, f)
      const r = this.applyIncoming(scopeId, delta.facts, delta.tombstones)
      applied += r.applied + r.tombstoned
      refused += sumRefused(r.refused)
      const advanced = parseSeq(delta.next_cursor) > parseSeq(since)
      since = delta.next_cursor
      this.registry.setCursor(hubKey(hub.host), scopeId, { watermark: since })
      if (!delta.has_more || !advanced) break
    }
    return { applied, refused }
  }

  /**
   * (spoke) Pousse ses changements locaux d'un scope vers le hub : seulement
   * les faits nés ici (curseur = numéro d'ordre local, pas la date du fait).
   */
  async push(scopeId: string, fetchImpl?: FetchLike): Promise<{ applied: number; skipped_lww: number; refused: number }> {
    const hub = this.hubPeer()
    if (!hub?.host) return { applied: 0, skipped_lww: 0, refused: 0 }
    const f = fetchImpl ?? globalFetch()
    const cur = this.registry.getCursor(hubKey(hub.host), scopeId)
    let since = String(parseSeq(cur.last_push_at))
    let applied = 0
    let skipped = 0
    let refused = 0
    for (;;) {
      const delta = this.collectDelta(scopeId, since, { originOnly: this.machineId })
      if (delta.facts.length === 0 && delta.tombstones.length === 0) break
      const resp = await this.signedPost<IncomingReport>(
        hub.host,
        '/v1/sync/push',
        { scope_id: scopeId, peer_machine_id: this.machineId, facts: delta.facts, tombstones: delta.tombstones },
        f,
      )
      applied += (resp.applied ?? 0) + (resp.tombstoned ?? 0)
      skipped += resp.skipped_lww ?? 0
      refused += resp.refused ? sumRefused(resp.refused) : 0
      const advanced = parseSeq(delta.next_cursor) > parseSeq(since)
      since = delta.next_cursor
      this.registry.setCursor(hubKey(hub.host), scopeId, { last_push_at: since })
      if (!delta.has_more || !advanced) break
    }
    return { applied, skipped_lww: skipped, refused }
  }

  /**
   * (spoke) Une passe complète sur les espaces que le HUB a accordés à ce Mac
   * (pas la config locale) : un espace en échec n'arrête pas les autres.
   */
  async syncAll(fetchImpl?: FetchLike): Promise<SyncRunReport> {
    const report: SyncRunReport = { pulled: 0, pushed: 0, refused: 0, refused_received: 0, errors: [] }
    const hub = this.hubPeer()
    if (hub?.host) {
      for (const scope of this.spokeScopes(hub)) {
        try {
          const p = await this.pull(scope.id, fetchImpl)
          report.pulled += p.applied
          report.refused_received += p.refused
        } catch (err) {
          report.errors.push(`${scope.type} (réception) : ${describeError(err)}`)
          continue // sans réception à jour, on n'envoie pas sur cet espace
        }
        try {
          const p = await this.push(scope.id, fetchImpl)
          report.pushed += p.applied
          report.refused += p.refused
        } catch (err) {
          report.errors.push(`${scope.type} (envoi) : ${describeError(err)}`)
        }
      }
    }
    this.lastRun = { ...report, at: nowISO(), ok: report.errors.length === 0 }
    return report
  }

  /** Espaces accordés par le hub (enregistrés au join), filtrés : jamais un type interdit. */
  private spokeScopes(hub: SyncPeer): MemoryScope[] {
    return hub.allowed_scopes
      .map(id => this.registry.getScope(id))
      .filter((s): s is MemoryScope => !!s && SYNC_ALLOWED_TYPES.includes(s.type) && !SYNC_FORBIDDEN_TYPES.includes(s.type))
  }

  /**
   * Une passe best-effort (appelée par la minuterie du daemon). Jamais throw.
   * Les erreurs sont JOURNALISÉES (une fois par panne, puis le retour à la
   * normale) : plus de panne muette.
   */
  async tick(fetchImpl?: FetchLike): Promise<SyncRunReport | null> {
    if (this.config.enabled !== true) return null
    if (this.role !== 'spoke') return null // le hub est canonique : il ne tire pas
    if (!this.hubPeer()?.host) return null
    let report: SyncRunReport
    try {
      report = await this.syncAll(fetchImpl)
    } catch (err) {
      report = { pulled: 0, pushed: 0, refused: 0, refused_received: 0, errors: [describeError(err)] }
      this.lastRun = { ...report, at: nowISO(), ok: false }
    }
    const errors = report.errors.join(' ; ')
    if (errors) {
      if (errors !== this.lastLoggedError) console.warn(`[memoria] synchro automatique en échec : ${errors}`)
      this.lastLoggedError = errors
    } else if (this.lastLoggedError) {
      console.warn('[memoria] synchro automatique rétablie')
      this.lastLoggedError = null
    }
    if (report.refused > 0) console.warn(`[memoria] synchro : ${report.refused} fait(s) refusé(s) par le hub (faits d'une autre machine, sensibles, secrets ou hors espace)`)
    if (report.refused_received > 0) console.warn(`[memoria] synchro : ${report.refused_received} fait(s) reçu(s) du hub écarté(s) ici (sensibles, secrets, en revue ou marqués d'un client)`)
    return report
  }

  /**
   * (spoke) Se déconnecte du hub : prévient le hub (qui coupe ce Mac), révoque
   * le pair local, GARDE les données reçues.
   */
  async leave(fetchImpl?: FetchLike): Promise<{ hub_notified: boolean | null }> {
    const hub = this.hubPeer()
    let notified: boolean | null = null
    if (hub?.host) {
      notified = false
      try {
        await this.signedPost(hub.host, '/v1/sync/leave', {}, fetchImpl ?? globalFetch(), FAREWELL_TIMEOUT_MS)
        notified = true
      } catch {
        // hub injoignable : la révocation côté hub reste à faire (« memoria sync revoke »)
      }
      this.registry.revokePeer(hub.machine_id)
    }
    this.deps.setSyncConfig({ enabled: false })
    this.deps.persistConfig()
    return { hub_notified: notified }
  }

  /** Liste des pairs (UI admin, `sync status`) avec leurs espaces autorisés lisibles. */
  peers(): SyncPeerView[] {
    return this.registry.listPeers().map(p => ({
      ...p,
      pending: p.role === 'spoke' && this.isPendingPairing(p.machine_id),
      allowed: p.allowed_scopes.map(id => {
        const s = this.registry.getScope(id)
        return { id, type: s?.type ?? null, name: s?.name ?? null }
      }),
    }))
  }

  /** Reprend un déplacement d'espace interrompu (arrêt brutal pendant un join). */
  recoverPendingScopeMove(): void {
    if (this.registry.getSetting(SCOPE_MOVE_KEY)) this.registry.recoverScopeMove(this.deps.moveScopeContent)
  }

  // ------------------------------------------------------------ internes

  private hubPeer(): SyncPeer | null {
    return this.registry.listPeers().find(p => p.role === 'hub') ?? null
  }

  private async signedGet<T>(host: string, path: string, f: FetchLike): Promise<T> {
    const res = await f(`http://${host}${path}`, { method: 'GET', headers: this.signHeaders('GET', path, '') })
    if (!res.ok) throw new Error(`sync GET ${path.split('?')[0]} → ${res.status}`)
    return (await res.json()) as T
  }

  private async signedPost<T>(host: string, path: string, body: unknown, f: FetchLike, timeoutMs?: number): Promise<T> {
    const payload = JSON.stringify(body)
    const init: Parameters<FetchLike>[1] = { method: 'POST', headers: { 'content-type': 'application/json', ...this.signHeaders('POST', path, payload) }, body: payload }
    if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs)
    const res = await f(`http://${host}${path}`, init)
    if (!res.ok) throw new Error(`sync POST ${path} → ${res.status}`)
    return (await res.json()) as T
  }

  /** En-têtes Bearer + HMAC pour une requête vers le hub. */
  private signHeaders(method: string, path: string, body: string): Record<string, string> {
    const hub = this.hubPeer()
    const token = hub ? this.registry.getSetting(`sync.peer_token.${hub.machine_id}`) : null
    // le token du hub est stocké au join (settings, chmod du registry) ; à défaut, en-tête vide → 401 clair
    const ts = nowISO()
    const nonce = newNonce()
    const cpk = clusterPairingKey(this.deps.secrets)
    const sig = signRequest(cpk, { method, path, body, ts, nonce })
    return {
      authorization: `Bearer ${token ?? ''}`,
      'x-memoria-ts': ts,
      'x-memoria-nonce': nonce,
      'x-memoria-sig': sig,
    }
  }
}

export class SyncAuthError extends Error {}
/** Espace refusé à ce pair (→ 403). */
export class SyncForbiddenError extends Error {}

export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function globalFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike
}

function hubKey(host: string): string {
  return `hub:${host}`
}

function rand4(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const b = globalThis.crypto.getRandomValues(new Uint8Array(4))
  return Array.from(b, x => A[x % A.length]).join('')
}

function parseInvite(raw: string | null): PendingInvite | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PendingInvite>
    if (typeof v.code_hash !== 'string' || typeof v.expires_at !== 'string') return null
    return {
      code_hash: v.code_hash,
      expires_at: v.expires_at,
      display_name: typeof v.display_name === 'string' ? v.display_name : 'machine',
      // invitation d'avant (sans liste) : l'espace d'équipe seulement
      scopes: Array.isArray(v.scopes) ? v.scopes.filter(t => SYNC_ALLOWED_TYPES.includes(t)) : ['org'],
      claimed_by: typeof v.claimed_by === 'string' ? v.claimed_by : null,
      attempts: Number.isInteger(v.attempts) ? Number(v.attempts) : 0,
    }
  } catch {
    return null
  }
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  if (!body) return {}
  try {
    const v = JSON.parse(body) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function sumRefused(r: Partial<RefusedCounts>): number {
  return Object.values(r).reduce<number>((n, c) => n + (typeof c === 'number' ? c : 0), 0)
}

function refusedReason(r: RefusedCounts): string {
  return Object.entries(r)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(',')
}

/** Message court d'une panne (code réseau si c'en est une), sans contenu. */
function describeError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string } }
  const code = e?.cause?.code
  return code ? `${e.message ?? 'erreur'} (${code})` : (e?.message ?? String(err))
}

const SENSITIVITIES = ['normal', 'sensitive', 'critical']
const LIFECYCLES = ['active', 'dormant', 'archived']

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/**
 * Contrôle un fait reçu d'une autre machine : forme, espace (celui de la
 * requête, sinon refus), jamais `critical` ni `sensitive`, jamais marqué d'un
 * client, jamais en attente de revue, jamais un texte qui touche un sujet
 * sensible ou porte un secret (refusé, pas masqué : rien n'en est rangé, ni
 * au coffre). Le fait rangé est RECONSTRUIT champ par champ (rien
 * d'inattendu ne passe) : espace forcé, visibilité partagée, empreinte de
 * contenu recalculée.
 */
function sanitizeIncomingFact(raw: unknown, scopeId: string): { fact: SyncFact } | { reason: keyof RefusedCounts } {
  if (!raw || typeof raw !== 'object') return { reason: 'invalid' }
  const r = raw as Record<string, unknown>
  const id = optStr(r['id'])
  const fact = str(r['fact'])
  const category = str(r['category']) ?? 'general'
  const created = optStr(r['created_at'])
  const updated = optStr(r['updated_at'])
  if (!id || fact === null || !created || !updated) return { reason: 'invalid' }
  if (r['scope_id'] !== scopeId) return { reason: 'scope' }
  const sensitivity = str(r['sensitivity']) ?? 'normal'
  if (!SENSITIVITIES.includes(sensitivity)) return { reason: 'invalid' }
  if (sensitivity === 'critical') return { reason: 'critical' }
  if (sensitivity === 'sensitive') return { reason: 'sensitive' }
  if (optStr(r['client_org_id'])) return { reason: 'client' }
  const lifecycle = str(r['lifecycle_state']) ?? 'active'
  if (!LIFECYCLES.includes(lifecycle)) return { reason: 'invalid' }
  // La revue est locale : un dormant reçu resterait invisible et jamais revu.
  if (lifecycle !== 'active') return { reason: 'dormant' }
  const text = teamTextRefusal(fact)
  if (text) return { reason: text }
  const rev = Number(r['origin_rev'] ?? 0)
  if (!Number.isSafeInteger(rev) || rev < 0) return { reason: 'invalid' }
  const confidence = Number(r['confidence'] ?? 0.8)
  return {
    fact: {
      id,
      fact,
      category,
      fact_type: str(r['fact_type']) ?? 'statement',
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.8,
      source: str(r['source']) ?? 'sync',
      scope_id: scopeId,
      sensitivity,
      visibility: 'shared',
      tags: str(r['tags']) ?? '[]',
      entity_ids: str(r['entity_ids']) ?? '[]',
      lifecycle_state: lifecycle,
      superseded: r['superseded'] ? 1 : 0,
      superseded_by: optStr(r['superseded_by']),
      origin_machine_id: optStr(r['origin_machine_id']),
      origin_rev: rev,
      content_hash: contentHash({ fact, category, scope_id: scopeId }),
      deleted_at: optStr(r['deleted_at']),
      created_at: created,
      updated_at: updated,
      expires_at: optStr(r['expires_at']),
    },
  }
}

function sanitizeTombstone(raw: unknown): Tombstone | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = optStr(r['id'])
  const deleted = optStr(r['deleted_at'])
  const updated = optStr(r['updated_at'])
  const rev = Number(r['origin_rev'] ?? 0)
  if (!id || !deleted || !updated || !Number.isSafeInteger(rev) || rev < 0) return null
  return { id, deleted_at: deleted, origin_machine_id: optStr(r['origin_machine_id']), origin_rev: rev, updated_at: updated }
}

function toSyncFact(r: Record<string, unknown>): SyncFact {
  return {
    id: String(r['id']),
    fact: String(r['fact']),
    category: String(r['category']),
    fact_type: String(r['fact_type']),
    confidence: Number(r['confidence']),
    source: String(r['source']),
    scope_id: String(r['scope_id']),
    sensitivity: String(r['sensitivity']),
    visibility: String(r['visibility']),
    tags: String(r['tags'] ?? '[]'),
    entity_ids: String(r['entity_ids'] ?? '[]'),
    lifecycle_state: String(r['lifecycle_state']),
    superseded: Number(r['superseded'] ?? 0),
    superseded_by: (r['superseded_by'] as string) ?? null,
    origin_machine_id: (r['origin_machine_id'] as string) ?? null,
    origin_rev: Number(r['origin_rev'] ?? 0),
    content_hash: (r['content_hash'] as string) ?? null,
    deleted_at: (r['deleted_at'] as string) ?? null,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    expires_at: (r['expires_at'] as string | null | undefined) ?? null,
  }
}
