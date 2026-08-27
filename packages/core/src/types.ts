/**
 * Types partagés Memoria — miroir du schéma (spec §3) et du contrat core (spec §4).
 * Règle : le core ne connaît AUCUN hook d'hôte ; il ne parle que ce contrat.
 */

// ---------------------------------------------------------------------------
// Identités & gouvernance (registry.sqlite)
// ---------------------------------------------------------------------------

export type AssistantType = 'claude-code' | 'codex' | 'openclaw' | 'cursor' | 'robot' | 'generic'

export type OrgType = 'own_company' | 'client' | 'vendor' | 'partner'

export type ScopeKind =
  | 'private' // privé à une instance d'assistant
  | 'user' // partagé : tout ce qui décrit l'utilisateur humain
  | 'org' // partagé : une organisation (own_company incluse)
  | 'client' // partagé : un client (isolation dure inter-clients)
  | 'project' // partagé : un projet
  | 'shared_topic' // partagé : un sujet fin
  | 'legacy_to_review' // quarantaine d'import

export type SecretAccess = 'none' | 'refs_only' | 'value_on_request'

export type PairingStatus = 'pending' | 'completed' | 'expired' | 'revoked'

export interface HumanUser {
  id: string
  display_name: string
  local_profile_name: string | null
  created_at: string
}

export interface Assistant {
  id: string
  type: AssistantType
  display_name: string
  owner_user_id: string
  default_scopes: string[]
  created_at: string
}

/** Instance réelle = unité de DB et de pairing (ex. `codex@macbook-primo`). */
export interface AssistantInstance {
  id: string
  assistant_id: string
  machine_id: string
  profile_id: string | null
  created_at: string
  last_seen_at: string | null
  token_hash: string | null
  revoked_at: string | null
}

export interface Person {
  id: string
  display_name: string
  notes: string | null
  /** Relation à Primo : « collaboratrice », « stagiaire », « client », « owner »… */
  relation: string | null
  org_id: string | null
  /** Lié au human_user propriétaire si cette personne EST l'utilisateur (Néto). */
  user_id: string | null
  created_at: string
  updated_at: string | null
}

/** Pair machine de synchro (un spoke côté hub, ou le hub côté spoke). */
export interface SyncPeer {
  id: string
  machine_id: string
  display_name: string
  role: 'hub' | 'spoke'
  host: string | null
  peer_token_hash: string
  cpk_location: string
  allowed_scopes: string[]
  last_seen_at: string | null
  added_at: string
  revoked_at: string | null
}

/** Identifiant qui permet de reconnaître un interlocuteur (Telegram, mail, tel…). */
export interface PersonIdentifier {
  id: string
  person_id: string
  kind: 'phone' | 'email' | 'telegram' | 'whatsapp' | 'handle' | 'other'
  value: string
  label: string | null
  created_at: string
}

/** Personne + ses identifiants + rôles, pour l'UI et l'identification. */
export interface PersonProfile extends Person {
  identifiers: PersonIdentifier[]
}

export interface Organization {
  id: string
  name: string
  org_type: OrgType
  parent_org_id: string | null
  created_at: string
}

export interface Project {
  id: string
  name: string
  owner_org_id: string
  client_org_id: string | null
  status: 'active' | 'paused' | 'done' | 'archived'
  created_at: string
}

export interface MemoryScope {
  id: string
  type: ScopeKind
  name: string
  owner_user_id: string | null
  org_id: string | null
  client_org_id: string | null
  project_id: string | null
  created_at: string
}

export interface ScopePolicy {
  assistant_id: string
  scope_id: string
  can_read: boolean
  can_write: boolean
  can_share: boolean
  secret_access: SecretAccess
}

export interface Pairing {
  id: string
  assistant_instance_id: string
  code_hash: string
  status: PairingStatus
  created_at: string
  expires_at: string
}

/** Audit neutre : JAMAIS de contenu — uniquement action + hash de cible. */
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

export interface SecretRef {
  id: string
  name: string
  service: string | null
  location: string // ex. `keychain:memoria/<name>` ou `vault:secrets.enc#<name>`
  scope_id: string | null
  allowed_assistants: string[]
  sensitivity: Sensitivity
  last_verified_at: string | null
  created_at: string
}

export interface DbRegistryEntry {
  id: string
  kind: 'registry' | 'assistant' | 'shared'
  path: string
  assistant_instance_id: string | null
  scope_id: string | null
}

// ---------------------------------------------------------------------------
// Contenu (assistants/<instance>/memory.sqlite ; shared/<scope>.sqlite)
// ---------------------------------------------------------------------------

export type Sensitivity = 'normal' | 'sensitive' | 'critical'

export type LifecycleState = 'active' | 'dormant' | 'archived'

export type Visibility = 'private' | 'shared'

