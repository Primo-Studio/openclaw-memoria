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

export interface AgentOverview {
  instance: string
  type: string
  facts: number
  themes: number
  procedures: number
  expertise: string[]
}

export async function getOverview(): Promise<AgentOverview[]> {
  const res = await request<{ agents: AgentOverview[] }>('GET', '/v1/admin/overview')
  return res.agents
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
  /** Thèmes (sujets) du fait — affichés en puces. Présent une fois la couche topics câblée. */
  topics?: string[]
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

/** Suppression DÉFINITIVE d'un agent (révoque + efface sa mémoire privée). */
export async function deleteAgent(assistantInstanceId: string): Promise<boolean> {
  const res = await request<{ deleted: boolean }>('POST', '/v1/admin/delete_agent', { assistant_instance_id: assistantInstanceId })
  return res.deleted
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
  openai: { available: boolean }
  openrouter: { available: boolean }
}

/** Détection des moteurs. Route « contrat » : 404 → géré par l'appelant. */
export async function getProviders(): Promise<ProvidersStatus> {
  return request<ProvidersStatus>('GET', '/v1/admin/providers')
}

export type LlmProviderName = 'ollama' | 'anthropic' | 'openai' | 'openrouter'

export interface LlmConfig {
  profile: string
  extraction?: { provider?: string; model?: string }
}

export async function getLlmProfile(): Promise<LlmConfig> {
  return request<LlmConfig>('GET', '/v1/admin/llm_profile')
}

export async function setLlmProfile(profile: LlmProfile): Promise<void> {
  await request<{ profile: LlmProfile }>('POST', '/v1/admin/llm_profile', { profile })
}

/** Choix explicite du provider/modèle d'extraction (« l'utilisateur décide »). */
export async function setExtractionProvider(provider: LlmProviderName, model?: string): Promise<void> {
  await request<unknown>('POST', '/v1/admin/llm_extraction', { provider, ...(model ? { model } : {}) })
}

// ------------------------------------------------------------ partage (§11)

export interface ScopeAccess {
  id: string
  type: string
  name: string
  readers: string[] // assistant_id autorisés en lecture
  facts: number
}

export interface AssistantInfo {
  id: string
  type: string
  display_name: string
}

export async function getScopes(): Promise<{ scopes: ScopeAccess[]; assistants: AssistantInfo[] }> {
  return request<{ scopes: ScopeAccess[]; assistants: AssistantInfo[] }>('GET', '/v1/admin/scopes')
}

export async function setPolicy(
  assistantId: string,
  scopeId: string,
  perms: { can_read?: boolean; can_write?: boolean; can_share?: boolean },
): Promise<void> {
  await request<{ ok: boolean }>('POST', '/v1/admin/policy', { assistant_id: assistantId, scope_id: scopeId, ...perms })
}

export async function shareFacts(factIds: string[], targetScope: string): Promise<{ shared: number; scope: string }> {
  return request<{ shared: number; scope: string }>('POST', '/v1/admin/share', { fact_ids: factIds, target_scope: targetScope })
}

export interface IdentityCandidate {
  id: string
  content: string
  category: string
  score: number
}

export async function getIdentityCandidates(instance: string): Promise<IdentityCandidate[]> {
  const res = await request<{ candidates: IdentityCandidate[] }>('GET', `/v1/admin/identity_candidates?instance=${encodeURIComponent(instance)}`)
  return res.candidates
}

// ------------------------------------------------------------ thèmes (topics)

export interface Topic {
  id: string
  name: string
  fact_count: number
  importance_score: number
  keywords: string[]
}

export async function getTopics(instance: string, minFacts = 1): Promise<Topic[]> {
  const res = await request<{ topics: Topic[] }>('GET', `/v1/admin/topics?instance=${encodeURIComponent(instance)}&min_facts=${minFacts}`)
  return res.topics
}

export async function getTopicFacts(instance: string, topicId: string): Promise<AdminFact[]> {
  const res = await request<{ facts: AdminFact[] }>('GET', `/v1/admin/topic_facts?instance=${encodeURIComponent(instance)}&topic=${encodeURIComponent(topicId)}`)
  return res.facts
}

// ------------------------------------------------------------ récurrences (patterns)

export interface Pattern {
  id: string
  label: string
  canonical_fact: string
  occurrences: number
  confidence: number
  kind: string
  status: string
}

export async function getPatterns(instance: string): Promise<Pattern[]> {
  const res = await request<{ patterns: Pattern[] }>('GET', `/v1/admin/patterns?instance=${encodeURIComponent(instance)}`)
  return res.patterns
}

export async function decidePattern(instance: string, patternId: string, decision: 'accept' | 'dismiss'): Promise<void> {
  await request<unknown>('POST', '/v1/admin/pattern_decision', { instance, id: patternId, decision })
}

// ------------------------------------------------------------ procédures (couche 6)

export interface Procedure {
  id: string
  name: string
  description: string
  steps: string[]
  trigger_patterns: string[]
  success_count: number
  failure_count: number
  quality_score: number
}

export async function getProcedures(instance: string): Promise<Procedure[]> {
  const res = await request<{ procedures: Procedure[] }>('GET', `/v1/admin/procedures?instance=${encodeURIComponent(instance)}`)
  return res.procedures
}

// ------------------------------------------------------------ expertise (couche 8)

export interface ExpertiseDomain {
  domain: string
  level: number
  evidence_count: number
}

export async function getExpertise(instance: string): Promise<ExpertiseDomain[]> {
  const res = await request<{ domains: ExpertiseDomain[] }>('GET', `/v1/admin/expertise?instance=${encodeURIComponent(instance)}`)
  return res.domains
}

// ------------------------------------------------------------ révisions (couche 18/24)

export interface RevisionProposal {
  id: string
  fact_id: string
  kind: string
  reason: string
  replacement_fact_id: string | null
  status: string
}

export async function getRevisions(instance: string): Promise<RevisionProposal[]> {
  const res = await request<{ proposals: RevisionProposal[] }>('GET', `/v1/admin/revisions?instance=${encodeURIComponent(instance)}`)
  return res.proposals
}

export async function proposeRevisions(instance: string): Promise<number> {
  const res = await request<{ proposed: number }>('POST', '/v1/admin/propose_revisions', { instance })
  return res.proposed
}

export async function decideRevision(instance: string, id: string, decision: 'accept' | 'dismiss'): Promise<void> {
  await request<unknown>('POST', '/v1/admin/revision_decision', { instance, id, decision })
}

// ------------------------------------------------------------ self-observation (couche 19)

export interface SelfObservation {
  id: string
  observation: string
  kind: string
  evidence_count: number
  confidence: number
}

export async function getSelfObservations(instance: string): Promise<SelfObservation[]> {
  const res = await request<{ observations: SelfObservation[] }>('GET', `/v1/admin/self_observations?instance=${encodeURIComponent(instance)}`)
  return res.observations
}

export async function deriveSelf(instance: string): Promise<number> {
  const res = await request<{ proposed: number }>('POST', '/v1/admin/derive_self', { instance })
  return res.proposed
}

// ------------------------------------------------------------ système (couches)

export async function getCognitiveStats(): Promise<Record<string, number>> {
  const res = await request<{ stats: Record<string, number> }>('GET', '/v1/admin/cognitive_stats')
  return res.stats
}

export async function refineTopics(instance: string): Promise<number> {
  const res = await request<{ refined: number }>('POST', '/v1/admin/refine_topics', { instance })
  return res.refined
}

// ------------------------------------------------------------ coffre (secrets)

export interface SecretRef {
  name: string
  service: string | null
  location: string
  created_at: string
}

export async function getSecrets(): Promise<SecretRef[]> {
  const res = await request<{ secrets: SecretRef[] }>('GET', '/v1/admin/secrets')
  return res.secrets
}

// ------------------------------------------------------------ mémoires partagées

export interface SharedScope {
  id: string
  type: string
  name: string
  label: string
  facts: number
}

export async function getSharedScopes(): Promise<SharedScope[]> {
  const res = await request<{ scopes: SharedScope[] }>('GET', '/v1/admin/shared_scopes')
  return res.scopes
}

export async function getScopeFacts(scopeId: string): Promise<AdminFact[]> {
  const res = await request<{ facts: AdminFact[] }>('GET', `/v1/admin/scope_facts?scope=${encodeURIComponent(scopeId)}`)
  return res.facts
}

// ------------------------------------------------------------ options (couches opt-in)

export async function getOptions(): Promise<Record<string, boolean>> {
  const res = await request<{ options: Record<string, boolean> }>('GET', '/v1/admin/options')
  return res.options
}

export async function setOption(key: string, enabled: boolean): Promise<Record<string, boolean>> {
  const res = await request<{ options: Record<string, boolean> }>('POST', '/v1/admin/options', { key, enabled })
  return res.options
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
  /** Thèmes où le souvenir sera rangé (affichés en puces). */
  topics?: string[]
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

// ------------------------------------------------------------ contrôle (Réglages)

export interface AutostartStatus {
  supported: boolean
  installed: boolean
  loaded: boolean
  plistPath: string
}

export interface ControlState {
  enabled: boolean
  autostart: AutostartStatus
  storage: { root: string; config_path: string; on_network_volume: boolean }
}

export async function getControl(): Promise<ControlState> {
  return request<ControlState>('GET', '/v1/admin/control')
}

export async function setEnabled(enabled: boolean): Promise<boolean> {
  const res = await request<{ enabled: boolean }>('POST', '/v1/admin/enabled', { enabled })
  return res.enabled
}

export async function setAutostart(enabled: boolean): Promise<AutostartStatus> {
  const res = await request<{ autostart: AutostartStatus }>('POST', '/v1/admin/autostart', { enabled })
  return res.autostart
}
