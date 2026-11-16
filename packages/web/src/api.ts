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

import { translate } from './i18n'

export type AgentType = 'claude-code' | 'codex' | 'openclaw' | 'chatgpt' | 'generic'

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

export interface DoctorActivity {
  last_recall_at?: string
  last_capture_at?: string
  recalls_24h: number
  captures_24h: number
  recall_ms_avg?: number
  recall_ms_p95?: number
  recall_tokens_avg?: number
  capture_ms_avg?: number
}

export interface DoctorMemory {
  facts_total: number
  facts_superseded: number
  facts_never_used: number
  contradictions_pending: number
  duplicates_pending: number
  wal_pending: number
  wal_stuck: number
}

/** Ce qui a QUITTÉ la machine sur 24 h (miroir de core DoctorCloud). Vide = rien n'est parti. */
export interface DoctorCloud {
  sends_24h: Array<{
    provider: string
    model: string
    purpose: string
    calls: number
    items: number
    chars: number
    failures: number
    tokens_in?: number
    tokens_out?: number
  }>
  last_send_at?: string
  chars_24h: number
}

// Miroir de core/types.ts DoctorReport. Les sections `activity`/`memory`/
// `cloud`/`usage` sont optionnelles ici : un service plus ancien ne les
// renvoie pas et l'UI doit rester lisible sans elles.
export interface DoctorReport {
  ok: boolean
  storage_root: string
  config_path: string
  registry_path: string
  databases: DoctorDatabase[]
  network_guard: { on_network_volume: boolean; journal_mode: string }
  activity?: DoctorActivity
  memory?: DoctorMemory
  cloud?: DoctorCloud
  usage?: LlmUsageReport
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
 * Écran demandé avec le token (`#token=…&route=memory`) : sert aux captures
 * automatisées (scripts/ui-preview.mjs) et aux liens profonds ouverts par le
 * CLI. Pur, testable. Absent ou vide → null (le routeur prend le défaut).
 */
export function extractRouteFromHash(hash: string): string | null {
  const route = new URLSearchParams(hash.replace(/^#/, '')).get('route')
  return route && /^[a-z-]+$/.test(route) ? route : null
}

/**
 * À appeler UNE fois avant le premier rendu : adopte le token présent dans
 * l'URL puis réécrit l'URL sans le fragment (ou avec la route demandée).
 */
export function adoptTokenFromHash(): void {
  const token = extractTokenFromHash(location.hash)
  if (!token) return
  sessionStorage.setItem(TOKEN_KEY, token)
  const route = extractRouteFromHash(location.hash)
  history.replaceState(null, '', location.pathname + location.search + (route ? `#/${route}` : ''))
}

export function adminToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function hasToken(): boolean {
  return adminToken() !== null
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const token = adminToken()
  if (!token) {
    // Message traduit : il remonte tel quel dans l'UI via humanError().
    throw new ApiError(401, translate('error.no_token'))
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    let message = translate('error.http_status', { status: res.status })
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

// --------------------------------- agents sur cette machine (détection / connexion 1 clic / import)

export type DetectedAgentKind = 'claude-code' | 'codex' | 'openclaw' | 'cursor'

export interface DetectedLegacyDb {
  path: string
  fact_count: number
}

export interface DetectedAgent {
  kind: DetectedAgentKind
  name: string
  installed: boolean
  data_found: { transcript_files?: number; legacy_db?: DetectedLegacyDb }
  already_connected: string | null
}

/** Détecte les assistants présents sur la machine (CLI, données importables, déjà connectés). */
export async function detectMachineAgents(): Promise<DetectedAgent[]> {
  const res = await request<{ agents: DetectedAgent[] }>('GET', '/v1/admin/agents_detect')
  return res.agents
}

export interface ConnectAgentResult {
  instance_id: string
  credentials_path: string
  registered: { host: string; registered: boolean; detail: string }
  restart_hint: string | null
}

/** Connexion 1 CLIC : pairing en processus + credentials + enregistrement MCP automatique. */
export async function connectAgent(kind: DetectedAgentKind, name?: string): Promise<ConnectAgentResult> {
  return request<ConnectAgentResult>('POST', '/v1/admin/agents_connect', { kind, ...(name ? { name } : {}) })
}

export interface ImportJobStatus {
  /** `interrupted` : le daemon s'est arrêté (stop, mise à jour, crash) pendant le job — message dans `error`. */
  state: 'idle' | 'running' | 'done' | 'error' | 'interrupted'
  kind: 'transcripts' | 'legacy' | 'chatgpt' | null
  instance_id: string | null
  progress: { files_done: number; files_total: number; facts_imported: number }
  error: string | null
  errors: string[]
  started_at: string | null
  finished_at: string | null
  /** Import ChatGPT (`memoria import chatgpt`) : bilan, forme détaillée côté daemon (ChatGptImportSummary). */
  summary?: Record<string, unknown> | null
}

/** Démarre un job d'import (un seul à la fois — 409 sinon). */
export async function startImport(input: {
  instance_id: string
  kind: 'transcripts' | 'legacy'
  legacy_path?: string
  max_windows_per_file?: number
}): Promise<ImportJobStatus> {
  return request<ImportJobStatus>('POST', '/v1/admin/import_start', input)
}

/** Statut du job d'import en cours (polling ~1 s). */
export async function getImportStatus(): Promise<ImportJobStatus> {
  return request<ImportJobStatus>('GET', '/v1/admin/import_status')
}

/**
 * Recherche dans la mémoire d'un agent. `q` vide = derniers souvenirs.
 * `limit` est facultatif : sans lui, le daemon garde son défaut (50) — les
 * appelants existants ne changent pas de comportement.
 */
export async function searchFacts(instance: string, q: string, limit?: number): Promise<AdminFact[]> {
  const params = new URLSearchParams({ instance, q })
  if (limit) params.set('limit', String(limit))
  const res = await request<{ facts: AdminFact[] }>('GET', `/v1/admin/facts?${params.toString()}`)
  return res.facts
}

/** Souvenir étiqueté de l'agent dont il vient (recherche globale). */
export interface GlobalFact extends AdminFact {
  agent_type: string
  instance: string | null
}

/** Recherche GLOBALE : mémoire de tous les agents d'un coup. */
export async function searchAll(q: string): Promise<GlobalFact[]> {
  const res = await request<{ facts: GlobalFact[] }>('GET', `/v1/admin/search?q=${encodeURIComponent(q)}`)
  return res.facts
}

/** Oubli définitif (hard-delete) par identifiants de faits. */
export async function forgetFacts(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await request<{ deleted: number }>('POST', '/v1/admin/forget', { ids })
  return res.deleted
}

// ------------------------------------------------------------ maintenance de la mémoire

/**
 * CORRIGE un souvenir : la version corrigée est créée, l'ancienne marquée
 * remplacée par elle. Le texte d'origine n'est jamais écrasé — la chaîne reste
 * navigable et une correction erronée reste rattrapable.
 */
export async function correctFact(instance: string, factId: string, content: string): Promise<AdminFact | null> {
  const res = await request<{ replacement: AdminFact | null }>('POST', '/v1/admin/correct_fact', {
    instance,
    fact_id: factId,
    content,
  })
  return res.replacement
}

/** FUSIONNE des doublons : `keepId` survit, les autres pointent sur lui. */
export async function mergeFacts(instance: string, keepId: string, mergeIds: string[]): Promise<string[]> {
  if (mergeIds.length === 0) return []
  const res = await request<{ merged: string[] }>('POST', '/v1/admin/merge_facts', {
    instance,
    keep_fact_id: keepId,
    merge_fact_ids: mergeIds,
  })
  return res.merged
}

/** Souvenirs jamais utilisés dans une réponse — la matière du ménage. */
export async function neverUsedFacts(instance: string, limit = 100): Promise<AdminFact[]> {
  const params = new URLSearchParams({ instance, limit: String(limit) })
  const res = await request<{ facts: AdminFact[] }>('GET', `/v1/admin/never_used?${params.toString()}`)
  return res.facts
}

// ------------------------------------------------------------ moteurs d'IA (§14)

export type LlmProfile = '100-local' | 'local-plus-cloud' | 'cloud'

export interface ProvidersStatus {
  ollama: { available: boolean; models: string[]; base_url?: string }
  anthropic: { available: boolean }
  lmstudio: { available: boolean; models?: string[]; base_url?: string }
  openai: { available: boolean }
  openrouter: { available: boolean }
}

/** Détection des moteurs. Route « contrat » : 404 → géré par l'appelant. */
export async function getProviders(): Promise<ProvidersStatus> {
  return request<ProvidersStatus>('GET', '/v1/admin/providers')
}

export type LlmProviderName = 'ollama' | 'lmstudio' | 'anthropic' | 'openai' | 'openrouter'

export interface LlmConfig {
  profile: string
  extraction?: { provider?: string; model?: string; base_url?: string }
  embeddings?: { provider?: string; model?: string; dimensions?: number; base_url?: string }
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

/** Scan matériel : pour proposer (ou déconseiller) un modèle local selon la
 *  puissance de la machine. */
export interface MachineCaps {
  platform: string
  arch: string
  ram_gb: number
  cpu_cores: number
  apple_silicon: boolean
  verdict: 'great' | 'ok' | 'weak'
  recommend_local: boolean
}

export async function getMachineCaps(): Promise<MachineCaps> {
  return request<MachineCaps>('GET', '/v1/admin/machine_caps')
}

/** Choix explicite du moteur d'embeddings (recherche sémantique). Deux
 *  fournisseurs réels : 'openai' (clé API, le plus simple) ou 'ollama' (local).
 *  Renvoie le nombre de souvenirs à (ré)indexer sous le nouveau modèle. */
export async function setEmbeddingsProvider(
  provider: 'openai' | 'ollama',
  model?: string,
): Promise<{ provider: string; model: string | null; pending: number }> {
  return request<{ provider: string; model: string | null; pending: number }>(
    'POST',
    '/v1/admin/llm_embeddings',
    { provider, ...(model ? { model } : {}) },
  )
}

/** Enregistre une clé API saisie par l'utilisateur (écrite côté daemon dans
 *  ~/.<provider>/api_key chmod 600, jamais renvoyée). Providers cloud uniquement. */
export async function setProviderKey(provider: LlmProviderName, key: string): Promise<void> {
  await request<unknown>('POST', '/v1/admin/provider_key', { provider, key })
}

// ------------------------------------------------------------ santé LLM (anti-mort-silencieuse)

/** État d'un moteur (extraction ou embeddings) dans le bilan de santé. */
export interface LlmEngineState {
  provider: string
  model: string
  available: boolean
  /** Toujours présent quand available=false. */
  reason?: string
  /** Embeddings seulement : souvenirs actifs sans vecteur pour le modèle courant. */
  pending?: number
}

export interface OllamaOptionState {
  kind: 'ollama'
  available: boolean
  serverUp: boolean
  hasEmbedModel: boolean
  hasExtractModel: boolean
  binaryInPath: boolean
  models: string[]
  baseUrl: string
  detail: string
}

export interface LmStudioOptionState {
  kind: 'lmstudio'
  available: boolean
  models: string[]
  baseUrl: string
  detail: string
}

export interface ApiKeyOptionState {
  kind: 'openai' | 'anthropic' | 'openrouter'
  available: boolean
  source: 'fichier' | 'env' | null
  keyFile: string
  detail: string
}

export interface OpenClawOptionState {
  kind: 'openclaw'
  available: boolean
  reusable: boolean
  provider?: 'openai' | 'anthropic' | 'openrouter'
  configPath?: string
  reason?: string
  detail: string
}

export interface LlmOptionsState {
  ollama: OllamaOptionState
  lmstudio: LmStudioOptionState
  openai: ApiKeyOptionState
  anthropic: ApiKeyOptionState
  openrouter: ApiKeyOptionState
  openclaw: OpenClawOptionState
}

/** Bilan GET /v1/admin/llm_health — la source de vérité anti-mort-silencieuse. */
export interface LlmHealth {
  extraction: LlmEngineState
  embeddings: LlmEngineState
  /** Souvenirs capturés en attente d'extraction (toutes instances). */
  wal_pending: number
  options: LlmOptionsState
}

export async function getLlmHealth(): Promise<LlmHealth> {
  return request<LlmHealth>('GET', '/v1/admin/llm_health')
}

/** Lance le téléchargement d'un modèle Ollama (409 si un job tourne déjà). */
export async function startOllamaPull(model: string): Promise<void> {
  await request<{ ok: boolean; model: string }>('POST', '/v1/admin/ollama_pull', { model })
}

export interface OllamaPullStatus {
  running: boolean
  model: string | null
  percent: number | null
  status: string | null
  error: string | null
}

export async function getOllamaPullStatus(): Promise<OllamaPullStatus> {
  return request<OllamaPullStatus>('GET', '/v1/admin/ollama_pull_status')
}

/** Copie la clé API trouvée chez OpenClaw vers ~/.<provider>/api_key (chmod 600). */
export async function copyOpenClawKey(provider: 'openai' | 'anthropic' | 'openrouter'): Promise<{ key_file: string }> {
  return request<{ ok: boolean; provider: string; key_file: string }>('POST', '/v1/admin/openclaw_copy_key', { provider })
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

/**
 * Raisons d'un refus de partage vers l'espace d'équipe (miroir de
 * TEAM_SHARE_REFUSALS, core/triage/types.ts), dans l'ordre où le moteur les teste.
 */
export const TEAM_SHARE_REFUSALS = ['critical', 'sensible', 'secret', 'client', 'redite', 'sans_tri', 'faux', 'rubrique', 'genre'] as const
export type TeamShareRefusal = (typeof TEAM_SHARE_REFUSALS)[number]
export type TeamShareRefusedCounts = Record<TeamShareRefusal, number>

export interface ShareFactsResult {
  shared: number
  scope: string
  /** Vers l'espace d'équipe (`org`) seulement : faits écartés par raison. */
  refused?: TeamShareRefusedCounts
}

/** `targetScope` : id, nom, ou `org` (l'espace d'équipe, garde-fous côté serveur). */
export async function shareFacts(factIds: string[], targetScope: string): Promise<ShareFactsResult> {
  return request<ShareFactsResult>('POST', '/v1/admin/share', { fact_ids: factIds, target_scope: targetScope })
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

export interface TopicRelation {
  a: string
  b: string
  weight: number
  shared_facts: number
  shared_entities: number
  via: string[]
}

export interface TopicGraph {
  nodes: Topic[]
  edges: TopicRelation[]
}

/** Graphe des thèmes liés (par faits/entités partagés). */
export async function getTopicRelations(instance: string, minFacts = 2): Promise<TopicGraph> {
  return request<TopicGraph>('GET', `/v1/admin/topic_relations?instance=${encodeURIComponent(instance)}&min_facts=${minFacts}`)
}

// ------------------------------------------------------------ carte des souvenirs

export interface MemoryMapPoint {
  id: string
  /** Position dans [-1, 1] : deux points proches parlent de la même chose. */
  x: number
  y: number
  label: string
  category: string
  /** Identifiant d'agent (instance) ou `shared:<scope>`. */
  agent: string
  created_at: string
  recall_count: number
  pinned: boolean
}

export interface MemoryMapAgent {
  id: string
  type: string
  name: string
  points: number
  unplaced: number
}

export interface MemoryMap {
  /** `error` : le dernier calcul a échoué, le service attend une relance explicite. */
  status: 'ready' | 'computing' | 'empty' | 'no-embeddings' | 'error'
  /** Raison de l'échec, seulement avec `status: 'error'`. */
  error?: string
  model: string | null
  computed_at: string | null
  points: MemoryMapPoint[]
  agents: MemoryMapAgent[]
  unplaced: number
}

export interface MemoryMapLinks {
  id: string
  content: string
  category: string
  agent: string
  created_at: string
  recall_count: number
  entities: string[]
  neighbours: Array<{ id: string; similarity: number }>
  related: Array<{ id: string; via: string }>
}

/** Carte des souvenirs : positions 2D de tous les souvenirs actifs, tous agents. */
export async function getMemoryMap(): Promise<MemoryMap> {
  return request<MemoryMap>('GET', '/v1/admin/memory_map')
}

export async function rebuildMemoryMap(): Promise<{ started: boolean }> {
  return request<{ started: boolean }>('POST', '/v1/admin/memory_map/rebuild', {})
}

/** Détail d'un point : texte complet, voisins par le sens, souvenirs liés par une entité. */
export async function getMemoryMapLinks(fact: string): Promise<MemoryMapLinks> {
  return request<MemoryMapLinks>('GET', `/v1/admin/memory_map/links?fact=${encodeURIComponent(fact)}`)
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

/**
 * Un des deux souvenirs cités par une proposition — miroir de
 * `RevisionFactDetail` (packages/core/src/types.ts).
 *
 * POURQUOI : on ne peut pas demander de choisir entre deux souvenirs en
 * n'affichant que leurs identifiants. Le daemon transporte donc le texte, sa
 * catégorie, sa date, l'agent qui l'a écrit et son état.
 */
export interface RevisionFactDetail {
  id: string
  fact: string
  category: string
  created_at: string
  /** Instance d'assistant d'origine (identifiant brut, traduit en nom à l'écran). */
  assistant_instance_id: string | null
  /** 'active' | 'dormant' | 'archived'. */
  lifecycle_state: string
  /** 1 = déjà remplacé par un souvenir plus récent. */
  superseded: number
}

export interface RevisionProposal {
  id: string
  fact_id: string
  kind: string
  reason: string
  replacement_fact_id: string | null
  status: string
  /**
   * Le souvenir qui serait RANGÉ, et celui qui le remplace. `null` = le
   * souvenir a été supprimé depuis (l'écran le dit, il ne laisse pas un blanc).
   * Facultatifs : un daemon plus ancien ne les envoie pas encore.
   */
  fact?: RevisionFactDetail | null
  replacement?: RevisionFactDetail | null
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

/**
 * Nombre de souvenirs en attente de revue (badge de la navigation). Le compte
 * seul, sans plafond : la liste (getReview) est réservée à l'écran Revue.
 */
export async function getReviewCount(): Promise<number> {
  const res = await request<{ count: number }>('GET', '/v1/admin/review/count')
  return res.count
}

export async function reviewDecision(ids: string[], decision: 'approve' | 'reject'): Promise<number> {
  if (ids.length === 0) return 0
  const res = await request<{ updated: number }>('POST', `/v1/admin/review/${decision}`, { ids })
  return res.updated
}

// ------------------------------------------------------------ personnes / interlocuteurs

export interface PersonIdentifier {
  id: string
  person_id: string
  kind: 'phone' | 'email' | 'telegram' | 'whatsapp' | 'handle' | 'other'
  value: string
  label: string | null
  created_at: string
}

export interface PersonProfile {
  id: string
  display_name: string
  notes: string | null
  relation: string | null
  org_id: string | null
  user_id: string | null
  created_at: string
  updated_at: string | null
  identifiers: PersonIdentifier[]
}

export async function getPersons(): Promise<PersonProfile[]> {
  const res = await request<{ persons: PersonProfile[] }>('GET', '/v1/admin/persons')
  return res.persons
}

export async function createPerson(input: { display_name: string; relation?: string; notes?: string }): Promise<PersonProfile> {
  const res = await request<{ person: PersonProfile }>('POST', '/v1/admin/person', input)
  return res.person
}

export async function updatePerson(id: string, patch: { display_name?: string; relation?: string | null; notes?: string | null }): Promise<PersonProfile> {
  const res = await request<{ person: PersonProfile }>('POST', '/v1/admin/person_update', { id, ...patch })
  return res.person
}

export async function deletePerson(id: string): Promise<boolean> {
  const res = await request<{ deleted: boolean }>('POST', '/v1/admin/person_delete', { id })
  return res.deleted
}

export async function addPersonIdentifier(personId: string, kind: PersonIdentifier['kind'], value: string, label?: string): Promise<PersonIdentifier> {
  const res = await request<{ identifier: PersonIdentifier }>('POST', '/v1/admin/person_identifier', { person_id: personId, kind, value, label })
  return res.identifier
}

export async function removePersonIdentifier(id: string): Promise<boolean> {
  const res = await request<{ deleted: boolean }>('POST', '/v1/admin/person_identifier_delete', { id })
  return res.deleted
}

export interface InterlocutorMatch {
  person: PersonProfile
  known: string[]
}

export async function identifyInterlocutor(input: { phone?: string; email?: string; telegram?: string; whatsapp?: string; handle?: string; name?: string }): Promise<InterlocutorMatch | null> {
  const res = await request<{ match: InterlocutorMatch | null }>('POST', '/v1/admin/identify_interlocutor', input)
  return res.match
}

// ------------------------------------------------------------ contrôle (Réglages)

export interface AutostartStatus {
  supported: boolean
  installed: boolean
  /** Service connu de launchd — PAS « en marche » (voir core/control/autostart.ts). */
  loaded: boolean
  /** Absents d'un daemon antérieur : `running` = process supervisé vivant. */
  running?: boolean
  pid?: number | null
  plistPath: string
}

/** Qui fait tourner le daemon qui répond : le service launchd, ou un lancement direct (`memoria start`). */
export type DaemonSupervisor = 'launchd' | null

export interface ControlState {
  enabled: boolean
  autostart: AutostartStatus
  /** Absent d'un daemon antérieur → on n'affiche rien plutôt que d'inventer. */
  supervisor?: DaemonSupervisor
  storage: { root: string; config_path: string; on_network_volume: boolean }
}

/**
 * Réponse de POST /v1/admin/autostart. `handover: true` = le daemon va
 * S'ARRÊTER et être relancé (sous launchd en mode `on`, en direct en mode
 * `off`) : la connexion suivante échoue quelques secondes, et la clé d'accès
 * (admin_token) est régénérée par le nouveau daemon.
 */
export interface AutostartChange {
  autostart: AutostartStatus
  handover: boolean
  mode?: 'on' | 'off'
}

export async function getControl(): Promise<ControlState> {
  return request<ControlState>('GET', '/v1/admin/control')
}

export async function setEnabled(enabled: boolean): Promise<boolean> {
  const res = await request<{ enabled: boolean }>('POST', '/v1/admin/enabled', { enabled })
  return res.enabled
}

export async function setAutostart(enabled: boolean): Promise<AutostartChange> {
  return request<AutostartChange>('POST', '/v1/admin/autostart', { enabled })
}

// ------------------------------------------------------------ synchro inter-machines

export interface SyncPeer {
  machine_id: string
  display_name: string
  role: 'hub' | 'spoke'
  host: string | null
  last_seen_at: string | null
  revoked_at: string | null
}

export interface SyncStatus {
  enabled: boolean
  role: 'hub' | 'spoke'
  machine_id: string
  hub: string | null
  listen_lan: string | null
  scopes: Array<{ id: string; type: string; name: string }>
  peers: SyncPeer[]
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return request<SyncStatus>('GET', '/v1/admin/sync/status')
}

export async function syncInitHub(listenLan: string): Promise<{ listen_lan: string; machine_id: string }> {
  return request('POST', '/v1/admin/sync/init_hub', { listen_lan: listenLan })
}

export async function syncInvite(displayName?: string): Promise<{ code: string; expires_at: string; hub_lan: string | null }> {
  return request('POST', '/v1/admin/sync/invite', { display_name: displayName })
}

export async function syncJoin(hub: string, code: string): Promise<{ scopes: number; facts: number; secrets: number }> {
  return request('POST', '/v1/admin/sync/join', { hub, code })
}

export async function syncNow(): Promise<{ pulled: number; pushed: number }> {
  return request('POST', '/v1/admin/sync/now', {})
}

export async function syncRevoke(machineId: string): Promise<{ revoked: boolean }> {
  return request('POST', '/v1/admin/sync/revoke', { machine_id: machineId })
}

export async function syncLeave(): Promise<{ ok: boolean }> {
  return request('POST', '/v1/admin/sync/leave', {})
}

// ------------------------------------------------------------ mise à jour

export interface VersionInfo {
  version: string
  sha: string | null
  is_git: boolean
  daemon: string
}

export async function getVersion(): Promise<VersionInfo> {
  return request<VersionInfo>('GET', '/v1/admin/version')
}

export interface UpdateResult {
  ok: boolean
  changed: boolean
  before: string | null
  after: string | null
  message: string
  log: string
}

export async function runUpdate(): Promise<UpdateResult> {
  return request<UpdateResult>('POST', '/v1/admin/update', {})
}

// ---------------------------------------------------------------- llm usage

export type LlmUsagePeriod = '24h' | '7d' | '30d' | 'all'

export interface LlmUsageRow {
  provider: string
  model: string
  purpose: 'extraction' | 'embeddings'
  local: boolean
  calls: number
  failures: number
  items: number
  chars: number
  ms_total: number
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  calls_metered: number
  first_ts: string | null
  last_ts: string | null
  estimated_cost_usd: number | null
  price_known: boolean
}

export interface LlmUsageReport {
  period: LlmUsagePeriod
  since: string | null
  generated_at: string
  pricing_as_of: string
  rows: LlmUsageRow[]
  totals: {
    calls: number
    failures: number
    input_tokens: number | null
    output_tokens: number | null
    estimated_cost_usd: number | null
    unpriced_calls: number
    unmetered_calls: number
  }
}

/** Consommation des modèles (appels, tokens, coût estimé) sur une fenêtre. */
export async function getLlmUsage(period: LlmUsagePeriod = '24h'): Promise<LlmUsageReport> {
  return request<LlmUsageReport>('GET', `/v1/admin/llm_usage?period=${period}`)
}

// ------------------------------------------------- aperçu du rappel (T30)

/** Raison d'un match (miroir de core RecallMatch). */
export type RecallMatch = 'text' | 'meaning' | 'graph' | 'context' | 'pinned'

/** Voisin d'un souvenir par entité partagée (miroir de core RecallLink). */
export interface RecallPreviewLink {
  id: string
  excerpt: string
  via: string
}

/**
 * Souvenir tel que le moteur le rend (miroir de core RecallItem). Les champs
 * d'enrichissement sont tous optionnels : le moteur ne les émet que s'ils ont
 * une valeur, et un service plus ancien n'en émet aucun.
 */
export interface RecallPreviewItem {
  id: string
  kind: string
  content: string
  category: string
  score: number
  created_at: string
  origin?: string
  revision?: { kind: string; replacement_fact_id?: string }
  matched_by?: RecallMatch[]
  via_entity?: string
  topic?: { id: string; name: string }
  entities?: string[]
  status?: string
  trust?: { confidence: number; used_count: number; recall_count: number }
  links?: RecallPreviewLink[]
}

/** Regroupement par thème (miroir de core RecallBlock). */
export interface RecallPreviewBlock {
  title: string
  topic_id?: string
  item_ids: string[]
  latest_id: string
  entities?: string[]
  loose?: boolean
}

export interface RecallPreviewDropped {
  reason: string
  count: number
}

/** Les trois formes sous lesquelles un rappel part vers un agent. */
export type RecallRenderId = 'mcp' | 'blocks' | 'openclaw'
export const RECALL_RENDER_IDS: readonly RecallRenderId[] = ['mcp', 'blocks', 'openclaw']

/** Résultat d'un rappel, réduit à ce que l'écran lit (miroir de core RecallResult). */
export interface RecallPreviewResult {
  items: RecallPreviewItem[]
  /** Blocs calculés par le moteur ; absent = l'écran regroupe lui-même. */
  blocks?: RecallPreviewBlock[]
  dropped: RecallPreviewDropped[]
}

export interface RecallRender {
  /** Le texte EXACT envoyé à l'agent sous cette forme. */
  text: string
  /** Nombre de tokens compté par le service ; absent = l'écran l'estime. */
  tokens?: number
  /**
   * Le rappel dont CE texte est tiré. Chaque forme a ses réglages (OpenClaw :
   * autre limite, autre budget, pas de seuil), donc son propre résultat.
   * Absent avec un service qui n'envoie qu'un résultat pour tous les rendus.
   */
  result?: RecallPreviewResult
}

/** Aperçu normalisé : ce que l'écran « Ce que voit l'IA » manipule. */
export interface RecallPreview extends RecallPreviewResult {
  instance: string
  query: string
  /**
   * Mémoire en pause : l'agent ne reçoit rien, ce n'est pas « aucun souvenir ».
   * `items` dit alors ce qu'il recevrait à la reprise, `renders` ce qu'il
   * reçoit vraiment pendant la pause.
   */
  disabled: boolean
  /** Forme que CET agent reçoit réellement. `items`, `blocks` et `dropped` sont ceux de son rappel. */
  native: RecallRenderId
  renders: Partial<Record<RecallRenderId, RecallRender>>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRenderId(v: unknown): v is RecallRenderId {
  return typeof v === 'string' && (RECALL_RENDER_IDS as readonly string[]).includes(v)
}

/** Forme reçue par un agent d'après son type : OpenClaw reçoit un bloc de texte, les autres le JSON MCP. */
export function nativeRenderOf(agentType: string | undefined): RecallRenderId {
  return agentType === 'openclaw' ? 'openclaw' : 'mcp'
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

/**
 * Un souvenir sûr à afficher, ou null s'il n'a ni identifiant ni texte.
 *
 * POURQUOI champ par champ : l'écran fait `links.map`, `entities.map`,
 * `topic.name`. Un seul champ d'une autre forme (service plus récent, réponse
 * abîmée) ferait planter tout l'écran. Un champ mal formé est donc retiré, et
 * le souvenir reste affiché avec ce qui est lisible.
 */
function normalizePreviewItem(raw: unknown): RecallPreviewItem | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['content'] !== 'string') return null
  const str = (key: string): string | undefined => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined)
  const item: RecallPreviewItem = {
    id: raw['id'],
    kind: str('kind') ?? '',
    content: raw['content'],
    category: str('category') ?? '',
    score: typeof raw['score'] === 'number' && Number.isFinite(raw['score']) ? raw['score'] : 0,
    created_at: str('created_at') ?? '',
  }
  const origin = str('origin')
  if (origin) item.origin = origin
  const status = str('status')
  if (status) item.status = status
  const via = str('via_entity')
  if (via) item.via_entity = via
  const revision = raw['revision']
  if (isRecord(revision) && typeof revision['kind'] === 'string') {
    item.revision = {
      kind: revision['kind'],
      ...(typeof revision['replacement_fact_id'] === 'string' ? { replacement_fact_id: revision['replacement_fact_id'] } : {}),
    }
  }
  if (Array.isArray(raw['matched_by'])) item.matched_by = raw['matched_by'].filter((m): m is RecallMatch => typeof m === 'string')
  const topic = raw['topic']
  if (isRecord(topic) && typeof topic['id'] === 'string' && typeof topic['name'] === 'string') item.topic = { id: topic['id'], name: topic['name'] }
  if (Array.isArray(raw['entities'])) item.entities = raw['entities'].filter((e): e is string => typeof e === 'string')
  const trust = raw['trust']
  if (isRecord(trust) && typeof trust['confidence'] === 'number') {
    item.trust = {
      confidence: trust['confidence'],
      used_count: typeof trust['used_count'] === 'number' ? trust['used_count'] : 0,
      recall_count: typeof trust['recall_count'] === 'number' ? trust['recall_count'] : 0,
    }
  }
  if (Array.isArray(raw['links'])) {
    item.links = raw['links'].flatMap(l =>
      isRecord(l) && typeof l['id'] === 'string' && typeof l['excerpt'] === 'string'
        ? [{ id: l['id'], excerpt: l['excerpt'], via: typeof l['via'] === 'string' ? l['via'] : '' }]
        : [],
    )
  }
  return item
}

/**
 * Un bloc sûr à afficher, ou null. Un bloc de thème sans titre est refusé : il
 * donnerait un intertitre vide. Ses souvenirs ne sont pas perdus, l'écran range
 * dans « Autres souvenirs » tout souvenir qu'aucun bloc ne cite (viewBlocks).
 */
function normalizePreviewBlock(raw: unknown): RecallPreviewBlock | null {
  if (!isRecord(raw) || !Array.isArray(raw['item_ids'])) return null
  const loose = raw['loose'] === true
  const title = typeof raw['title'] === 'string' ? raw['title'].trim() : ''
  if (!loose && title === '') return null
  return {
    title,
    item_ids: raw['item_ids'].filter((id): id is string => typeof id === 'string'),
    latest_id: typeof raw['latest_id'] === 'string' ? raw['latest_id'] : '',
    ...(typeof raw['topic_id'] === 'string' ? { topic_id: raw['topic_id'] } : {}),
    ...(isStringArray(raw['entities']) ? { entities: raw['entities'] } : {}),
    ...(loose ? { loose: true } : {}),
  }
}

/** Résultat d'un rappel (racine ou rendu) : tableaux vérifiés, entrées illisibles ignorées. */
function normalizePreviewResult(result: Record<string, unknown>): RecallPreviewResult {
  const items = (Array.isArray(result['items']) ? result['items'] : []).flatMap(i => normalizePreviewItem(i) ?? [])
  const blocks = Array.isArray(result['blocks']) ? result['blocks'].flatMap(b => normalizePreviewBlock(b) ?? []) : undefined
  const dropped = (Array.isArray(result['dropped']) ? result['dropped'] : []).filter(
    (d): d is RecallPreviewDropped => isRecord(d) && typeof d['reason'] === 'string' && typeof d['count'] === 'number' && d['count'] > 0,
  )
  return { items, ...(blocks ? { blocks } : {}), dropped }
}

/**
 * Normalise la réponse de POST /v1/admin/recall_preview. Pur, testable.
 *
 * Forme attendue (packages/daemon/src/server.ts, `RecallPreviewResponse`) :
 *   { instance, agent_type, query, result: RecallResult, disabled?,
 *     renderings: [{ id: 'mcp' | 'blocks' | 'openclaw', native, text, tokens, result }] }
 *
 * POURQUOI un résultat par rendu : un agent OpenClaw ne reçoit pas le même
 * rappel qu'un agent MCP (autre limite, autre budget, pas de seuil). La vue
 * « Lisible » et le résumé doivent décrire le rappel du rendu NATIF, sinon ils
 * montrent des souvenirs que l'agent ne reçoit pas. On lit donc le résultat du
 * rendu natif, et celui de la racine seulement si le rendu n'en porte pas
 * (service qui n'envoie qu'un résultat).
 *
 * POURQUOI tolérant : l'UI doit rester lisible devant un service un peu plus
 * ancien ou un peu plus récent qu'elle. Un champ absent ou mal formé est
 * ignoré, jamais inventé : un rendu manquant reste ABSENT et l'écran dit « non
 * fourni » plutôt que de fabriquer un texte que l'agent n'a jamais reçu.
 */
export function normalizeRecallPreview(raw: unknown, fallback: { instance: string; query: string; agentType?: string }): RecallPreview {
  const root = isRecord(raw) ? raw : {}

  const renders: Partial<Record<RecallRenderId, RecallRender>> = {}
  let declared: RecallRenderId | undefined
  for (const r of Array.isArray(root['renderings']) ? root['renderings'] : []) {
    if (!isRecord(r) || !isRenderId(r['id']) || typeof r['text'] !== 'string') continue
    const tokens = r['tokens']
    renders[r['id']] = {
      text: r['text'],
      ...(typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? { tokens } : {}),
      ...(isRecord(r['result']) ? { result: normalizePreviewResult(r['result']) } : {}),
    }
    if (r['native'] === true && !declared) declared = r['id']
  }

  const agentType = typeof root['agent_type'] === 'string' ? root['agent_type'] : fallback.agentType
  const native = declared ?? nativeRenderOf(agentType)
  const result = renders[native]?.result ?? normalizePreviewResult(isRecord(root['result']) ? root['result'] : root)
  return {
    instance: typeof root['instance'] === 'string' ? root['instance'] : fallback.instance,
    query: typeof root['query'] === 'string' ? root['query'] : fallback.query,
    disabled: root['disabled'] === true,
    ...result,
    native,
    renders,
  }
}

/**
 * Exécute le VRAI rappel de l'agent `instance`, en aperçu : le service ne
 * touche ni aux compteurs d'usage ni au journal (option `preview` du moteur).
 * Un 404 « route inconnue » remonte en ApiError : l'écran le traduit en
 * « service plus ancien » (voir isOldServiceError).
 */
/**
 * Vrai si l'erreur vient d'un service qui ne connaît pas encore la route.
 * Le même code 404 sert aussi à « instance inconnue » (agent supprimé entre
 * temps) : celui-là reste une erreur ordinaire, avec « Réessayer ».
 */
export function isOldServiceError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && !/instance/i.test(err.message)
}

export async function previewRecall(instance: string, query: string, agentType?: string): Promise<RecallPreview> {
  const raw = await request<unknown>('POST', '/v1/admin/recall_preview', { instance, query })
  return normalizeRecallPreview(raw, { instance, query, ...(agentType ? { agentType } : {}) })
}


// ------------------------------------------------------------ tri des souvenirs

/*
 * Miroir des types du tri (core/triage/types.ts) et des routes
 * /v1/admin/triage/* (daemon/triage-routes.ts). Le curseur de pagination est
 * OPAQUE : on renvoie tel quel le `next_cursor` de la page précédente.
 */

export const TRIAGE_GENRES = ['idee', 'decision', 'process', 'lecon', 'preference', 'style', 'savoir', 'fait', 'chronologie', 'ephemere'] as const
export type TriageGenre = (typeof TRIAGE_GENRES)[number]
export const TRIAGE_SOUS_TYPES = ['app', 'business', 'contenu', 'outil', 'amelioration', 'autre'] as const
export type TriageSousType = (typeof TRIAGE_SOUS_TYPES)[number]
export const TRIAGE_RUBRIQUES = [
  'clients', 'vente', 'rh', 'erreurs', 'outils', 'savoir_entreprise', 'projet', 'app', 'contenu', 'finance', 'juridique', 'infra',
] as const
export type TriageRubrique = (typeof TRIAGE_RUBRIQUES)[number]
export type TriageAuteurSource = 'message' | 'llm' | 'inconnu'
export type TriageDateSource = 'fichier' | 'archive' | 'etat' | 'metadata' | 'creation' | 'import' | 'inconnu'

/** Une ligne de la liste d'administration (TriageListItem). */
export interface TriageItem {
  fact_id: string
  text: string
  category: string
  genre: TriageGenre | null
  sous_type: TriageSousType | null
  rubriques: TriageRubrique[]
  person_id: string | null
  /** `owner`, `inconnu`, `ia:<agent>`, `person:<id>`, ou null (non classé). */
  auteur: string | null
  auteur_source: TriageAuteurSource
  approuve_par_owner: boolean
  importance: number | null
  projet: string | null
  titre: string | null
  citation: string | null
  entites: string[]
  conversation_at: string | null
  conversation_at_source: TriageDateSource
  amas_size: number
  sensible: boolean
  verdict: 'faux' | null
  llm_failures: number
  validated: boolean
  source_db: string
  instance_id: string | null
  source_path: string | null
}

/** Filtre de la liste (noms des paramètres de GET /v1/admin/triage). */
export interface TriageFilter {
  genre?: TriageGenre[]
  sous_type?: TriageSousType
  /** `owner`, `ia`, `person`, `inconnu` ou une valeur exacte. */
  auteur?: string
  rubrique?: TriageRubrique
  projet?: string
  importance_min?: number
  q?: string
  instance?: string
  validated?: boolean
  sensible?: boolean
  include_faux?: boolean
  since?: string
  until?: string
  /** Candidats pour l'espace d'équipe (process, savoir, leçon métier ; ni client, ni sensible, ni secret). */
  team?: boolean
}

export interface TriagePage {
  items: TriageItem[]
  next_cursor: string | null
}

/** Paramètres d'URL d'un filtre (pur, testable) : seuls les champs renseignés partent. */
export function triageQuery(filter: TriageFilter, page: { cursor?: string | null; limit?: number } = {}): string {
  const p = new URLSearchParams()
  if (filter.genre && filter.genre.length > 0) p.set('genre', filter.genre.join(','))
  if (filter.sous_type) p.set('sous_type', filter.sous_type)
  if (filter.auteur) p.set('auteur', filter.auteur)
  if (filter.rubrique) p.set('rubrique', filter.rubrique)
  if (filter.projet?.trim()) p.set('projet', filter.projet.trim())
  if (typeof filter.importance_min === 'number') p.set('importance_min', String(filter.importance_min))
  if (filter.q?.trim()) p.set('q', filter.q.trim())
  if (filter.instance) p.set('instance', filter.instance)
  if (typeof filter.validated === 'boolean') p.set('validated', String(filter.validated))
  if (typeof filter.sensible === 'boolean') p.set('sensible', String(filter.sensible))
  if (filter.include_faux) p.set('include_faux', 'true')
  if (filter.since) p.set('since', filter.since)
  if (filter.until) p.set('until', filter.until)
  if (filter.team) p.set('team', 'true')
  if (page.limit) p.set('limit', String(page.limit))
  if (page.cursor) p.set('cursor', page.cursor)
  const qs = p.toString()
  return qs ? `?${qs}` : ''
}

export async function getTriageList(filter: TriageFilter, page: { cursor?: string | null; limit?: number } = {}): Promise<TriagePage> {
  return request<TriagePage>('GET', `/v1/admin/triage${triageQuery(filter, page)}`)
}

/** Faits proposés pour l'espace d'équipe (filtre « candidats équipe » du serveur). Pas encore d'écran. */
export async function getTeamCandidates(
  filter: Omit<TriageFilter, 'team'> = {},
  page: { cursor?: string | null; limit?: number } = {},
): Promise<TriagePage> {
  return getTriageList({ ...filter, team: true }, page)
}

export interface TriageGenreCount {
  total: number
  validated: number
  pending: number
}

export interface TriageStats {
  facts_total: number
  triaged: number
  untriaged: number
  sensible: number
  failed: number
  faux: number
  same_as_active: number
  amas: number
  redites: number
  by_genre: Record<string, TriageGenreCount>
  by_auteur: Record<string, number>
}

export async function getTriageStats(): Promise<TriageStats> {
  return request<TriageStats>('GET', '/v1/admin/triage/stats')
}

export interface TriageEstimate {
  facts_pending: number
  facts_active: number
  facts_sensible: number
  facts_to_embed: number
  llm_facts_max: number
  llm_calls_max: number
  cost_usd: number | null
  provider: string | null
  model: string | null
  budget_usd: number
  within_budget: boolean
}

export type TriageRunState = 'idle' | 'running' | 'done' | 'cancelled' | 'paused' | 'budget' | 'error' | 'interrupted'

export interface TriageRunStatus {
  run_id: string | null
  state: TriageRunState
  dry_run: boolean
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
  budget_usd: number
  spent_usd: number
  total_spent_usd: number
  dbs_total: number
  dbs_done: number
  facts_done: number
  classified: number
  inherited: number
  sensible: number
  failed: number
  llm_calls: number
  max_block_ms: number | null
  error: string | null
  estimate: TriageEstimate | null
}

export async function getTriageRun(): Promise<TriageRunStatus> {
  return request<TriageRunStatus>('GET', '/v1/admin/triage/run')
}

/** Lance un passage (ou une estimation sans aucun appel : `dry_run`). Rend dès le démarrage. */
export async function startTriageRun(opts: { dry_run?: boolean; budget_usd?: number } = {}): Promise<TriageRunStatus> {
  return request<TriageRunStatus>('POST', '/v1/admin/triage/run', opts)
}

export async function cancelTriageRun(): Promise<boolean> {
  return (await request<{ cancelled: boolean }>('DELETE', '/v1/admin/triage/run')).cancelled
}

export interface TriagePromoteResult {
  promoted: number
  merged_members: number
  merged_into_active: number
  skipped_sensitive: number
  skipped_faux: number
  already_active: number
  not_found: number
  shared: number
  /** `share: 'org'` seulement : faits validés mais écartés de l'espace d'équipe, par raison. */
  share_refused?: TeamShareRefusedCounts
}

/**
 * Valide (→ actif) ; `share` : partagé ensuite. `true` ou `'user'` : avec
 * toutes les IA (espace « user ») ; `'org'` : espace d'équipe, filtré côté serveur.
 */
export async function promoteTriage(factIds: string[], opts: { share?: boolean | 'user' | 'org' } = {}): Promise<TriagePromoteResult> {
  const share = opts.share === 'user' || opts.share === 'org' ? opts.share : opts.share ? true : undefined
  return request<TriagePromoteResult>('POST', '/v1/admin/triage/promote', { fact_ids: factIds, ...(share !== undefined ? { share } : {}) })
}

export interface TriageCorrectionInput {
  fact_id: string
  genre?: TriageGenre
  sous_type?: TriageSousType | null
  sensible?: boolean
}

export async function correctTriage(c: TriageCorrectionInput): Promise<boolean> {
  return (await request<{ updated: boolean }>('POST', '/v1/admin/triage/correct', c)).updated
}

/** Marque faux (le souvenir reste en attente, caché) ou retire la marque (null). */
export async function setTriageVerdict(factIds: string[], verdict: 'faux' | null): Promise<number> {
  return (await request<{ updated: number }>('POST', '/v1/admin/triage/verdict', { fact_ids: factIds, verdict })).updated
}

// ---------------------------------------------------------------- passe styles
// Miroir de StylesPassOptions / StylesReport (core/triage/types.ts) et de
// /v1/admin/triage/styles (daemon/triage-routes.ts). Pas encore d'écran.

/** `owner` : la manière d'échanger du propriétaire, mois par mois ; `person` : comment échanger avec une fiche Person. */
export type StylesPassMode = 'owner' | 'person'

export interface StylesPassInput {
  mode: StylesPassMode
  /** Obligatoire en mode person. */
  person_id?: string
  dry_run?: boolean
  budget_usd?: number
  /** Date ISO : messages ou faits sources postérieurs seulement. */
  since?: string
  /** Refait une période même si elle n'a pas assez changé. */
  force?: boolean
  /** Mode owner seulement. */
  sources?: Array<'claude-code' | 'codex-history'>
  /** Mode person seulement : bases lisibles par cette instance, et instance où écrire. */
  instance?: string
}

export interface StylesProgress {
  periods_done: number
  periods_total: number
  llm_calls: number
  facts_created: number
  spent_usd: number
}

export interface StylesReport {
  mode: StylesPassMode
  person_id: string | null
  sessions_found: number
  sessions_read: number
  messages_seen: number
  messages_sensitive: number
  facts_scanned: number
  sources_matched: number
  sources_excluded_rubrique: number
  sources_sensitive: number
  items_sent: number
  periods_found: number
  periods_small: number
  periods_known: number
  periods_sent: number
  periods_failed: number
  facts_created: number
  facts_duplicate: number
  observations_rejected: Record<string, number>
  llm_calls: number
  llm_calls_estimate: number
  spent_usd: number
  estimate_usd: number | null
  stopped: 'cancelled' | 'paused' | 'budget' | 'circuit' | 'closed' | 'max_facts' | null
  errors: string[]
  max_block_ms: number | null
}

export interface StylesJobState {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
  dry_run: boolean
  started_at: string | null
  finished_at: string | null
  progress: StylesProgress | null
  report: StylesReport | null
  refusal: string | null
  error: string | null
}

export async function getStylesPass(): Promise<StylesJobState> {
  return request<StylesJobState>('GET', '/v1/admin/triage/styles')
}

/** Lance la passe styles (ou une estimation sans aucun appel : `dry_run`). Rend dès le démarrage (202). */
export async function startStylesPass(input: StylesPassInput): Promise<StylesJobState> {
  return request<StylesJobState>('POST', '/v1/admin/triage/styles', input)
}

export async function cancelStylesPass(): Promise<boolean> {
  return (await request<{ cancelled: boolean }>('DELETE', '/v1/admin/triage/styles')).cancelled
}