export interface Fact {
  id: string
  fact: string
  category: string
  fact_type: string
  confidence: number
  source: string
  assistant_instance_id: string | null
  user_id: string | null
  org_id: string | null
  client_org_id: string | null
  project_id: string | null
  topic_id: string | null
  scope_id: string
  sensitivity: Sensitivity
  visibility: Visibility
  tags: string[]
  entity_ids: string[]
  lifecycle_state: LifecycleState
  superseded: boolean
  superseded_by: string | null
  usefulness: number
  recall_count: number
  used_count: number
  relevance_weight: number
  created_at: string
  updated_at: string
  last_accessed_at: string | null
  /** Provenance synchro (présente sur les faits de scopes partagés). */
  origin_machine_id?: string | null
  origin_rev?: number
  content_hash?: string | null
  deleted_at?: string | null
}

export interface Procedure {
  id: string
  name: string
  description: string
  steps: string[]
  trigger_patterns: string[]
  success_count: number
  failure_count: number
  failure_reasons: string[] // ⚠ colonne ABSENTE dans le legacy (bug procedural.ts:1053) — présente ici
  scope_id: string
  assistant_instance_id: string | null
  project_id: string | null
  lifecycle_state: LifecycleState
  created_at: string
  updated_at: string
}

export interface Topic {
  id: string
  name: string
  scope_id: string | null
  share_policy: Record<string, unknown> | null
  sensitivity: Sensitivity
  importance_score: number
  keywords: string[]
  created_at: string
}

/** Anti-bug 768/1536 : model + dimensions TOUJOURS stockés, comparaison inter-dim interdite. */
export interface EmbeddingRow {
  id: string
  owner_type: 'fact' | 'procedure' | 'observation' | 'topic'
  owner_id: string
  model: string
  dimensions: number
  vector: Buffer // Float32Array sérialisé little-endian
  created_at: string
}

export interface WalEntry {
  id: number
  ts: string
  assistant_instance_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  processed: boolean
  attempts: number
}

// ---------------------------------------------------------------------------
// Contrat core (spec §4)
// ---------------------------------------------------------------------------

export interface ActiveContext {
  project_id?: string | null
  org_id?: string | null
  client_org_id?: string | null
  repo_path?: string | null
  topic?: string | null
  /** Qui parle à l'agent en ce moment (id de personne). null/absent = l'owner (Néto). */
  interlocutor_person_id?: string | null
}

export type CaptureMode = 'auto-private' | 'review-first' | 'incognito'

export interface StoreFactInput {
  instance: string // assistant_instance_id
  scope?: string // scope_id ; défaut = scope privé de l'instance
  content: string
  category?: string
  fact_type?: string
  confidence?: number
  source?: string
  sensitivity?: Sensitivity
  tags?: string[]
  org_id?: string | null
  client_org_id?: string | null
  project_id?: string | null
}

export interface RecallInput {
  instance: string
  query: string
  active_context?: ActiveContext
  /**
   * @deprecated Ignoré : un fait dormant attend une validation (review-first,
   * quarantaine d'import) et ne sort JAMAIS au recall. Gardé pour la
   * compatibilité des clients qui l'envoient encore.
   */
  include_dormant?: boolean
  include_secret_refs?: boolean
  limit?: number
  /** Cap dur de tokens injectés (anti-bruit, corrige format.ts legacy). */
  token_budget?: number
  /** Expansion graphe (voisins par entités partagées). Défaut activé. */
  expand_graph?: boolean
}

/**
 * Révision EN ATTENTE sur un souvenir remonté au recall.
 *
 * Un fait contredit par un plus récent reste ACTIF tant qu'un humain n'a pas
 * tranché (`RevisionEngine.accept()` est la seule voie vers la supersession —
 * règle d'or de la couche 18). Conséquence observée en bêta : le fait corrigé et
 * sa correction coexistaient au recall, sans que l'agent puisse les distinguer.
 * On ne supersède rien automatiquement — trop risqué, un faux positif masquerait
 * un souvenir valide en silence — mais on rend la contestation VISIBLE.
 */
import type { FactOrigin } from './engine/origin.js'

export interface PendingRevision {
  kind: 'obsolete' | 'contradicted' | 'duplicate'
  /** Fait plus récent proposé en remplacement (absent pour un obsolète pur). */
  replacement_fact_id?: string
}

export interface RecallItem {
  kind: 'fact' | 'procedure' | 'observation'
  id: string
  content: string
  category: string
  scope_id: string
  source_db: string // chemin/étiquette de la DB d'origine (fan-out)
  score: number
  created_at: string
  /** Présent UNIQUEMENT si une révision est proposée et non tranchée. */
  revision?: PendingRevision
  /** Niveau de vérité dérivé (déclaré / extrait / déduit / confirmé). */
  origin?: FactOrigin
}

export interface RecallResult {
  items: RecallItem[]
  totalFound: number
  /** Tokens estimés du bloc injecté (≤ budget). */
  tokens: number
  scopes_searched: string[]
}

