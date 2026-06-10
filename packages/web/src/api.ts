/**
 * Client HTTP du daemon Memoria (routes /v1/admin/* — voir packages/daemon/src/server.ts).
 *
 * Auth : le CLI `memoria` ouvre l'UI avec `#token=<admin_token>` dans l'URL.
 * On adopte ce token au premier chargement, on le range en sessionStorage,
 * puis on nettoie l'URL — un secret ne doit jamais rester dans l'historique
 * du navigateur.
 *
 * Les types ci-dessous sont un MIROIR volontaire des types core/daemon :
 * l'UI est bundlée à part (Vite) et ne dépend d'aucun package Node.
 */

export type AgentType = 'claude-code' | 'codex' | 'openclaw' | 'generic'

export interface AssistantInstance {
  id: string
  assistant_id: string
  machine_id: string
  profile_id: string | null
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export interface AgentEntry {
  instance: AssistantInstance
  assistant_type: string
  db_path: string | null
}

export interface Stats {
  facts: number
  databases: number
  instances: number
}

export interface DoctorDatabase {
  kind: string
  path: string
  exists: boolean
  size_bytes: number
  wal_pending?: number
}

export interface DoctorReport {
  ok: boolean
  storage_root: string
  config_path: string
  registry_path: string
  databases: DoctorDatabase[]
  network_guard: { on_network_volume: boolean; journal_mode: string }
  warnings: string[]
}

export interface AuditEntry {
  id: number
  ts: string
  actor_type: 'assistant' | 'user' | 'system'
  actor_id: string
  action: string
  target_id_hash: string | null
  scope_id: string | null
  reason: string | null
}

export interface PairResult {
  assistant_id: string
  assistant_instance_id: string
  pairing_code: string
  command: string
}

/**
 * Fait tel que renvoyé par GET /v1/admin/facts (route câblée à l'intégration).
 * `scope_name` est optionnel : si le daemon le fournit, l'UI affiche un libellé
 * lisible plutôt que l'id de scope.
 */
export interface AdminFact {
  id: string
  fact: string
  category: string
  scope_id: string
  scope_name?: string
  sensitivity?: string
  created_at: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Même origine en prod (le daemon sert dist/ sous /ui/) ; surchargable en dev.
const baseUrl: string = (import.meta.env.VITE_DAEMON_URL as string | undefined) ?? ''

const TOKEN_KEY = 'memoria.admin_token'

/** Extrait le token d'un fragment d'URL `#token=…` (pur, testable hors DOM). */
export function extractTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')
  return token && token.length > 0 ? token : null
}

/**
 * À appeler UNE fois avant le premier rendu : adopte le token présent dans
 * l'URL puis réécrit l'URL sans le fragment.
 */
export function adoptTokenFromHash(): void {
  const token = extractTokenFromHash(location.hash)
  if (!token) return
  sessionStorage.setItem(TOKEN_KEY, token)
  history.replaceState(null, '', location.pathname + location.search)
}

export function adminToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function hasToken(): boolean {
  return adminToken() !== null
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = adminToken()
  if (!token) {
    throw new ApiError(401, 'Aucune clé d’accès — relancez `memoria` depuis votre terminal.')
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    let message = `Le service a répondu HTTP ${res.status}.`
    try {
      const payload = (await res.json()) as { error?: string }
      if (typeof payload.error === 'string' && payload.error.length > 0) message = payload.error
    } catch {
      // Corps non-JSON : on garde le statut HTTP comme message, mais on le signale.
      console.warn(`memoria-ui : réponse non-JSON du daemon sur ${path} (HTTP ${res.status})`)
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

// ------------------------------------------------------------------ endpoints

export async function getStats(): Promise<Stats> {
  return request<Stats>('GET', '/v1/admin/stats')
}

export async function getDoctor(): Promise<DoctorReport> {
  return request<DoctorReport>('GET', '/v1/admin/doctor')
}

export async function getAgents(): Promise<AgentEntry[]> {
  const res = await request<{ agents: AgentEntry[] }>('GET', '/v1/admin/agents')
  return res.agents
}

export async function getAudit(): Promise<AuditEntry[]> {
  const res = await request<{ entries: AuditEntry[] }>('GET', '/v1/admin/audit')
  return res.entries
}

export async function pairAgent(type: AgentType, displayName?: string): Promise<PairResult> {
  return request<PairResult>('POST', '/v1/admin/pair', {
    type,
    ...(displayName ? { display_name: displayName } : {}),
  })
}

export async function revokeAgent(assistantInstanceId: string): Promise<void> {
  await request<{ ok: boolean }>('POST', '/v1/admin/revoke', { assistant_instance_id: assistantInstanceId })
}

/** Recherche dans la mémoire d'un agent. `q` vide = derniers souvenirs. */
export async function searchFacts(instance: string, q: string): Promise<AdminFact[]> {
  const params = new URLSearchParams({ instance, q })
  const res = await request<{ facts: AdminFact[] }>('GET', `/v1/admin/facts?${params.toString()}`)
  return res.facts
}

/** Oubli définitif (hard-delete) par identifiants de faits. */
export async function forgetFacts(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await request<{ deleted: number }>('POST', '/v1/admin/forget', { ids })
  return res.deleted
}

// ------------------------------------------------------------ moteurs d'IA (§14)

export type LlmProfile = '100-local' | 'local-plus-cloud' | 'cloud'

export interface ProvidersStatus {
  ollama: { available: boolean; models: string[]; base_url?: string }
  anthropic: { available: boolean }
  lmstudio: { available: boolean }
}

/** Détection Ollama/Anthropic/LM Studio. Route « contrat » : 404 → null géré par l'appelant. */
export async function getProviders(): Promise<ProvidersStatus> {
  return request<ProvidersStatus>('GET', '/v1/admin/providers')
}

export async function getLlmProfile(): Promise<LlmProfile> {
  return (await request<{ profile: LlmProfile }>('GET', '/v1/admin/llm_profile')).profile
}

export async function setLlmProfile(profile: LlmProfile): Promise<void> {
  await request<{ profile: LlmProfile }>('POST', '/v1/admin/llm_profile', { profile })
}

// ------------------------------------------------------------ capture & revue

export type CaptureMode = 'auto-private' | 'review-first' | 'incognito'

export async function getCaptureMode(): Promise<CaptureMode> {
  const res = await request<{ mode: CaptureMode }>('GET', '/v1/admin/capture_mode')
  return res.mode
}

export async function setCaptureMode(mode: CaptureMode): Promise<void> {
  await request<{ mode: CaptureMode }>('POST', '/v1/admin/capture_mode', { mode })
}

/** Item en attente de revue (capture review-first ou quarantaine d'import). */
export interface ReviewItem {
  id: string
  fact_id: string
  content: string
  category: string
  confidence: number
  source_type: string
  source_db: string
  created_at: string
}

export async function getReview(): Promise<ReviewItem[]> {
  const res = await request<{ items: ReviewItem[] }>('GET', '/v1/admin/review')
  return res.items
}

export async function reviewDecision(ids: string[], decision: 'approve' | 'reject'): Promise<number> {
  if (ids.length === 0) return 0
  const res = await request<{ updated: number }>('POST', `/v1/admin/review/${decision}`, { ids })
  return res.updated
}