export interface ForgetFilter {
  ids?: string[]
  scope_id?: string
  /** Sémantique ET : seuls les faits contenant TOUS les mots de la requête partent. */
  query?: string
  category?: string
  /** Requis dès qu'aucun `ids` n'est donné (requête comprise) : garde anti-suppression massive. */
  confirm_bulk?: boolean
  /** Ne supprime rien : renvoie seulement combien de faits partiraient (`matched`). */
  dry_run?: boolean
}

/**
 * Activité récente, dérivée de `audit_log`.
 *
 * Les latences ne couvrent QUE la période depuis l'instrumentation : les entrées
 * d'audit antérieures ne portent pas de `ms=`. Un champ absent signifie « pas
 * encore mesuré », jamais « zéro ».
 */
export interface DoctorActivity {
  last_recall_at?: string
  last_capture_at?: string
  recalls_24h: number
  captures_24h: number
  /** Moyenne et p95 en millisecondes sur les recalls récents mesurés. */
  recall_ms_avg?: number
  recall_ms_p95?: number
  /** Coût moyen, en tokens, du contexte réellement injecté. */
  recall_tokens_avg?: number
  capture_ms_avg?: number
}

/** État de la mémoire elle-même (volume, hygiène, dette de révision). */
export interface DoctorMemory {
  facts_total: number
  facts_superseded: number
  /** Faits jamais utilisés dans une réponse (candidats au ménage). */
  facts_never_used: number
  /** Révisions proposées et NON tranchées, par type. */
  contradictions_pending: number
  duplicates_pending: number
  /** Messages en attente d'extraction. */
  wal_pending: number
  /** Entrées bloquées : plusieurs tentatives d'extraction échouées. */
  wal_stuck: number
}

/**
 * Ce qui a QUITTÉ la machine. Vide sur une installation tout-local — ce qui est
 * en soi l'information la plus utile : rien n'est parti.
 */
export interface DoctorCloud {
  /** Envois sur 24 h, par fournisseur/modèle/finalité (tokens quand le fournisseur les a rapportés). */
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
  /** Volume total en caractères sur 24 h — jamais le contenu. */
  chars_24h: number
}

/** Fenêtre d'agrégation de la consommation des modèles. */
export type LlmUsagePeriod = '24h' | '7d' | '30d' | 'all'

/** Agrégat brut (registry) d'un couple fournisseur/modèle/finalité. */
export interface LlmUsageAggregate {
  provider: string
  model: string
  purpose: 'extraction' | 'embeddings'
  /** Modèle exécuté sur la machine (rien ne sort, coût nul). */
  local: boolean
  calls: number
  failures: number
  items: number
  chars: number
  ms_total: number
  /** null = aucun appel mesuré (le fournisseur ne rapporte pas ses tokens). */
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  /** Appels pour lesquels le fournisseur a rapporté des tokens. */
  calls_metered: number
  first_ts: string | null
  last_ts: string | null
}

/** Ligne enrichie du coût estimé (tarifs indicatifs, `pricing.ts`). */
export interface LlmUsageRow extends LlmUsageAggregate {
  /** USD. null = tarif inconnu ou aucun token mesuré (cloud). Local → 0. */
  estimated_cost_usd: number | null
  price_known: boolean
}

export interface LlmUsageReport {
  period: LlmUsagePeriod
  /** Borne basse ISO, null pour `all`. */
  since: string | null
  generated_at: string
  /** Date de référence des tarifs utilisés pour l'estimation. */
  pricing_as_of: string
  rows: LlmUsageRow[]
  totals: {
    calls: number
    failures: number
    input_tokens: number | null
    output_tokens: number | null
    /** null si aucune ligne n'a pu être chiffrée. */
    estimated_cost_usd: number | null
    /** Appels dont le coût n'a pas pu être estimé (tarif inconnu / non mesuré). */
    unpriced_calls: number
    /** Appels sans mesure de tokens. */
    unmetered_calls: number
  }
}

/** Statut d'un message confié à la capture (suivi post-timeout). */
export interface CaptureStatusEntry {
  wal_id: number
  status: 'pending' | 'retrying' | 'done' | 'failed'
  attempts: number
}

export interface CaptureStatusResult {
  entries: CaptureStatusEntry[]
  pending: number
  retrying: number
  done: number
  failed: number
}

export interface DoctorReport {
  ok: boolean
  storage_root: string
  config_path: string
  registry_path: string
  databases: Array<{ kind: string; path: string; exists: boolean; size_bytes: number; wal_pending?: number }>
  network_guard: { on_network_volume: boolean; journal_mode: string }
  activity: DoctorActivity
  memory: DoctorMemory
  cloud: DoctorCloud
  /** Consommation des modèles sur 24 h (tous fournisseurs, locaux compris). */
  usage: LlmUsageReport
  warnings: string[]
}

export interface MemoriaEvent {
  type: string
  ts: string
  payload: Record<string, unknown>
}
