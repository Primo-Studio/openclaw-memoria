/**
 * Memoria — le moteur (spec §4). Aucune dépendance d'hôte.
 * P1 : identité/pairing, storeFact, recall fan-out gouverné, forget hard-delete,
 * doctor/stats. Capture pipeline (WAL→redaction→extraction) arrive en P2,
 * MCP/UI en P3 — voir docs/v3/STATUS.md.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { cpus, hostname, totalmem } from 'node:os'
import { dirname, join, relative } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import { importLegacyCognition } from '../migration/import-cognition.js'
import { importTranscripts } from '../migration/import-transcripts.js'
import { CHATGPT_EXTRACTION_SYSTEM } from '../migration/chatgpt-export.js'
import {
  ensureStorageTree,
  loadConfigFile,
  resolveStorageRoot,
  saveConfigFile,
  storagePaths,
  type ResolveOptions,
  type ResolvedConfig,
} from '../config.js'
import { RegistryStore } from '../storage/registry.js'
import { isOnNetworkVolume } from '../storage/network-guard.js'
import {
  ContentStore,
  normalizeText,
  queryTokens,
  RECALL_FTS_OPEN_BUDGET_MS,
  rowToFact,
  type FactRow,
  type FtsHit,
  type FtsSearchOptions,
} from '../storage/content.js'
import { EmbeddingIndexer, hybridSearchFacts } from '../vector/index.js'
import {
  CognitionEngine,
  TopicEngine,
  PatternEngine,
  ProceduralEngine,
  FeedbackEngine,
  type ReinforceResult,
  ClusterEngine,
  SelfObservationEngine,
  RevisionEngine,
  AutoSkillEngine,
  MarkdownSync,
  dialectic,
  type TopicSummary,
  type TopicGraph,
  type Pattern,
  type ProcedureMatch,
  type ProceduralProcedure,
  type SelfObservation,
  type DialecticResult,
  type ExpandResult,
  cleanTopicLabel,
  topicSlug,
} from '../cognition/index.js'
import { estimateTokens, factNormHash, newId, nowISO, sha256Hex } from '../util.js'
import { AesVaultProvider, createSecretProvider, RegexRedactor } from '../secrets/index.js'
import type { DetectedSecret, SecretProvider } from '../secrets/types.js'
import { EXPERTISE_MAX } from '../cognition/feedback.js'
import { factOrigin } from './origin.js'
import { findDuplicate, normalizeFact, type DuplicateMatch } from './selective.js'
import {
  collectVectors,
  countVectors,
  countPlaceable,
  countUnplaced,
  lastComputedAt,
  mapLinks,
  readMapPoints,
  writeProjection,
  type MemoryMap,
  type MemoryMapAgent,
  type MemoryMapLinks,
  type MemoryMapPoint,
  type MemoryMapSource,
} from '../cognition/memory-map.js'
import { runProjection } from '../cognition/projection.js'
import {
  resolveLlmProfile,
  auditExtraction,
  auditEmbeddings,
  formatCloudSend,
  meterExtraction,
  meterEmbeddings,
  estimateCostUsd,
  priceFor,
  PRICING_AS_OF,
  type UsageSink,
} from '../llm/index.js'
import type { CloudAuditSink } from '../llm/index.js'
import type { LlmOptions } from '../llm/detect.js'
import type { EmbeddingProvider, LlmProvider } from '../llm/provider.js'
import { CapturePipeline, type CaptureTurnInput, type CaptureTurnResult } from './capture.js'
import type { WalReplaySummary } from './wal.js'
import { isProceduralQuery, passesClientIsolation, scoreFact } from './scoring.js'
import { applyRecallCutoff, buildRecallBlocks, rankEntities } from './recall-format.js'
import { localMachineId, nextRev } from '../sync/clock.js'
import { contentHash } from '../sync/merge.js'
import { SyncEngine, type SyncConfig } from '../sync/engine.js'
import { effectiveSyncTypes, normalizeSyncTypes, repointScopeColumns } from '../sync/scopes.js'
import { freshGroupKeys } from '../secrets/index.js'
import { TriageService, type TriageServiceHost } from '../triage/service.js'
import { copyTriageRows, emptyRow, readTriageRows, rowFromDb as rowFromTriageDb, upsertTriageRows } from '../triage/store.js'
import { dot, float32FromBlob, normalizeVector, numberSignature, quantizeInt8, REDITE_THRESHOLD } from '../triage/dedup.js'
import { isSensitive as isTriageSensitive } from '../triage/sensitive.js'
import { knn, listVecTables, vecTableName } from '../vector/vec-table.js'
import {
  TEAM_REFUSED_RUBRIQUES,
  TEAM_SHARE_GENRES,
  TEAM_SHARE_REFUSALS,
  TRIAGE_PROMPT_VERSION,
  TriageRefusedError,
  type IdeaItem,
  type IdeasFilter,
  type IdeasResult,
  type SemanticDuplicate,
  type StorePendingTriagedInput,
  type StorePendingTriagedResult,
  type StylesPassFn,
  type StylesQuery,
  type StylesResult,
  type TriagePromoteOptions,
  type TriageListFilter,
  type TriagePromoteResult,
  type TriageRow,
  type TeamShareRefusal,
  type TeamShareRefusedCounts,
  type UserMessageSourceKind,
  type UserMessagesPassFn,
} from '../triage/types.js'
import { filterConditions } from '../triage/store.js'
import type {
  AssistantInstance,
  AssistantType,
  CaptureMode,
  DbRegistryEntry,
  DoctorEngine,
  DoctorReport,
  LlmUsagePeriod,
  LlmUsageReport,
  LlmUsageRow,
  Fact,
  ForgetFilter,
  MemoryScope,
  Person,
  PersonIdentifier,
  PersonProfile,
  ActiveContext,
  RecallDropped,
  RecallInput,
  RecallItem,
  RecallLink,
  RecallMatch,
  PendingRevision,
  DoctorActivity,
  DoctorMemory,
  DoctorCloud,
  CaptureStatusResult,
  RecallResult,
  RevisionProposalDetailed,
  StoreFactInput,
} from '../types.js'

/** État d'un moteur (extraction ou embeddings) dans le bilan de santé LLM. */
export interface LlmEngineHealth {
  provider: string
  model: string
  available: boolean
  /** Pourquoi le moteur est indisponible — TOUJOURS présent quand available=false. */
  reason?: string
  /** Embeddings seulement : faits actifs sans vecteur pour le modèle courant (à (ré)indexer). */
  pending?: number
}

/** Bilan de santé LLM (GET /v1/admin/llm_health) — anti-mort-silencieuse. */
export interface LlmHealthReport {
  extraction: LlmEngineHealth
  embeddings: LlmEngineHealth
  /** Entrées WAL en attente d'extraction, toutes instances confondues. */
  wal_pending: number
  options: LlmOptions
}

export interface PairAssistantInput {
  type: AssistantType
  display_name?: string
  machine?: string
  profile?: string | null
}

export interface PairAssistantResult {
  assistant_id: string
  assistant_instance_id: string
  pairing_code: string
  /** Commande à copier-coller dans le chat de l'agent (D4). */
  command: string
}

export interface MemoriaInitOptions extends ResolveOptions {
  userDisplayName?: string
  /**
   * Override du profil LLM (tests, daemon piloté). `undefined` = résolution
   * automatique (Ollama/Anthropic selon config) au premier captureTurn.
   * `{ extraction: null }` = capture sans LLM (WAL seul).
   */
  llm?: { extraction: LlmProvider | null; embeddings?: EmbeddingProvider | null }
  /** Coffre forcé (tests : 'aes-vault' pour ne jamais toucher le Keychain réel). */
  secretsVault?: 'keychain-macos' | 'aes-vault'
  /** Coffre INJECTÉ (tests : simuler un Trousseau qui refuse) — prime sur secretsVault. */
  secretProvider?: SecretProvider
}

/**
 * Résultat d'une déclaration de fait PAR UN AGENT (`declareFact`) : soit un
 * fait (actif, ou dormant en mode « Revue d'abord »), soit un refus ANNONCÉ
 * en mode « Pause » — jamais une écriture muette, jamais un non-écrit muet.
 */
export type DeclareFactResult =
  | { fact: Fact; skipped: false; mode: CaptureMode }
  | { fact: null; skipped: true; reason: 'paused'; mode: CaptureMode }

/**
 * Nom court de l'espace de l'ENTREPRISE, accepté partout où l'on désigne un
 * scope cible (store_fact, partage, promotion du tri) : `org` désigne l'espace
 * d'équipe quel que soit son identifiant `org:<uuid>` (voir `teamScope`).
 */
export const TEAM_SCOPE_ALIAS = 'org'

/** Rôle de la machine dans le partage d'équipe (config `[sharing] machine`). */
export type SharingMachineRole = 'owner' | 'team'

/** Résultat d'un partage. `refused` : vers l'espace d'équipe seulement, faits écartés par raison. */
export interface ShareFactsResult {
  shared: number
  scope: string
  refused?: TeamShareRefusedCounts
}

/** Référence posée par le masquage à la place d'un secret (`[secret:<nom>]`). */
const SECRET_REF = '[secret:'

/** Agents qui, sur un Mac d'équipe, écrivent dans l'espace d'équipe dès l'appairage. Jamais OpenClaw. */
const TEAM_WRITER_TYPES: readonly AssistantType[] = ['claude-code', 'codex']

/** Début de tout refus d'écriture dans l'espace d'équipe (403 côté daemon, message propre côté MCP). */
const TEAM_WRITE_REFUSED = "écriture refusée dans l'espace d'équipe (org)"

const DEFAULT_TOKEN_BUDGET = 1500
const DEFAULT_RECALL_LIMIT = 12
/** Délai de regroupement des indexations d'embeddings déclenchées par storeFact. */
const EMBEDDINGS_DEBOUNCE_MS = 250
/** Écart entre deux tranches du remplissage de fond de l'index de rappel (la boucle respire). */
const RECALL_INDEX_STEP_DELAY_MS = 50
/** Nouvel essai du remplissage après une erreur (base verrouillée par un autre processus…). */
const RECALL_INDEX_RETRY_MS = 60_000
/**
 * File de revue : items `pending` de type fait, avec leur source et leur fait.
 * PARTAGÉ par listReview et countReview : le badge compte exactement ce que la
 * liste montrerait (un item dont le fait a été oublié n'y figure pas).
 */
const REVIEW_QUEUE_FROM = `FROM memory_import_items i
           JOIN memory_sources s ON s.id = i.source_id
           JOIN facts f ON f.id = i.target_memory_id
           WHERE i.status = 'pending' AND i.target_type = 'fact'`
/**
 * Délai avant la cognition d'un fait DÉCLARÉ (store_fact, partage). Plus long
 * que celui des embeddings : une rafale d'écritures donne un seul passage, et
 * chaque fait peut coûter un appel LLM d'extraction.
 */
const COGNITION_DEBOUNCE_MS = 1500
/** Faits traités par base et par lot (plafond historique d'un passage ordinaire). */
const COGNITION_BATCH = 2000
/** Faits rangés par thème entre deux retours à la boucle d'événements. */
const COGNITION_TOPIC_SLICE = 20
/**
 * Extractions ratées d'affilée qui arrêtent un rattrapage LLM. Chez un
 * fournisseur cloud, isAvailable() veut dire « clé présente » : une API en
 * panne (réseau, 401, 429, quota) ne se voit qu'à l'échec des appels.
 */
const COGNITION_LLM_MAX_CONSECUTIVE_FAILURES = 3
/** Les amas se recalculent au plus une fois par jour hors rattrapage. */
const CLUSTER_REBUILD_INTERVAL_MS = 24 * 60 * 60 * 1000
/**
 * Au-delà, le recalcul des amas est sauté : son coût croît comme le carré du
 * nombre de faits (mesuré sur données fictives : 0,1 s pour 1 000 faits, 0,9 s
 * pour 3 000, 3,3 s pour 6 000). Le calcul est découpé (ClusterEngine.rebuildAsync
 * rend la main toutes les 15 ms), donc il ne fige plus le daemon ; ces plafonds
 * bornent seulement le temps de calcul total : environ une seconde pour le
 * passage automatique, une dizaine pour le rattrapage, lancé à la main.
 */
const CLUSTER_AUTO_MAX_FACTS = 3000
const CLUSTER_CATCHUP_MAX_FACTS = 10_000

/** Faits validés par transaction dans promoteTriaged (une page de l'écran de tri). */
const PROMOTE_SLICE = 50
/**
 * Membres EN ATTENTE d'un amas. `INDEXED BY` : sans lui, le planificateur
 * part de `idx_facts_lifecycle` (deux égalités) et balaie tous les dormants
 * (mesuré : 39 ms par fait sur 70 000, 0,05 ms par l'index des amas).
 */
export const PROMOTE_MEMBERS_SQL = `SELECT t.fact_id AS id FROM fact_triage t INDEXED BY idx_fact_triage_amas JOIN facts f ON f.id = t.fact_id
  WHERE t.amas_id = ? AND t.fact_id != ? AND f.lifecycle_state = 'dormant' AND f.superseded = 0 AND f.deleted_at IS NULL`
/** Genres dont les redites sont cherchées parmi les faits en attente (passe sur les messages). */
const TRIAGE_VEC_GENRES = "('idee','decision','preference','style','process','lecon')"
/**
 * Page de construction du cache des redites : une fenêtre de rowid de
 * `fact_triage_vectors` (bornée même si peu de lignes passent le filtre).
 * `CROSS JOIN` fixe l'ordre : sans lui, le planificateur pourrait partir des
 * dormants de `facts` (même piège que les membres d'amas).
 */
export const TRIAGE_VEC_PAGE_SQL = `SELECT v.rowid AS rid, v.fact_id AS id, f.fact AS fact, v.vector AS vector, v.dimensions AS dimensions
  FROM fact_triage_vectors v CROSS JOIN facts f CROSS JOIN fact_triage t
  WHERE v.rowid >= ? AND v.rowid < ? AND v.model = ? AND f.id = v.fact_id AND t.fact_id = v.fact_id
    AND f.superseded = 0 AND f.deleted_at IS NULL AND f.lifecycle_state = 'dormant'
    AND t.sensible = 0 AND t.genre IN ${TRIAGE_VEC_GENRES}
  ORDER BY v.rowid DESC`
/** Largeur d'une page (rowid) : quelques ms de blocage au plus. */
const TRIAGE_VEC_PAGE = 512
/** Vecteurs int8 par bloc (ajouts sans recopie). */
const TRIAGE_VEC_BLOCK = 1024
/**
 * Plafond du cache des redites, toutes bases : octets de vecteurs int8.
 * Le parcours coûte ~1 ms par Mo (mesuré) : 32 Mo ≈ 30 ms au pire par appel,
 * soit ~21 800 vecteurs de 1 536 d. Au-delà, les plus anciens sont laissés de
 * côté (le passage du moteur les regroupe de toute façon en amas).
 */
const TRIAGE_VEC_MAX_BYTES = 32 * 1024 * 1024
/** Marge au-delà du plafond pour les faits écrits PENDANT la passe (ses propres redites). */
const TRIAGE_VEC_APPEND_MARGIN_BYTES = 4 * 1024 * 1024

/**
 * Vecteurs de tri des faits en attente d'une base, gardés le temps d'une
 * passe sur les messages : int8 contigus par bloc, norme précalculée, jamais
 * le texte (relu en base avant de rendre un candidat).
 */
interface TriageVecCache {
  model: string
  dims: number
  blocks: Int8Array[]
  /** 1 / norme du vecteur int8 (0 pour un vecteur nul). */
  invNorms: number[]
  /** Composantes [0, split) d'abord ; norme (normée) du reste [split, dims) pour la borne de Cauchy-Schwarz. */
  split: number
  restNorms: number[]
  /** Signature des nombres du texte (garde chiffres) ; null = écarté (relu invalide). */
  sigs: Array<string | null>
  ids: string[]
  count: number
  /** Pages lues par rowid décroissant : prochaine borne haute (exclue), plus petit rowid à lire. */
  cursor: number
  floor: number
  complete: boolean
  truncated: boolean
  /** Construction en cours (arrière-plan), ou null. */
  building: Promise<void> | null
}

/** Relecture d'un candidat du cache avant de le rendre comme redite. */
const TRIAGE_VEC_RECHECK_SQL = `SELECT f.fact AS fact FROM facts f JOIN fact_triage t ON t.fact_id = f.id
  WHERE f.id = ? AND f.lifecycle_state = 'dormant' AND f.superseded = 0 AND f.deleted_at IS NULL AND t.sensible = 0`

/** Début de la seconde partie d'un vecteur : premier quart arrondi à un multiple de 4 (0 sous 16 d : pas de borne). */
function triageVecSplit(dims: number): number {
  return (dims >> 2) & ~3
}

/**
 * Candidats du cache au-dessus du seuil, mêmes nombres (signature) que la
 * requête. Score = requête normée · int8 / norme de l'int8 : le cosinus de
 * l'ancien calcul (vecteur relu puis normé), sans recopie en float.
 *
 * Borne exacte (Cauchy-Schwarz) après le premier quart : le reste du produit
 * ne dépasse jamais |requête reste| × |vecteur reste|. Un vecteur qui ne peut
 * plus atteindre le seuil est laissé là, sans redite manquée. Mesuré sur
 * 21 800 vecteurs denses de 1 536 d : ~26 → ~7 ms.
 */
function scanTriageVec(cache: TriageVecCache, v: Float32Array, sig: string, hit: (k: number, score: number) => void): void {
  const d = cache.dims
  const dq = cache.split
  const d4 = d - ((d - dq) % 4)
  const sigs = cache.sigs
  const invNorms = cache.invNorms
  const restNorms = cache.restNorms
  let vr = 0
  for (let i = dq; i < d; i++) vr += v[i]! * v[i]!
  vr = Math.sqrt(vr)
  // Marge d'arrondi : on ne laisse un vecteur que s'il est franchement sous le seuil.
  const cut = REDITE_THRESHOLD - 1e-6
  // Index courant plutôt que `o + i` : mesuré ~25 % plus rapide (V8).
  for (let b = 0; b < cache.blocks.length; b++) {
    const data = cache.blocks[b]!
    const base = b * TRIAGE_VEC_BLOCK
    const n = Math.min(TRIAGE_VEC_BLOCK, cache.count - base)
    for (let j = 0, p = 0; j < n; j++, p += d) {
      const k = base + j
      if (sigs[k] !== sig) continue
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let s3 = 0
      for (let i = 0, q = p; i < dq; i += 4, q += 4) {
        s0 += data[q]! * v[i]!
        s1 += data[q + 1]! * v[i + 1]!
        s2 += data[q + 2]! * v[i + 2]!
        s3 += data[q + 3]! * v[i + 3]!
      }
      const w = invNorms[k]!
      if ((s0 + s1 + s2 + s3) * w + vr * restNorms[k]! < cut) continue
      for (let i = dq, q = p + dq; i < d4; i += 4, q += 4) {
        s0 += data[q]! * v[i]!
        s1 += data[q + 1]! * v[i + 1]!
        s2 += data[q + 2]! * v[i + 2]!
        s3 += data[q + 3]! * v[i + 3]!
      }
      for (let i = d4; i < d; i++) s0 += data[p + i]! * v[i]!
      const score = (s0 + s1 + s2 + s3) * w
      if (score >= REDITE_THRESHOLD) hit(k, score)
    }
  }
}

/** Options d'un passage de cognition (voir Memoria.processCognition). */
export interface CognitionPassOptions {
  /** Rattrapage : reprend aussi les faits marqués `backfill` par la migration, sans plafond de lot. */
  includeBackfill?: boolean
  /**
   * Avec `includeBackfill` seulement : autorise le LLM d'extraction (un appel
   * par fait). Défaut false : heuristique seule, aucun appel LLM.
   */
  llm?: boolean
  /**
   * Avec `includeBackfill` seulement : nombre maximal de faits traités par ce
   * passage. C'est la borne du coût en mode LLM (un appel par fait). Le reste
   * attend le rattrapage suivant. Absent = pas de plafond.
   */
  maxFacts?: number
  /** Avancement, appelé après chaque fait et à la fin de chaque base. */
  onProgress?: (progress: CognitionProgress) => void
}

export interface CognitionProgress {
  dbs_total: number
  dbs_done: number
  processed: number
  errors: number
}

export interface CognitionPassResult {
  /** Faits traités (marqueur posé). */
  processed: number
  /** Parmi eux, ceux dont l'extraction est passée par le LLM (= appels LLM d'extraction réussis). */
  llm_facts: number
  /** Faits en échec, mis de côté jusqu'au redémarrage (jamais rejoués en boucle). */
  errors: number
  /** Bases dont les amas ont été recalculés. */
  clusters_rebuilt: number
  /** Bases trop grosses pour un recalcul des amas sans figer le daemon (absent = aucune). */
  clusters_skipped?: number
  /** Vrai si `maxFacts` a arrêté le rattrapage avant la fin : il reste des faits à reprendre. */
  capped?: boolean
  /** Vrai si le rattrapage a été annulé (cancelCognitionCatchup) : le reste attend le lancement suivant. */
  cancelled?: boolean
}

/** Source d'un item de revue autre que « capture-review » (passe sur les messages : « user-messages »). */
interface ReviewSourceSpec {
  type: string
  key: string
  path?: string | null
  metadata?: Record<string, unknown>
}

/** Demande de passage en attente : plusieurs appels se fondent en une seule. */
interface CognitionRequest {
  /** null = toutes les bases. */
  instances: Set<string> | null
  includeBackfill: boolean
  llm: boolean
  /** null = pas de plafond. */
  maxFacts: number | null
  listeners: Array<(progress: CognitionProgress) => void>
  promise: Promise<CognitionPassResult>
  /** Annulation demandée (rattrapage seulement), lue entre deux faits. */
  cancelled: boolean
}

/** Rend la main à la boucle d'événements (le daemon sert ses requêtes HTTP entre deux faits). */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
/** Plafond du niveau d'expertise AMORCÉ depuis le volume de thèmes (jamais « expert » sans usage réel). */
const BOOTSTRAP_EXPERTISE_CAP = 0.4

export class Memoria {
  readonly resolved: ResolvedConfig
  readonly paths: ReturnType<typeof storagePaths>
  readonly registry: RegistryStore
  private readonly pool = new Map<string, ContentStore>()
  private closed = false

  private readonly secretProvider: SecretProvider
  /** Coffre AES local de REPLI quand le coffre principal (Trousseau) refuse d'écrire — ouvert à la demande. */
  private fallbackVault: AesVaultProvider | null = null
  private readonly redactor = new RegexRedactor()
  private syncEngine?: SyncEngine
  private readonly llmOverride: MemoriaInitOptions['llm']
  private pipelinePromise: Promise<CapturePipeline> | null = null
  private profilePromise: Promise<{ extraction: LlmProvider | null; embeddings: EmbeddingProvider | null }> | null = null
  /** Empreinte (provider/modèle) du dernier profil résolu — pour détecter un changement réel. */
  private profileSnapshot: { extraction: string | null; embeddings: string | null } | null = null
  private profileResolvedAt = 0
  /**
   * Délai avant de RE-résoudre un profil INCOMPLET (extraction ou embeddings
   * à null). Le daemon est lancé par launchd avant l'app Ollama : sans cela,
   * un Ollama éteint au boot laissait la capture en « defer no-llm » pour
   * toute la vie du processus, pendant que llmHealth affichait « prêt ».
   * Public pour les tests (0 = relance immédiate).
   */
  profileRetryMs = 60_000
  /** Instances dont l'indexation d'embeddings est planifiée (storeFact, debounce). */
  private readonly indexQueue = new Set<string>()
  private indexTimer: NodeJS.Timeout | null = null
  /** Instances dont la cognition est planifiée (storeFact, partage), même principe. */
  private readonly cognitionQueue = new Set<string>()
  /** Vrai si la cognition planifiée doit couvrir TOUTES les bases (partage : pas d'instance). */
  private cognitionQueueAll = false
  private cognitionTimer: NodeJS.Timeout | null = null
  /** Public pour les tests (0 = au prochain tour de boucle). */
  cognitionDebounceMs = COGNITION_DEBOUNCE_MS
  /** File des passages de cognition : un seul tourne à la fois. */
  private cognitionChain: Promise<void> = Promise.resolve()
  /** Passage en attente par nature (ordinaire, rattrapage heuristique, rattrapage LLM). */
  private readonly cognitionWaiting = new Map<string, CognitionRequest>()
  /** Passage en train de tourner (pour pouvoir annuler un rattrapage). */
  private cognitionRunning: CognitionRequest | null = null
  /**
   * Faits mis de côté pour la vie du processus : extraction LLM tentée et
   * ratée, ou traitement en erreur. Sans cela ils repartaient au LLM à chaque
   * passage, donc désormais à chaque store_fact.
   */
  private readonly cognitionSkip = new Set<string>()
  /** Bases dont les liens hérités des faits critical ont été purgés par ce processus (voir runCognitionPass). */
  private readonly criticalPurged = new Set<string>()
  /** Dernier recalcul des amas par base (ms), en plus de la date lue en base. */
  private readonly clustersRebuiltAt = new Map<string, number>()
  /** Calcul de la carte des souvenirs en cours (un seul à la fois). */
  private mapJob: Promise<void> | null = null
  private mapError: string | null = null
  /** Heure (ms) du dernier calcul en échec ; remise à zéro par un calcul réussi. */
  private mapFailedAt: number | null = null
  /**
   * État des données au dernier calcul tenté (réussi ou non) : modèle, nombre
   * de vecteurs, nombre de souvenirs encore plaçables. Tant qu'il n'a pas
   * changé, aucun calcul AUTOMATIQUE ne repart : un calcul qui échoue, ou des
   * vecteurs impossibles à placer, relanceraient sinon un calcul complet à
   * chaque lecture de la carte. Le nombre de plaçables compte aussi : des faits
   * remplacés un pour un laissent le nombre de vecteurs inchangé.
   * `pending` : le calcul a échoué, la prochaine lecture relève l'état.
   */
  private mapAttempt: { model: string; vectors: number; placeable: number } | 'pending' | null = null
  private indexers = new WeakMap<ContentStore, EmbeddingIndexer>()
  private readonly cognitionEngines = new WeakMap<ContentStore, CognitionEngine>()
  private readonly topicEngines = new WeakMap<ContentStore, TopicEngine>()
  private readonly patternEngines = new WeakMap<ContentStore, PatternEngine>()
  private readonly proceduralEngines = new WeakMap<ContentStore, ProceduralEngine>()
  private readonly feedbackEngines = new WeakMap<ContentStore, FeedbackEngine>()
  private readonly clusterEngines = new WeakMap<ContentStore, ClusterEngine>()
  private readonly selfObsEngines = new WeakMap<ContentStore, SelfObservationEngine>()
  private readonly revisionEngines = new WeakMap<ContentStore, RevisionEngine>()
  /** Tri des souvenirs (voir triage/). */
  readonly triage: TriageService
  /** Passe sur les messages de l'utilisateur, branchée par l'hôte (jamais importée ici). */
  private userMessagesPassFn: UserMessagesPassFn | null = null
  /** Passe styles, branchée par l'hôte (jamais importée ici). */
  private stylesPassFn: StylesPassFn | null = null

  private constructor(resolved: ResolvedConfig, opts: MemoriaInitOptions) {
    this.resolved = resolved
    this.paths = storagePaths(resolved.storageRoot)
    ensureStorageTree(resolved.storageRoot)
    this.registry = new RegistryStore(this.paths.registry)
    this.registry.bootstrap(opts.userDisplayName)
    // AVANT registerDb : sinon le registre déplacé se ré-enregistrait sous son
    // nouveau chemin à côté de l'ancienne entrée (deux « registres »).
    this.rebaseDbRegistry()
    this.registry.registerDb({ kind: 'registry', path: this.paths.registry, assistant_instance_id: null, scope_id: null })
    this.secretProvider = opts.secretProvider ?? createSecretProvider(this.paths.secretsDir, { force: opts.secretsVault })
    this.llmOverride = opts.llm
    this.grantDefaultUserWrite()
    this.grantTeamWriteDefault()
    this.triage = new TriageService(this.triageHost())
  }

  /**
   * Branche la passe sur les messages de l'utilisateur (`triage/user-messages.ts`).
   * L'hôte (daemon) l'appelle au démarrage ; le moteur ne l'importe jamais.
   */
  registerUserMessagesPass(fn: UserMessagesPassFn): void {
    this.userMessagesPassFn = fn
  }

  /**
   * Branche la passe styles (`triage/styles-pass.ts`). Même règle : l'hôte
   * (daemon) l'appelle au démarrage, le moteur ne l'importe jamais.
   */
  registerStylesPass(fn: StylesPassFn): void {
    this.stylesPassFn = fn
  }

  /**
   * Décision produit (27/08, « améliorer les souvenirs entre les modèles ») :
   * les agents ÉCRIVENT dans `user` par défaut. Migration douce des installations
   * existantes : une policy `user` sans can_write est ouverte SAUF si
   * l'utilisateur l'a réglée lui-même (audit set_scope_access) — son choix
   * prime. Idempotent (rien à faire une fois ouverte).
   */
  private grantDefaultUserWrite(): void {
    const userScope = this.registry.getScopeByName('user')
    if (!userScope) return
    const touched = this.registry.db.prepare(
      "SELECT 1 FROM audit_log WHERE action = 'set_scope_access' AND target_id_hash = ? LIMIT 1",
    )
    for (const assistant of this.registry.listAssistants()) {
      // Un agent de canal (OpenClaw : WhatsApp/Telegram, exposé à des tiers)
      // reste en LECTURE seule sur `user` : sinon un interlocuteur externe peut
      // lui faire écrire un « fait sur l'utilisateur » lu par tous les autres
      // modèles (surface d'injection, revue 27/08). Son partage passe par la revue.
      if (assistant.type === 'openclaw') continue
      const policy = this.registry.getPolicy(assistant.id, userScope.id)
      if (!policy || policy.can_write) continue
      if (touched.get(sha256Hex(`${assistant.id}:${userScope.id}`))) continue
      this.registry.setPolicy({ ...policy, can_write: true })
      this.registry.audit({
        actor_type: 'system',
        actor_id: 'migration',
        action: 'grant_user_write_default',
        target_id_hash: sha256Hex(`${assistant.id}:${userScope.id}`),
        scope_id: userScope.id,
        reason: null,
      })
    }
  }

  // ------------------------------------------------------------ espace d'équipe (org)

  /** Rôle de cette machine dans le partage d'équipe : `owner` (défaut) ou `team`. */
  machineRole(): SharingMachineRole {
    return this.resolved.config.sharing?.machine === 'team' ? 'team' : 'owner'
  }

  /**
   * Écrit la config en mémoire dans config.toml. `[sharing]` n'est réglé par
   * aucune route, seulement à la main dans le fichier : il est relu sur le
   * disque au moment d'écrire. Sans cela, un join (ou un réglage) fait entre
   * l'ajout de `machine = "team"` et le redémarrage l'effaçait, et le Mac
   * repartait en `owner`. Le rôle en service ne change qu'au redémarrage.
   */
  private saveConfig(): void {
    let next = this.resolved.config
    try {
      const sharing = loadConfigFile(this.resolved.configPath).sharing
      next = { ...this.resolved.config }
      if (sharing) next.sharing = sharing
      else delete next.sharing
    } catch {
      // fichier illisible : on l'écrase comme avant, avec la config en mémoire
    }
    saveConfigFile(next, this.resolved.configPath)
  }

  /**
   * L'espace de l'ENTREPRISE (scope `org`), retrouvé par son type et son lien,
   * jamais par son nom `org:<uuid>` (renommé ou repris d'un autre Mac, il
   * change). Dans l'ordre :
   *  1. sur un Mac d'équipe relié, l'org repris du hub (dans les scopes
   *     autorisés du pair hub). Depuis la reprise sans perte (`adoptScope`),
   *     c'est le même que le 2 : l'org local a pris l'id du hub en gardant
   *     son organisation. Le 1 reste pour l'état laissé par l'ancien code
   *     (une ligne à part, sans organisation, à côté de l'org local) ;
   *  2. l'org de l'organisation `own_company` : `registry.ownOrgScope()`, le
   *     MÊME résolveur que la reprise au join et que bootstrap, pour que
   *     l'alias et la synchro ne visent jamais deux lignes différentes ;
   *  3. le seul scope org, s'il n'y en a qu'un.
   * null : aucun, ou plusieurs sans lien clair (on ne devine pas).
   * Lecture du registre seulement (quelques lignes) : rien n'est balayé.
   */
  teamScope(): MemoryScope | null {
    this.assertOpen()
    const orgs = this.registry.listScopes().filter(s => s.type === 'org')
    if (orgs.length === 0) return null
    const fromHub = new Set(this.registry.listPeers().filter(p => p.role === 'hub').flatMap(p => p.allowed_scopes))
    const adopted = orgs.find(s => fromHub.has(s.id))
    if (adopted) return adopted
    const mine = this.registry.ownOrgScope()
    if (mine) return mine
    return orgs.length === 1 ? orgs[0]! : null
  }

  /** Tous les scopes de type org (doublon de reprise compris) : ce qui y est déjà n'est plus un candidat équipe. */
  private teamScopeIds(): string[] {
    return this.registry
      .listScopes()
      .filter(s => s.type === 'org')
      .map(s => s.id)
  }

  /** Scope désigné par un id, un nom, ou l'alias `org`. null : inconnu. */
  private resolveScopeRef(ref: string): MemoryScope | null {
    if (ref === TEAM_SCOPE_ALIAS) return this.teamScope()
    return this.registry.getScope(ref) ?? this.registry.getScopeByName(ref)
  }

  /**
   * Mac d'équipe : un agent Claude Code ou Codex reçoit lecture ET écriture sur
   * l'espace d'équipe, s'il n'a encore AUCUNE politique sur ce scope (un
   * réglage existant, fait à la main ou non, n'est jamais modifié). OpenClaw
   * n'est jamais servi ici : bot joignable par des tiers. Sur le Mac du
   * propriétaire, rien : ses faits n'entrent dans `org` que par sa validation.
   */
  private grantTeamWrite(assistant: { id: string; type: AssistantType }, reason: string): void {
    if (this.machineRole() !== 'team' || !TEAM_WRITER_TYPES.includes(assistant.type)) return
    const scope = this.teamScope()
    if (!scope || this.registry.getPolicy(assistant.id, scope.id)) return
    this.registry.setPolicy({
      assistant_id: assistant.id,
      scope_id: scope.id,
      can_read: true,
      can_write: true,
      can_share: false,
      secret_access: 'none',
    })
    this.registry.audit({
      actor_type: 'system',
      actor_id: reason,
      action: 'grant_team_write_default',
      target_id_hash: sha256Hex(`${assistant.id}:${scope.id}`),
      scope_id: scope.id,
      reason: `type=${assistant.type}`,
    })
  }

  /**
   * Même droit au démarrage, pour les agents appairés AVANT le passage en
   * `team`. L'ordre « join » puis « team », ou l'inverse, est indifférent :
   * la reprise de l'org du hub change son id en emmenant les politiques
   * (`reIdScope`), donc un droit déjà posé suit, et n'est pas reposé ici.
   * Idempotent ; registre seulement (quelques lignes), aucune base de contenu.
   * `setScopeAccess` écrit toujours une ligne : un choix du propriétaire (même
   * un retrait) est donc une politique existante, jamais réécrite ici.
   */
  private grantTeamWriteDefault(): void {
    if (this.machineRole() !== 'team') return
    for (const assistant of this.registry.listAssistants()) this.grantTeamWrite(assistant, 'migration')
  }

  /**
   * Garde-fous d'une écriture dans l'espace d'équipe, AVANT le dédoublonnage
   * et le masquage (un fait refusé ne laisse rien au coffre). Chaque refus
   * commence par TEAM_WRITE_REFUSED (403) et ne cite jamais le contenu.
   * Appelé pour une écriture d'agent (`byAgent`) ; un agent OpenClaw est
   * refusé même avec le droit posé à la main (bot joignable par des tiers),
   * et assertWritable le refuse aussi pour épingler, corriger, dater.
   */
  private assertTeamWrite(instance: AssistantInstance, scope: MemoryScope, input: StoreFactInput, content: string): void {
    const refuse = (why: string): never => {
      throw new Error(`${TEAM_WRITE_REFUSED} : ${why}`)
    }
    if (this.registry.getAssistant(instance.assistant_id)?.type === 'openclaw') {
      refuse("un agent OpenClaw (joignable par des tiers) n'écrit jamais dans l'espace d'équipe ; garde le fait privé")
    }
    if (!this.registry.getPolicy(instance.assistant_id, scope.id)?.can_write) {
      refuse("cet agent n'a pas can_write sur l'espace d'équipe ; garde le fait privé, le propriétaire peut ouvrir le droit dans l'écran Partage")
    }
    if (input.sensitivity === 'sensitive' || input.sensitivity === 'critical') {
      refuse(`un fait ${input.sensitivity} n'entre jamais dans l'espace d'équipe ; garde-le privé`)
    }
    if (isTriageSensitive(content)) {
      refuse("le fait touche un sujet sensible (paie, impôts, santé, identité…) ; garde-le privé")
    }
    if (content.includes(SECRET_REF) || this.redactor.redact(content).found.length > 0) {
      refuse("le fait contient un secret ; rien n'a été écrit, ni le fait ni le secret")
    }
    const project = input.project_id ? this.registry.getProject(input.project_id) : null
    if (input.client_org_id || project?.client_org_id) {
      refuse("un client est déclaré dans le contexte actif : ce qui touche un client reste hors de l'espace d'équipe")
    }
  }

  /**
   * Première raison qui écarte un fait d'un partage vers l'espace d'équipe
   * (ordre de TEAM_SHARE_REFUSALS), ou null s'il peut y entrer. Le texte
   * stocké est déjà masqué : le secret se lit dans la marque du tri et dans
   * la référence `[secret:…]`, le masquage relu ne sert qu'aux anciens faits.
   */
  private teamShareRefusal(row: FactRow, triage: TriageRow | null): TeamShareRefusal | null {
    if (row.sensitivity === 'critical') return 'critical'
    if (row.sensitivity === 'sensitive') return 'sensible'
    // Marque levée à la main par le propriétaire (correction `sensible: false`) : son choix prime, comme à la validation.
    const ownerLifted = triage !== null && !triage.sensible && triage.corrected_fields.includes('sensible')
    if (triage?.sensible || (!ownerLifted && isTriageSensitive(row.fact))) return 'sensible'
    if (triage?.secret_found || row.fact.includes(SECRET_REF) || this.redactor.redact(row.fact).found.length > 0) return 'secret'
    const project = row.project_id ? this.registry.getProject(row.project_id) : null
    if (row.client_org_id || project?.client_org_id) return 'client'
    if (row.superseded) return 'redite'
    if (!triage || !triage.genre) return 'sans_tri'
    if (triage.verdict === 'faux') return 'faux'
    if (triage.rubriques.some(r => TEAM_REFUSED_RUBRIQUES.includes(r))) return 'rubrique'
    if (!TEAM_SHARE_GENRES.includes(triage.genre)) return 'genre'
    return null
  }

  /**
   * Réaligne db_registry sur la racine COURANTE. Les chemins y sont absolus :
   * après `memoria move` (clé USB, autre dossier) ils pointaient sur l'ancien
   * emplacement et rien ne les recalculait — tout ce qui passe par
   * listDbs/dbForInstance (stats, doctor, forget, revue, thèmes, options…)
   * voyait des bases « absentes du disque » : 0 souvenir, `forget` « 0
   * supprimé » alors que le recall (chemins recalculés) marchait encore.
   * Chaque chemin se dérive de racine + kind + instance/scope : on le
   * recalcule à chaque boot — idempotent, silencieux quand rien ne bouge.
   */
  private rebaseDbRegistry(): void {
    for (const entry of this.registry.listDbs()) {
      const expected = this.expectedDbPath(entry)
      if (expected === null || expected === entry.path) continue
      this.registry.rebaseDb(entry.id, expected)
      console.log(`[memoria] base ${entry.kind} réalignée sur la racine courante : ${entry.path} → ${expected}`)
    }
  }

  /** Chemin canonique d'une entrée du registre sous la racine courante (null si indérivable). */
  private expectedDbPath(entry: DbRegistryEntry): string | null {
    switch (entry.kind) {
      case 'registry':
        return this.paths.registry
      case 'assistant':
        return entry.assistant_instance_id ? this.paths.assistantDb(entry.assistant_instance_id) : null
      case 'shared': {
        const scope = entry.scope_id ? this.registry.getScope(entry.scope_id) : null
        if (!scope) return null
        try {
          return this.sharedDbPath(scope)
        } catch {
          return null // type de scope sans DB partagée : on ne touche pas
        }
      }
      default:
        return null
    }
  }

  /** Point d'entrée unique. `Memoria.init({ storageRoot })` pour les tests/daemon. */
  static init(opts: MemoriaInitOptions = {}): Memoria {
    const resolved = resolveStorageRoot(opts)
    return new Memoria(resolved, opts)
  }

  // ------------------------------------------------------------ identité & connexion

  pairAssistant(input: PairAssistantInput): PairAssistantResult {
    this.assertOpen()
    const { user } = this.registry.bootstrap()
    const assistant = this.registry.ensureAssistant(input.type, input.display_name ?? input.type, user.id)
    const instance = this.registry.createInstance(assistant.id, input.machine ?? hostname(), input.profile)

    // Scope privé de l'instance + provision de sa DB
    const privateScope = this.registry.ensureScope('private', `private:${instance.id}`, {})
    const dbPath = this.paths.assistantDb(instance.id)
    this.openContent(dbPath)
    this.registry.registerDb({ kind: 'assistant', path: dbPath, assistant_instance_id: instance.id, scope_id: privateScope.id })

    // Policies par défaut : privé = lecture/écriture ; `user` = lecture ET
    // écriture (décision 27/08 : ce qu'un agent apprend SUR l'utilisateur doit
    // pouvoir être déclaré une fois pour tous les modèles ; avant, 10 faits
    // partagés pour ~4 000 privés). La gouvernance reste modifiable dans
    // l'écran Partage (setScopeAccess).
    this.registry.setPolicy({
      assistant_id: assistant.id,
      scope_id: privateScope.id,
      can_read: true,
      can_write: true,
      can_share: false,
      secret_access: 'none',
    })
    const userScope = this.registry.getScopeByName('user')
    if (userScope && !this.registry.getPolicy(assistant.id, userScope.id)) {
      this.registry.setPolicy({
        assistant_id: assistant.id,
        scope_id: userScope.id,
        can_read: true,
        // Pas d'écriture par défaut pour un agent de canal (cf. grantDefaultUserWrite).
        can_write: assistant.type !== 'openclaw',
        can_share: false,
        secret_access: 'none',
      })
    }
    // Mac d'équipe : Claude Code et Codex lisent et écrivent l'espace d'équipe.
    this.grantTeamWrite(assistant, 'pairing')

    const { code } = this.registry.createPairing(instance.id)
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: 'pair_assistant',
      target_id_hash: sha256Hex(instance.id),
      scope_id: privateScope.id,
      reason: `type=${input.type}`,
    })
    return {
      assistant_id: assistant.id,
      assistant_instance_id: instance.id,
      pairing_code: code,
      command: `npx -y @memoria/mcp connect --code ${code}`,
    }
  }

  completePairing(code: string): { assistant_instance_id: string; instance_token: string; assistant_type: string } | null {
    this.assertOpen()
    const result = this.registry.completePairing(code)
    if (!result) return null
    this.registry.audit({
      actor_type: 'assistant',
      actor_id: result.instance.id,
      action: 'complete_pairing',
      target_id_hash: sha256Hex(result.instance.id),
      scope_id: null,
      reason: null,
    })
    const assistant = this.registry.getAssistant(result.instance.assistant_id)
    return {
      assistant_instance_id: result.instance.id,
      instance_token: result.token,
      assistant_type: assistant?.type ?? 'generic',
    }
  }

  revokeInstance(instanceId: string): void {
    this.assertOpen()
    this.registry.revokeInstance(instanceId)
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: 'revoke_instance',
      target_id_hash: sha256Hex(instanceId),
      scope_id: null,
      reason: null,
    })
  }

  /**
   * Supprime DÉFINITIVEMENT un agent : révoque, ferme et efface sa DB de mémoire
   * privée, retire son scope privé et son enregistrement. Irréversible (≠ révoquer
   * qui garde la mémoire). Audit neutre.
   */
  deleteInstance(instanceId: string): { deleted: boolean } {
    this.assertOpen()
    const instance = this.registry.getInstance(instanceId)
    if (!instance) return { deleted: false }
    const dbPath = this.paths.assistantDb(instanceId)
    // fermer la connexion du pool avant d'effacer le fichier
    const store = this.pool.get(dbPath)
    if (store) {
      store.close()
      this.pool.delete(dbPath)
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
    rmSync(dirname(dbPath), { recursive: true, force: true })
    this.registry.deleteInstance(instanceId)
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: 'delete_instance',
      target_id_hash: sha256Hex(instanceId),
      scope_id: null,
      reason: null,
    })
    return { deleted: true }
  }

  // ------------------------------------------------------------ kill-switch & stockage

  /** Memoria actif ? (kill-switch global). Absent = true par défaut. */
  isEnabled(): boolean {
    return this.resolved.config.enabled !== false
  }

  /**
   * Bascule le kill-switch global et le persiste. À false, le daemon refuse
   * capture ET recall (no-op annoncé) sans se fermer : « pause » de Memoria.
   */
  setEnabled(enabled: boolean): boolean {
    this.assertOpen()
    this.resolved.config.enabled = enabled
    this.saveConfig()
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: enabled ? 'memoria_enabled' : 'memoria_disabled',
      target_id_hash: null,
      scope_id: null,
      reason: null,
    })
    return enabled
  }

  /** Emplacement courant de la mémoire (pour l'UI « déplacer vers clé USB »). */
  storageInfo(): { root: string; config_path: string; on_network_volume: boolean } {
    return {
      root: this.paths.root,
      config_path: this.resolved.configPath,
      on_network_volume: isOnNetworkVolume(this.paths.root),
    }
  }

  // ------------------------------------------------------------ interlocuteurs (personnes)

  listPersons(): PersonProfile[] {
    this.assertOpen()
    return this.registry.listPersons()
  }

  getPerson(id: string): PersonProfile | null {
    this.assertOpen()
    return this.registry.getPerson(id)
  }

  createPerson(input: { display_name: string; relation?: string | null; notes?: string | null; org_id?: string | null }): Person {
    this.assertOpen()
    const p = this.registry.createPerson(input)
    this.registry.audit({ actor_type: 'user', actor_id: 'local', action: 'person_create', target_id_hash: sha256Hex(p.id), scope_id: null, reason: null })
    return p
  }

  updatePerson(id: string, patch: Partial<Pick<Person, 'display_name' | 'notes' | 'relation' | 'org_id'>>): Person | null {
    this.assertOpen()
    return this.registry.updatePerson(id, patch)
  }

  deletePerson(id: string): boolean {
    this.assertOpen()
    const ok = this.registry.deletePerson(id)
    if (ok) this.registry.audit({ actor_type: 'user', actor_id: 'local', action: 'person_delete', target_id_hash: sha256Hex(id), scope_id: null, reason: null })
    return ok
  }

  addPersonIdentifier(personId: string, kind: PersonIdentifier['kind'], value: string, label?: string | null): PersonIdentifier {
    this.assertOpen()
    return this.registry.addIdentifier(personId, kind, value, label)
  }

  removePersonIdentifier(id: string): boolean {
    this.assertOpen()
    return this.registry.removeIdentifier(id)
  }

  /**
   * Reconnaît l'interlocuteur courant via un ou plusieurs identifiants
   * (Telegram/WhatsApp/mail/handle…). Renvoie la personne + ses faits connus
   * pour que l'agent sache à QUI il parle. Aucun identifiant → null (= owner par défaut).
   *
   * `instanceId` = l'agent qui demande : `known` est alors borné à SES scopes
   * lisibles (même fan-out que son recall). Sans instance (UI locale / route
   * admin) : vue globale. Un appel agent DOIT passer son instance — sinon un
   * bot WhatsApp recevrait les souvenirs privés (et critiques) de Claude Code.
   */
  identifyInterlocutor(
    input: {
      phone?: string
      email?: string
      telegram?: string
      whatsapp?: string
      handle?: string
      name?: string
    },
    instanceId?: string,
  ): { person: PersonProfile; known: string[] } | null {
    this.assertOpen()
    const tries: Array<[PersonIdentifier['kind'], string | undefined]> = [
      ['telegram', input.telegram],
      ['whatsapp', input.whatsapp],
      ['phone', input.phone],
      ['email', input.email],
      ['handle', input.handle],
    ]
    let person: PersonProfile | null = null
    for (const [kind, value] of tries) {
      if (!value) continue
      person = this.registry.findPersonByIdentifier(kind, value)
      if (person) break
    }
    // repli par nom exact (display_name) si aucun identifiant ne matche
    if (!person && input.name) {
      const match = this.registry.listPersons().find(p => p.display_name.toLowerCase() === input.name!.trim().toLowerCase())
      if (match) person = match
    }
    if (!person) return null
    return { person, known: this.knownAboutPerson(person.display_name, instanceId) }
  }

  /**
   * Comme identifyInterlocutor, mais CRÉE la personne au premier contact si aucun
   * identifiant connu ne matche (auto-enregistrement des interlocuteurs, ex.
   * nouveau numéro WhatsApp/Telegram). Le premier identifiant fourni sert de clé.
   * `created` indique si une nouvelle personne a été créée. Sans aucun identifiant
   * fourni → comportement identique à identifyInterlocutor (pas de création).
   */
  identifyOrCreateInterlocutor(
    input: {
      phone?: string
      email?: string
      telegram?: string
      whatsapp?: string
      handle?: string
      name?: string
      relation?: string | null
    },
    instanceId?: string,
  ): { person: PersonProfile; known: string[]; created: boolean } | null {
    this.assertOpen()
    const existing = this.identifyInterlocutor(input, instanceId)
    if (existing) return { ...existing, created: false }

    // Aucune personne connue : on tente la création si on a AU MOINS un identifiant.
    const tries: Array<[PersonIdentifier['kind'], string | undefined]> = [
      ['telegram', input.telegram],
      ['whatsapp', input.whatsapp],
      ['phone', input.phone],
      ['email', input.email],
      ['handle', input.handle],
    ]
    const idents = tries.filter((t): t is [PersonIdentifier['kind'], string] => Boolean(t[1]))
    if (idents.length === 0) return null // rien pour identifier → owner par défaut

    const display = input.name?.trim() || idents[0]![1]
    const person = this.registry.createPerson({ display_name: display, relation: input.relation ?? null })
    for (const [kind, value] of idents) {
      // addIdentifier a un index unique (kind,value) : en cas de course, on ignore.
      try {
        this.registry.addIdentifier(person.id, kind, value)
      } catch {
        /* identifiant déjà rattaché ailleurs — on garde la personne créée */
      }
    }
    this.registry.audit({ actor_type: 'assistant', actor_id: 'local', action: 'person_autocreate', target_id_hash: sha256Hex(person.id), scope_id: null, reason: null })
    const profile = this.registry.getPerson(person.id)
    if (!profile) throw new Error('person auto-create: profil introuvable après création')
    return { person: profile, known: this.knownAboutPerson(profile.display_name, instanceId), created: true }
  }

  /**
   * Faits connus mentionnant cette personne. Avec `instanceId` : fan-out
   * GOUVERNÉ (DB privée de l'agent + scopes partagés lisibles, dormants exclus,
   * sensibilité plafonnée comme au recall). Sans : recherche globale (admin).
   * Avant : toujours globale → n'importe quel agent lisait les faits privés et
   * critiques de tous les autres via un simple identifiant.
   */
  private knownAboutPerson(name: string, instanceId?: string, limit = 8): string[] {
    if (instanceId === undefined) return this.globalSearch(name, limit).map(h => h.fact)
    const instance = this.mustInstance(instanceId)
    const hits: FtsHit[] = []
    for (const target of this.resolveReadTargets(instance)) {
      hits.push(
        ...this.openContent(target.dbPath).searchFacts(name, {
          limit,
          includeDormant: false,
          maxSensitivity: 'sensitive',
          scopeIds: target.scopeIds,
        }),
      )
    }
    return hits
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map(h => h.row.fact)
  }

  /** Texte court « tu parles à X » pour l'injection de contexte (recall). */
  describeInterlocutor(personId: string): string | null {
    const p = this.registry.getPerson(personId)
    if (!p) return null
    const bits = [p.display_name]
    if (p.relation) bits.push(`(${p.relation})`)
    let line = `Tu parles à ${bits.join(' ')}.`
    if (p.notes) line += ` ${p.notes}`
    return line
  }

  /** Authentifie un token d'instance (utilisé par le daemon). */
  authenticate(token: string): AssistantInstance | null {
    this.assertOpen()
    const inst = this.registry.verifyInstanceToken(token)
    if (inst) this.registry.touchInstance(inst.id)
    return inst
  }

  // ------------------------------------------------------------------- mémoire

  /**
   * Déclaration EXPLICITE (MCP store_fact, CLI, import) : dédoublonnage EXACT
   * seulement. Le near-dup (Jaccard > 0,85) appliqué ici jetait sans bruit
   * toute variante à un mot près d'une phrase longue — « 13 octobre » →
   * « 14 octobre », « avec option » → « sans option », « toujours » → « jamais » —
   * et renvoyait l'ANCIEN fait à l'agent comme si c'était le sien : la
   * correction ou la contradiction était perdue, seul un audit en gardait
   * trace. Un agent qui déclare a choisi ses mots ; seule la capture (bruit
   * conversationnel, redites) garde le near-dup.
   */
  storeFact(input: StoreFactInput): Fact {
    return this.storeFactInternal(input, { nearDup: false }).fact
  }

  /**
   * Déclaration d'un fait PAR UN AGENT (POST /v1/memory/store_fact, outil MCP
   * memoria_store_fact) : soumise au MODE DE CAPTURE global, exactement comme
   * la capture. `auto-private` → fait actif ; `review-first` → fait DORMANT +
   * item de revue (aucun agent ne le voit avant validation) ; `incognito`
   * (« Pause ») → rien n'est écrit, et c'est dit (`skipped: 'paused'`).
   * Avant, seul captureTurn consultait le mode : un utilisateur passé en Pause
   * pour une conversation sensible voyait quand même ses faits mémorisés.
   * `storeFact` reste la primitive sans mode (import, partage, tests).
   */
  declareFact(input: StoreFactInput): DeclareFactResult {
    this.assertOpen()
    const mode = this.getCaptureMode()
    if (mode === 'incognito') {
      // Une instance inconnue/révoquée reste une erreur, pause ou pas.
      this.mustInstance(input.instance)
      return { fact: null, skipped: true, reason: 'paused', mode }
    }
    const { fact } = this.storeFactInternal(input, { nearDup: false, quarantine: mode === 'review-first', byAgent: true })
    return { fact, skipped: false, mode }
  }

  /**
   * Écriture gouvernée + HYGIÈNE (audit 27/08) : contenu vide refusé,
   * catégorie normalisée (« Preference » ≠ « preference » donnait deux
   * domaines d'expertise), et dédoublonnage PAR SCOPE (findDuplicate). Le
   * near-dup n'est activé QUE par la capture (`opts.nearDup`) ; storeFact et
   * correctFact ne dédoublonnent qu'en exact. Un doublon DORMANT (revue en
   * attente) redéclaré explicitement à l'IDENTIQUE est validé : déclarer =
   * confirmer — jamais sur un simple rapprochement, qui validerait un fait
   * que l'agent n'a pas énoncé. `created=false` = l'existant a été renvoyé.
   *
   * `opts.quarantine` (mode « Revue d'abord ») : le fait naît DORMANT + item
   * de revue, dans la même transaction que l'INSERT (un crash entre les deux
   * publiait un fait jamais revu) ; et un doublon dormant redéclaré RESTE
   * dormant — la validation appartient à l'utilisateur, pas à la répétition.
   */
  private storeFactInternal(
    input: StoreFactInput,
    opts: {
      nearDup?: boolean
      quarantine?: boolean
      /** Source de l'item de revue (défaut : « capture-review » de l'instance). */
      reviewSource?: ReviewSourceSpec
      /** Écrit avec le fait, dans la MÊME transaction (ligne de tri). Seulement pour un fait créé. */
      afterInsert?: (store: ContentStore, fact: Fact) => void
      /** false : un jumeau exact expiré reste expiré (défaut : il est réveillé). */
      revive?: boolean
      /**
       * Écriture d'un AGENT (declareFact : route store_fact et outil MCP ;
       * correctFact : route correct) : vers l'espace d'équipe, garde-fous
       * assertTeamWrite. La primitive storeFact (imports, tests, fixtures de
       * synchro) garde seulement le contrôle de droit, comme avant.
       */
      byAgent?: boolean
    } = {},
  ): { fact: Fact; created: boolean } {
    this.assertOpen()
    const instance = this.mustInstance(input.instance)
    const scope = this.resolveTargetScope(instance, input.scope)
    const trimmed = input.content.trim()
    if (!trimmed) throw new Error('storeFact : contenu vide refusé')
    const category = (input.category ?? 'general').trim().toLowerCase() || 'general'

    if (scope.type === 'private') {
      // Seul SON scope privé : un fait écrit sous le scope privé d'un autre
      // agent atterrissait dans la DB de l'appelant avec un scope étranger →
      // exclu du recall des deux (invisible pour tous, perdu sans bruit).
      if (scope.name !== `private:${instance.id}`) {
        throw new Error(`écriture refusée : le scope « ${scope.name} » est le privé d'un autre agent`)
      }
    } else if (scope.type === 'org' && opts.byAgent) {
      // Espace d'équipe, écrit par un agent : OpenClaw, droit d'écriture, puis
      // contenu (sensible, secret, client), avant tout dédoublonnage ou masquage.
      this.assertTeamWrite(instance, scope, input, trimmed)
    } else {
      const policy = this.registry.getPolicy(instance.assistant_id, scope.id)
      if (!policy?.can_write) {
        throw new Error(`écriture refusée : l'assistant n'a pas can_write sur le scope « ${scope.name} »`)
      }
    }

    // GATE SECRETS — défense en profondeur (audit QW1) : tout fait, même posé
    // en direct (store_fact MCP) ou issu d'un import, passe par la redaction
    // AVANT le stockage. La valeur détectée part au coffre, jamais dans facts.
    const content = this.redactBeforeStore(trimmed)

    const store = this.storeForScope(scope, instance)
    const rawDup = findDuplicate(store, scope.id, content, opts)
    // Un doublon EXACT n'en est un que si l'existant est RAPPELABLE dans le même
    // contexte. Sinon (revue 27/08) la déclaration était jetée en silence et
    // l'agent recevait l'id d'un fait invisible : « fait perdu, vérités
    // divergentes entre agents ».
    //  - même contexte client/projet, fait expiré → on le RÉVEILLE (expires_at NULL) ;
    //  - autre contexte client/projet → ce n'est pas une redite, c'est un fait
    //    distinct (l'isolation client le cache justement à l'autre contexte).
    const sameContext = (existing: Fact): boolean =>
      (existing.client_org_id ?? null) === (input.client_org_id ?? null) &&
      (existing.project_id ?? null) === (input.project_id ?? null)
    const dup = rawDup && rawDup.kind === 'exact' && !sameContext(rawDup.existing) ? null : rawDup
    if (dup) {
      const now = nowISO()
      if (dup.kind === 'exact' && dup.existing.lifecycle_state === 'dormant' && !opts.quarantine) {
        this.activateFact(store, dup.existing.id)
      }
      const expiresAt = dup.existing.expires_at ?? null
      const expired = opts.revive !== false && dup.kind === 'exact' && expiresAt !== null && expiresAt <= now
      if (expired) {
        store.db.prepare('UPDATE facts SET expires_at = NULL, updated_at = ? WHERE id = ?').run(now, dup.existing.id)
      }
      this.registry.audit({
        actor_type: 'assistant',
        actor_id: instance.id,
        action: expired ? 'store_fact_revive' : 'store_fact_dedup',
        target_id_hash: sha256Hex(dup.existing.id),
        scope_id: scope.id,
        reason: dup.kind,
      })
      const fact = store.getFact(dup.existing.id) ?? dup.existing
      return { fact, created: false }
    }

    // PROVENANCE (synchro) : les faits d'un scope PARTAGÉ portent l'origine
    // (machine + révision logique) + un hash de contenu, pour la convergence LWW
    // inter-machines. Les faits privés n'en ont pas besoin (jamais synchronisés).
    const shared = scope.type !== 'private'
    const provenance = shared
      ? {
          origin_machine_id: localMachineId(this.registry),
          origin_rev: nextRev(this.registry),
          content_hash: contentHash({ fact: content, category, scope_id: scope.id }),
        }
      : {}

    const insert = (): Fact => {
      const inserted = store.insertFact({
        fact: content,
        category,
        fact_type: input.fact_type,
        confidence: input.confidence,
        source: input.source ?? 'manual',
        assistant_instance_id: instance.id,
        // Espace d'équipe : l'organisation est celle du scope, jamais l'étiquette `org` du contexte de l'agent.
        org_id: scope.type === 'org' ? scope.org_id : (input.org_id ?? scope.org_id),
        client_org_id: input.client_org_id ?? scope.client_org_id,
        project_id: input.project_id ?? scope.project_id,
        scope_id: scope.id,
        sensitivity: input.sensitivity,
        tags: input.tags,
        visibility: scope.type === 'private' ? 'private' : 'shared',
        ...provenance,
      })
      const fact = opts.quarantine ? this.quarantineForReview(store, inserted, instance.id, opts.reviewSource) : inserted
      opts.afterInsert?.(store, fact)
      return fact
    }
    const fact = opts.quarantine || opts.afterInsert ? store.db.transaction(insert)() : insert()
    this.registry.audit({
      actor_type: 'assistant',
      actor_id: instance.id,
      action: 'store_fact',
      target_id_hash: sha256Hex(fact.id),
      scope_id: scope.id,
      reason: null,
    })
    // Un fait posé directement (MCP store_fact, partage, correction) n'était
    // embeddé qu'à la capture suivante ou au redémarrage → invisible à la
    // branche vectorielle du recall entre-temps. Bucket B, jamais bloquant.
    this.scheduleEmbeddings(instance.id)
    // Même raison pour le graphe et les thèmes : sans capture derrière, un
    // fait déclaré restait sans entité, sans thème et sans amas. L'écriture
    // est déjà validée ici ; un échec de cognition ne peut plus la défaire.
    this.scheduleCognition(instance.id)
    return { fact, created: true }
  }

  /**
   * Indexation différée (debounce court) des DB lisibles par l'instance :
   * une rafale de storeFact (import, correction en série) donne UNE passe.
   * Le timer n'empêche pas le process de se terminer ; close() l'annule.
   */
  private scheduleEmbeddings(instanceId: string): void {
    this.indexQueue.add(instanceId)
    if (this.indexTimer) return
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null
      const ids = [...this.indexQueue]
      this.indexQueue.clear()
      if (this.closed) return
      for (const id of ids) {
        void this.indexEmbeddings(id).catch((err: unknown) =>
          console.warn('[memoria] indexation embeddings différée en échec :', (err as Error).message),
        )
      }
    }, EMBEDDINGS_DEBOUNCE_MS)
    this.indexTimer.unref()
  }

  /**
   * Cognition différée et dédoublonnée, sur le modèle de scheduleEmbeddings :
   * une rafale de faits déclarés donne UN passage. Sans instance (partage) :
   * toutes les bases. Le passage lui-même est sérialisé par processCognition.
   */
  private scheduleCognition(instanceId?: string): void {
    if (instanceId) this.cognitionQueue.add(instanceId)
    else this.cognitionQueueAll = true
    if (this.cognitionTimer) return
    this.cognitionTimer = setTimeout(() => {
      this.cognitionTimer = null
      const ids = [...this.cognitionQueue]
      const all = this.cognitionQueueAll
      this.cognitionQueue.clear()
      this.cognitionQueueAll = false
      if (this.closed) return
      // Les appels se fondent dans un seul passage en attente (voir processCognition).
      for (const id of all ? [undefined] : ids) {
        void this.processCognition(id).catch((err: unknown) =>
          console.warn('[memoria] cognition différée en échec :', (err as Error).message),
        )
      }
    }, this.cognitionDebounceMs)
    this.cognitionTimer.unref()
  }

  /**
   * Active un fait dormant et clôt ses items de revue `pending` (même règle
   * que le partage : valider par un autre chemin = sortir de la revue, sans
   * item orphelin qui répondrait « updated: 1 » pour rien).
   */
  private activateFact(store: ContentStore, factId: string): void {
    const tx = store.db.transaction(() => {
      store.db.prepare("UPDATE facts SET lifecycle_state = 'active', updated_at = ? WHERE id = ?").run(nowISO(), factId)
      store.db
        .prepare(
          `UPDATE memory_import_items SET status = 'accepted', reviewed_by = 'local', reviewed_at = ?
           WHERE status = 'pending' AND target_memory_id = ?`,
        )
        .run(nowISO(), factId)
      resetBackfillMarkers(store, [factId])
    })
    tx()
    // Dormant = ignoré par la cognition : maintenant qu'il est actif, on le relie.
    this.scheduleCognition()
  }

  /**
   * Doublon d'un énoncé dans TOUTES les DB lisibles par l'instance (privée +
   * partagées autorisées) — le même mécanisme que la capture, étendu au
   * fan-out du recall. Sert à la capture, à l'import de transcripts et à tout
   * appelant qui veut savoir « est-ce déjà su quelque part ? » avant d'écrire.
   */
  findKnownDuplicate(
    instanceId: string,
    factText: string,
    opts: { includePrivate?: boolean; accept?: (store: ContentStore, factId: string) => boolean } = {},
  ): DuplicateMatch | null {
    this.assertOpen()
    const instance = this.mustInstance(instanceId)
    const privateDbPath = this.paths.assistantDb(instance.id)
    const accept = opts.accept
    for (const target of this.resolveReadTargets(instance)) {
      if (opts.includePrivate === false && target.dbPath === privateDbPath) continue
      const store = this.openContent(target.dbPath)
      for (const scopeId of target.scopeIds) {
        const dup = findDuplicate(store, scopeId, factText, accept ? { accept: id => accept(store, id) } : {})
        if (dup) return dup
      }
    }
    return null
  }

  /**
   * Recall fan-out gouverné (spec §6.1) :
   * scopes autorisés → pré-filtre SQL par DB → fusion → scoring global →
   * filtre dur client → budget tokens GLOBAL → compteurs d'usage.
   */
  recall(input: RecallInput): RecallResult {
    this.assertOpen()
    return this.performRecall(input, (store, query, searchOpts) => store.searchFacts(query, searchOpts))
  }

  /**
   * Recall HYBRIDE (FTS + vectoriel, spec §10) : embedde la requête puis fusion
   * RRF par DB. Sans provider d'embeddings / sans extension vec / en cas
   * d'échec d'embedding → identique à recall() (dégradation annoncée).
   */
  async recallSemantic(input: RecallInput): Promise<RecallResult> {
    this.assertOpen()
    const provider = await this.ensureEmbeddings()
    if (!provider) return this.recall(input)
    let queryVector: Float32Array | undefined
    try {
      queryVector = (await provider.embed([input.query]))[0]
    } catch (err) {
      console.warn('[memoria] embedding de requête en échec — recall FTS seul :', (err as Error).message)
    }
    if (!queryVector) return this.recall(input)
    const vec = queryVector
    return this.performRecall(input, (store, query, searchOpts) =>
      hybridSearchFacts(store, query, { ...searchOpts, queryVector: vec, model: provider.model, dimensions: provider.dimensions }),
    )
  }

  private performRecall(
    input: RecallInput,
    search: (store: ContentStore, query: string, opts: FtsSearchOptions) => FtsHit[],
  ): RecallResult {
    const startedAt = Date.now()
    const instance = this.mustInstance(input.instance)
    const budget = input.token_budget ?? DEFAULT_TOKEN_BUDGET
    const limit = input.limit ?? DEFAULT_RECALL_LIMIT

    // CONTEXT-TREE (couche 9) : un contexte « projet » remonte sa hiérarchie
    // (projet → client → organisation) → le boost s'applique à tous les niveaux.
    const context = this.expandContextTree(input.active_context)
    const searchTargets = this.resolveReadTargets(instance)
    const now = Date.now()
    const procedural = isProceduralQuery(input.query) // boost procédures sur requête impérative
    // Faits de l'espace d'équipe : rendus `org` à l'agent (jamais comme un fait sur l'utilisateur).
    const teamIds = new Set(this.teamScopeIds())
    const teamMark = (scopeId: string): Pick<RecallItem, 'scope_type'> => (teamIds.has(scopeId) ? { scope_type: 'org' } : {})
    // `row` voyage avec le candidat : l'enrichissement (statut, confiance) le
    // relit après la sélection sans refaire de requête.
    const candidates: Array<{ item: RecallItem; store: ContentStore; row: FactRow }> = []
    let totalFound = 0

    for (const target of searchTargets) {
      const store = this.openContent(target.dbPath)
      const hits = search(store, input.query, {
        limit: 50,
        // JAMAIS de dormant au recall : un fait dormant attend une validation
        // (review-first, quarantaine d'import). `include_dormant` arrivait tel
        // quel du body HTTP → tout client pouvait lire l'inapprouvé.
        includeDormant: false,
        maxSensitivity: 'sensitive',
        scopeIds: target.scopeIds,
      })
      for (const hit of hits) {
        // FILTRE DUR anti-fuite inter-clients — jamais un boost, une exclusion.
        if (!passesClientIsolation(hit.row, context)) continue
        const parts = scoreFact(hit.row, hit.relevance, context, now, procedural)
        if (parts.total <= 0) continue
        // Compté APRÈS les filtres durs : compté avant, `total_found` disait
        // combien de faits d'un autre client (ou expirés) répondaient à la
        // requête, sans en rendre aucun. Un agent pouvait sonder mot par mot.
        totalFound++
        const matchedBy: RecallMatch[] = []
        if (hit.via !== 'meaning') matchedBy.push('text')
        if (hit.via === 'meaning' || hit.via === 'both') matchedBy.push('meaning')
        candidates.push({
          store,
          row: hit.row,
          item: {
            kind: 'fact',
            id: hit.row.id,
            content: hit.row.fact,
            category: hit.row.category,
            scope_id: hit.row.scope_id,
            source_db: relative(this.paths.root, target.dbPath),
            score: parts.total,
            created_at: hit.row.created_at,
            origin: factOrigin(hit.row),
            matched_by: [...matchedBy, ...boostReasons(hit.row, context)],
            ...teamMark(hit.row.scope_id),
          },
        })
      }
    }

    // --- Expansion graphe (bucket B au recall, §6.1 étape 4) : SQL pur, 0 LLM.
    // expandEntities ne traverse que des faits que CE rappel pourrait rendre
    // (scopes, client du contexte, expiration, cycle de vie, sensibilité) : un
    // fait caché ne sert jamais de pont. Le voisin repasse quand même ici par
    // les MÊMES filtres durs que la recherche directe (passesRecallHardFilters),
    // pour qu'un chemin d'accès de plus ne devienne jamais une fuite.
    if (input.expand_graph !== false && candidates.length > 0) {
      const existing = new Set(candidates.map(c => c.item.id))
      const storeScopes = new Map<ContentStore, { scopeIds: string[]; dbPath: string }>()
      for (const target of searchTargets) {
        storeScopes.set(this.openContent(target.dbPath), { scopeIds: target.scopeIds, dbPath: target.dbPath })
      }
      const seedsByStore = new Map<ContentStore, string[]>()
      for (const c of candidates) {
        const arr = seedsByStore.get(c.store) ?? []
        if (arr.length < 8) arr.push(c.item.id)
        seedsByStore.set(c.store, arr)
      }
      for (const [store, seeds] of seedsByStore) {
        const meta = storeScopes.get(store)
        if (!meta || seeds.length === 0) continue
        let expanded: ExpandResult[] = []
        try {
          // GRAPH_MAX_NEIGHBORS demandés, comme avant T30 : un voisin déjà
          // trouvé par les mots prend sa place dans ces 8. Les faits cachés ne
          // sont plus proposés (filtrés dans l'expansion), donc demander plus
          // pour compenser n'apportait que des voisins en plus au rappel sans option.
          expanded = this.cognitionFor(store, null).expandEntities(seeds, meta.scopeIds, {
            maxHops: 2,
            maxFacts: GRAPH_MAX_NEIGHBORS,
            clientOrgId: context?.client_org_id ?? null,
            now,
          })
        } catch {
          // Graphe d'entités absent ou illisible dans cette base : l'expansion
          // est un plus, le rappel direct reste entier.
        }
        const fresh = expanded.filter(ex => !existing.has(ex.fact_id))
        if (fresh.length === 0) continue
        // Une seule lecture groupée des voisins, rendus dans l'ordre de l'expansion.
        const rowsById = new Map(
          (
            store.db
              .prepare(`SELECT * FROM facts WHERE id IN (${fresh.map(() => '?').join(',')})`)
              .all(...fresh.map(ex => ex.fact_id)) as FactRow[]
          ).map(r => [r.id, r]),
        )
        for (const ex of fresh) {
          const row = rowsById.get(ex.fact_id)
          if (!row) continue
          if (!passesRecallHardFilters(row, meta.scopeIds, context, now)) continue
          // relevance dérivée du lien graphe, fortement escomptée (un voisin n'est
          // jamais aussi pertinent qu'un hit direct) ; on garde recency/confiance.
          const parts = scoreFact(row, Math.min(0.4, ex.score) * 0.5, context, now, procedural)
          if (parts.total <= 0) continue
          existing.add(ex.fact_id)
          candidates.push({
            store,
            row,
            item: {
              kind: 'fact',
              id: row.id,
              content: row.fact,
              category: row.category,
              scope_id: row.scope_id,
              source_db: relative(this.paths.root, meta.dbPath),
              score: parts.total,
              created_at: row.created_at,
              origin: factOrigin(row),
              matched_by: ['graph', ...boostReasons(row, context)],
              ...(ex.via_entity ? { via_entity: ex.via_entity } : {}),
              ...teamMark(row.scope_id),
            },
          })
        }
      }
    }

    // DÉDOUBLONNAGE inter-DB : le même énoncé en privé ET dans un scope
    // partagé (cas courant : deux agents ont appris la même préférence, l'une
    // des copies a été partagée) remontait deux fois, consommant budget et
    // `limit`. On garde la copie du scope le plus large (partagé > privé) avec
    // le meilleur score des deux ; l'autre n'est ni renvoyée ni comptée.
    // Deux copies dans la MÊME DB ne sont pas touchées : c'est le travail de
    // la révision (doublons proposés), pas du recall.
    const privateDbPath = this.paths.assistantDb(instance.id)
    const byText = new Map<string, number[]>()
    const deduped: typeof candidates = []
    for (const c of candidates) {
      const key = normalizeFact(c.item.content)
      const indices = byText.get(key) ?? []
      const twinIdx = indices.find(i => deduped[i]!.store !== c.store)
      if (twinIdx === undefined) {
        indices.push(deduped.length)
        byText.set(key, indices)
        deduped.push(c)
        continue
      }
      const kept = deduped[twinIdx]!
      const keptShared = kept.store.path !== privateDbPath
      const thisShared = c.store.path !== privateDbPath
      const winner = thisShared && !keptShared ? c : kept
      winner.item.score = Math.max(kept.item.score, c.item.score)
      // Les raisons des deux copies valent pour l'énoncé gardé.
      winner.item.matched_by = [...new Set([...(kept.item.matched_by ?? []), ...(c.item.matched_by ?? [])])]
      // L'union peut apporter la raison « graph » de la copie écartée : son
      // entité de passage suit, sinon le rappel dit « graph » sans dire par où.
      const via = kept.item.via_entity ?? c.item.via_entity
      if (via && !winner.item.via_entity) winner.item.via_entity = via
      deduped[twinIdx] = winner
    }
    candidates.length = 0
    candidates.push(...deduped)

    candidates.sort((a, b) => b.item.score - a.item.score)

    // ARRÊT SUR DÉCROCHAGE (optionnel) : fait AVANT le budget et les compteurs
    // d'usage, sinon un souvenir coupé serait quand même compté comme rappelé
    // et remonterait au prochain rappel (auto-renforcement).
    const cut = applyRecallCutoff(candidates, input.cutoff, c => c.item.score)
    const ranked = cut.kept

    // CAP DUR de tokens (corrige format.ts legacy : aucun cap global)
    const selected: typeof candidates = []
    let tokens = 0
    let overBudget = 0
    let overLimit = 0
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i]!
      if (selected.length >= limit) {
        overLimit = ranked.length - i
        break
      }
      const cost = estimateTokens(c.item.content)
      if (tokens + cost > budget && selected.length > 0) {
        overBudget++
        continue
      }
      tokens += cost
      selected.push(c)
    }
    const dropped: RecallDropped[] = []
    if (cut.dropped > 0) dropped.push({ reason: 'cutoff', count: cut.dropped })
    if (overBudget > 0) dropped.push({ reason: 'budget', count: overBudget })
    if (overLimit > 0) dropped.push({ reason: 'limit', count: overLimit })

    // Compteurs d'usage par DB d'origine
    const byStore = new Map<ContentStore, string[]>()
    for (const s of selected) {
      const arr = byStore.get(s.store) ?? []
      arr.push(s.item.id)
      byStore.set(s.store, arr)
    }
    // Un aperçu ne laisse aucune trace : ni compteur, ni « dernier accès ».
    if (!input.preview) for (const [store, ids] of byStore) store.touchFacts(ids)

    // Marque les souvenirs CONTESTÉS (révision proposée, pas encore tranchée).
    // Fait après la sélection : une seule requête par DB, sur les seuls ids
    // réellement remontés.
    for (const [store, ids] of byStore) {
      const pending = pendingRevisionsFor(store, ids)
      if (pending.size === 0) continue
      for (const s of selected) {
        if (s.store !== store) continue
        const rev = pending.get(s.item.id)
        if (rev) s.item.revision = rev
      }
    }

    // ENRICHISSEMENT (T30) : thème, entités, statut, confiance, voisins. Après
    // la sélection, donc sur une douzaine d'ids, en requêtes groupées par DB.
    for (const [store] of byStore) {
      enrichRecallItems(
        store,
        selected.filter(s => s.store === store),
        {
          now,
          context,
          // Thèmes et voisins obéissent aux mêmes scopes que la recherche elle-même.
          scopeIds: searchTargets.filter(t => this.openContent(t.dbPath) === store).flatMap(t => t.scopeIds),
          links: input.links === true,
          exclude: new Set(selected.map(s => s.item.id)),
        },
      )
    }

    // L'audit alimente `doctor` (rappels sur 24 h, latence, tokens) : un aperçu
    // humain n'est pas un rappel d'agent et ne doit pas y figurer.
    if (!input.preview) {
      this.registry.audit({
        actor_type: 'assistant',
        actor_id: instance.id,
        action: 'recall',
        target_id_hash: null,
        scope_id: null,
        // Format PARSABLE (`clé=valeur`) : `doctor` en dérive latence et coût en
        // tokens sans table de métriques dédiée ni migration. Aucune donnée
        // sensible — que des compteurs.
        reason: `returned=${selected.length} tokens=${tokens} ms=${Date.now() - startedAt}`,
      })
    }

    const items = selected.map(s => s.item)
    return {
      items,
      totalFound,
      tokens,
      scopes_searched: searchTargets.flatMap(t => t.scopeNames),
      ...(dropped.length > 0 ? { dropped } : {}),
      ...(input.format === 'blocks' ? { blocks: buildRecallBlocks(items) } : {}),
    }
  }

  /**
   * Capture WAL-first (spec §6.2) : redaction → WAL → extraction → dédup →
   * store. Respecte le capture_mode global : `incognito` = AUCUNE écriture.
   */
  async captureTurn(input: CaptureTurnInput): Promise<CaptureTurnResult & { mode: CaptureMode }> {
    this.assertOpen()
    this.mustInstance(input.instance)
    const mode = this.getCaptureMode()
    if (mode === 'incognito') {
      return { appended: 0, wal_ids: [], processed: 0, facts_created: 0, deferred: 0, failed: 0, abandoned: 0, mode }
    }
    const startedAt = Date.now()
    const pipeline = await this.ensurePipeline()
    const result = await pipeline.captureTurn(input)

    // La capture n'était PAS auditée : impossible de répondre à « la dernière
    // capture a-t-elle réussi ? », l'angle mort exact signalé en bêta.
    this.registry.audit({
      actor_type: 'assistant',
      actor_id: input.instance,
      action: 'capture_turn',
      target_id_hash: null,
      scope_id: null,
      reason: `appended=${result.appended} facts=${result.facts_created} deferred=${result.deferred} failed=${result.failed} ms=${Date.now() - startedAt}`,
    })

    // Bucket B ASYNC (jamais dans le chemin de réponse) : embeddings + cognition.
    if (result.facts_created > 0) {
      void this.indexEmbeddings(input.instance).catch((err: unknown) =>
        console.warn('[memoria] indexation embeddings en échec :', (err as Error).message),
      )
      void this.processCognition(input.instance).catch((err: unknown) =>
        console.warn('[memoria] traitement cognitif en échec :', (err as Error).message),
      )
    }
    return { ...result, mode }
  }

  /**
   * Traite les faits sans graphe (entités/relations/observations) puis les
   * range par thème. Async, bucket B : appelé après une capture, après un
   * fait déclaré ou un partage (différé), et au démarrage du daemon. LLM
   * d'extraction optionnel (heuristique sinon).
   *
   * SÉRIALISÉ : un seul passage tourne à la fois. Un appel pendant un passage
   * attend UN passage suivant, et tous les appels de même nature arrivés
   * entre-temps s'y fondent (leurs instances s'additionnent). Sans cela deux
   * passages lisaient la même liste de faits en attente et payaient deux fois
   * le LLM pour le même fait.
   *
   * `includeBackfill` = rattrapage de l'existant (voir CognitionPassOptions) :
   * heuristique seule par défaut, donc aucun appel LLM ; avec `llm: true`, un
   * appel par fait repris et rien d'autre (les thèmes créés gardent leur
   * libellé heuristique), donc au plus `maxFacts` appels. Les amas sont
   * recalculés à la fin.
   */
  async processCognition(instanceId?: string, opts: CognitionPassOptions = {}): Promise<CognitionPassResult> {
    this.assertOpen()
    const includeBackfill = opts.includeBackfill === true
    const llm = includeBackfill && opts.llm === true
    // Les natures ne se mélangent pas : un rattrapage heuristique qui
    // absorberait un passage ordinaire priverait les faits neufs du LLM.
    const kind = includeBackfill ? (llm ? 'catchup-llm' : 'catchup') : 'pass'
    // En pause, Memoria ne lit ni n'écrit pour les agents : un rattrapage qui
    // enverrait des centaines de faits au LLM dans le dos de l'utilisateur est
    // refusé. L'heuristique, locale, reste permise.
    if (llm && !this.isEnabled()) {
      throw new Error('Memoria est en pause : rattrapage en mode LLM refusé. Réactive Memoria, ou lance le rattrapage sans LLM.')
    }
    const maxFacts =
      includeBackfill && typeof opts.maxFacts === 'number' && opts.maxFacts > 0 ? Math.floor(opts.maxFacts) : null
    const waiting = this.cognitionWaiting.get(kind)
    if (waiting) {
      // Demandes fondues : la plus large l'emporte (un appelant sans plafond n'est pas bridé).
      waiting.maxFacts = waiting.maxFacts === null || maxFacts === null ? null : Math.max(waiting.maxFacts, maxFacts)
      if (instanceId && waiting.instances) waiting.instances.add(instanceId)
      else waiting.instances = null
      if (opts.onProgress) waiting.listeners.push(opts.onProgress)
      return waiting.promise
    }
    const request: CognitionRequest = {
      instances: instanceId ? new Set([instanceId]) : null,
      includeBackfill,
      llm,
      maxFacts,
      listeners: opts.onProgress ? [opts.onProgress] : [],
      promise: undefined as unknown as Promise<CognitionPassResult>,
      cancelled: false,
    }
    const run = this.cognitionChain.then(() => {
      // Retiré de l'attente au DÉPART du passage : un appel qui arrive pendant
      // qu'il tourne ouvre le passage suivant au lieu d'être perdu.
      this.cognitionWaiting.delete(kind)
      this.cognitionRunning = request
      return this.runCognitionPass(request).finally(() => {
        this.cognitionRunning = null
      })
    })
    request.promise = run
    this.cognitionWaiting.set(kind, request)
    this.cognitionChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Demande l'arrêt du rattrapage en cours ou en attente. Il s'arrête entre
   * deux faits : ce qui est traité le reste, la suite attend le prochain
   * lancement. Un rattrapage LLM de plusieurs milliers de faits peut durer des
   * heures et retient derrière lui les passages ordinaires ; sans ceci, le seul
   * moyen de l'arrêter était de redémarrer. Un passage ordinaire n'est jamais
   * annulé. Rend false s'il n'y a aucun rattrapage à arrêter.
   */
  cancelCognitionCatchup(): boolean {
    const targets = [this.cognitionRunning, this.cognitionWaiting.get('catchup'), this.cognitionWaiting.get('catchup-llm')].filter(
      (r): r is CognitionRequest => r != null && r.includeBackfill,
    )
    for (const request of targets) request.cancelled = true
    return targets.length > 0
  }

  /** Un passage de cognition (toujours appelé sous la file de processCognition). */
  private async runCognitionPass(request: CognitionRequest): Promise<CognitionPassResult> {
    const result: CognitionPassResult = { processed: 0, llm_facts: 0, errors: 0, clusters_rebuilt: 0 }
    // Fermé pendant l'attente (arrêt du daemon) : on sort sans bruit.
    if (this.closed) return result
    // Pause posée pendant que ce rattrapage LLM attendait son tour : processCognition
    // l'avait accepté, mais rien ne doit partir au LLM dans le dos de l'utilisateur.
    if (request.llm && !this.isEnabled()) {
      throw new Error('Memoria est en pause : rattrapage en mode LLM refusé. Réactive Memoria, ou lance le rattrapage sans LLM.')
    }
    const heuristicOnly = request.includeBackfill && !request.llm
    // Heuristique seule : on ne résout même pas le profil LLM (aucune sonde réseau).
    const extraction = heuristicOnly ? null : (await this.ensureProfile()).extraction
    const cancelled = (): boolean => {
      if (request.cancelled) result.cancelled = true
      return request.cancelled
    }
    if (cancelled()) return result
    // Mode LLM demandé sans LLM joignable : on refuse AVANT de toucher un fait.
    // Dégrader en heuristique marquait les faits « heuristic » : ils partaient
    // ensuite au LLM lors d'un passage ordinaire (jusqu'à maxFacts appels que
    // personne n'avait demandés), alors que la sortie annonçait 0 appel.
    if (request.llm && !(await this.extractionReachable(extraction))) {
      throw new Error(
        'rattrapage en mode LLM impossible : aucun LLM d’extraction joignable. Rien n’a été traité. Relance sans LLM (heuristique), ou quand le LLM répond.',
      )
    }

    const paths = request.instances
      ? [...new Set([...request.instances].flatMap(id => this.contentDbPathsFor(id)))]
      : this.contentDbPathsFor()
    const progress: CognitionProgress = { dbs_total: paths.length, dbs_done: 0, processed: 0, errors: 0 }
    const report = (): void => {
      progress.processed = result.processed
      progress.errors = result.errors
      for (const listener of request.listeners) {
        try {
          listener({ ...progress })
        } catch {
          /* un écouteur fautif n'arrête pas la cognition */
        }
      }
    }

    const capReached = (): boolean => request.maxFacts !== null && result.processed + result.errors >= request.maxFacts
    // Extractions ratées d'affilée pendant un rattrapage LLM, toutes bases confondues.
    let consecutiveFailures = 0

    for (const path of paths) {
      if (this.closed) return result
      const store = this.openContent(path)
      // Liens hérités des faits critical, reliés avant que la cognition ne les
      // écarte : purgés une fois par base et par processus, AVANT le rangement
      // par thème, qui range de nouveau les faits des thèmes supprimés.
      if (!this.criticalPurged.has(path)) {
        this.criticalPurged.add(path)
        try {
          this.purgeCriticalLinks(store)
        } catch (err) {
          console.warn('[memoria] purge des liens des faits critical en échec :', (err as Error).message)
        }
      }
      // Moteurs SANS LLM hors cache pour le rattrapage heuristique : ceux du
      // cache gardent le LLM dès qu'ils l'ont connu (il est « collant »).
      const engine = heuristicOnly ? new CognitionEngine({ store, llm: null }) : this.cognitionFor(store, extraction)
      // Faits jamais traités (marqueur fact_cognition), + ceux vus en
      // heuristique seulement si un LLM est disponible maintenant (une fois).
      // Avant : « sans entité liée » → un fait où le LLM ne trouve rien
      // repartait au cloud à CHAQUE capture, sans fin.
      const llmAvailable = !heuristicOnly && extraction !== null && (await extraction.isAvailable())
      const remark = store.db.prepare("UPDATE fact_cognition SET via = 'backfill' WHERE fact_id = ?")
      // Compteur persistant : borne les nouveaux essais d'un redémarrage à l'autre (pendingFactIds).
      const countFailure = store.db.prepare('UPDATE fact_cognition SET llm_failures = llm_failures + 1 WHERE fact_id = ?')
      const markerOf = store.db.prepare('SELECT via FROM fact_cognition WHERE fact_id = ?')
      const seen = new Set<string>()
      // Faits traités par CE passage : seuls eux peuvent demander un libellé de thème au LLM.
      const processedNow = new Set<string>()
      let paused = false
      for (;;) {
        const ids = engine
          .pendingFactIds(llmAvailable, COGNITION_BATCH + seen.size + this.cognitionSkip.size, {
            includeBackfill: request.includeBackfill,
          })
          .filter(id => !seen.has(id) && !this.cognitionSkip.has(id))
        if (ids.length === 0) break
        // Plafond atteint alors qu'il reste des faits : on le dit, on n'y touche pas.
        if (capReached()) {
          result.capped = true
          break
        }
        for (const id of ids) {
          if (this.closed || cancelled()) return result
          if (capReached()) break
          // Pause posée en cours de route : un passage qui peut appeler le LLM
          // s'arrête entre deux faits. La suite attend la reprise. Sans LLM,
          // l'heuristique, locale, reste permise.
          if (engine.hasLlm && !this.isEnabled()) {
            if (request.llm) {
              throw new Error(
                `Memoria mise en pause : rattrapage LLM arrêté après ${result.processed} faits (${result.llm_facts} par le LLM). La suite reste à rattraper.`,
              )
            }
            paused = true
            break
          }
          seen.add(id)
          // Rattrapage LLM, ou nouvel essai LLM d'un fait déjà vu en
          // heuristique : en cas d'échec, rien n'est écrit (processFact
          // llmOnly). Le fait garde son marqueur d'origine et sa date : un
          // rattrapage ultérieur le reprend, et ses entités ne s'empilent pas.
          const llmOnly = request.llm || (llmAvailable && markerOf.get(id) !== undefined)
          let llmFailed = false
          try {
            const r = await engine.processFact(id, { llmOnly })
            if (r.processed) {
              result.processed++
              processedNow.add(id)
              if (r.via === 'llm') result.llm_facts++
              // LLM disponible mais extraction ratée (erreur, délai, JSON
              // illisible) : le marqueur reste « heuristic », donc le fait
              // serait rejoué à chaque passage. Une seule tentative par vie
              // du processus, et le compteur borne les redémarrages.
              else if (llmAvailable) {
                this.cognitionSkip.add(id)
                countFailure.run(id)
              }
              // Rattrapage heuristique : le marqueur reste « backfill » pour
              // qu'aucun passage ordinaire ne renvoie ensuite ces faits au LLM
              // (le coût surprise que la migration 11 évitait déjà).
              if (heuristicOnly) remark.run(id)
            } else if (r.llm_failed) {
              llmFailed = true
              result.errors++
              countFailure.run(id)
              // Le rattrapage ne met rien de côté : un rattrapage ultérieur, dans
              // ce même processus, doit pouvoir reprendre le fait.
              if (!request.llm) this.cognitionSkip.add(id)
            }
          } catch (err) {
            // Un fait qui plante (texte trop court pour une observation, ligne
            // abîmée) ne doit ni arrêter le passage ni revenir en tête de
            // liste à chaque fois : il bloquait tous les faits suivants.
            result.errors++
            this.cognitionSkip.add(id)
            console.warn(`[memoria] cognition du fait ${id} en échec :`, (err as Error).message)
          }
          report()
          if (request.llm) {
            consecutiveFailures = llmFailed ? consecutiveFailures + 1 : 0
            // isAvailable() ne prouve rien chez un fournisseur cloud (clé
            // présente) : seuls les échecs répétés disent que l'API est en panne.
            if (consecutiveFailures >= COGNITION_LLM_MAX_CONSECUTIVE_FAILURES) {
              throw new Error(
                `${consecutiveFailures} extractions LLM ratées d’affilée : rattrapage arrêté après ${result.processed} faits (${result.llm_facts} par le LLM). Les faits en échec restent à rattraper : relance quand le LLM répond.`,
              )
            }
            // Le LLM ne répond plus du tout : inutile d'attendre deux autres échecs.
            if (llmFailed && !(await this.extractionReachable(extraction))) {
              throw new Error(
                `LLM d’extraction devenu injoignable : rattrapage arrêté après ${result.processed} faits (${result.llm_facts} par le LLM). Relance-le quand le LLM répond.`,
              )
            }
          }
          // Un traitement heuristique n'attend rien : sans ce retour à la
          // boucle, 2 000 faits formaient un seul bloc et le daemon ne
          // répondait plus (voir docs/analyse-pannes-daemon-2026-11-05.md).
          await yieldToEventLoop()
        }
        // Passage ordinaire : un seul lot, comme avant. Le rattrapage va au bout
        // (ou jusqu'au plafond, constaté au tour suivant).
        if (!request.includeBackfill || paused) break
      }
      if (this.closed || cancelled()) return result

      // TOPICS : ranger les faits par thème APRÈS que les entités existent
      // (entité-first), par petites tranches pour la même raison.
      try {
        // Rattrapage (les deux modes) : libellés heuristiques, moteur hors cache.
        // Le rangement couvre TOUS les faits sans thème de la base, hors du
        // plafond maxFacts : avec le LLM, le coût du rattrapage ne serait plus borné.
        const topics = request.includeBackfill ? new TopicEngine({ store, llm: null }) : this.topicFor(store, extraction)
        // Faits ACTIFS sans thème, les plus récents d'abord. Un fait dormant (en
        // attente de validation) n'est pas rangé : le thème qu'il créerait
        // porterait son nom jusque dans le rappel des autres faits. Il sera
        // rangé au passage qui suit sa validation. Un fait critical non plus.
        const pending = store.db
          .prepare(
            `SELECT f.id FROM facts f
             WHERE f.superseded = 0 AND f.lifecycle_state = 'active' AND f.sensitivity IN ('normal','sensitive')
               AND NOT EXISTS (SELECT 1 FROM fact_topics ft WHERE ft.fact_id = f.id)
             ORDER BY f.created_at DESC LIMIT ?`,
          )
          // LIMIT -1 = sans limite (rattrapage).
          .all(request.includeBackfill ? -1 : COGNITION_BATCH) as Array<{ id: string }>
        for (let i = 0; i < pending.length; i++) {
          if (this.closed || request.cancelled) break
          const id = (pending[i] as { id: string }).id
          // Libellé LLM seulement pour un fait traité par CE passage, et jamais
          // en pause. Les autres (validés, partagés, hérités, thèmes supprimés
          // par un oubli) n'ont pas à partir au LLM hors du rattrapage plafonné.
          await topics.assignFact(id, { labelLlm: processedNow.has(id) && this.isEnabled() })
          if ((i + 1) % COGNITION_TOPIC_SLICE === 0) await yieldToEventLoop()
        }
      } catch (err) {
        result.errors++
        console.warn('[memoria] rangement par thème en échec :', (err as Error).message)
      }
      if (this.closed || cancelled()) return result

      // AMAS : recalcul complet sans LLM. Toujours après un rattrapage ; sinon
      // au plus une fois par jour, et seulement si ce passage a traité des faits.
      if (request.includeBackfill || (processedNow.size > 0 && this.clustersDue(path, store))) {
        try {
          const max = request.includeBackfill ? CLUSTER_CATCHUP_MAX_FACTS : CLUSTER_AUTO_MAX_FACTS
          const { n } = store.db
            .prepare("SELECT COUNT(*) AS n FROM facts WHERE superseded = 0 AND lifecycle_state = 'active'")
            .get() as { n: number }
          if (n > max) {
            // On note la tentative : sinon ce comptage et ce message reviendraient à chaque passage.
            this.clustersRebuiltAt.set(path, Date.now())
            result.clusters_skipped = (result.clusters_skipped ?? 0) + 1
            console.warn(`[memoria] amas non recalculés (${n} faits actifs, plafond ${max}) : le calcul durerait trop longtemps`)
          } else {
            await this.rebuildClustersAt(path, store)
            result.clusters_rebuilt++
          }
        } catch (err) {
          result.errors++
          console.warn('[memoria] recalcul des amas en échec :', (err as Error).message)
        }
        await yieldToEventLoop()
      }
      progress.dbs_done++
      report()
    }
    return result
  }

  /** Le LLM d'extraction répond-il ? (une sonde en erreur vaut « non ») */
  private async extractionReachable(extraction: LlmProvider | null): Promise<boolean> {
    if (!extraction) return false
    try {
      return await extraction.isAvailable()
    } catch {
      return false
    }
  }

  /**
   * Retire des couches dérivées des faits qui vont être effacés (oubli, rejet
   * en revue), ou qui n'auraient jamais dû y entrer (critical) :
   *  - thèmes : chaque thème touché est SUPPRIMÉ (son nom a pu venir de ces
   *    faits), ses autres faits seront rangés de nouveau ;
   *  - récurrences, amas : retirés des membres ;
   *  - graphe : liens fait-entité, contextes de relation, entités orphelines,
   *    observations recopiées (CognitionEngine.detachFacts).
   * Appelé AVANT hardDeleteFacts : thèmes et observations lisent encore le fait.
   */
  private purgeDerived(store: ContentStore, ids: string[]): void {
    if (ids.length === 0) return
    this.topicFor(store, null).onForget(ids)
    this.patternFor(store).onForget(ids)
    this.cognitionFor(store, null).detachFacts(ids)
    this.clusterFor(store).onForget(ids)
  }

  /**
   * Faits critical reliés avant que la cognition ne les écarte : leur texte a
   * nourri entités, relations, thème et amas. Mêmes nettoyages que l'oubli ;
   * le fait lui-même reste. Une requête par base et par processus.
   */
  private purgeCriticalLinks(store: ContentStore): void {
    const ids = (
      store.db
        .prepare(
          `SELECT f.id FROM facts f WHERE f.sensitivity = 'critical' AND (
             EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = f.id)
             OR EXISTS (SELECT 1 FROM fact_topics ft WHERE ft.fact_id = f.id)
             OR EXISTS (SELECT 1 FROM cluster_members cm WHERE cm.fact_id = f.id))`,
        )
        .all() as Array<{ id: string }>
    ).map(r => r.id)
    this.purgeDerived(store, ids)
  }

  /** Recalcul automatique des amas dû pour cette base ? (dernier recalcul vieux de plus d'un jour) */
  private clustersDue(path: string, store: ContentStore): boolean {
    let last = this.clustersRebuiltAt.get(path) ?? 0
    try {
      // La date survit au redémarrage tant qu'il reste au moins un amas en
      // base. On lit celle du RECALCUL : la date de mise à jour d'un amas bouge
      // à chaque oubli, et un oubli par jour repoussait le recalcul sans fin.
      const stored = this.clusterFor(store).lastRebuildAt()
      if (stored !== null) last = Math.max(last, stored)
    } catch {
      /* table absente : on s'en tient à la mémoire du processus */
    }
    return Date.now() - last >= CLUSTER_REBUILD_INTERVAL_MS
  }

  /** Recalcul des amas d'une base, découpé : le daemon répond pendant le calcul. */
  private async rebuildClustersAt(path: string, store: ContentStore): Promise<{ clusters: number }> {
    const r = await this.clusterFor(store).rebuildAsync()
    this.clustersRebuiltAt.set(path, Date.now())
    return { clusters: r.clusters }
  }

  /** Thèmes (couche 14) : liste des sujets d'une instance, triés par importance. */
  listTopics(instanceId: string, minFacts = 1): TopicSummary[] {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.topicFor(this.openContent(db.path), null).listTopics({ minFacts })
  }

  topicFacts(instanceId: string, topicId: string, limit = 50): Array<{ id: string; fact: string; category: string; created_at: string }> {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.topicFor(this.openContent(db.path), null)
      .factsForTopic(topicId, { limit })
      .map(f => ({ id: f.id, fact: f.fact, category: f.category, created_at: f.created_at }))
  }

  /** Graphe des thèmes (couche 14) : qui est lié à qui, et par quoi. Lecture, 0 LLM. */
  topicRelations(instanceId: string, minFacts = 2): TopicGraph {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { nodes: [], edges: [] }
    return this.topicFor(this.openContent(db.path), null).relations({ minFacts })
  }

  // ---------------------------------------------------------------- carte des souvenirs (T28)

  /** Bases de contenu à cartographier : la base privée de chaque agent actif + les bases partagées. */
  private mapSources(): Array<MemoryMapSource & { type: string; name: string }> {
    const out: Array<MemoryMapSource & { type: string; name: string }> = []
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      if (entry.kind === 'assistant') {
        const instance = entry.assistant_instance_id ? this.registry.getInstance(entry.assistant_instance_id) : null
        if (!instance || instance.revoked_at) continue
        const assistant = this.registry.getAssistant(instance.assistant_id)
        out.push({
          store: this.openContent(entry.path),
          agent: instance.id,
          type: assistant?.type ?? 'generic',
          name: assistant?.display_name ?? assistant?.type ?? 'agent',
        })
      } else {
        const scope = entry.scope_id ? this.registry.getScope(entry.scope_id) : null
        out.push({
          store: this.openContent(entry.path),
          // Une base partagée PAR scope : l'identifiant doit l'être aussi. Avec
          // le type (`shared:client`), deux clients fusionnaient dans la légende.
          agent: `shared:${entry.scope_id ?? entry.id}`,
          type: 'shared',
          name: scope?.name ?? 'shared',
        })
      }
    }
    return out
  }

  /**
   * Carte des souvenirs : chaque fait actif à sa position 2D (projection de
   * son embedding), tous agents dans le même espace. Lecture du cache ; si la
   * carte est vide ou nettement en retard, un recalcul part en arrière-plan.
   */
  async memoryMap(): Promise<MemoryMap> {
    this.assertOpen()
    const provider = await this.ensureEmbeddings()
    if (!provider) {
      return { status: 'no-embeddings', model: null, computed_at: null, points: [], agents: [], unplaced: 0 }
    }
    const key = { model: provider.model, dimensions: provider.dimensions }
    const sources = this.mapSources()
    const points: MemoryMapPoint[] = []
    const agents: MemoryMapAgent[] = []
    let unplaced = 0
    let placeable = 0
    let vectors = 0
    let computedAt: string | null = null
    const passes = new Set<string>()
    for (const source of sources) {
      const own = readMapPoints(source, key.model)
      const missing = countUnplaced(source, key.model)
      placeable += countPlaceable(source, key)
      vectors += countVectors(source, key)
      unplaced += missing
      for (const p of own) points.push(p)
      const at = lastComputedAt(source, key.model)
      if (at) passes.add(at)
      if (at && (!computedAt || at > computedAt)) computedAt = at
      // TOUTES les sources, même sans souvenir placé (points: 0) : l'écran
      // attribue les couleurs d'après le rang dans cette liste. Si elle ne
      // contenait que les agents présents sur la carte, la couleur des autres
      // changerait dès qu'un agent gagne ou perd son premier souvenir.
      agents.push({ id: source.agent, type: source.type, name: source.name, points: own.length, unplaced: missing })
    }
    // Recalcul automatique : carte vide, ou retard notable (pas à chaque fait).
    const late = placeable > 0 && (points.length === 0 || placeable >= Math.max(20, Math.ceil(points.length * 0.05)))
    // Pendant qu'une indexation avance, chaque lecture trouvait assez de
    // nouveaux vecteurs pour relancer un calcul complet, en chaîne. Une carte
    // qui a déjà des points attend donc un délai minimal ; le bouton
    // « Recalculer » (rebuildMemoryMap) reste immédiat.
    // Une date dans le futur (horloge déréglée, base venue d'une autre machine)
    // ne compte pas comme récente : elle bloquerait tout recalcul automatique.
    const within = (since: number): boolean => {
      const age = Date.now() - since
      return age >= 0 && age < Memoria.MAP_AUTO_MIN_INTERVAL_MS
    }
    const recent = points.length > 0 && computedAt !== null && within(Date.parse(computedAt))
    // Les positions de toutes les bases doivent sortir du MÊME calcul. Des dates
    // différentes = une écriture a échoué en route (deux calculs superposés) :
    // on refait un calcul complet, sans attendre le délai.
    const mixed = passes.size > 1
    if (this.mapAttempt === 'pending') this.mapAttempt = { model: key.model, vectors, placeable }
    const changed =
      !this.mapAttempt ||
      this.mapAttempt.model !== key.model ||
      this.mapAttempt.vectors !== vectors ||
      this.mapAttempt.placeable !== placeable
    // Après un échec, TOUTE relance automatique attend le délai, y compris pour
    // les dates mélangées et la carte vide. Sinon, pendant une panne durable,
    // chaque vecteur ajouté par l'indexation relance un calcul complet qui
    // échoue à son tour, en chaîne.
    const failedRecently = this.mapError !== null && this.mapFailedAt !== null && within(this.mapFailedAt)
    if ((mixed || (late && !recent)) && changed && !failedRecently && !this.mapJob) this.rebuildMemoryMap()
    if (this.mapJob) return { status: 'computing', model: key.model, computed_at: computedAt, points, agents, unplaced }
    if (this.mapError) {
      return { status: 'error', error: this.mapError, model: key.model, computed_at: computedAt, points, agents, unplaced }
    }
    return { status: points.length === 0 ? 'empty' : 'ready', model: key.model, computed_at: computedAt, points, agents, unplaced }
  }

  /**
   * Délai minimal entre deux recalculs AUTOMATIQUES d'une carte qui a déjà des
   * points, et avant toute relance automatique après un calcul en échec.
   */
  static readonly MAP_AUTO_MIN_INTERVAL_MS = 5 * 60_000

  /** Lance le recalcul de la carte (sans attendre). `started: false` si un calcul tourne déjà. */
  rebuildMemoryMap(): { started: boolean } {
    this.assertOpen()
    if (this.mapJob) return { started: false }
    this.mapError = null
    this.mapJob = (async () => {
      const provider = await this.ensureEmbeddings()
      if (!provider) return
      const key = { model: provider.model, dimensions: provider.dimensions }
      const sources = this.mapSources()
      const collected = await collectVectors(sources, key)
      if (this.closed) return
      // Après un calcul réussi, il reste à placer les seuls vecteurs écartés
      // (valeur non finie) : tout autre nombre veut dire que les données ont bougé.
      const attempt = { model: key.model, vectors: collected.candidates, placeable: collected.candidates - collected.n }
      // Le calcul part dans un worker thread : le daemon continue de répondre.
      // `collected.flat` est cédé au worker (pas de copie) : ne plus le lire après.
      const coords = await runProjection(collected.flat, collected.n, key.dimensions)
      if (this.closed) return
      const perSource = sources.map(() => [] as Array<{ id: string; x: number; y: number }>)
      collected.owners.forEach((owner, i) => {
        perSource[owner.source]!.push({ id: owner.id, x: coords[i * 2]!, y: coords[i * 2 + 1]! })
      })
      const computedAt = nowISO()
      // Une transaction par base : si l'une échoue (base verrouillée par un
      // autre process), on écrit quand même les autres, puis on signale
      // l'échec. Les bases restées sur l'ancien calcul gardent leur ancienne
      // date : memoryMap() voit le mélange et le dit.
      const failed: string[] = []
      for (const [i, source] of sources.entries()) {
        // L'attente d'un verrou est synchrone : rendre la main entre deux bases.
        if (i > 0) await new Promise<void>(resolve => setImmediate(resolve))
        if (this.closed) return
        try {
          writeProjection(source, key.model, perSource[i]!, computedAt)
        } catch (err) {
          failed.push(`${source.name} (${(err as Error).message})`)
        }
      }
      if (failed.length > 0) {
        throw new Error(`positions non écrites pour ${failed.length} base(s) sur ${sources.length} : ${failed.join(' ; ')}`)
      }
      this.mapAttempt = attempt
      this.mapFailedAt = null
    })()
      .catch((err: unknown) => {
        // Ce qui reste à placer après un échec n'est pas prévisible (certaines
        // bases sont écrites, d'autres non) : la prochaine lecture relève l'état.
        this.mapAttempt = 'pending'
        this.mapFailedAt = Date.now()
        this.mapError = (err as Error).message
        console.warn('[memoria] carte des souvenirs : calcul en échec :', this.mapError)
      })
      .finally(() => {
        this.mapJob = null
      })
    return { started: true }
  }

  /** Attend la fin du calcul en cours (tests, CLI). Rejette si le calcul a échoué. */
  async memoryMapSettled(): Promise<void> {
    await this.mapJob
    if (this.mapError) throw new Error(this.mapError)
  }

  /** Détail et fils d'un souvenir de la carte : voisins par le sens + entités partagées. */
  async memoryMapLinks(factId: string): Promise<MemoryMapLinks | null> {
    this.assertOpen()
    const provider = await this.ensureEmbeddings()
    if (!provider) return null
    return mapLinks(this.mapSources(), { model: provider.model, dimensions: provider.dimensions }, factId)
  }

  /** Récurrences (couche 22) : détecte + liste les patterns proposés d'une instance. */
  detectPatterns(instanceId: string, minOccurrences = 3): { proposed: number } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { proposed: 0 }
    const result = this.patternFor(this.openContent(db.path)).detect({ minOccurrences })
    return { proposed: result.proposed.length }
  }

  listPatterns(instanceId: string): Pattern[] {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.patternFor(this.openContent(db.path)).listProposed()
  }

  /**
   * Tranche une récurrence. Accepter = CONSOLIDER (c'est ce que promet le
   * bouton « Consolider ») : un seul membre reste actif — le canonique, le
   * plus récent (celui dont le pattern a tiré `canonical_fact`) — et les
   * autres membres encore actifs sont supersédés EN POINTANT SUR LUI
   * (superseded_by), comme mergeFacts. Rien n'est effacé, la chaîne reste
   * navigable et réversible. Avant : accept() ne changeait rien à la mémoire ;
   * PatternEngine.consolidate (jamais câblé) aurait supersédé TOUS les
   * membres sans remplaçant — perte nette de souvenirs.
   */
  decidePattern(instanceId: string, patternId: string, decision: 'accept' | 'dismiss'): { ok: boolean; superseded: number } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { ok: false, superseded: 0 }
    const store = this.openContent(db.path)
    const engine = this.patternFor(store)
    let superseded = 0
    const result = decision === 'accept' ? engine.accept(patternId) : engine.dismiss(patternId)
    if (decision === 'accept' && result) {
      const ph = result.member_fact_ids.map(() => '?').join(',')
      const members = result.member_fact_ids.length
        ? (store.db
            .prepare(`SELECT id, fact, created_at FROM facts WHERE id IN (${ph}) AND superseded = 0 ORDER BY created_at DESC`)
            .all(...result.member_fact_ids) as Array<{ id: string; fact: string; created_at: string }>)
        : []
      const canonical = members.find(f => f.fact === result.canonical_fact) ?? members[0]
      if (canonical && members.length > 1) {
        const ts = nowISO()
        const cognition = this.cognitionFor(store, null)
        const tx = store.db.transaction(() => {
          const stmt = store.db.prepare('UPDATE facts SET superseded = 1, superseded_by = ?, updated_at = ? WHERE id = ? AND superseded = 0')
          for (const f of members) {
            if (f.id === canonical.id) continue
            const changed = stmt.run(canonical.id, ts, f.id).changes
            superseded += changed
            // Une supersession sort le fait du graphe (voir correctFact).
            if (changed > 0) cognition.onFactSuperseded(f.id)
          }
        })
        tx()
      }
    }
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: `pattern_${decision}`,
      target_id_hash: sha256Hex(patternId),
      scope_id: null,
      reason: decision === 'accept' ? `superseded=${superseded}` : null,
    })
    return { ok: result !== null, superseded }
  }

  /**
   * Context-tree (couche 9) : complète un contexte partiel via la hiérarchie du
   * registre. Déclarer un projet remonte implicitement son client et son
   * organisation → le boost de pertinence s'applique à tout l'arbre, et les
   * faits du client du projet redeviennent visibles (cohérent : le projet EST
   * pour ce client).
   */
  private expandContextTree(context: import('../types.js').ActiveContext | undefined): import('../types.js').ActiveContext | undefined {
    if (!context?.project_id) return context
    const project = this.registry.getProject(context.project_id)
    if (!project) return context
    return {
      ...context,
      client_org_id: context.client_org_id ?? project.client_org_id ?? undefined,
      org_id: context.org_id ?? project.owner_org_id,
    }
  }

  private topicFor(store: ContentStore, llm: import('../llm/provider.js').LlmProvider | null): TopicEngine {
    let engine = this.topicEngines.get(store)
    if (!engine) {
      engine = new TopicEngine({ store, llm })
      this.topicEngines.set(store, engine)
    } else if (llm && !engine.hasLlm) {
      // Cache PAR STORE, pas par provider : un premier appel de lecture
      // (llm=null) ne doit pas priver le store des libellés LLM pour toujours.
      engine.setLlm(llm)
    }
    return engine
  }

  private patternFor(store: ContentStore): PatternEngine {
    let engine = this.patternEngines.get(store)
    if (!engine) {
      engine = new PatternEngine({ store })
      this.patternEngines.set(store, engine)
    }
    return engine
  }

  private proceduralFor(store: ContentStore): ProceduralEngine {
    let engine = this.proceduralEngines.get(store)
    if (!engine) {
      engine = new ProceduralEngine({ store })
      this.proceduralEngines.set(store, engine)
    }
    return engine
  }

  private feedbackFor(store: ContentStore): FeedbackEngine {
    let engine = this.feedbackEngines.get(store)
    if (!engine) {
      engine = new FeedbackEngine({ store })
      this.feedbackEngines.set(store, engine)
    }
    return engine
  }

  private clusterFor(store: ContentStore): ClusterEngine {
    let engine = this.clusterEngines.get(store)
    if (!engine) {
      engine = new ClusterEngine({ store })
      this.clusterEngines.set(store, engine)
    }
    return engine
  }

  private selfObsFor(store: ContentStore): SelfObservationEngine {
    let engine = this.selfObsEngines.get(store)
    if (!engine) {
      engine = new SelfObservationEngine({ store })
      this.selfObsEngines.set(store, engine)
    }
    return engine
  }

  private revisionFor(store: ContentStore): RevisionEngine {
    let engine = this.revisionEngines.get(store)
    if (!engine) {
      engine = new RevisionEngine({ store })
      this.revisionEngines.set(store, engine)
    }
    return engine
  }

  // ---------------------------------------------------- couches profondes (vague 7)

  /** Self-observation (couche 19) : l'agent observe son propre comportement. */
  selfObservations(instanceId: string, kind?: SelfObservation['kind']): SelfObservation[] {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.selfObsFor(this.openContent(db.path)).list(kind ? { kind } : {})
  }

  /** Dérive forces/faiblesses/habitudes depuis procédures + patterns (opt-in, propose). */
  deriveSelfObservations(instanceId: string): { proposed: number } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { proposed: 0 }
    const store = this.openContent(db.path)
    const procedures = this.proceduralFor(store).listProcedures().map(p => ({
      name: p.name,
      success_count: p.success_count,
      failure_count: p.failure_count,
    }))
    const patterns = this.patternFor(store).listProposed().map(p => ({ description: p.label, occurrences: p.occurrences }))
    const r = this.selfObsFor(store).deriveFromHistory({ procedures, patterns }, { instanceId })
    return { proposed: r.proposed.length }
  }

  /** Dialectic (couche 21) : confronte les points de vue de la mémoire (opt-in, lecture seule). */
  async dialectic(instanceId: string, question: string, limit = 12): Promise<DialecticResult> {
    this.assertOpen()
    const instance = this.mustInstance(instanceId)
    const targets = this.resolveReadTargets(instance)
    // Sur la DB privée (la principale) ; scopes autorisés transmis pour l'anti-fuite.
    const store = this.openContent(this.paths.assistantDb(instanceId))
    const scopeIds = targets.flatMap(t => t.scopeIds)
    return dialectic(store, question, { limit, scopeIds })
  }

  /** Revision (couches 18/24) : propose le ménage de la mémoire (contradits/doublons), sans rien modifier. */
  async proposeRevisions(instanceId: string, limit = 100): Promise<{ proposed: number }> {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { proposed: 0 }
    const r = await this.revisionFor(this.openContent(db.path)).propose({ limit })
    return { proposed: r.proposals.length }
  }

  /**
   * Propositions de révision EN ATTENTE, avec le contenu des deux souvenirs.
   *
   * Le type est ÉLARGI (RevisionProposalDetailed étend les champs de
   * RevisionProposal) : les appelants existants continuent de lire `kind`,
   * `reason` et les identifiants sans rien changer, et ceux qui affichent la
   * proposition à un humain ont enfin le TEXTE à montrer.
   */
  listRevisions(instanceId: string): RevisionProposalDetailed[] {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.revisionFor(this.openContent(db.path)).listProposalsDetailed()
  }

  /** Applique (supersède) ou écarte une proposition de révision — SUR VALIDATION explicite. */
  decideRevision(instanceId: string, proposalId: string, decision: 'accept' | 'dismiss'): { ok: boolean } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db) return { ok: false }
    const store = this.openContent(db.path)
    const engine = this.revisionFor(store)
    let ok: boolean
    if (decision === 'accept') {
      const accepted = engine.accept(proposalId)
      ok = accepted.applied
      // Une supersession sort le fait du graphe (voir correctFact).
      if (accepted.applied && accepted.supersededFactId) this.cognitionFor(store, null).onFactSuperseded(accepted.supersededFactId)
    } else {
      ok = engine.dismiss(proposalId)
    }
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: `revision_${decision}`,
      target_id_hash: sha256Hex(proposalId),
      scope_id: null,
      reason: null,
    })
    return { ok }
  }

  /** Auto-skill (couche 23) : propose des procédures consolidées depuis les récurrences (sur validation). */
  proposeSkills(instanceId: string): Array<{ label: string; steps: string[]; source: string }> {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    const proposals = new AutoSkillEngine({ store: this.openContent(db.path) }).propose()
    return proposals.map(p => ({ label: p.label, steps: p.steps, source: p.source }))
  }

  /**
   * Markdown sync (couche 20, opt-in) : exporte la mémoire d'une instance en
   * .md lisibles — sa DB privée à la racine de `outDir`, ET chaque scope
   * PARTAGÉ qu'elle peut lire sous `outDir/shared/<scope>/` (`user` compris :
   * c'est la destination nominale de « ce qu'un agent apprend SUR
   * l'utilisateur »). Avant, seule la DB privée partait : un utilisateur qui
   * exportait « sa mémoire » perdait la partie partagée sans avertissement.
   */
  exportMarkdown(instanceId: string, outDir: string, byTopic = true): { files: string[]; facts: number; shared_facts: number; scopes: string[] } {
    this.assertOpen()
    const instance = this.registry.getInstance(instanceId)
    const privateDb = this.paths.assistantDb(instanceId)
    if (!instance || !existsSync(privateDb)) return { files: [], facts: 0, shared_facts: 0, scopes: [] }

    const files: string[] = []
    let facts = 0
    let sharedFacts = 0
    const scopes: string[] = []
    for (const target of this.resolveReadTargets(instance)) {
      if (!existsSync(target.dbPath)) continue
      const store = this.openContent(target.dbPath)
      if (target.dbPath === privateDb) {
        const r = new MarkdownSync({ store, outDir }).export({ byTopic })
        files.push(...r.files)
        facts += r.facts
        continue
      }
      target.scopeIds.forEach((scopeId, i) => {
        // Un scope sans fait actif ne produit pas de dossier vide.
        const n = store.db
          .prepare("SELECT COUNT(*) AS n FROM facts WHERE superseded = 0 AND lifecycle_state = 'active' AND scope_id = ?")
          .get(scopeId) as { n: number }
        if (n.n === 0) return
        const name = target.scopeNames[i] ?? scopeId
        const r = new MarkdownSync({ store, outDir: join(outDir, 'shared', name.replace(/[^A-Za-z0-9._-]+/g, '-')) }).export({
          byTopic,
          scopeFilter: [scopeId],
        })
        files.push(...r.files)
        sharedFacts += r.facts
        scopes.push(name)
      })
    }
    return { files, facts, shared_facts: sharedFacts, scopes }
  }

  // ---------------------------------------------------------- procédures (couche 6)

  /** Retrouve les meilleures procédures pour une tâche (FTS + taux de succès), gouverné. */
  matchProcedures(instanceId: string, query: string, limit = 5): ProcedureMatch[] {
    this.assertOpen()
    const instance = this.mustInstance(instanceId)
    const targets = this.resolveReadTargets(instance)
    const out: ProcedureMatch[] = []
    for (const target of targets) {
      const store = this.openContent(target.dbPath)
      out.push(...this.proceduralFor(store).matchProcedures(query, { scopeIds: target.scopeIds, limit }))
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Apprentissage : enregistre le résultat d'exécution d'une procédure. */
  recordProcedureExecution(instanceId: string, procedureId: string, outcome: 'success' | 'failure', errorOutput?: string): boolean {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db) return false
    return this.proceduralFor(this.openContent(db.path)).recordExecution({ procedureId, outcome, errorOutput }).applied
  }

  listProcedures(instanceId: string): ProceduralProcedure[] {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.proceduralFor(this.openContent(db.path)).listProcedures()
  }

  // ---------------------------------------------------------- feedback (couches 7-8)

  /**
   * Renforce/atténue des faits selon leur usage réel dans une réponse.
   *
   * Retourne le détail (faits touchés, domaines crédités) : sans lui, un
   * appelant ne pouvait pas distinguer « signal pris en compte » de « aucun de
   * ces ids n'existe / est supersédé », et la boucle restait aveugle.
   */
  reinforceFacts(instanceId: string, factIds: string[], used: boolean): ReinforceResult {
    this.assertOpen()
    const instance = this.mustInstance(instanceId)
    // Même fan-out que le recall : les ids viennent de N'IMPORTE quelle DB
    // lisible (privée OU partagée). Ne chercher que dans la privée laissait
    // la mémoire partagée sans aucun signal d'usage (used_count figé à 0).
    const remaining = new Set(factIds)
    const updated: string[] = []
    const domains = new Set<string>()
    for (const target of this.resolveReadTargets(instance)) {
      if (remaining.size === 0) break
      const store = this.openContent(target.dbPath)
      const present = this.factsPresentIn(store, [...remaining], target.scopeIds)
      if (present.length === 0) continue
      const r = this.feedbackFor(store).reinforce(present, { used })
      for (const id of r.updated) {
        updated.push(id)
        remaining.delete(id)
      }
      for (const d of r.domains) domains.add(d)
    }
    return { updated, domains: [...domains] }
  }

  /** Ids (parmi `ids`) existant dans `store` sous l'un des scopes autorisés. */
  private factsPresentIn(store: ContentStore, ids: string[], scopeIds: string[]): string[] {
    if (ids.length === 0 || scopeIds.length === 0) return []
    const ip = ids.map(() => '?').join(',')
    const sp = scopeIds.map(() => '?').join(',')
    const rows = store.db
      .prepare(`SELECT id FROM facts WHERE id IN (${ip}) AND scope_id IN (${sp})`)
      .all(...ids, ...scopeIds) as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  /**
   * Localise un fait par id dans les DB LISIBLES par l'instance (sa privée +
   * les partagées dont le scope est autorisé) — là d'où viennent les ids que
   * memoria_recall lui a donnés. Null = introuvable dans SES scopes (un fait
   * privé d'un autre agent reste invisible, même par son id).
   */
  private locateFact(instance: AssistantInstance, factId: string): { store: ContentStore; row: FactRow; scope: MemoryScope } | null {
    for (const target of this.resolveReadTargets(instance)) {
      const store = this.openContent(target.dbPath)
      const row = store.db.prepare('SELECT * FROM facts WHERE id = ?').get(factId) as FactRow | undefined
      if (!row || !target.scopeIds.includes(row.scope_id)) continue
      const scope = this.registry.getScope(row.scope_id)
      if (!scope) continue
      return { store, row, scope }
    }
    return null
  }

  /** Modifier un fait partagé exige can_write sur son scope (le privé est toujours à soi). */
  private assertWritable(instance: AssistantInstance, scope: MemoryScope): void {
    if (scope.type === 'private') return
    // Épingler, corriger, dater un fait de l'espace d'équipe : jamais par OpenClaw, même avec le droit posé à la main.
    if (scope.type === 'org' && this.registry.getAssistant(instance.assistant_id)?.type === 'openclaw') {
      throw new Error(`${TEAM_WRITE_REFUSED} : un agent OpenClaw (joignable par des tiers) n'y modifie rien`)
    }
    const policy = this.registry.getPolicy(instance.assistant_id, scope.id)
    // Lecture seule sur l'espace d'équipe (cas du Mac du propriétaire) : le refus le nomme, pour que l'agent ne lise pas « scope user ».
    if (scope.type === 'org' && !policy?.can_write) {
      throw new Error(`${TEAM_WRITE_REFUSED} : cet agent lit l'espace d'équipe sans can_write ; il n'y modifie rien`)
    }
    if (!policy?.can_write) {
      throw new Error(`écriture refusée : l'assistant n'a pas can_write sur le scope « ${scope.name} »`)
    }
  }

  /**
   * Statut des messages d'une capture — le « suivi de colis » réclamé en bêta.
   *
   * Dérivé du WAL et de l'audit, SANS table ni colonne supplémentaire :
   *   processed=0, attempts=0  → pending    (en file)
   *   processed=0, attempts>0  → retrying   (tentative n/max)
   *   processed=1 + audit d'abandon → failed
   *   processed=1 sinon        → done
   *
   * L'abandon n'est pas marqué sur la ligne WAL (elle est simplement
   * `processed`), mais il est audité avec un hash de l'id : c'est ce hash qu'on
   * recoupe ici. Un statut faux serait pire que pas de statut.
   */
  captureStatus(instanceId: string, walIds: number[]): CaptureStatusResult {
    this.assertOpen()
    const out: CaptureStatusResult = { entries: [], pending: 0, retrying: 0, done: 0, failed: 0 }
    if (walIds.length === 0) return out
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return out
    const store = this.openContent(db.path)

    const placeholders = walIds.map(() => '?').join(',')
    const rows = store.db
      .prepare(`SELECT id, processed, attempts FROM wal_buffer WHERE id IN (${placeholders})`)
      .all(...walIds) as Array<{ id: number; processed: number; attempts: number }>
    const known = new Map(rows.map(r => [r.id, r]))

    for (const id of walIds) {
      const row = known.get(id)
      if (!row) {
        // Purgée par le cleanup borné : elle a forcément été traitée, sinon elle
        // serait restée pending (le cleanup ne touche que `processed = 1`).
        out.entries.push({ wal_id: id, status: 'done', attempts: 0 })
        out.done++
        continue
      }
      if (row.processed === 0) {
        const status = row.attempts > 0 ? 'retrying' : 'pending'
        out.entries.push({ wal_id: id, status, attempts: row.attempts })
        if (status === 'retrying') out.retrying++
        else out.pending++
        continue
      }
      const abandoned = this.registry.db
        .prepare("SELECT 1 FROM audit_log WHERE action = 'wal_entry_abandoned' AND target_id_hash = ? LIMIT 1")
        .get(sha256Hex(`wal:${store.path}:${id}`)) as unknown
      if (abandoned) {
        out.entries.push({ wal_id: id, status: 'failed', attempts: row.attempts })
        out.failed++
      } else {
        out.entries.push({ wal_id: id, status: 'done', attempts: row.attempts })
        out.done++
      }
    }
    return out
  }

  /**
   * CORRIGE un souvenir : crée la version corrigée et marque l'ancienne
   * supersédée, `superseded_by` pointant sur la nouvelle.
   *
   * On ne réécrit JAMAIS le contenu en place. Deux raisons : la chaîne de
   * supersession reste navigable (« d'où vient cette correction ? »), et une
   * correction erronée reste rattrapable — écraser le texte détruirait
   * l'historique sans filet. C'est la même règle que `RevisionEngine.accept()`.
   */
  correctFact(instanceId: string, factId: string, content: string): { replacement: Fact | null } {
    this.assertOpen()
    const text = content.trim()
    if (!text) throw new Error('contenu de correction vide')
    const instance = this.mustInstance(instanceId)
    const located = this.locateFact(instance, factId)
    if (!located || located.row.superseded) return { replacement: null }
    const { store, row: old, scope } = located
    this.assertWritable(instance, scope)

    // La correction hérite du classement de l'original (catégorie, scope,
    // épinglage) : corriger une formulation ne doit pas dégrader le rangement.
    // Le remplaçant naît dans la MÊME DB que l'original (storeForScope) : la
    // chaîne superseded_by reste navigable dans une seule base.
    // Dédup EXACTE seulement : une correction est proche de l'original par
    // construction, le near-dup la prendrait pour un doublon. Texte identique
    // à l'existant = rien à corriger (sinon l'original pointerait sur lui-même).
    // Le tout dans UNE transaction (même DB) : un échec entre l'insertion du
    // remplaçant et la supersession laissait deux faits actifs.
    const tx = store.db.transaction((): Fact | null => {
      const { fact: replacement } = this.storeFactInternal(
        { instance: instanceId, content: text, category: old.category, scope: old.scope_id },
        // Correction par un agent : un fait d'équipe corrigé repasse les garde-fous (secret, sensible…).
        { nearDup: false, byAgent: true },
      )
      if (replacement.id === factId) return null
      store.db
        .prepare("UPDATE facts SET superseded = 1, superseded_by = ?, updated_at = ? WHERE id = ? AND superseded = 0")
        .run(replacement.id, nowISO(), factId)
      if (old.pinned) store.db.prepare('UPDATE facts SET pinned = 1 WHERE id = ?').run(replacement.id)
      return replacement
    })
    const replacement = tx()
    if (!replacement) return { replacement: null }
    // Le fait corrigé sort du graphe : ses entités et les relations qu'il
    // justifiait reliaient encore l'ancienne association aux autres faits.
    // Même règle pour toute supersession (fusion, révision, récurrence).
    this.cognitionFor(store, null).onFactSuperseded(factId)
    this.registry.audit({
      actor_type: 'user', actor_id: 'local', action: 'fact_correct',
      target_id_hash: sha256Hex(factId), scope_id: null, reason: `replacement=${sha256Hex(replacement.id).slice(0, 12)}`,
    })
    return { replacement }
  }

  /**
   * FUSIONNE des doublons : `keepId` survit, les autres sont supersédés en
   * pointant sur lui. Aucun contenu n'est réécrit ni supprimé — un doublon
   * fusionné reste consultable et la fusion reste traçable.
   */
  mergeFacts(instanceId: string, keepId: string, mergeIds: string[]): { merged: string[] } {
    this.assertOpen()
    const targets = mergeIds.filter(id => id !== keepId)
    if (targets.length === 0) return { merged: [] }
    const instance = this.mustInstance(instanceId)
    const located = this.locateFact(instance, keepId)
    // Refuser plutôt que fusionner vers un fait absent ou déjà supersédé :
    // on créerait une chaîne cassée, exactement le bug legacy 'split:'.
    if (!located || located.row.superseded) throw new Error(`fusion impossible : le fait conservé ${keepId} est absent ou supersédé`)
    const { store, scope } = located
    this.assertWritable(instance, scope)
    // Les doublons fusionnés doivent vivre dans la MÊME DB que le conservé
    // (superseded_by ne traverse pas les bases) : un id d'ailleurs est ignoré.

    const ts = nowISO()
    const merged: string[] = []
    const tx = store.db.transaction(() => {
      for (const id of targets) {
        const r = store.db
          .prepare("UPDATE facts SET superseded = 1, superseded_by = ?, updated_at = ? WHERE id = ? AND superseded = 0")
          .run(keepId, ts, id)
        if (r.changes > 0) merged.push(id)
      }
    })
    tx()
    // Les doublons fusionnés sortent du graphe (voir correctFact).
    const cognition = this.cognitionFor(store, null)
    for (const id of merged) cognition.onFactSuperseded(id)
    if (merged.length > 0) {
      this.registry.audit({
        actor_type: 'user', actor_id: 'local', action: 'fact_merge',
        target_id_hash: sha256Hex(keepId), scope_id: null, reason: `merged=${merged.length}`,
      })
    }
    return { merged }
  }

  /**
   * Souvenirs JAMAIS utilisés — la matière du ménage réclamé en bêta
   * (« afficher les mémoires jamais utilisées »).
   */
  neverUsedFacts(instanceId: string, limit = 100): Fact[] {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    const store = this.openContent(db.path)
    const rows = store.db
      .prepare(
        `SELECT * FROM facts
         WHERE superseded = 0 AND used_count = 0 AND pinned = 0
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(Math.max(1, limit)) as FactRow[]
    return rows.map(rowToFact)
  }

  /**
   * Épingle ou désépingle un souvenir. Un fait épinglé remonte franchement au
   * recall et échappe à l'atténuation des dormants — c'est le « garde ça sous
   * la main » réclamé en bêta. Ne modifie jamais le contenu.
   */
  setPinned(instanceId: string, factId: string, pinned: boolean): boolean {
    this.assertOpen()
    const instance = this.mustInstance(instanceId)
    const located = this.locateFact(instance, factId)
    if (!located) return false
    this.assertWritable(instance, located.scope)
    const { store } = located
    const r = store.db
      .prepare('UPDATE facts SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, nowISO(), factId)
    if (r.changes > 0) {
      this.registry.audit({
        actor_type: 'user', actor_id: 'local',
        action: pinned ? 'fact_pin' : 'fact_unpin',
        target_id_hash: sha256Hex(factId), scope_id: null, reason: null,
      })
    }
    return r.changes > 0
  }

  /**
   * Fixe (ou lève, avec `null`) la date d'expiration d'un souvenir. Passé cette
   * date il n'est plus RAPPELÉ — il n'est pas supprimé : l'utilisateur a demandé
   * qu'on cesse de s'en servir, pas qu'on efface l'historique.
   *
   * La date est stockée en ISO Z, quel que soit le format reçu : du texte brut
   * (« Jan 1 2020 », décalage +05:00) se comparait mal en SQL, et la garde du
   * thème jugeait vivant un fait que le rappel jugeait expiré.
   */
  setExpiry(instanceId: string, factId: string, expiresAt: string | null): boolean {
    this.assertOpen()
    if (expiresAt !== null) {
      const at = Date.parse(expiresAt)
      if (Number.isNaN(at)) throw new Error(`date d'expiration invalide : ${expiresAt} (ISO 8601 attendu)`)
      expiresAt = new Date(at).toISOString()
    }
    const instance = this.mustInstance(instanceId)
    const located = this.locateFact(instance, factId)
    if (!located) return false
    this.assertWritable(instance, located.scope)
    const { store } = located
    const r = store.db
      .prepare('UPDATE facts SET expires_at = ?, updated_at = ? WHERE id = ?')
      .run(expiresAt, nowISO(), factId)
    if (r.changes > 0) {
      this.registry.audit({
        actor_type: 'user', actor_id: 'local', action: 'fact_expiry',
        target_id_hash: sha256Hex(factId), scope_id: null,
        reason: expiresAt ? `expires_at=${expiresAt}` : 'levée',
      })
    }
    return r.changes > 0
  }

  /** Domaines d'expertise de l'agent (où il « sait » le plus). */
  topExpertise(instanceId: string, limit = 10): Array<{ domain: string; level: number; evidence_count: number }> {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.feedbackFor(this.openContent(db.path)).topDomains(limit)
  }

  /**
   * Amorce l'expertise depuis les thèmes existants : l'agent « maîtrise » les
   * sujets sur lesquels il a accumulé le plus de souvenirs. Le signal d'usage
   * (reinforce) l'affinera ensuite. Idempotent (recalcul complet).
   */
  bootstrapExpertise(instanceId: string): { domains: number } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { domains: 0 }
    const store = this.openContent(db.path)
    const feedback = this.feedbackFor(store)
    const topics = this.topicFor(store, null).listTopics({ minFacts: 3 })
    let domains = 0
    for (const t of topics.slice(0, 30)) {
      // AMORCE, pas verdict : accumuler des souvenirs sur un sujet n'en fait
      // pas un « expert confirmé ». Avant : delta = log1p(fact_count) ≥ 1.39
      // dans la saturation `prev + delta × (1 − prev)` → 1.0 en un pas pour
      // TOUS les thèmes (30 domaines à 1.0 en prod, « maîtrise : Environ GB »).
      // Cible bornée (3 faits ≈ 0.14, 50 faits ≈ 0.39, jamais > 0.4) ; on ne
      // fait que COMBLER l'écart jusqu'à cette cible : idempotent d'un boot à
      // l'autre, et un niveau gagné par l'usage réel (reinforce) n'est jamais
      // abaissé.
      const target = Math.min(BOOTSTRAP_EXPERTISE_CAP, 0.1 * Math.log1p(t.fact_count))
      const current = feedback.getExpertise(t.name)?.level ?? 0
      if (current >= target) continue
      // updateExpertise applique prev + delta × (MAX − prev) : delta pour atteindre `target`.
      feedback.updateExpertise(t.name, (target - current) / (EXPERTISE_MAX - current))
      domains++
    }
    return { domains }
  }

  // ---------------------------------------------------------- clusters (couche 16)

  rebuildClusters(instanceId: string): { clusters: number } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { clusters: 0 }
    // Appel direct, d'un seul bloc (API synchrone) ; les passages de cognition
    // utilisent la version découpée (rebuildClustersAt).
    const r = this.clusterFor(this.openContent(db.path)).rebuild()
    this.clustersRebuiltAt.set(db.path, Date.now())
    return { clusters: r.clusters }
  }

  listClusters(instanceId: string, minSize = 3): Array<{ id: string; label: string; size: number }> {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    return this.clusterFor(this.openContent(db.path))
      .listClusters({ minSize })
      .map(c => ({ id: c.id, label: c.label, size: c.size }))
  }

  /**
   * Importe le graphe cognitif (entités/relations/observations/topics) d'une
   * base legacy v3.34 vers la mémoire PRIVÉE d'une instance. Complète
   * `importLegacyDb` (qui ne ramène que faits + procédures). La base legacy est
   * ouverte en lecture seule. Idempotent.
   */
  importCognitionInto(legacyPath: string, instanceId: string): import('../migration/import-cognition.js').ImportCognitionReport {
    this.assertOpen()
    this.mustInstance(instanceId)
    const privateScope = this.registry.getScopeByName(`private:${instanceId}`)
    if (!privateScope) throw new Error(`scope privé introuvable pour l'instance ${instanceId}`)
    const store = this.openContent(this.paths.assistantDb(instanceId))
    const legacy = new DatabaseCtor(legacyPath, { readonly: true })
    try {
      const report = importLegacyCognition({ legacyDb: legacy, targetStore: store, scopeId: privateScope.id })
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: 'import_cognition',
        target_id_hash: sha256Hex(instanceId),
        scope_id: privateScope.id,
        reason: `entities=${report.entities_imported};relations=${report.relations_imported};observations=${report.observations_imported}`,
      })
      return report
    } finally {
      legacy.close()
    }
  }

  /**
   * Importe des transcripts (Claude Code / Codex / Markdown) vers la mémoire
   * d'une instance, en QUARANTAINE (faits dormants + revue). Réutilise le LLM
   * d'extraction du profil. Idempotent par hash de fichier.
   */
  async importTranscripts(
    instanceId: string,
    files: string[],
    opts: {
      sinceDate?: string
      maxWindowsPerFile?: number
      dryRun?: boolean
      onProgress?: import('../migration/import-transcripts.js').ImportTranscriptsInput['onProgress']
    } = {},
  ): Promise<import('../migration/import-transcripts.js').ImportTranscriptsReport> {
    this.assertOpen()
    this.mustInstance(instanceId)
    const { extraction } = await this.ensureProfile()
    const report = await importTranscripts({
      files,
      memoria: this,
      instanceId,
      extraction,
      // Même gate secrets que la capture : rien ne part au LLM en clair.
      redactor: this.redactor,
      secretSink: s => this.vaultSecret(s),
      sinceDate: opts.sinceDate,
      maxWindowsPerFile: opts.maxWindowsPerFile,
      dryRun: opts.dryRun,
      onProgress: opts.onProgress,
    })
    if (!opts.dryRun && report.facts_quarantined > 0) {
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: 'import_transcripts',
        target_id_hash: sha256Hex(instanceId),
        scope_id: null,
        reason: `quarantined=${report.facts_quarantined};files=${report.files_read}`,
      })
    }
    return report
  }

  /**
   * Instance ChatGPT de cette machine (non révoquée), ou null. Toujours la
   * MÊME d'un import à l'autre : une nouvelle instance = une nouvelle base, et
   * tout l'export repartirait au LLM.
   */
  findChatGptInstance(): string | null {
    this.assertOpen()
    const machine = hostname()
    const found = this.listAgents()
      .filter(a => a.assistant_type === 'chatgpt' && a.instance.revoked_at === null)
      .sort((a, b) => Number(b.instance.machine_id === machine) - Number(a.instance.machine_id === machine) || a.instance.created_at.localeCompare(b.instance.created_at))
    return found[0]?.instance.id ?? null
  }

  /**
   * Instance ChatGPT existante, sinon créée (type `chatgpt`, scope privé et
   * base dédiée). L'appairage est conclu tout de suite : ChatGPT ne se
   * connecte jamais au daemon, son jeton n'est gardé nulle part.
   */
  ensureChatGptInstance(): string {
    const existing = this.findChatGptInstance()
    if (existing) return existing
    const paired = this.pairAssistant({ type: 'chatgpt', display_name: 'ChatGPT' })
    const done = this.completePairing(paired.pairing_code)
    if (!done) throw new Error('création de l’instance ChatGPT impossible (appairage refusé)')
    return done.assistant_instance_id
  }

  /** Fournisseur et modèle d'extraction configurés, sans les appeler (estimation de coût). */
  async extractionModel(): Promise<{ provider: string; model: string } | null> {
    this.assertOpen()
    const { extraction } = await this.ensureProfile()
    return extraction ? { provider: extraction.name, model: extraction.model } : null
  }

  /**
   * Importe des conversations d'un export ChatGPT (déjà lues) en QUARANTAINE,
   * par la même chaîne que les transcripts : fenêtres, extraction, état des
   * fenêtres, dédup, faits dormants en revue. Prompt dédié (idées, décisions,
   * préférences) ; pas de plafond qui sacrifie le début d'une conversation.
   * `instanceId` null : dry-run seulement (aucune instance encore créée).
   */
  async importChatGpt(
    instanceId: string | null,
    units: import('../migration/import-transcripts.js').TranscriptUnit[],
    opts: {
      maxWindowsPerFile?: number
      dryRun?: boolean
      onProgress?: import('../migration/import-transcripts.js').ImportTranscriptsInput['onProgress']
    } = {},
  ): Promise<import('../migration/import-transcripts.js').ImportTranscriptsReport> {
    this.assertOpen()
    if (instanceId !== null) {
      const assistant = this.listAgents().find(a => a.instance.id === instanceId)
      this.mustInstance(instanceId)
      if (assistant && assistant.assistant_type !== 'chatgpt') {
        throw new Error(`l'instance ${instanceId} est de type « ${assistant.assistant_type} », pas chatgpt`)
      }
    } else if (!opts.dryRun) {
      throw new Error('import ChatGPT : instance cible manquante')
    }
    const { extraction } = await this.ensureProfile()
    const report = await importTranscripts({
      files: [],
      units,
      memoria: this,
      instanceId,
      extraction,
      redactor: this.redactor,
      secretSink: s => this.vaultSecret(s),
      systemPrompt: CHATGPT_EXTRACTION_SYSTEM,
      maxWindowsPerFile: opts.maxWindowsPerFile ?? Number.POSITIVE_INFINITY,
      tailQuietMs: 0,
      dryRun: opts.dryRun,
      onProgress: opts.onProgress,
    })
    if (!opts.dryRun && instanceId !== null && report.facts_quarantined > 0) {
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: 'import_chatgpt',
        target_id_hash: sha256Hex(instanceId),
        scope_id: null,
        reason: `quarantined=${report.facts_quarantined};conversations=${report.files_read}`,
      })
    }
    return report
  }

  /** Decay du graphe (job quotidien) sur toutes les DB de contenu. */
  decayCognition(): { decayed: number; pruned: number } {
    this.assertOpen()
    let decayed = 0
    let pruned = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const r = this.cognitionFor(this.openContent(entry.path), null).decay()
      decayed += r.decayed
      pruned += r.pruned
    }
    return { decayed, pruned }
  }

  private cognitionFor(store: ContentStore, llm: import('../llm/provider.js').LlmProvider | null): CognitionEngine {
    let engine = this.cognitionEngines.get(store)
    if (!engine) {
      engine = new CognitionEngine({ store, llm })
      this.cognitionEngines.set(store, engine)
    } else if (llm && !engine.hasLlm) {
      // Même règle que topicFor : le LLM devient collant dès qu'on le connaît.
      // Avant : recall() avant la 1re capture → moteur figé en heuristique,
      // extraction graphe LLM jamais utilisée, sans aucun signal.
      engine.setLlm(llm)
    }
    return engine
  }

  /**
   * DB de contenu à traiter pour une instance : SA DB privée + les DB partagées
   * dont le scope lui est lisible (même fan-out que le recall) — sans
   * instance : toutes. Avant, les jobs par instance (embeddings, cognition)
   * ne voyaient que la DB privée : un fait posé dans `user` restait sans
   * vecteur ni entités jusqu'au prochain redémarrage.
   */
  private contentDbPathsFor(instanceId?: string): string[] {
    if (!instanceId) {
      return this.registry
        .listDbs()
        .filter(e => e.kind !== 'registry' && existsSync(e.path))
        .map(e => e.path)
    }
    const instance = this.registry.getInstance(instanceId)
    if (!instance || instance.revoked_at) return []
    return this.resolveReadTargets(instance)
      .map(t => t.dbPath)
      .filter(p => existsSync(p))
  }

  /**
   * Indexe les faits sans embedding (une instance, ou toutes). Appelé après
   * chaque capture (fire-and-forget), après chaque storeFact (différé) et au
   * boot du daemon. Sans provider d'embeddings → no-op.
   */
  async indexEmbeddings(instanceId?: string): Promise<{ indexed: number }> {
    this.assertOpen()
    const provider = await this.ensureEmbeddings()
    if (!provider) return { indexed: 0 }
    let indexed = 0
    const paths = this.contentDbPathsFor(instanceId)
    for (const [i, path] of paths.entries()) {
      // Main rendue entre deux bases : au démarrage, les 8 bases se vérifiaient d'un bloc.
      if (i > 0) await new Promise(resolve => setImmediate(resolve))
      if (this.closed) break
      const store = this.openContent(path)
      let indexer = this.indexers.get(store)
      if (!indexer) {
        indexer = new EmbeddingIndexer({ store, provider })
        this.indexers.set(store, indexer)
      }
      const run = await indexer.runAll()
      indexed += run.indexed
    }
    return { indexed }
  }

  /** Rejeu du WAL au boot (daemon) : aucune entrée pending n'est oubliée. */
  async replayWal(): Promise<Array<{ instance: string; summary: WalReplaySummary }>> {
    this.assertOpen()
    const pipeline = await this.ensurePipeline()
    const out: Array<{ instance: string; summary: WalReplaySummary }> = []
    for (const inst of this.registry.listInstances()) {
      if (inst.revoked_at) continue
      const db = this.registry.dbForInstance(inst.id)
      if (!db || !existsSync(db.path)) continue
      const summary = await pipeline.replayAtBoot(inst.id)
      out.push({ instance: inst.id, summary })
    }
    return out
  }

  /**
   * Un moteur d'extraction est-il configuré ET joignable ? Sert de garde-fou
   * AVANT de lancer un job d'import (422 côté daemon : « Configure d'abord un
   * moteur d'intelligence ») — plutôt qu'un job qui tourne pour rien.
   */
  async hasExtraction(): Promise<boolean> {
    this.assertOpen()
    const { extraction } = await this.ensureProfile()
    if (!extraction) return false
    try {
      return await extraction.isAvailable()
    } catch (err) {
      console.warn(`[memoria] disponibilité du moteur d'extraction : ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Profil LLM résolu une fois (override tests/daemon > résolution auto) —
   * mais un profil INCOMPLET est retenté après `profileRetryMs` : ce que le
   * pipeline utilise doit finir par refléter ce qui tourne sur la machine.
   */
  private ensureProfile(): Promise<{ extraction: LlmProvider | null; embeddings: EmbeddingProvider | null }> {
    if (
      this.profilePromise &&
      this.llmOverride === undefined &&
      this.profileSnapshot &&
      (this.profileSnapshot.extraction === null || this.profileSnapshot.embeddings === null) &&
      Date.now() - this.profileResolvedAt >= this.profileRetryMs
    ) {
      this.profilePromise = null
    }
    this.profilePromise ??= (async () => {
      // Compteur de consommation : TOUS les providers (locaux compris, et
      // ceux injectés par les tests/daemon) — c'est une mesure, pas un audit.
      const usageSink: UsageSink = call => this.registry.recordLlmUsage(call)
      if (this.llmOverride !== undefined) {
        return {
          extraction: this.llmOverride.extraction ? meterExtraction(this.llmOverride.extraction, usageSink) : null,
          embeddings: this.llmOverride.embeddings ? meterEmbeddings(this.llmOverride.embeddings, usageSink) : null,
        }
      }
      // Passe les modèles déjà en base pour que l'avertissement cross-modèle
      // ne crie au loup que s'il y a vraiment un mélange (pas à chaque boot).
      const profile = await resolveLlmProfile(this.resolved.config, {
        knownEmbeddingModels: this.listKnownEmbeddingModels(),
      })
      // Journal des envois cloud : enveloppe ICI, seul point où les deux
      // providers sont résolus. Les providers locaux ressortent inchangés.
      const sink: CloudAuditSink = send => {
        this.registry.audit({
          actor_type: 'system',
          actor_id: 'llm',
          action: 'cloud_send',
          target_id_hash: null,
          scope_id: null,
          reason: formatCloudSend(send),
        })
      }
      this.adoptProfileSnapshot(profile)
      // Ordre : compteur à l'extérieur, audit cloud à l'intérieur — l'audit
      // expose aussi la variante détaillée, le compteur voit donc les tokens.
      return {
        extraction: profile.extraction ? meterExtraction(auditExtraction(profile.extraction, sink), usageSink) : null,
        embeddings: profile.embeddings ? meterEmbeddings(auditEmbeddings(profile.embeddings, sink), usageSink) : null,
      }
    })()
    return this.profilePromise
  }

  /**
   * Enregistre l'empreinte du profil résolu et jette ce qui a mémoïsé
   * l'ANCIEN provider : le pipeline de capture (extraction figée dans
   * CapturePipeline) si l'extraction change, les indexeurs si les embeddings
   * changent. Rien n'est jeté quand rien ne change (les groupes de tours en
   * mémoire du pipeline survivent à une simple re-vérification).
   */
  private adoptProfileSnapshot(profile: { extraction: LlmProvider | null; embeddings: EmbeddingProvider | null }): void {
    const next = {
      extraction: profile.extraction ? `${profile.extraction.name}/${profile.extraction.model}` : null,
      embeddings: profile.embeddings ? `${profile.embeddings.name}/${profile.embeddings.model}` : null,
    }
    const prev = this.profileSnapshot
    if (prev && prev.extraction !== next.extraction) this.pipelinePromise = null
    if (prev && prev.embeddings !== next.embeddings) this.indexers = new WeakMap<ContentStore, EmbeddingIndexer>()
    this.profileSnapshot = next
    this.profileResolvedAt = Date.now()
  }

  /** Oublie le profil mémoïsé (et tout ce qui en dépend) : re-résolu au prochain usage. */
  private invalidateProfile(): void {
    this.profilePromise = null
    this.pipelinePromise = null
    this.profileSnapshot = null
    this.indexers = new WeakMap<ContentStore, EmbeddingIndexer>()
  }

  /**
   * `SELECT DISTINCT model FROM embeddings` sur chaque memory.sqlite d'assistant.
   * Lecture seule, best-effort — un fichier verrouillé n'empêche pas le boot.
   */
  private listKnownEmbeddingModels(): string[] {
    const assistantsDir = join(this.resolved.storageRoot, 'assistants')
    if (!existsSync(assistantsDir)) return []
    const models = new Set<string>()
    for (const id of readdirSync(assistantsDir)) {
      const dbPath = this.paths.assistantDb(id)
      if (!existsSync(dbPath)) continue
      try {
        const db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true })
        try {
          const rows = db.prepare('SELECT DISTINCT model FROM embeddings').all() as Array<{ model: string }>
          for (const r of rows) {
            if (r.model) models.add(r.model)
          }
        } finally {
          db.close()
        }
      } catch {
        // base absente / schéma ancien / lock — ignorer
      }
    }
    return [...models].sort()
  }

  private async ensureEmbeddings(): Promise<EmbeddingProvider | null> {
    return (await this.ensureProfile()).embeddings
  }

  /** Pipeline de capture construit une fois (résolution LLM comprise). */
  private ensurePipeline(): Promise<CapturePipeline> {
    this.pipelinePromise ??= (async () => {
      const { extraction } = await this.ensureProfile()
      return new CapturePipeline({
        openStore: id => this.openContent(this.paths.assistantDb(id)),
        // ID du scope (pas le nom) : findDuplicate compare facts.scope_id
        defaultScope: id => {
          const scope = this.registry.getScopeByName(`private:${id}`)
          if (!scope) throw new Error(`scope privé introuvable pour l'instance ${id}`)
          return scope.id
        },
        storeFact: input => this.storeCaptured(input),
        // Le pipeline dédoublonne déjà contre le scope privé ; ici, les scopes
        // PARTAGÉS lisibles (un fait déjà dans `user` ne revient pas en privé).
        knownElsewhere: (id, text) => this.findKnownDuplicate(id, text, { includePrivate: false }) !== null,
        audit: entry => this.registry.audit(entry),
        redactor: this.redactor,
        secretSink: s => this.vaultSecret(s),
        extraction,
      })
    })()
    return this.pipelinePromise
  }

  /**
   * Écriture issue de la CAPTURE : en mode review-first le fait naît DORMANT
   * (invisible au recall) + entre en file de revue ; l'approbation l'active.
   */
  private storeCaptured(input: StoreFactInput): Fact {
    // near-dup ASSUMÉ ici : la capture voit des redites bruitées d'un même
    // souvenir ; une déclaration explicite (storeFact) ne l'a pas.
    return this.storeFactInternal(
      { ...input, source: input.source ?? 'capture' },
      { nearDup: true, quarantine: this.getCaptureMode() === 'review-first' },
    ).fact
  }

  /**
   * Met un fait FRAÎCHEMENT inséré en quarantaine de revue : dormant + item
   * `pending` (source « capture-review »). Appelé DANS la transaction de
   * l'INSERT. Un fait déjà connu (dédup) ne passe jamais ici : le rendre
   * dormant ferait disparaître du recall un souvenir validé.
   */
  private quarantineForReview(store: ContentStore, fact: Fact, instanceId: string, source?: ReviewSourceSpec): Fact {
    store.db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(fact.id)
    const sourceId = source ? this.ensureNamedSource(store, source) : this.ensureReviewSource(store, instanceId)
    store.db
      .prepare(
        `INSERT INTO memory_import_items (id, source_id, target_memory_id, target_type, proposed_scope_id, status, confidence)
         VALUES (?, ?, ?, 'fact', ?, 'pending', ?)`,
      )
      .run(newId(), sourceId, fact.id, fact.scope_id, fact.confidence)
    return { ...fact, lifecycle_state: 'dormant' }
  }

  /** Source unique « capture-review » par instance (provenance des items en revue). */
  private ensureReviewSource(store: ContentStore, instanceId: string): string {
    const hash = sha256Hex(`capture-review:${instanceId}`)
    const existing = store.db.prepare('SELECT id FROM memory_sources WHERE source_hash = ?').get(hash) as
      | { id: string }
      | undefined
    if (existing) return existing.id
    const id = newId()
    store.db
      .prepare(
        `INSERT INTO memory_sources (id, source_type, source_path, source_hash, imported_at, metadata)
         VALUES (?, 'capture-review', NULL, ?, ?, ?)`,
      )
      .run(id, hash, new Date().toISOString(), JSON.stringify({ instance: instanceId }))
    return id
  }

  /** Source nommée (ex. « user-messages » d'une session) : une par clé, créée à la première écriture. */
  private ensureNamedSource(store: ContentStore, source: ReviewSourceSpec): string {
    const hash = sha256Hex(`${source.type}:${source.key}`)
    const existing = store.db.prepare('SELECT id FROM memory_sources WHERE source_hash = ?').get(hash) as { id: string } | undefined
    if (existing) return existing.id
    const id = newId()
    store.db
      .prepare(
        `INSERT INTO memory_sources (id, source_type, source_path, source_hash, imported_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, source.type, source.path ?? null, hash, nowISO(), JSON.stringify(source.metadata ?? {}))
    return id
  }

  /** File de revue : items pending (capture review-first ET quarantaine d'import). */
  listReview(opts: { limit?: number } = {}): Array<{
    id: string
    fact_id: string
    content: string
    category: string
    confidence: number
    source_type: string
    source_db: string
    created_at: string
    topics: string[]
  }> {
    this.assertOpen()
    const limit = Math.min(opts.limit ?? 100, 500)
    const out: ReturnType<Memoria['listReview']> = []
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      const topicEngine = this.topicFor(store, null)
      const rows = store.db
        .prepare(
          `SELECT i.id, i.target_memory_id AS fact_id, i.confidence, s.source_type,
                  f.fact AS content, f.category, f.created_at
           ${REVIEW_QUEUE_FROM}
           ORDER BY f.created_at DESC LIMIT ?`,
        )
        .all(limit) as Array<Omit<ReturnType<Memoria['listReview']>[number], 'source_db' | 'topics'>>
      for (const row of rows) {
        out.push({
          ...row,
          source_db: relative(this.paths.root, entry.path),
          topics: topicEngine.topicsForFact(row.fact_id).map(t => t.name),
        })
      }
    }
    return out.slice(0, limit)
  }

  /**
   * Nombre d'items de la file de revue, toutes bases : même périmètre que
   * listReview (REVIEW_QUEUE_FROM), sans plafond, sans tri ni thèmes. Sert le
   * badge « Revue » de l'interface, relu toutes les 20 s : il lisait la liste
   * entière (150 à 353 ms de boucle figée, règle n°27). Le COUNT garde la
   * recherche dans l'index de `facts.id` par item, pour que le compte égale la
   * liste (un fait oublié laisse son item `pending`). Sur 72 737 items (copie
   * de la plus grosse base) : 40 à 65 ms en régime établi, contre 110 à 159 ms
   * pour la liste de 100.
   */
  countReview(): number {
    this.assertOpen()
    let total = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      total += (store.db.prepare(`SELECT COUNT(*) AS c ${REVIEW_QUEUE_FROM}`).get() as { c: number }).c
    }
    return total
  }

  /** Approuve (active) ou rejette (hard-delete) des items de revue. */
  reviewDecision(itemIds: string[], decision: 'accepted' | 'rejected'): { updated: number } {
    this.assertOpen()
    if (itemIds.length === 0) return { updated: 0 }
    // Des faits en attente changent d'état : le cache des redites du tri est périmé.
    this.dropTriageVecCache()
    let updated = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      const placeholders = itemIds.map(() => '?').join(',')
      const rows = store.db
        .prepare(
          `SELECT id, target_memory_id FROM memory_import_items WHERE id IN (${placeholders}) AND status = 'pending'`,
        )
        .all(...itemIds) as Array<{ id: string; target_memory_id: string }>
      if (rows.length === 0) continue
      const tx = store.db.transaction(() => {
        const factIds = rows.map(r => r.target_memory_id)
        if (decision === 'accepted') {
          const fp = factIds.map(() => '?').join(',')
          store.db.prepare(`UPDATE facts SET lifecycle_state = 'active' WHERE id IN (${fp})`).run(...factIds)
          resetBackfillMarkers(store, factIds)
        } else {
          // Même nettoyage que forget : un dormant relié ou rangé avant le
          // correctif de la cognition laissait son nom de thème et ses arêtes.
          this.purgeDerived(store, factIds)
          store.hardDeleteFacts(factIds)
        }
        const ip = rows.map(() => '?').join(',')
        store.db
          .prepare(
            `UPDATE memory_import_items SET status = ?, reviewed_by = 'local', reviewed_at = ? WHERE id IN (${ip})`,
          )
          .run(decision, new Date().toISOString(), ...rows.map(r => r.id))
      })
      tx()
      updated += rows.length
      // Un fait dormant n'a ni entité ni thème (la cognition l'ignore) : une
      // fois validé, il doit rejoindre le graphe sans attendre une capture.
      // Rejeté : les faits des thèmes supprimés sont à ranger de nouveau.
      this.scheduleCognition()
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: `review_${decision}`,
        target_id_hash: sha256Hex(rows.map(r => r.target_memory_id).sort().join(',')),
        scope_id: null,
        reason: `items=${rows.length}`,
      })
    }
    // Un fait approuvé devient `active` : il est maintenant éligible à
    // l'indexation (les dormants ne sont jamais embeddés avant revue). Même
    // fire-and-forget que le post-capture — l'échec est loggé, jamais avalé.
    if (decision === 'accepted' && updated > 0) {
      void this.indexEmbeddings().catch((err: unknown) =>
        console.warn(`[memoria] indexation après approbation en échec : ${(err as Error).message}`),
      )
    }
    return { updated }
  }

  /**
   * Nombre de faits encore en quarantaine legacy (`legacy_to_review`).
   * Garde-fou des imports : le scope est UNIQUE — on refuse d'importer une 2e
   * base legacy tant que la quarantaine n'est pas vidée (adoptLegacyInto).
   */
  legacyQuarantineCount(): number {
    this.assertOpen()
    const scope = this.registry.getScopeByName('legacy_to_review')
    if (!scope) return 0
    const entry = this.registry.dbForScope(scope.id)
    if (!entry || !existsSync(entry.path)) return 0
    return this.openContent(entry.path).countFacts()
  }

  /**
   * Adopte la quarantaine (`legacy_to_review`) vers la mémoire PRIVÉE d'une
   * instance : les souvenirs hérités deviennent réellement à elle et
   * recallables. Déplacement (copie dans la DB privée + retrait de la
   * quarantaine), pas duplication. Réversible via le backup d'import.
   */
  adoptLegacyInto(instanceId: string, opts: { reindex?: boolean } = {}): { facts: number; procedures: number } {
    this.assertOpen()
    const instance = this.mustInstance(instanceId)
    const legacyScope = this.registry.getScopeByName('legacy_to_review')
    if (!legacyScope) return { facts: 0, procedures: 0 }
    const legacyDbEntry = this.registry.dbForScope(legacyScope.id)
    if (!legacyDbEntry || !existsSync(legacyDbEntry.path)) return { facts: 0, procedures: 0 }

    const source = this.openContent(legacyDbEntry.path)
    const targetPath = this.paths.assistantDb(instanceId)
    const target = this.openContent(targetPath)
    const privateScope = this.registry.getScopeByName(`private:${instanceId}`)
    if (!privateScope) throw new Error(`scope privé introuvable pour l'instance ${instanceId}`)

    const factRows = source.db.prepare('SELECT * FROM facts').all() as FactRow[]
    const procRows = source.db.prepare('SELECT * FROM procedures').all() as Array<Record<string, unknown>>

    const factCols = source.db.pragma('table_info(facts)') as Array<{ name: string }>
    const procCols = source.db.pragma('table_info(procedures)') as Array<{ name: string }>
    const factColNames = factCols.map(c => c.name)
    const procColNames = procCols.map(c => c.name)

    const insertFact = target.db.prepare(
      `INSERT OR IGNORE INTO facts (${factColNames.join(',')}) VALUES (${factColNames.map(c => '@' + c).join(',')})`,
    )
    const insertProc = procColNames.length
      ? target.db.prepare(
          `INSERT OR IGNORE INTO procedures (${procColNames.join(',')}) VALUES (${procColNames.map(c => '@' + c).join(',')})`,
        )
      : null

    const move = target.db.transaction(() => {
      let f = 0
      for (const row of factRows) {
        insertFact.run({
          ...row,
          scope_id: privateScope.id,
          assistant_instance_id: instanceId,
          visibility: 'private',
          lifecycle_state: 'active',
          // La quarantaine peut contenir des lignes sans hash (import fait
          // après la migration) : recopiées telles quelles, elles obligeaient
          // la recherche de doublon à balayer le scope privé.
          ...(factColNames.includes('norm_hash') ? { norm_hash: factNormHash(row.fact) } : {}),
        })
        f++
      }
      let p = 0
      if (insertProc) {
        for (const row of procRows) {
          insertProc.run({ ...row, scope_id: privateScope.id, assistant_instance_id: instanceId })
          p++
        }
      }
      return { f, p }
    })
    const moved = move()

    // Vide la quarantaine (le backup d'import reste la sécurité de rollback)
    source.db.exec('DELETE FROM memory_import_items; DELETE FROM facts; DELETE FROM procedures; DELETE FROM memory_sources;')

    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: 'adopt_legacy',
      target_id_hash: sha256Hex(instanceId),
      scope_id: privateScope.id,
      reason: `facts=${moved.f};procedures=${moved.p}`,
    })

    if (opts.reindex) {
      void this.indexEmbeddings(instanceId).catch((err: unknown) =>
        console.warn('[memoria] réindexation post-adoption en échec :', (err as Error).message),
      )
    }
    void instance
    return { facts: moved.f, procedures: moved.p }
  }

  // ------------------------------------------------------------------ partage

  /**
   * Promeut des faits vers un scope PARTAGÉ (`user`/`org`/…) : ils quittent la
   * mémoire privée de leur agent et deviennent recallables par tout agent
   * autorisé sur ce scope (spec §11, partage gouverné). Déplacement, pas copie.
   *
   * Vers l'espace d'équipe (`org`, alias compris) : garde-fous CÔTÉ SERVEUR
   * (teamShareRefusal) ; un fait écarté reste où il est, et `refused` donne
   * les comptes par raison. Les autres scopes ne changent pas.
   */
  shareFacts(factIds: string[], targetScopeRef: string): ShareFactsResult {
    this.assertOpen()
    if (factIds.length === 0) return { shared: 0, scope: targetScopeRef }
    const scope = this.resolveScopeRef(targetScopeRef)
    if (!scope) throw new Error(`scope cible inconnu : ${targetScopeRef}`)
    if (scope.type === 'private' || scope.type === 'legacy_to_review') {
      throw new Error(`partage interdit vers un scope ${scope.type}`)
    }
    const refused: TeamShareRefusedCounts | null =
      scope.type === 'org' ? (Object.fromEntries(TEAM_SHARE_REFUSALS.map(r => [r, 0])) as TeamShareRefusedCounts) : null
    const targetPath = this.sharedDbPathPublic(scope)
    const target = this.openContent(targetPath)
    this.registry.registerDb({ kind: 'shared', path: targetPath, assistant_instance_id: null, scope_id: scope.id })
    // Les faits (et leurs vecteurs de tri) changent de base : cache des redites périmé.
    this.dropTriageVecCache()

    const idSet = new Set(factIds)
    let shared = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || entry.path === targetPath || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      const placeholders = [...idSet].map(() => '?').join(',')
      let rows = store.db.prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`).all(...idSet) as FactRow[]
      if (rows.length === 0) continue
      if (refused) {
        const triage = new Map(readTriageRows(store.db, rows.map(r => r.id)).map(t => [t.fact_id, t]))
        rows = rows.filter(row => {
          const why = this.teamShareRefusal(row, triage.get(row.id) ?? null)
          if (why) refused[why]++
          return why === null
        })
        if (rows.length === 0) continue
      }
      const cols = (store.db.pragma('table_info(facts)') as Array<{ name: string }>).map(c => c.name)
      const insert = target.db.prepare(
        `INSERT OR IGNORE INTO facts (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`,
      )
      const tx = target.db.transaction(() => {
        for (const row of rows) {
          insert.run({
            ...row,
            scope_id: scope.id,
            visibility: 'shared',
            // Partager = VALIDER. Un fait dormant (revue en attente) copié tel
            // quel restait dormant à jamais dans la DB partagée : invisible au
            // recall de tous, sorti de la revue (l'item pointait vers un fait
            // parti), donc perdu — 4 238 dormants en prod étaient exposés à ça.
            lifecycle_state: 'active',
            org_id: scope.org_id ?? row.org_id,
            client_org_id: scope.client_org_id ?? row.client_org_id,
            project_id: scope.project_id ?? row.project_id,
            // Hash toujours posé à l'arrivée, même si la ligne source n'en avait pas.
            ...(cols.includes('norm_hash') ? { norm_hash: factNormHash(row.fact) } : {}),
          })
          shared++
        }
      })
      tx()
      const ids = rows.map(r => r.id)
      // La ligne de tri (et le vecteur de tri) suivent le fait : l'effacement
      // ci-dessous les emporterait (clé étrangère en cascade).
      try {
        copyTriageRows(store.db, target.db, ids)
      } catch (err) {
        console.warn('[memoria] partage : lignes de tri non recopiées :', (err as Error).message)
      }
      const leave = store.db.transaction(() => {
        // Clore les items de revue du fait déplacé : sinon ils restent
        // `pending` en orphelins et une approbation ultérieure répond
        // « updated: 1 » sans rien changer (faux succès).
        const ph = ids.map(() => '?').join(',')
        store.db
          .prepare(
            `UPDATE memory_import_items SET status = 'accepted', reviewed_by = 'local', reviewed_at = ?
             WHERE status = 'pending' AND target_memory_id IN (${ph})`,
          )
          .run(nowISO(), ...ids)
        store.hardDeleteFacts(ids)
      })
      leave()
    }
    if (shared > 0) {
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: 'share_facts',
        target_id_hash: sha256Hex([...idSet].sort().join(',')),
        scope_id: scope.id,
        reason: refused ? `shared=${shared} refused=${Object.values(refused).reduce((n, c) => n + c, 0)}` : `shared=${shared}`,
      })
      // Le partage ne copie que la ligne du fait : entités, thème et marqueur
      // restent dans la base d'origine (puis y sont supprimés). La base
      // partagée doit donc refaire la cognition de ce qu'elle vient de recevoir.
      // Pas d'instance ici : toutes les bases, en un seul passage différé.
      this.scheduleCognition()
    }
    return refused ? { shared, scope: scope.name, refused } : { shared, scope: scope.name }
  }

  /** Scopes + agents qui peuvent les lire (matrice de partage UI). */
  // ------------------------------------------------------------ synchro inter-machines

  /** ContentStore d'un scope PARTAGÉ (ouvre/enregistre la DB locale). null si privé/inconnu. */
  sharedContentStore(scopeId: string): ContentStore | null {
    this.assertOpen()
    const scope = this.registry.getScope(scopeId)
    if (!scope || scope.type === 'private' || scope.type === 'legacy_to_review') return null
    const path = this.sharedDbPathPublic(scope)
    const store = this.openContent(path)
    this.registry.registerDb({ kind: 'shared', path, assistant_instance_id: null, scope_id: scope.id })
    return store
  }

  /** Scopes synchronisables présents localement (types whitelistés). */
  syncableScopes(whitelist: readonly string[]): MemoryScope[] {
    this.assertOpen()
    // Un seul espace d'équipe voyage : celui que vise l'alias `org`
    // (teamScope), donc celui où le propriétaire partage. Un Mac qui porte
    // deux scopes org (doublon laissé par un ancien join) les proposerait
    // sinon tous les deux, et le Mac invité reprendrait deux fois l'identité.
    const team = whitelist.includes('org') ? this.teamScope() : null
    return this.registry.listScopes().filter(s => whitelist.includes(s.type) && (s.type !== 'org' || s.id === team?.id))
  }

  /**
   * Configure cette machine comme HUB de synchro (persiste). Redémarrage requis
   * pour le listener LAN.
   *
   * - Espaces : `scopes` (types) validés, `org` par défaut ; jamais `user`,
   *   privé ni quarantaine. Sans `scopes`, la liste déjà en place est gardée
   *   (filtrée des types interdits).
   * - Clés du groupe : NEUVES tant qu'aucun Mac n'est relié. Un coffre peut
   *   garder des clés d'un ancien essai, qu'un nouveau groupe ne doit pas
   *   reprendre. Avec des Mac déjà reliés, elles sont gardées : les changer
   *   les couperait tous sans un mot (changer la clé = `rotate-key`, reporté).
   */
  configureSyncHub(listenLan: string, scopes?: readonly string[] | string | null): { listen_lan: string; scopes: string[]; keys: 'new' | 'kept' } {
    this.assertOpen()
    const types = scopes === undefined || scopes === null ? effectiveSyncTypes(this.resolved.config.sync?.scopes) : normalizeSyncTypes(scopes)
    const linked = this.registry.listPeers().filter(p => p.role === 'spoke')
    const keys: 'new' | 'kept' = linked.length === 0 ? 'new' : 'kept'
    if (keys === 'new') freshGroupKeys(this.secretProvider)
    this.resolved.config.sync = {
      ...this.resolved.config.sync,
      enabled: true,
      role: 'hub',
      machine_id: localMachineId(this.registry),
      listen_lan: listenLan,
      scopes: types,
    }
    this.saveConfig()
    this.registry.audit({ actor_type: 'user', actor_id: 'local', action: 'sync_hub_configured', target_id_hash: null, scope_id: null, reason: `scopes=${types.join(',')};keys=${keys}` })
    this.syncEngine = undefined // re-construire avec la nouvelle config
    return { listen_lan: listenLan, scopes: types, keys }
  }

  /**
   * Déplace le contenu d'un espace partagé vers un nouvel identifiant (reprise
   * de l'identité du hub au join) : toutes les colonnes d'espace de sa base, et
   * l'empreinte de contenu, qui contient l'identifiant de l'espace. Une seule
   * transaction de cette base ; sans effet si la base n'existe pas encore.
   */
  private moveScopeContent(from: MemoryScope, toId: string): void {
    if (from.type === 'private' || from.type === 'legacy_to_review') throw new Error(`espace ${from.type} : jamais déplacé par la synchro`)
    const path = this.sharedDbPath(from)
    if (!existsSync(path)) return
    const store = this.openContent(path)
    const rows = store.db.prepare('SELECT id, fact, category FROM facts WHERE scope_id = ? AND content_hash IS NOT NULL').all(from.id) as Array<{ id: string; fact: string; category: string }>
    const rehash = store.db.prepare('UPDATE facts SET content_hash = ? WHERE id = ?')
    store.db.transaction(() => {
      repointScopeColumns(store.db, from.id, toId)
      for (const r of rows) rehash.run(contentHash({ fact: r.fact, category: r.category, scope_id: toId }), r.id)
    })()
  }

  /** Coffre local (pour le module de synchro — clés GVK/CPK + valeurs scellées). */
  get secrets(): SecretProvider {
    return this.secretProvider
  }

  /** Moteur de synchro inter-machines (lazy). Construit avec la config [sync]. */
  get sync(): SyncEngine {
    if (!this.syncEngine) {
      this.syncEngine = new SyncEngine({
        registry: this.registry,
        secrets: this.secretProvider,
        machineId: localMachineId(this.registry),
        // relue à chaque usage : join et leave remplacent l'objet de config
        config: () => this.resolved.config.sync ?? {},
        sharedStore: (scopeId: string) => this.sharedContentStore(scopeId),
        listSyncableScopes: (whitelist: readonly string[]) => this.syncableScopes(whitelist),
        persistConfig: () => this.saveConfig(),
        setSyncConfig: (patch: Record<string, unknown>) => {
          this.resolved.config.sync = { ...this.resolved.config.sync, ...patch }
        },
        replaceSyncConfig: (cfg: SyncConfig | undefined) => {
          if (cfg) this.resolved.config.sync = { ...cfg }
          else delete this.resolved.config.sync
        },
        moveScopeContent: (from: MemoryScope, toId: string) => this.moveScopeContent(from, toId),
      })
    }
    return this.syncEngine
  }

  listScopesWithAccess(): Array<{ id: string; type: string; name: string; readers: string[]; facts: number }> {
    this.assertOpen()
    return this.registry.listScopes().map(scope => {
      const readers = this.registry
        .listAssistants()
        .filter(a => this.registry.getPolicy(a.id, scope.id)?.can_read)
        .map(a => a.id)
      let facts = 0
      const dbEntry = scope.type === 'private' ? null : this.registry.dbForScope(scope.id)
      if (dbEntry && existsSync(dbEntry.path)) {
        facts = (this.openContent(dbEntry.path).db.prepare('SELECT COUNT(*) AS c FROM facts WHERE scope_id = ?').get(scope.id) as { c: number }).c
      }
      return { id: scope.id, type: scope.type, name: scope.name, readers, facts }
    })
  }

  /** Accorde/retire à un assistant l'accès à un scope (matrice de partage). */
  setScopeAccess(
    assistantId: string,
    scopeId: string,
    perms: { can_read?: boolean; can_write?: boolean; can_share?: boolean; secret_access?: 'none' | 'refs_only' | 'value_on_request' },
  ): void {
    this.assertOpen()
    const current = this.registry.getPolicy(assistantId, scopeId)
    this.registry.setPolicy({
      assistant_id: assistantId,
      scope_id: scopeId,
      can_read: perms.can_read ?? current?.can_read ?? false,
      can_write: perms.can_write ?? current?.can_write ?? false,
      can_share: perms.can_share ?? current?.can_share ?? false,
      secret_access: perms.secret_access ?? current?.secret_access ?? 'none',
    })
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: 'set_scope_access',
      target_id_hash: sha256Hex(`${assistantId}:${scopeId}`),
      scope_id: scopeId,
      reason: JSON.stringify(perms),
    })
  }

  /**
   * Repère, dans la mémoire d'une instance, les faits qui parlent de
   * l'utilisateur (identité/préférences) — candidats à promouvoir vers `user`.
   * Ne décide RIEN : retourne des propositions que l'utilisateur valide.
   */
  suggestIdentityFacts(instanceId: string, limit = 50): Array<{ id: string; content: string; category: string; score: number }> {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return []
    const store = this.openContent(db.path)
    // Actifs seulement : un fait dormant attend l'écran Revue, pas l'écran
    // Partage — le proposer ici court-circuitait la revue.
    const rows = store.db.prepare("SELECT * FROM facts WHERE superseded = 0 AND lifecycle_state = 'active'").all() as FactRow[]
    const user = this.registry.bootstrap().user
    const nameTokens = user.display_name.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    const cues = [
      ...nameTokens,
      'utilisateur', 'préfère', 'prefere', 'aime', 'déteste', 'deteste', 'veut', 'identité', 'identity',
      'son nom', 'mon nom', 'email', 'courriel', 'téléphone', 'adresse', 'anniversaire', 'langue',
      'pompeu', 'neto', 'primo',
    ]
    const identityCats = new Set(['identity', 'preference', 'profil', 'profile', 'user', 'savoir'])
    const scored = rows
      .map(r => {
        const text = r.fact.toLowerCase()
        let score = 0
        for (const cue of cues) if (text.includes(cue)) score += cue.length > 4 ? 2 : 1
        if (identityCats.has(r.category.toLowerCase())) score += 1
        return { id: r.id, content: r.fact, category: r.category, score }
      })
      .filter(c => c.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    return scored
  }

  /** Variante publique de sharedDbPath (utilisée par shareFacts). */
  private sharedDbPathPublic(scope: MemoryScope): string {
    return this.sharedDbPath(scope)
  }

  /**
   * Hard-delete gouverné (spec §11). `matched` = faits visés (utile en dry_run).
   *
   * Sans `ids`, la suppression est TOUJOURS « en masse » (confirm_bulk requis),
   * requête comprise : la CLI l'exigeait déjà, le moteur laissait passer.
   */
  forget(filter: ForgetFilter): { deleted: number; matched: number } {
    this.assertOpen()
    const hasIds = (filter.ids?.length ?? 0) > 0
    if (!hasIds && !filter.query && !filter.category && !filter.scope_id) {
      throw new Error('forget : filtre vide refusé')
    }
    if (!hasIds && filter.confirm_bulk !== true) {
      throw new Error('forget : suppression en masse — confirm_bulk requis')
    }
    // Un fait oublié ne doit plus être rendu comme redite par le cache du tri.
    this.dropTriageVecCache()

    let deleted = 0
    let matched = 0
    /** Ids effacés, toutes bases confondues : leurs originaux sont rendus ensuite. */
    const gone = new Set<string>()
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      let ids = filter.ids ?? []
      if (!hasIds) {
        const conditions: string[] = []
        const params: unknown[] = []
        if (filter.scope_id) {
          conditions.push('scope_id = ?')
          params.push(filter.scope_id)
        }
        if (filter.category) {
          conditions.push('category = ?')
          params.push(filter.category)
        }
        let rows: Array<{ id: string }>
        if (filter.query) {
          // La requête FTS est un OR (pensé pour le recall, qui note ensuite la
          // couverture). Pour EFFACER, on exige tous les mots : « clé API
          // Stripe » ne doit pas emporter « la clé du bureau est chez Claire ».
          const tokens = queryTokens(filter.query)
          rows = store
            .searchFacts(filter.query, { limit: 500, includeDormant: true, maxSensitivity: 'critical', scopeIds: filter.scope_id ? [filter.scope_id] : undefined })
            .filter(h => {
              const text = normalizeText(h.row.fact)
              return tokens.every(t => text.includes(t))
            })
            .map(h => ({ id: h.row.id }))
          if (filter.category) rows = rows.filter(r => store.getFact(r.id)?.category === filter.category)
        } else {
          rows = store.db
            .prepare(`SELECT id FROM facts${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`)
            .all(...params) as Array<{ id: string }>
        }
        ids = rows.map(r => r.id)
      }
      if (ids.length === 0) continue
      // Ne compter que les ids réellement présents dans CETTE base — sinon
      // dry_run additionnait ids × nombre de bases (« matched: 3 » pour 1 fait).
      const present = store.db
        .prepare(`SELECT COUNT(*) AS n FROM facts WHERE id IN (${ids.map(() => '?').join(',')})`)
        .get(...ids) as { n: number }
      matched += present.n
      if (filter.dry_run || present.n === 0) continue
      // Nettoyer thèmes, récurrences, graphe et amas AVANT le hard-delete
      // (ils lisent encore le fait) : voir purgeDerived.
      this.purgeDerived(store, ids)
      const n = store.hardDeleteFacts(ids)
      deleted += n
      if (n === 0) continue
      for (const id of ids) gone.add(id)
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: 'forget',
        target_id_hash: sha256Hex(ids.slice().sort().join(',')),
        scope_id: filter.scope_id ?? null,
        reason: `deleted=${n}`,
      })
    }
    if (gone.size === 0) return { deleted, matched }

    // Oublier un REMPLAÇANT (correction, fusion, consolidation) rend la parole
    // à l'original : sinon il restait `superseded_by = <id disparu>`, invisible
    // au recall à jamais — la chaîne cassée du legacy « split: ». Passe à part,
    // APRÈS les suppressions et sur TOUTES les bases : après shareFacts, le
    // remplaçant vit dans la base partagée et l'original reste dans la base
    // privée, où un oubli par requête ne trouvait pas l'id du remplaçant.
    const goneJson = JSON.stringify([...gone])
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      const restoredIds = (
        store.db.prepare('SELECT id FROM facts WHERE superseded_by IN (SELECT value FROM json_each(?))').all(goneJson) as Array<{ id: string }>
      ).map(r => r.id)
      if (restoredIds.length === 0) continue
      const restoredJson = JSON.stringify(restoredIds)
      store.db
        .prepare('UPDATE facts SET superseded = 0, superseded_by = NULL, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))')
        .run(nowISO(), restoredJson)
      // La supersession l'avait sorti du graphe : sans marqueur, le passage
      // suivant le relie de nouveau.
      store.db.prepare('DELETE FROM fact_cognition WHERE fact_id IN (SELECT value FROM json_each(?))').run(restoredJson)
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: 'forget',
        target_id_hash: sha256Hex([...gone].sort().join(',')),
        scope_id: filter.scope_id ?? null,
        reason: `restored=${restoredIds.length}`,
      })
    }
    // Faits des thèmes supprimés, originaux rendus : à ranger et relier de nouveau.
    this.scheduleCognition()
    return { deleted, matched }
  }

  // -------------------------------------------------------------------- admin

  /**
   * Navigation admin dans la mémoire (UI web) : faits d'une instance (sa DB
   * privée) ou de toutes les DB, récents d'abord ou filtrés FTS.
   */
  browseFacts(opts: { instance?: string; q?: string; limit?: number } = {}): Array<Fact & { source_db: string; topics: string[] }> {
    this.assertOpen()
    const limit = Math.min(opts.limit ?? 50, 200)
    const targets: string[] = []
    if (opts.instance) {
      const db = this.registry.dbForInstance(opts.instance)
      if (db) targets.push(db.path)
    } else {
      for (const entry of this.registry.listDbs()) {
        if (entry.kind !== 'registry' && existsSync(entry.path)) targets.push(entry.path)
      }
    }
    const out: Array<Fact & { source_db: string; topics: string[] }> = []
    for (const path of targets) {
      const store = this.openContent(path)
      const label = relative(this.paths.root, path)
      const topicEngine = this.topicFor(store, null)
      const withTopics = (row: FactRow): Fact & { source_db: string; topics: string[] } => ({
        ...rowToFact(row),
        source_db: label,
        topics: topicEngine.topicsForFact(row.id).map(t => t.name),
      })
      if (opts.q) {
        for (const hit of store.searchFacts(opts.q, { limit, includeDormant: true, maxSensitivity: 'critical' })) {
          out.push(withTopics(hit.row))
        }
      } else {
        const rows = store.db
          .prepare('SELECT * FROM facts ORDER BY created_at DESC LIMIT ?')
          .all(limit) as FactRow[]
        for (const row of rows) out.push(withTopics(row))
      }
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    return out.slice(0, limit)
  }

  /**
   * Recherche GLOBALE : un seul champ qui interroge la mémoire de TOUS les agents
   * (+ scopes partagés) d'un coup, chaque résultat étiqueté de l'agent dont il
   * vient. « Où, chez n'importe quel agent, ai-je vu X ? » Lecture pure.
   */
  globalSearch(q: string, limit = 80): Array<Fact & { source_db: string; topics: string[]; agent_type: string; instance: string | null }> {
    this.assertOpen()
    // carte chemin-relatif → (type, instance) pour étiqueter les résultats
    const byDb = new Map<string, { type: string; instance: string }>()
    for (const a of this.listAgents()) {
      if (a.db_path) byDb.set(relative(this.paths.root, a.db_path), { type: a.assistant_type, instance: a.instance.id })
    }
    return this.browseFacts({ q, limit }).map(f => {
      const owner = byDb.get(f.source_db)
      return { ...f, agent_type: owner?.type ?? 'partagé', instance: owner?.instance ?? null }
    })
  }

  /**
   * Détection des moteurs d'IA disponibles (onboarding/réglages §14) :
   * Ollama (modèles présents), LM Studio, clé Anthropic. Sans réseau bloquant.
   */
  async detectProviders(): Promise<{
    ollama: { available: boolean; models: string[]; base_url: string }
    lmstudio: { available: boolean; models: string[]; base_url: string }
    anthropic: { available: boolean }
    openai: { available: boolean }
    openrouter: { available: boolean }
  }> {
    this.assertOpen()
    const { resolveAnthropicApiKey, resolveOpenAiApiKey, DEFAULT_OLLAMA_BASE_URL, DEFAULT_LMSTUDIO_BASE_URL, lmstudioListModels } =
      await import('../llm/index.js')
    const ollamaBase = DEFAULT_OLLAMA_BASE_URL
    let ollamaModels: string[] = []
    let ollamaUp = false
    try {
      const res = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        ollamaUp = true
        const data = (await res.json()) as { models?: Array<{ name: string }> }
        ollamaModels = (data.models ?? []).map(m => m.name)
      }
    } catch {
      ollamaUp = false
    }
    const lm = await lmstudioListModels()
    return {
      ollama: { available: ollamaUp, models: ollamaModels, base_url: ollamaBase },
      lmstudio: { available: lm.up, models: lm.models, base_url: DEFAULT_LMSTUDIO_BASE_URL },
      anthropic: { available: resolveAnthropicApiKey({}) !== null },
      openai: { available: resolveOpenAiApiKey({ flavor: 'openai' }) !== null },
      openrouter: { available: resolveOpenAiApiKey({ flavor: 'openrouter' }) !== null },
    }
  }

  /** Nombre TOTAL d'entrées WAL en attente d'extraction, toutes instances confondues. */
  walPendingTotal(): number {
    this.assertOpen()
    let pending = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      pending += this.openContent(entry.path).walPendingCount()
    }
    return pending
  }

  /**
   * Santé LLM (GET /v1/admin/llm_health) — LA source de vérité anti-mort-
   * silencieuse : moteur d'extraction/embeddings effectifs (résolution FRAÎCHE,
   * pas le mémo : l'utilisateur vient peut-être de télécharger un modèle),
   * entrées WAL en attente, et inventaire des options disponibles.
   */
  async llmHealth(opts: { ollamaBaseUrl?: string; lmstudioBaseUrl?: string } = {}): Promise<LlmHealthReport> {
    this.assertOpen()
    const {
      DEFAULT_ANTHROPIC_MODEL,
      DEFAULT_LOCAL_EXTRACTION_MODEL,
      DEFAULT_OLLAMA_EMBEDDING_MODEL,
      DEFAULT_OPENAI_EMBEDDING_MODEL,
      DEFAULT_OPENAI_MODEL,
      DEFAULT_OPENROUTER_MODEL,
      detectLlmOptions,
      modelMatches,
      resolveLlmProfile,
    } = await import('../llm/index.js')

    const options = await detectLlmOptions({ ollamaBaseUrl: opts.ollamaBaseUrl, lmstudioBaseUrl: opts.lmstudioBaseUrl })
    const profile = await resolveLlmProfile(this.resolved.config, {
      ollamaBaseUrl: opts.ollamaBaseUrl,
      lmstudioBaseUrl: opts.lmstudioBaseUrl,
    })
    // Ce que l'UI affiche DOIT être ce que le pipeline utilise : si cette
    // résolution fraîche diffère du profil mémoïsé (Ollama démarré après le
    // daemon, modèle tiré entre-temps), on jette le mémo — le prochain
    // captureTurn repart sur les moteurs réellement disponibles.
    if (this.llmOverride === undefined && this.profileSnapshot) {
      const fresh = {
        extraction: profile.extraction ? `${profile.extraction.name}/${profile.extraction.model}` : null,
        embeddings: profile.embeddings ? `${profile.embeddings.name}/${profile.embeddings.model}` : null,
      }
      if (fresh.extraction !== this.profileSnapshot.extraction || fresh.embeddings !== this.profileSnapshot.embeddings) {
        this.invalidateProfile()
      }
    }

    // ---- extraction : disponible (provider résolu) ou indisponible AVEC raison
    let extraction: LlmEngineHealth
    if (profile.extraction) {
      extraction = { provider: profile.extraction.name, model: profile.extraction.model, available: true }
    } else {
      const explicit = this.resolved.config.llm?.extraction
      const profileName = this.resolved.config.llm?.profile ?? '100-local'
      const provider = explicit?.provider ?? (profileName === 'cloud' ? 'anthropic' : 'ollama')
      const defaults: Record<string, string> = {
        ollama: DEFAULT_LOCAL_EXTRACTION_MODEL,
        lmstudio: '(premier modèle chargé)',
        anthropic: DEFAULT_ANTHROPIC_MODEL,
        openai: DEFAULT_OPENAI_MODEL,
        openrouter: DEFAULT_OPENROUTER_MODEL,
      }
      const model = explicit?.model ?? defaults[provider] ?? '(inconnu)'
      let reason: string
      switch (provider) {
        case 'ollama': {
          if (!options.ollama.serverUp) {
            reason = 'serveur Ollama injoignable — lance l’application Ollama (ou « ollama serve »)'
          } else {
            const wanted = explicit?.model ?? DEFAULT_LOCAL_EXTRACTION_MODEL
            reason = options.ollama.models.some(m => modelMatches(m, wanted))
              ? `modèle « ${wanted} » présent mais provider indisponible — vérifie les logs du service`
              : `modèle « ${wanted} » non téléchargé — « ollama pull ${wanted} »`
          }
          break
        }
        case 'lmstudio':
          reason = !options.lmstudio.available
            ? 'LM Studio injoignable — démarre son serveur local (onglet Developer)'
            : options.lmstudio.models.length === 0
              ? 'aucun modèle chargé dans LM Studio'
              : `modèle « ${explicit?.model ?? ''} » non chargé dans LM Studio`
          break
        case 'anthropic':
        case 'openai':
        case 'openrouter':
          reason = `clé API absente — place-la dans ~/.${provider}/api_key (chmod 600)`
          break
        default:
          reason = `provider inconnu : ${provider}`
      }
      extraction = { provider, model, available: false, reason }
    }

    // ---- embeddings (recherche sémantique) : deux moteurs réels — OpenAI
    // (clé API, le plus simple) ou Ollama local. Quand rien n'est résolu, on
    // recommande selon ce qui est détecté au lieu d'imposer Ollama.
    let embeddings: LlmEngineHealth
    const pinnedEmbeddings = this.resolved.config.llm?.embeddings
    if (profile.embeddings) {
      embeddings = {
        provider: profile.embeddings.name,
        model: profile.embeddings.model,
        available: true,
        pending: await this.embeddingsPending(),
      }
    } else if (pinnedEmbeddings?.provider) {
      // Choix EXPLICITE indisponible : on le dit tel quel (provider/modèle
      // choisis + raison) — jamais un autre moteur annoncé « disponible » à
      // sa place. Avant, Ollama prenait le relais en silence.
      const provider = pinnedEmbeddings.provider
      let model: string
      let reason: string
      switch (provider) {
        case 'openai':
          model = pinnedEmbeddings.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL
          reason = `clé API absente — place-la dans ~/.openai/api_key (chmod 600), ou choisis Ollama dans Réglages`
          break
        case 'ollama': {
          model = pinnedEmbeddings.model ?? DEFAULT_OLLAMA_EMBEDDING_MODEL
          reason = !options.ollama.serverUp
            ? 'serveur Ollama injoignable — lance l’application Ollama (ou « ollama serve »)'
            : options.ollama.models.some(m => modelMatches(m, model))
              ? `modèle « ${model} » présent mais provider indisponible — vérifie les logs du service`
              : `modèle « ${model} » non téléchargé — « ollama pull ${model} »`
          break
        }
        default:
          model = pinnedEmbeddings.model ?? '(inconnu)'
          reason = `provider d'embeddings inconnu : ${provider} (attendu : ollama|openai)`
      }
      embeddings = { provider, model, available: false, reason }
    } else if (options.openai.available) {
      embeddings = {
        provider: 'openai',
        model: DEFAULT_OPENAI_EMBEDDING_MODEL,
        available: false,
        reason: `Recherche sémantique inactive — choisis un moteur d'embeddings (recommandé : OpenAI, clé déjà présente)`,
      }
    } else if (options.ollama.serverUp) {
      embeddings = {
        provider: 'ollama',
        model: DEFAULT_OLLAMA_EMBEDDING_MODEL,
        available: false,
        reason: `Recherche sémantique inactive — Ollama détecté : « ollama pull ${DEFAULT_OLLAMA_EMBEDDING_MODEL} », ou choisis une clé OpenAI`,
      }
    } else {
      embeddings = {
        provider: 'openai',
        model: DEFAULT_OPENAI_EMBEDDING_MODEL,
        available: false,
        reason: `Recherche sémantique inactive — choisis un moteur : clé OpenAI (le plus simple) ou Ollama local`,
      }
    }

    return { extraction, embeddings, wal_pending: this.walPendingTotal(), options }
  }

  /** Profil LLM courant (config) + choix explicite d'extraction s'il existe. */
  getLlmProfile(): {
    profile: string
    extraction?: { provider?: string; model?: string; base_url?: string }
    embeddings?: { provider?: string; model?: string; dimensions?: number; base_url?: string }
  } {
    this.assertOpen()
    return {
      profile: this.resolved.config.llm?.profile ?? '100-local',
      extraction: this.resolved.config.llm?.extraction,
      embeddings: this.resolved.config.llm?.embeddings,
    }
  }

  /**
   * Scan matériel léger : sert à l'UI pour proposer (ou déconseiller) un modèle
   * LOCAL selon la puissance de la machine. La RAM est le facteur déterminant ;
   * le silicium Apple (mémoire unifiée) fait tourner les modèles bien mieux à
   * RAM égale, d'où deux barèmes. Aucune donnée sensible.
   */
  machineCaps(): {
    platform: string
    arch: string
    ram_gb: number
    cpu_cores: number
    apple_silicon: boolean
    verdict: 'great' | 'ok' | 'weak'
    recommend_local: boolean
  } {
    const ramGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10
    const cores = cpus().length
    const arch = process.arch
    const platform = process.platform
    const appleSilicon = platform === 'darwin' && arch === 'arm64'
    let verdict: 'great' | 'ok' | 'weak'
    if (appleSilicon) verdict = ramGb >= 16 ? 'great' : ramGb >= 8 ? 'ok' : 'weak'
    else verdict = ramGb >= 32 ? 'great' : ramGb >= 16 ? 'ok' : 'weak'
    return {
      platform,
      arch,
      ram_gb: ramGb,
      cpu_cores: cores,
      apple_silicon: appleSilicon,
      verdict,
      recommend_local: verdict !== 'weak',
    }
  }

  /** Change le profil LLM (raccourci) et le persiste. */
  setLlmProfile(profile: string): void {
    this.assertOpen()
    // Choisir un profil raccourci efface le choix explicite de provider.
    this.resolved.config.llm = { ...this.resolved.config.llm, profile, extraction: undefined }
    this.persistLlmConfig(`set_llm_profile:${profile}`)
  }

  /**
   * Choix EXPLICITE du provider/modèle d'extraction (« l'utilisateur décide »).
   * provider ∈ ollama|lmstudio|anthropic|openai|openrouter. baseUrl : serveurs
   * locaux OpenAI-compatibles (LM Studio) hors port par défaut.
   */
  setExtractionProvider(provider: string, model?: string, baseUrl?: string): void {
    this.assertOpen()
    this.resolved.config.llm = {
      ...this.resolved.config.llm,
      profile: 'custom',
      extraction: { provider, ...(model ? { model } : {}), ...(baseUrl ? { base_url: baseUrl } : {}) },
    }
    this.persistLlmConfig(`set_extraction:${provider}${model ? `:${model}` : ''}`)
  }

  /**
   * Choix EXPLICITE du provider/modèle d'embeddings (recherche sémantique).
   * provider ∈ ollama|openai (les seuls fournisseurs d'embeddings supportés ;
   * pas de LM Studio ni Anthropic, pas de login/OAuth). Ce choix explicite
   * prime sur la détection auto et sur la garde cloud (resolveLlmProfile).
   * `dimensions` : à préciser seulement pour un modèle hors table connue —
   * elles sont gravées avec chaque vecteur, une valeur fausse corrompt la base.
   * Après l'écriture, relancer `indexEmbeddings()` : l'indexation est
   * incrémentale, seuls les faits sans vecteur pour le nouveau modèle sont ré-embqués.
   */
  setEmbeddingsProvider(provider: string, model?: string, dimensions?: number, baseUrl?: string): void {
    this.assertOpen()
    if (provider !== 'ollama' && provider !== 'openai') {
      throw new Error(`provider d'embeddings non supporté : ${provider} (attendu : ollama|openai)`)
    }
    // Gravées avec chaque vecteur : une valeur fausse corrompt la base. On
    // refuse tout ce qui n'est pas un entier plausible plutôt que de l'écrire.
    if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 64 || dimensions > 8192)) {
      throw new Error(`dimensions invalides : ${JSON.stringify(dimensions)} (entier entre 64 et 8192 attendu)`)
    }
    this.resolved.config.llm = {
      ...this.resolved.config.llm,
      embeddings: {
        provider,
        ...(model ? { model } : {}),
        ...(dimensions ? { dimensions } : {}),
        ...(baseUrl ? { base_url: baseUrl } : {}),
      },
    }
    this.persistLlmConfig(`set_embeddings:${provider}${model ? `:${model}` : ''}`)
  }

  /**
   * Faits actifs (superseded=0, lifecycle_state='active' — les dormants en
   * attente de revue ne sont pas embeddés, cf. EmbeddingIndexer.pendingFacts)
   * sans vecteur pour le modèle d'embeddings courant, toutes bases confondues =
   * ce qu'une (ré)indexation aurait à faire. 0 si aucun moteur d'embeddings.
   */
  async embeddingsPending(): Promise<number> {
    this.assertOpen()
    const { embeddings } = await this.ensureProfile()
    if (!embeddings) return 0
    let pending = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      const row = store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM facts f
           WHERE f.superseded = 0 AND f.lifecycle_state = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM embeddings e
               WHERE e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ?
             )`,
        )
        .get(embeddings.model) as { c: number }
      pending += row.c
    }
    return pending
  }

  private persistLlmConfig(action: string): void {
    this.saveConfig()
    // invalide la résolution mémoïsée (pipeline et indexeurs compris) →
    // re-résolue au prochain usage
    this.invalidateProfile()
    this.registry.audit({ actor_type: 'user', actor_id: 'local', action, target_id_hash: null, scope_id: null, reason: null })
  }

  // ------------------------------------------------------------ options (bucket C/D)

  /**
   * Options activables (couches opt-in / sur validation). OFF par défaut : ces
   * couches ne tournent QUE sur demande. ON = elles tournent automatiquement
   * (au boot du daemon + après les captures). L'utilisateur garde le contrôle.
   */
  getOptions(): Record<string, boolean> {
    this.assertOpen()
    const keys = ['auto_themes_ai', 'auto_self_observation', 'auto_revision', 'auto_patterns', 'markdown_export']
    const out: Record<string, boolean> = {}
    for (const k of keys) out[k] = this.registry.getSetting(`option.${k}`) === 'on'
    return out
  }

  /** Active/désactive une option. L'activer la fait tourner UNE FOIS tout de suite. */
  async setOption(key: string, enabled: boolean): Promise<void> {
    this.assertOpen()
    this.registry.setSetting(`option.${key}`, enabled ? 'on' : 'off')
    this.registry.audit({ actor_type: 'user', actor_id: 'local', action: `option_${enabled ? 'on' : 'off'}:${key}`, target_id_hash: null, scope_id: null, reason: null })
    if (enabled) await this.runOption(key)
  }

  /** Exécute une option sur toutes les instances actives (boot daemon + activation). */
  async runOption(key: string): Promise<void> {
    this.assertOpen()
    for (const inst of this.registry.listInstances()) {
      if (inst.revoked_at) continue
      const db = this.registry.dbForInstance(inst.id)
      if (!db || !existsSync(db.path)) continue
      try {
        switch (key) {
          case 'auto_themes_ai':
            await this.refineTopicLabels(inst.id)
            break
          case 'auto_self_observation':
            this.deriveSelfObservations(inst.id)
            break
          case 'auto_revision':
            await this.proposeRevisions(inst.id)
            break
          case 'auto_patterns':
            this.detectPatterns(inst.id)
            break
          case 'markdown_export':
            this.exportMarkdown(inst.id, join(this.paths.root, 'exports', inst.id), true)
            break
        }
      } catch (err) {
        console.warn(`[memoria] option ${key} sur ${inst.id} en échec :`, (err as Error).message)
      }
    }
  }

  /** Lance toutes les options ACTIVÉES (appelé au boot du daemon). */
  async runEnabledOptions(): Promise<{ ran: string[] }> {
    this.assertOpen()
    const ran: string[] = []
    for (const [key, on] of Object.entries(this.getOptions())) {
      if (on) {
        await this.runOption(key)
        ran.push(key)
      }
    }
    return { ran }
  }

  /** Mode de capture global : auto-private (défaut) | review-first | incognito (pause). */
  getCaptureMode(): CaptureMode {
    this.assertOpen()
    const raw = this.registry.getSetting('capture_mode')
    return raw === 'review-first' || raw === 'incognito' ? raw : 'auto-private'
  }

  setCaptureMode(mode: CaptureMode): void {
    this.assertOpen()
    this.registry.setSetting('capture_mode', mode)
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: `set_capture_mode:${mode}`,
      target_id_hash: null,
      scope_id: null,
      reason: null,
    })
  }

  listAgents(): Array<{ instance: AssistantInstance; assistant_type: string; db_path: string | null }> {
    this.assertOpen()
    return this.registry.listInstances().map(instance => {
      const assistant = this.registry.getAssistant(instance.assistant_id)
      const db = this.registry.dbForInstance(instance.id)
      return { instance, assistant_type: assistant?.type ?? 'generic', db_path: db?.path ?? null }
    })
  }

  /** Synthèse par agent : ce que chacun sait (souvenirs, thèmes, procédures, maîtrise). */
  agentOverview(): Array<{
    instance: string
    type: string
    facts: number
    themes: number
    procedures: number
    expertise: string[]
  }> {
    this.assertOpen()
    const out: ReturnType<Memoria['agentOverview']> = []
    for (const inst of this.registry.listInstances()) {
      if (inst.revoked_at) continue
      const assistant = this.registry.getAssistant(inst.assistant_id)
      if (assistant?.type === 'generic') continue
      const db = this.registry.dbForInstance(inst.id)
      if (!db || !existsSync(db.path)) continue
      const store = this.openContent(db.path)
      out.push({
        instance: inst.id,
        type: assistant?.type ?? 'generic',
        facts: store.countFacts(),
        themes: this.topicFor(store, null).listTopics({ minFacts: 2 }).length,
        procedures: this.proceduralFor(store).listProcedures().length,
        expertise: this.feedbackFor(store).topDomains(4).map(d => d.domain),
      })
    }
    return out
  }

  /**
   * Stats vivantes des couches cognitives (écran « Système ») : compte réel par
   * table, agrégé sur toutes les DB de contenu. Sert à RENDRE VISIBLES les 24
   * couches et prouver qu'elles tournent.
   */
  cognitiveStats(): Record<string, number> {
    this.assertOpen()
    const tables = [
      'facts', 'entities', 'relations', 'fact_entities', 'observations', 'topics', 'fact_topics',
      'embeddings', 'procedures', 'patterns', 'fact_clusters', 'self_observations',
      'revision_proposals', 'wal_buffer',
    ]
    const totals: Record<string, number> = {}
    for (const t of tables) totals[t] = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      for (const t of tables) {
        try {
          const r = store.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }
          totals[t]! += r.c
        } catch {
          /* table absente sur cette DB — ignore */
        }
      }
    }
    totals['secret_refs'] = this.registry.listSecretRefs().length
    return totals
  }

  /** Coffre : références de secrets stockées (JAMAIS la valeur). */
  listSecrets(): Array<{ name: string; service: string | null; location: string; created_at: string }> {
    this.assertOpen()
    return this.registry.listSecretRefs()
  }

  /**
   * Mémoires PARTAGÉES (user/org/client/projet) + leur contenu explorable :
   * c'est là que vivent « les infos sur moi », « l'entreprise », « ce qui est
   * partagé ». Privé exclu (cf. écran Mémoire par agent).
   */
  listSharedScopes(): Array<{ id: string; type: string; name: string; label: string; facts: number }> {
    this.assertOpen()
    const LABELS: Record<string, string> = {
      user: 'Sur vous',
      org: 'Entreprise',
      client: 'Client',
      project: 'Projet',
      shared_topic: 'Sujet partagé',
    }
    const out: ReturnType<Memoria['listSharedScopes']> = []
    for (const scope of this.registry.listScopes()) {
      if (scope.type === 'private' || scope.type === 'legacy_to_review') continue
      const dbEntry = this.registry.dbForScope(scope.id)
      let facts = 0
      if (dbEntry && existsSync(dbEntry.path)) {
        facts = (this.openContent(dbEntry.path).db.prepare('SELECT COUNT(*) AS c FROM facts WHERE scope_id = ?').get(scope.id) as { c: number }).c
      }
      out.push({ id: scope.id, type: scope.type, name: scope.name, label: LABELS[scope.type] ?? scope.name, facts })
    }
    return out
  }

  /** Souvenirs d'un scope partagé (contenu de « Sur vous », « Entreprise », un client…). */
  scopeFacts(scopeId: string, limit = 100): Array<{ id: string; fact: string; category: string; created_at: string }> {
    this.assertOpen()
    const scope = this.registry.getScope(scopeId)
    if (!scope) return []
    const dbEntry = this.registry.dbForScope(scope.id)
    if (!dbEntry || !existsSync(dbEntry.path)) return []
    const rows = this.openContent(dbEntry.path).db
      .prepare('SELECT id, fact, category, created_at FROM facts WHERE scope_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(scope.id, Math.min(limit, 300)) as Array<{ id: string; fact: string; category: string; created_at: string }>
    return rows
  }

  /**
   * Affine les libellés de thèmes d'une instance avec le LLM configuré (à la
   * demande, couche 14). Gratuit par défaut (heuristique) ; ce bouton paie un
   * petit appel par thème pour des noms propres. Retourne le nombre renommé.
   *
   * C'est le SEUL chemin qui renomme des thèmes déjà en base, et il est
   * déclenché par l'utilisateur (bouton « Affiner les libellés ») ou par
   * l'option `auto_themes_ai` qu'il a activée — jamais par une migration.
   *
   * Le prompt demandait « Title Case » : ça n'existe pas en français et ça
   * rendait un prénom indistinct d'un mot commun (« Le Tarif Horaire »). Il
   * demande maintenant un NOM DE SUJET en casse de phrase, sans article, et la
   * réponse passe par `cleanTopicLabel` — la même mise en forme que les thèmes
   * créés automatiquement, pour que les deux chemins produisent la même chose.
   */
  async refineTopicLabels(instanceId: string, limit = 40): Promise<{ refined: number }> {
    this.assertOpen()
    const { extraction } = await this.ensureProfile()
    if (!extraction || !(await extraction.isAvailable())) return { refined: 0 }
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { refined: 0 }
    const store = this.openContent(db.path)
    const topicEngine = this.topicFor(store, null)
    const topics = topicEngine.listTopics({ minFacts: 2 }).slice(0, limit)
    let refined = 0
    for (const t of topics) {
      const sample = topicEngine.factsForTopic(t.id, { limit: 5 }).map(f => f.fact)
      if (sample.length === 0) continue
      try {
        const raw = await extraction.complete({
          system:
            'Name the SUBJECT shared by these memories as a short noun phrase of 2 to 5 words, in the same language as the memories. ' +
            'No leading article. Sentence case: capitalise only the first word, proper nouns and acronyms. ' +
            'Keep the exact spelling, accents and capitalisation of names and acronyms (Néto, JamBoard, CLI). ' +
            'A subject name, not a sentence fragment. Reply with the title ONLY, nothing else.',
          prompt: sample.map(s => `- ${s}`).join('\n'),
          maxTokens: 20,
          temperature: 0.2,
        })
        const answer = raw.trim().replace(/^["'#*\s]+|["'.*\s]+$/g, '').slice(0, 60)
        // Une réponse hors sujet (JSON, balise, phrase entière) ne renomme rien :
        // le thème garde son nom, et on le DIT (pas de mort silencieuse).
        if (answer.length < 3 || !/\p{L}/u.test(answer) || /[{}[\]<>]/u.test(answer) || answer.split(/\s+/).length > 8) {
          if (answer !== '') console.warn(`[memoria:topics] affinage refusé (${t.id}) — réponse inutilisable : ${answer.slice(0, 40)}`)
          continue
        }
        // Même mise en forme que les thèmes créés automatiquement. La source
        // est un échantillon des faits du thème : elle sert d'arbitre pour la
        // casse (un mot écrit en minuscules dans les faits n'est pas un nom propre).
        const label = cleanTopicLabel(answer, { source: sample.join(' '), maxWords: 5 })
        if (label.length >= 3 && label.toLowerCase() !== t.name.toLowerCase()) {
          // Le slug suit le nom : c'est lui qui empêche deux thèmes homonymes
          // à la prochaine création (createTopic déduplique par slug).
          store.db
            .prepare('UPDATE topics SET name = ?, slug = ?, updated_at = ? WHERE id = ?')
            .run(label, topicSlug(label), nowISO(), t.id)
          refined++
        }
      } catch (err) {
        console.warn(`[memoria:topics] affinage LLM échoué (${t.id}) :`, (err as Error).message)
      }
    }
    return { refined }
  }

  stats(): { facts: number; databases: number; instances: number } {
    this.assertOpen()
    let facts = 0
    let databases = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry') continue
      databases++
      if (existsSync(entry.path)) facts += this.openContent(entry.path).countFacts()
    }
    return { facts, databases, instances: this.registry.listInstances().length }
  }

  doctor(): DoctorReport {
    this.assertOpen()
    const warnings: string[] = []
    const databases: DoctorReport['databases'] = []
    let onNetwork = false
    let journalMode = 'wal'
    for (const entry of this.registry.listDbs()) {
      const exists = existsSync(entry.path)
      let size = 0
      let walPending: number | undefined
      if (exists) {
        size = statSync(entry.path).size
        if (entry.kind !== 'registry') {
          const store = this.openContent(entry.path)
          walPending = store.walPendingCount()
          onNetwork ||= store.onNetworkVolume
          journalMode = store.journalMode
          if (store.onNetworkVolume) {
            warnings.push(`DB sur volume réseau/synchronisé : ${entry.path} (journal_mode=${store.journalMode})`)
          }
        }
      } else if (entry.kind !== 'registry') {
        warnings.push(`DB enregistrée mais absente du disque : ${entry.path}`)
      }
      databases.push({ kind: entry.kind, path: entry.path, exists, size_bytes: size, wal_pending: walPending })
    }

    const activity = this.doctorActivity()
    const memory = this.doctorMemory()
    const cloud = this.doctorCloud()
    const usage = this.llmUsage('24h')

    // Les avertissements sont ce que l'utilisateur doit ACTION­NER — pas une
    // reformulation des compteurs. On ne signale que l'anormal.
    // La PAUSE d'abord : c'est la cause n°1 de « mes agents ne se souviennent
    // de rien », et le doctor concluait « ✓ OK » sans un mot.
    const enabled = this.isEnabled()
    if (!enabled) {
      warnings.push(
        'Memoria est en PAUSE (« memoria disable » ou l’interrupteur de l’app) : capture et recall sont refusés pour tous les agents — « memoria enable » pour reprendre.',
      )
    }
    if (memory.wal_stuck > 0) {
      warnings.push(
        `${memory.wal_stuck} message(s) bloqué(s) en extraction (plusieurs tentatives échouées) — vérifier le provider LLM.`,
      )
    }
    if (memory.contradictions_pending + memory.duplicates_pending > 0) {
      warnings.push(
        `${memory.contradictions_pending + memory.duplicates_pending} révision(s) en attente d'arbitrage — jusque-là, les faits contestés restent actifs (écran Révisions).`,
      )
    }
    if (activity.recall_ms_p95 !== undefined && activity.recall_ms_p95 > 1000) {
      warnings.push(`recall lent : p95 à ${activity.recall_ms_p95} ms — le plugin coupe à recallTimeoutMs.`)
    }

    // MOTEUR D'IA — sans lui, Memoria journalise les conversations mais
    // n'en extrait aucun souvenir. Une installation neuve est exactement dans
    // ce cas : le doctor annonçait « ✓ OK » pendant que rien ne se mémorisait
    // (constaté sur une installation de test le 28/08). Lecture synchrone de
    // la config : le doctor ne fait aucun appel réseau.
    const llm = this.resolved.config.llm
    const engine: DoctorEngine = {
      configured: Boolean(llm?.extraction?.provider),
      extraction_provider: llm?.extraction?.provider ?? null,
      extraction_model: llm?.extraction?.model ?? null,
      embeddings_provider: llm?.embeddings?.provider ?? null,
      embeddings_model: llm?.embeddings?.model ?? null,
    }
    if (!engine.configured) {
      warnings.push(
        'Aucun moteur d’IA configuré — Memoria enregistre les conversations mais n’en extrait aucun souvenir. ' +
          'Ouvre « memoria ui » → Réglages → Moteur d’intelligence.',
      )
    } else if (!engine.embeddings_provider) {
      warnings.push(
        'Aucun moteur d’embeddings — la recherche par le sens est inactive (recherche par mots-clés seule). ' +
          'Réglages → Recherche sémantique.',
      )
    }

    return {
      ok: warnings.length === 0,
      enabled,
      storage_root: this.paths.root,
      config_path: this.resolved.configPath,
      registry_path: this.paths.registry,
      databases,
      network_guard: { on_network_volume: onNetwork, journal_mode: journalMode },
      activity,
      memory,
      engine,
      cloud,
      usage,
      warnings,
    }
  }

  /**
   * Consommation des modèles sur une fenêtre : appels, tokens, coût estimé —
   * tous fournisseurs, locaux compris. Réponse à « combien ça me coûte, et
   * quel modèle travaille ? ».
   */
  llmUsage(period: LlmUsagePeriod = '24h'): LlmUsageReport {
    this.assertOpen()
    const windows: Record<LlmUsagePeriod, number | null> = {
      '24h': 86_400_000,
      '7d': 7 * 86_400_000,
      '30d': 30 * 86_400_000,
      all: null,
    }
    const win = windows[period]
    const since = win === null ? null : new Date(Date.now() - win).toISOString()
    const rows: LlmUsageRow[] = this.registry.llmUsageRows(since).map(r => ({
      ...r,
      estimated_cost_usd: estimateCostUsd(r.provider, r.model, r.input_tokens, r.output_tokens),
      price_known: priceFor(r.provider, r.model) !== null,
    }))

    const sumOrNull = (vals: Array<number | null>): number | null => {
      const known = vals.filter((v): v is number => v !== null)
      return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
    }
    const costs = rows.map(r => r.estimated_cost_usd)
    const cost = sumOrNull(costs)
    return {
      period,
      since,
      generated_at: new Date().toISOString(),
      pricing_as_of: PRICING_AS_OF,
      rows,
      totals: {
        calls: rows.reduce((n, r) => n + r.calls, 0),
        failures: rows.reduce((n, r) => n + r.failures, 0),
        input_tokens: sumOrNull(rows.map(r => r.input_tokens)),
        output_tokens: sumOrNull(rows.map(r => r.output_tokens)),
        estimated_cost_usd: rows.length === 0 ? 0 : cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000,
        unpriced_calls: rows.filter(r => r.estimated_cost_usd === null).reduce((n, r) => n + r.calls, 0),
        unmetered_calls: rows.reduce((n, r) => n + (r.calls - r.calls_metered), 0),
      },
    }
  }

  /** Envois cloud des dernières 24 h, agrégés depuis `audit_log`. */
  private doctorCloud(): DoctorCloud {
    const db = this.registry.db
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const rows = db
      .prepare("SELECT ts, reason FROM audit_log WHERE action = 'cloud_send' AND ts >= ? ORDER BY id DESC")
      .all(since) as Array<{ ts: string; reason: string }>

    const groups = new Map<string, DoctorCloud['sends_24h'][number]>()
    let chars = 0
    for (const r of rows) {
      const provider = field(r.reason, 'provider') ?? '?'
      const model = field(r.reason, 'model') ?? '?'
      const purpose = field(r.reason, 'purpose') ?? '?'
      const key = `${provider}|${model}|${purpose}`
      const g = groups.get(key) ?? { provider, model, purpose, calls: 0, items: 0, chars: 0, failures: 0 }
      g.calls += 1
      g.items += metric(r.reason, 'items') ?? 0
      const c = metric(r.reason, 'chars') ?? 0
      g.chars += c
      chars += c
      if (field(r.reason, 'ok') === 'false') g.failures += 1
      // Tokens : présents seulement depuis l'instrumentation — on additionne
      // ce qui existe, sans jamais écrire un 0 à la place d'un « inconnu ».
      const tin = metric(r.reason, 'tokens_in')
      if (tin !== undefined) g.tokens_in = (g.tokens_in ?? 0) + tin
      const tout = metric(r.reason, 'tokens_out')
      if (tout !== undefined) g.tokens_out = (g.tokens_out ?? 0) + tout
      groups.set(key, g)
    }
    const out: DoctorCloud = { sends_24h: [...groups.values()].sort((a, b) => b.chars - a.chars), chars_24h: chars }
    const last = db
      .prepare("SELECT ts FROM audit_log WHERE action = 'cloud_send' ORDER BY ts DESC LIMIT 1")
      .get() as { ts: string } | undefined
    if (last) out.last_send_at = last.ts
    return out
  }

  /** Activité récente, lue dans `audit_log` (aucune table de métriques dédiée). */
  private doctorActivity(): DoctorActivity {
    const db = this.registry.db
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const lastOf = (action: string): string | undefined =>
      (db.prepare('SELECT ts FROM audit_log WHERE action = ? ORDER BY ts DESC LIMIT 1').get(action) as
        | { ts: string }
        | undefined)?.ts
    const countSince = (action: string): number =>
      (db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND ts >= ?').get(action, since) as { c: number }).c

    // On ne lit que les entrées RÉCENTES et instrumentées : les anciennes ne
    // portent pas de `ms=`, les inclure fausserait la moyenne vers le bas.
    const recent = (action: string, limit = 200): string[] =>
      (db.prepare('SELECT reason FROM audit_log WHERE action = ? AND reason LIKE \'%ms=%\' ORDER BY id DESC LIMIT ?')
        .all(action, limit) as Array<{ reason: string }>).map(r => r.reason)

    const recalls = recent('recall')
    const captures = recent('capture_turn')
    const out: DoctorActivity = {
      recalls_24h: countSince('recall'),
      captures_24h: countSince('capture_turn'),
    }
    const lastRecall = lastOf('recall')
    if (lastRecall) out.last_recall_at = lastRecall
    const lastCapture = lastOf('capture_turn')
    if (lastCapture) out.last_capture_at = lastCapture

    const recallMs = recalls.map(r => metric(r, 'ms')).filter((n): n is number => n !== undefined)
    if (recallMs.length > 0) {
      out.recall_ms_avg = Math.round(avg(recallMs))
      out.recall_ms_p95 = percentile(recallMs, 0.95)
    }
    const recallTokens = recalls.map(r => metric(r, 'tokens')).filter((n): n is number => n !== undefined)
    if (recallTokens.length > 0) out.recall_tokens_avg = Math.round(avg(recallTokens))
    const captureMs = captures.map(r => metric(r, 'ms')).filter((n): n is number => n !== undefined)
    if (captureMs.length > 0) out.capture_ms_avg = Math.round(avg(captureMs))
    return out
  }

  /** Volume et hygiène de la mémoire, agrégés sur toutes les DB de contenu. */
  private doctorMemory(): DoctorMemory {
    const out: DoctorMemory = {
      facts_total: 0,
      facts_superseded: 0,
      facts_never_used: 0,
      contradictions_pending: 0,
      duplicates_pending: 0,
      wal_pending: 0,
      wal_stuck: 0,
    }
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || !existsSync(entry.path)) continue
      const db = this.openContent(entry.path).db
      const one = (sql: string, ...args: unknown[]): number =>
        ((db.prepare(sql).get(...args) as { c: number } | undefined)?.c ?? 0)
      out.facts_total += one('SELECT COUNT(*) AS c FROM facts')
      out.facts_superseded += one('SELECT COUNT(*) AS c FROM facts WHERE superseded = 1')
      out.facts_never_used += one('SELECT COUNT(*) AS c FROM facts WHERE superseded = 0 AND used_count = 0')
      out.wal_pending += one('SELECT COUNT(*) AS c FROM wal_buffer WHERE processed = 0')
      out.wal_stuck += one('SELECT COUNT(*) AS c FROM wal_buffer WHERE processed = 0 AND attempts >= 3')
      try {
        out.contradictions_pending += one(
          "SELECT COUNT(*) AS c FROM revision_proposals WHERE status = 'proposed' AND kind = 'contradicted'",
        )
        out.duplicates_pending += one(
          "SELECT COUNT(*) AS c FROM revision_proposals WHERE status = 'proposed' AND kind = 'duplicate'",
        )
      } catch {
        /* couche révision (90-99) jamais appliquée sur cette DB */
      }
    }
    return out
  }

  // ------------------------------------------------------------------ tri des souvenirs

  /** Modèle de vecteurs vu à la dernière résolution du profil par le tri (redites par le sens). */
  private triageEmbKey: { model: string; dimensions: number } | null = null
  /**
   * Vecteurs de tri des faits en attente, par base (redites de la passe sur
   * les messages). Construit par pages avant la passe, vidé à sa fin et à
   * chaque changement des faits en attente (oubli, validation, partage, revue).
   */
  private readonly triageVecCache = new Map<string, TriageVecCache>()
  /** Avertissement « cache tronqué » déjà donné pour ce processus. */
  private triageVecWarned = false

  /** Accès internes prêtés au service de tri (jamais exposés tels quels). */
  private triageHost(): TriageServiceHost {
    return {
      dbs: instanceId => this.contentDbPathsFor(instanceId).map(path => ({ path, store: this.openContent(path) })),
      readTargets: instanceId => {
        const instance = this.registry.getInstance(instanceId)
        if (!instance || instance.revoked_at) return []
        return this.resolveReadTargets(instance)
          .filter(t => existsSync(t.dbPath))
          .map(t => ({ path: t.dbPath, store: this.openContent(t.dbPath), scopeIds: t.scopeIds }))
      },
      relativeDb: path => relative(this.paths.root, path),
      profile: async () => {
        const p = await this.ensureProfile()
        this.triageEmbKey = p.embeddings ? { model: p.embeddings.model, dimensions: p.embeddings.dimensions } : null
        return p
      },
      redact: text => {
        const r = this.redactor.redact(text)
        for (const secret of r.found) this.vaultSecret(secret)
        return { text: r.text, secrets: r.found.length }
      },
      isEnabled: () => this.isEnabled(),
      isClosed: () => this.closed,
      getSetting: key => this.registry.getSetting(key),
      setSetting: (key, value) => this.registry.setSetting(key, value),
      config: () => this.resolved.config.triage ?? {},
      configDir: () => dirname(this.resolved.configPath),
      agentOf: id => this.agentOfInstance(id),
      persons: () => this.registry.listPersons().map(p => ({ id: p.id, display_name: p.display_name })),
      audit: (action, reason) =>
        this.registry.audit({ actor_type: 'user', actor_id: 'local', action, target_id_hash: null, scope_id: null, reason }),
      promote: opts => this.promoteTriaged(opts),
      teamScopeIds: () => this.teamScopeIds(),
      ideas: (id, filter, context) => this.ideasForInstance(id, filter, context),
      styles: (id, query) => this.stylesForInstance(id, query),
      storePendingTriaged: input => this.storePendingTriaged(input),
      resolveInstanceForSource: source => this.resolveInstanceForSource(source),
      findSemanticDuplicate: (id, text, vector, opts) => this.findSemanticDuplicate(id, text, vector, opts),
      instanceDb: id => {
        const path = this.paths.assistantDb(id)
        return this.registry.getInstance(id) && existsSync(path) ? { path, store: this.openContent(path) } : null
      },
      userMessagesPass: () => {
        const pass = this.userMessagesPassFn
        return pass ? (host, opts) => this.withTriageVecCache(opts.dryRun !== true, () => pass(host, opts)) : null
      },
      stylesPass: () => {
        const pass = this.stylesPassFn
        return pass ? (host, opts) => this.withTriageVecCache(opts.dryRun !== true, () => pass(host, opts)) : null
      },
      personProfile: id => {
        const p = this.registry.getPerson(id)
        if (!p) return null
        // Alias de nom seulement : un numéro, un e-mail ou un compte de messagerie n'est pas un prénom.
        const aliases = p.identifiers.filter(i => i.kind === 'handle' || i.kind === 'other').map(i => i.value)
        return { id: p.id, display_name: p.display_name, aliases }
      },
    }
  }

  /**
   * Le cache des redites ne vit que le temps d'une passe annexe (messages,
   * styles) : construit par pages AVANT (sans figer la boucle d'événements),
   * vidé à la fin. Un dry-run ne le construit pas (il ne cherche aucun doublon).
   */
  private async withTriageVecCache<T>(warm: boolean, fn: () => Promise<T>): Promise<T> {
    this.dropTriageVecCache()
    try {
      if (warm) await this.warmTriageVecCaches()
      return await fn()
    } finally {
      this.dropTriageVecCache()
    }
  }

  /** `ia:<agent>` d'une instance : claude, codex, gpt… (type d'assistant, jamais deviné par le LLM). */
  private agentOfInstance(instanceId: string | null): string {
    if (!instanceId) return 'autre'
    const instance = this.registry.getInstance(instanceId)
    const type = instance ? this.registry.getAssistant(instance.assistant_id)?.type : undefined
    switch (type) {
      case 'claude-code':
        return 'claude'
      case 'codex':
        return 'codex'
      case 'chatgpt':
        return 'gpt'
      case 'openclaw':
      case 'cursor':
        return type
      default:
        return 'autre'
    }
  }

  /**
   * VALIDE des faits triés (→ actifs). Ce n'est pas reviewDecision (qui prend
   * des items de revue et efface au rejet) :
   *  - activation + clôture des items de revue + marqueurs de cognition remis
   *    à zéro, une transaction par tranche de 50 faits ; puis cognition et vecteurs ;
   *  - sensible = marque de la ligne de tri OU filtre sensible relu sur le
   *    texte (une ligne créée par une correction, ou triée avant un filtre plus
   *    large, peut porter sensible = 0), sauf si le propriétaire a levé la
   *    marque à la main (correction `sensible: false`) ;
   *  - les membres EN ATTENTE de l'amas sont supersédés vers le représentant
   *    (traçable, comme mergeFacts), leurs items passent en `duplicate` : le
   *    rappel ne reçoit pas N quasi-doublons ; un membre déjà actif n'est pas touché ;
   *  - une redite d'un fait actif est supersédée vers lui au lieu d'être validée ;
   *  - un secret resté en clair dans un ancien fait est re-masqué avant ;
   *  - sensibles sautés par défaut (comptés) ; avec `allow_sensitive`, validés
   *    en sensitivity = 'critical' : gardés, invisibles au rappel ;
   *  - marqués faux : sautés ;
   *  - au plus 500 par appel (chaque fait validé peut coûter un appel LLM au
   *    passage ordinaire de cognition) ; par filtre, éphémères et sensibles exclus.
   */
  private promoteTriaged(opts: TriagePromoteOptions): TriagePromoteResult {
    this.assertOpen()
    const result: TriagePromoteResult = {
      promoted: 0,
      merged_members: 0,
      merged_into_active: 0,
      skipped_sensitive: 0,
      skipped_faux: 0,
      already_active: 0,
      not_found: 0,
      shared: 0,
      secrets_masked: 0,
      cognition_calls_estimate: 0,
    }
    if (!opts.fact_ids && !opts.filter) throw new TriageRefusedError('bad-request', 'promotion : des ids ou un filtre sont requis')
    // Les faits en attente changent : les vecteurs gardés pour les redites ne sont plus sûrs.
    this.dropTriageVecCache()
    let left = Math.max(1, Math.min(500, Math.floor(opts.max ?? 500)))
    const wanted = opts.fact_ids ? [...new Set(opts.fact_ids)] : null
    const seen = new Set<string>()
    const toShare: string[] = []
    const now = nowISO()
    // `true` reste l'espace `user` ; `'org'` passe par les garde-fous de l'espace d'équipe (shareFacts).
    const shareTo = opts.share === 'org' ? TEAM_SCOPE_ALIAS : opts.share === true || opts.share === 'user' ? 'user' : null
    // Filtre « candidats équipe » : ce qui est déjà dans l'espace d'équipe n'y est pas proposé.
    const listQuery = opts.filter?.team ? { excludeScopeIds: this.teamScopeIds() } : {}
    for (const path of this.contentDbPathsFor(wanted ? undefined : opts.filter?.instance)) {
      if (left <= 0) break
      const store = this.openContent(path)
      const db = store.db
      let rows: Array<Record<string, unknown>>
      if (wanted) {
        rows = store.db
          .prepare(
            `SELECT f.id AS f_id, f.fact AS f_fact, f.lifecycle_state AS f_state, f.superseded AS f_superseded, t.*
             FROM facts f LEFT JOIN fact_triage t ON t.fact_id = f.id
             WHERE f.id IN (SELECT value FROM json_each(?)) AND f.deleted_at IS NULL`,
          )
          .all(JSON.stringify(wanted.filter(id => !seen.has(id)))) as Array<Record<string, unknown>>
      } else {
        const filter = { ...opts.filter, validated: false }
        const { where, params } = filterConditions(filter, listQuery)
        const genres = filter.genre === undefined ? [] : Array.isArray(filter.genre) ? filter.genre : [filter.genre]
        if (!genres.includes('ephemere')) where.push("(t.genre IS NULL OR t.genre != 'ephemere')")
        if (!opts.allow_sensitive) where.push('t.sensible = 0')
        rows = store.db
          .prepare(
            `SELECT f.id AS f_id, f.fact AS f_fact, f.lifecycle_state AS f_state, f.superseded AS f_superseded, t.*
             FROM fact_triage t JOIN facts f ON f.id = t.fact_id
             WHERE ${where.join(' AND ')}
             ORDER BY COALESCE(t.importance, 0) DESC, COALESCE(t.conversation_at, '') DESC LIMIT ?`,
          )
          .all(...params, left) as Array<Record<string, unknown>>
      }
      // Requêtes préparées une fois par base (et non par fait).
      const sql = {
        twin: db.prepare("SELECT id FROM facts WHERE id = ? AND lifecycle_state = 'active' AND superseded = 0 AND deleted_at IS NULL"),
        supersede: db.prepare('UPDATE facts SET superseded = 1, superseded_by = ?, updated_at = ? WHERE id = ?'),
        closeItems: db.prepare(
          `UPDATE memory_import_items SET status = ?, reviewed_by = 'local', reviewed_at = ?
           WHERE status = 'pending' AND target_memory_id = ?`,
        ),
        mask: db.prepare('UPDATE facts SET fact = ?, norm_hash = ?, updated_at = ? WHERE id = ?'),
        critical: db.prepare("UPDATE facts SET sensitivity = 'critical' WHERE id = ?"),
        activate: db.prepare("UPDATE facts SET lifecycle_state = 'active', updated_at = ? WHERE id = ?"),
        members: db.prepare(PROMOTE_MEMBERS_SQL),
      }
      const activated: string[] = []
      // Une transaction par tranche ; compteurs et listes de la tranche fusionnés
      // seulement après son commit (un échec n'en laisse rien dans le résultat).
      for (let start = 0; start < rows.length && left > 0; start += PROMOTE_SLICE) {
        const slice = rows.slice(start, start + PROMOTE_SLICE)
        const outcome = db.transaction(() => {
          const out = {
            counts: { promoted: 0, merged_members: 0, merged_into_active: 0, skipped_sensitive: 0, skipped_faux: 0, already_active: 0, not_found: 0, secrets_masked: 0 },
            seen: [] as string[],
            activated: [] as string[],
            share: [] as string[],
            used: 0,
          }
          const sliceSeen = new Set<string>()
          for (const r of slice) {
            if (left - out.used <= 0) break
            const id = String(r.f_id)
            // Membre supersédé plus tôt dans cet appel : les lignes ont été lues avant.
            if (seen.has(id) || sliceSeen.has(id)) continue
            sliceSeen.add(id)
            out.seen.push(id)
            const triage = r.fact_id ? rowFromTriageDb(r) : null
            if (Number(r.f_superseded) === 1) {
              out.counts.not_found++
              continue
            }
            if (r.f_state === 'active') {
              out.counts.already_active++
              // Fait déjà validé, désigné par son id : il part quand même vers l'espace d'équipe (amorçage).
              if (shareTo === TEAM_SCOPE_ALIAS && wanted) out.share.push(id)
              continue
            }
            if (r.f_state !== 'dormant') {
              out.counts.not_found++
              continue
            }
            if (triage?.verdict === 'faux') {
              out.counts.skipped_faux++
              continue
            }
            const text = String(r.f_fact)
            const ownerLifted = triage !== null && !triage.sensible && triage.corrected_fields.includes('sensible')
            const sensible = triage?.sensible === true || (!ownerLifted && isTriageSensitive(text))
            if (sensible && !opts.allow_sensitive) {
              out.counts.skipped_sensitive++
              continue
            }
            out.used++
            const twin = triage?.same_as_active ? (sql.twin.get(triage.same_as_active) as { id: string } | undefined) : undefined
            if (twin) {
              sql.supersede.run(twin.id, now, id)
              sql.closeItems.run('duplicate', now, id)
              out.counts.merged_into_active++
              continue
            }
            if (triage?.secret_found) {
              const masked = this.redactBeforeStore(text)
              if (masked !== text) {
                sql.mask.run(masked, factNormHash(masked), now, id)
                out.counts.secrets_masked++
              }
            }
            if (sensible) sql.critical.run(id)
            sql.activate.run(now, id)
            sql.closeItems.run('accepted', now, id)
            resetBackfillMarkers(store, [id])
            out.activated.push(id)
            out.share.push(id)
            out.counts.promoted++
            // Membres de l'amas encore en attente : supersédés vers le représentant validé.
            for (const m of sql.members.all(id, id) as Array<{ id: string }>) {
              sql.supersede.run(id, now, m.id)
              sql.closeItems.run('duplicate', now, m.id)
              sliceSeen.add(m.id)
              out.seen.push(m.id)
              out.share.push(m.id)
              out.counts.merged_members++
            }
          }
          return out
        })()
        for (const [k, n] of Object.entries(outcome.counts)) result[k as keyof typeof outcome.counts] += n
        for (const id of outcome.seen) seen.add(id)
        activated.push(...outcome.activated)
        toShare.push(...outcome.share)
        left -= outcome.used
      }
      if (activated.length > 0) {
        this.registry.audit({
          actor_type: 'user',
          actor_id: 'local',
          action: 'triage_promote',
          target_id_hash: sha256Hex([...activated].sort().join(',')),
          scope_id: null,
          reason: `facts=${activated.length}`,
        })
      }
    }
    if (wanted) result.not_found += wanted.filter(id => !seen.has(id)).length
    result.cognition_calls_estimate = result.promoted
    if (result.promoted > 0) {
      // Les faits validés rejoignent le graphe et l'index (activateFact ne le faisait pas pour les vecteurs).
      this.scheduleCognition()
      void this.indexEmbeddings().catch((err: unknown) =>
        console.warn(`[memoria] indexation après validation du tri en échec : ${(err as Error).message}`),
      )
    }
    if (shareTo && toShare.length > 0) {
      // Le partage déplace le fait (et sa ligne de tri) dans la base partagée ;
      // les membres supersédés suivent vers `user` : la chaîne superseded_by
      // reste dans une seule base. Vers l'espace d'équipe, une redite ne part
      // pas (raison `redite`) : seul le représentant voyage.
      const shared = this.shareFacts(toShare, shareTo)
      result.shared = shared.shared
      if (shared.refused) result.share_refused = shared.refused
    }
    return result
  }

  /** Conditions communes des lectures d'agent : faits ACTIFS triés, non sensibles, non faux, représentants. */
  private triageAgentRows(
    instanceId: string,
    filter: TriageListFilter,
    activeContext: ActiveContext | undefined,
    order: string,
    limit: number,
  ): Array<{ row: FactRow; triage: TriageRow }> {
    const instance = this.mustInstance(instanceId)
    const context = this.expandContextTree(activeContext)
    const now = Date.now()
    const out: Array<{ row: FactRow; triage: TriageRow }> = []
    for (const target of this.resolveReadTargets(instance)) {
      const store = this.openContent(target.dbPath)
      const { where, params } = filterConditions({ ...filter, validated: true, include_members: false, include_faux: false, sensible: false })
      where.push('t.genre IS NOT NULL', "f.sensitivity IN ('normal','sensitive')")
      where.push(`f.scope_id IN (${target.scopeIds.map(() => '?').join(',')})`)
      params.push(...target.scopeIds)
      const rows = store.db
        .prepare(`SELECT f.*, t.* FROM fact_triage t JOIN facts f ON f.id = t.fact_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
        .all(...params, limit * 3) as Array<Record<string, unknown>>
      for (const r of rows) {
        const row = r as unknown as FactRow
        // Mêmes filtres DURS que le rappel (actif, non supersédé, sensibilité, scopes, expiration, client).
        if (!passesRecallHardFilters(row, target.scopeIds, context, now)) continue
        out.push({ row, triage: rowFromTriageDb(r) })
      }
    }
    return out
  }

  /**
   * Idées, décisions… VALIDÉES lisibles par l'instance, avec les mêmes filtres
   * que le rappel (scopes, sensibilité, client, expiration). Les faits en
   * attente ne sont jamais rendus : seulement leur nombre par genre, sans texte.
   */
  private ideasForInstance(instanceId: string, filter: IdeasFilter, activeContext?: ActiveContext): IdeasResult {
    this.assertOpen()
    const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 30)))
    const found = this.triageAgentRows(
      instanceId,
      { genre: filter.genre, sous_type: filter.sous_type, auteur: filter.auteur, projet: filter.projet, q: filter.q, importance_min: filter.importance_min },
      activeContext,
      "COALESCE(t.importance, 0) DESC, COALESCE(t.conversation_at, '') DESC",
      limit,
    )
    found.sort(
      (a, b) =>
        (b.triage.importance ?? 0) - (a.triage.importance ?? 0) ||
        (b.triage.conversation_at ?? '').localeCompare(a.triage.conversation_at ?? ''),
    )
    const items: IdeaItem[] = found.slice(0, limit).map(({ row, triage }) => ({
      id: row.id,
      text: row.fact,
      titre: triage.titre,
      genre: triage.genre!,
      sous_type: triage.sous_type,
      auteur: triage.auteur,
      auteur_source: triage.auteur_source,
      projet: triage.projet,
      importance: triage.importance,
      rubriques: triage.rubriques,
      conversation_at: triage.conversation_at,
      amas_size: triage.amas_size,
      validated: true,
    }))
    // Compteurs en attente : nombre par genre, jamais de texte. Mêmes scopes et même isolation client.
    const pending: Record<string, number> = {}
    const instance = this.mustInstance(instanceId)
    const client = this.expandContextTree(activeContext)?.client_org_id ?? null
    for (const target of this.resolveReadTargets(instance)) {
      const rows = this.openContent(target.dbPath)
        .db.prepare(
          `SELECT t.genre AS genre, COUNT(*) AS n FROM fact_triage t JOIN facts f ON f.id = t.fact_id
           WHERE f.lifecycle_state = 'dormant' AND f.superseded = 0 AND f.deleted_at IS NULL
             AND t.genre IS NOT NULL AND t.sensible = 0 AND t.verdict IS NULL AND t.same_as_active IS NULL
             AND (t.amas_id IS NULL OR t.amas_id = t.fact_id)
             AND f.sensitivity IN ('normal','sensitive')
             AND f.scope_id IN (${target.scopeIds.map(() => '?').join(',')})
             AND (f.client_org_id IS NULL OR f.client_org_id = '' OR f.client_org_id IS ?)
           GROUP BY t.genre`,
        )
        .all(...target.scopeIds, client) as Array<{ genre: string; n: number }>
      for (const r of rows) pending[r.genre] = (pending[r.genre] ?? 0) + r.n
    }
    return { items, pending_counts: pending }
  }

  /** Styles d'échange VALIDÉS d'une personne (null = le propriétaire), du plus récent au plus ancien. */
  private stylesForInstance(instanceId: string, query: StylesQuery): StylesResult {
    this.assertOpen()
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 10)))
    const personId = query.person_id ?? null
    const found = this.triageAgentRows(instanceId, { genre: 'style', person_id: personId }, query.active_context, "COALESCE(t.conversation_at, '') DESC", limit)
    found.sort((a, b) => (b.triage.conversation_at ?? '').localeCompare(a.triage.conversation_at ?? ''))
    return {
      person_id: personId,
      items: found.slice(0, limit).map(({ row, triage }) => ({ id: row.id, text: row.fact, titre: triage.titre, conversation_at: triage.conversation_at })),
    }
  }

  /**
   * Écrit un fait EN ATTENTE trié (passe sur les messages) : storeFactInternal
   * en quarantaine (jamais storeFact : un texte identique à un dormant
   * l'activerait), item de revue sous une source « user-messages », ligne de
   * tri dans la même transaction. Un fait identique existant n'est ni activé
   * ni réécrit (created = false) ; expiré, il est réveillé, sauf `noRevive`.
   */
  private storePendingTriaged(input: StorePendingTriagedInput): StorePendingTriagedResult {
    this.assertOpen()
    const now = nowISO()
    const sensible = isTriageSensitive(input.content)
    let created = false
    const emb = this.triageEmbKey
    const { fact } = this.storeFactInternal(
      { instance: input.instance, content: input.content, category: input.category ?? 'general', source: 'user-messages' },
      {
        nearDup: false,
        quarantine: true,
        ...(input.noRevive ? { revive: false } : {}),
        reviewSource: { type: 'user-messages', key: input.source.key, path: input.source.path ?? null, metadata: input.source.metadata },
        afterInsert: (store, f) => {
          created = true
          const row: TriageRow = {
            ...emptyRow(f.id, now),
            auteur_source: 'message',
            amas_id: f.id,
            prompt_version: TRIAGE_PROMPT_VERSION,
            ...input.triage,
            fact_id: f.id,
            triaged_at: now,
            sensible: sensible || input.triage.sensible === true,
          }
          upsertTriageRows(store.db, [row])
          if (input.vector && emb && input.vector.length === emb.dimensions && !row.sensible) {
            const q = quantizeInt8(input.vector)
            store.db
              .prepare('INSERT OR REPLACE INTO fact_triage_vectors (fact_id, model, dimensions, vector) VALUES (?, ?, ?, ?)')
              .run(f.id, emb.model, emb.dimensions, q)
            // Redites de la suite de la passe : le nouveau rowid est au-dessus des pages restantes, jamais lu deux fois.
            const cache = this.triageVecCache.get(store.path)
            if (cache && cache.model === emb.model && cache.dims === emb.dimensions) {
              this.appendTriageVec(cache, f.id, f.fact, new Int8Array(q.buffer, q.byteOffset, emb.dimensions), TRIAGE_VEC_APPEND_MARGIN_BYTES)
            }
          }
        },
      },
    )
    return { fact_id: fact.id, created }
  }

  /** Instance d'origine d'une source de messages. */
  private resolveInstanceForSource(source: { kind: UserMessageSourceKind; path?: string }): string | null {
    this.assertOpen()
    if (source.kind === 'chatgpt') return this.findChatGptInstance()
    const type = source.kind === 'codex-history' ? 'codex' : 'claude-code'
    const agents = this.listAgents().filter(a => a.instance.revoked_at === null && a.assistant_type === type)
    if (source.kind === 'claude-code' && source.path) {
      for (const a of agents) {
        if (!a.db_path || !existsSync(a.db_path)) continue
        const hit = this.openContent(a.db_path).db.prepare('SELECT 1 FROM memory_sources WHERE source_path = ? LIMIT 1').get(source.path)
        if (hit) return a.instance.id
      }
    }
    const machine = hostname()
    agents.sort(
      (a, b) =>
        Number(b.instance.machine_id === machine) - Number(a.instance.machine_id === machine) ||
        (b.instance.last_seen_at ?? '').localeCompare(a.instance.last_seen_at ?? ''),
    )
    return agents[0]?.instance.id ?? null
  }

  /**
   * Doublon d'un texte dans les bases lisibles par l'instance : exact (actifs
   * et dormants), puis par le sens (≥ 0,92, mêmes nombres) parmi les actifs
   * (index vec0) et les faits en attente triés (cache des vecteurs de tri).
   *
   * Synchrone (contrat TriageHost) : le cache n'est jamais construit d'un coup
   * ici. Une base absente du cache y entre par sa première page, la suite se
   * lit en arrière-plan ; pendant ce temps, les faits en attente pas encore lus
   * ne sont pas comparés (la passe sur les messages construit le cache AVANT
   * de commencer, voir triageHost().userMessagesPass). Un candidat du cache est
   * relu en base avant d'être rendu : existe, en attente, non supersédé, non
   * sensible, mêmes nombres.
   *
   * `personId` (passe styles) : seuls comptent les faits dont la ligne de tri
   * porte ce person_id (null : aucune ligne, ou fait du propriétaire). Un
   * candidat d'une autre personne est sauté et la recherche continue (plus de
   * candidats examinés) : le style d'une autre fiche n'est pas une redite et ne
   * doit pas cacher celle de la même personne. Absent : aucun filtre.
   */
  private findSemanticDuplicate(
    instanceId: string,
    text: string,
    vector?: Float32Array,
    opts: { personId?: string | null } = {},
  ): SemanticDuplicate | null {
    this.assertOpen()
    const filtered = opts.personId !== undefined
    const samePerson = (store: ContentStore, id: string): boolean => {
      if (!filtered) return true
      const row = store.db.prepare('SELECT person_id FROM fact_triage WHERE fact_id = ?').get(id) as { person_id: string | null } | undefined
      return (row?.person_id ?? null) === opts.personId
    }
    const exact = this.findKnownDuplicate(instanceId, text, filtered ? { accept: samePerson } : {})
    if (exact) return { fact_id: exact.existing.id, score: 1, kind: 'exact' }
    const emb = this.triageEmbKey
    if (!vector || !emb || vector.length !== emb.dimensions || isTriageSensitive(text)) return null
    const v = normalizeVector(vector)
    const sig = numberSignature(text)
    let best: SemanticDuplicate | null = null
    const consider = (store: ContentStore, id: string, fact: string, other: Float32Array): void => {
      const score = dot(v, other)
      if (score >= REDITE_THRESHOLD && numberSignature(fact) === sig && (!best || score > best.score) && samePerson(store, id)) {
        best = { fact_id: id, score, kind: 'meaning' }
      }
    }
    const pending: Array<{ store: ContentStore; cache: TriageVecCache; k: number; score: number }> = []
    for (const target of this.resolveReadTargets(this.mustInstance(instanceId))) {
      const store = this.openContent(target.dbPath)
      if (listVecTables(store.db).includes(vecTableName(emb))) {
        try {
          const hits = knn(store.db, emb, v, filtered ? 64 : 16)
          const rows = store.db
            .prepare(
              `SELECT f.id, f.fact, e.vector, e.dimensions FROM facts f
               JOIN embeddings e ON e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ?
               WHERE f.id IN (SELECT value FROM json_each(?)) AND f.lifecycle_state = 'active' AND f.superseded = 0`,
            )
            .all(emb.model, JSON.stringify(hits.map(h => h.fact_id))) as Array<{ id: string; fact: string; vector: Buffer; dimensions: number }>
          for (const r of rows) consider(store, r.id, r.fact, float32FromBlob(r.vector, r.dimensions))
        } catch {
          /* index vectoriel indisponible : les faits en attente restent comparés */
        }
      }
      const cache = this.triageVecCacheFor(store, emb)
      scanTriageVec(cache, v, sig, (k, score) => pending.push({ store, cache, k, score }))
    }
    pending.sort((a, b) => b.score - a.score)
    for (const c of pending) {
      if (best !== null && c.score <= (best as SemanticDuplicate).score) break
      const id = c.cache.ids[c.k]!
      // Le cache a pu vieillir (oubli, validation, fusion, partage) : relu en base.
      const row = c.store.db.prepare(TRIAGE_VEC_RECHECK_SQL).get(id) as { fact: string } | undefined
      if (row && numberSignature(row.fact) === sig) {
        // Valide mais d'une autre personne : sauté, jamais retiré du cache.
        if (!samePerson(c.store, id)) continue
        best = { fact_id: id, score: c.score, kind: 'meaning' }
        break
      }
      c.cache.sigs[c.k] = null
    }
    return best
  }

  /** Vide le cache des redites (une construction en cours s'arrête à sa page suivante). */
  private dropTriageVecCache(): void {
    this.triageVecCache.clear()
  }

  /**
   * Construit, par pages et en rendant la main entre elles, le cache des
   * redites de toutes les bases. Toutes les constructions partent ensemble et
   * se relaient page par page : sous le plafond commun, chaque base garde ses
   * vecteurs les plus récents (une grosse base lue la première ne prend pas tout).
   */
  private async warmTriageVecCaches(): Promise<void> {
    const emb = this.triageEmbKey
    if (!emb) return
    const building: Array<Promise<void>> = []
    for (const path of this.contentDbPathsFor()) {
      if (this.closed) return
      const cache = this.triageVecCacheFor(this.openContent(path), emb)
      if (cache.building) building.push(cache.building)
    }
    await Promise.all(building)
  }

  /**
   * Cache des redites d'une base. Créé au besoin : sa première page est lue
   * tout de suite (une petite base est alors complète), la suite en arrière-plan.
   */
  private triageVecCacheFor(store: ContentStore, emb: { model: string; dimensions: number }): TriageVecCache {
    const existing = this.triageVecCache.get(store.path)
    if (existing && existing.model === emb.model && existing.dims === emb.dimensions) return existing
    const bounds = store.db.prepare('SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM fact_triage_vectors').get() as { lo: number | null; hi: number | null }
    const cache: TriageVecCache = {
      model: emb.model,
      dims: emb.dimensions,
      blocks: [],
      invNorms: [],
      split: triageVecSplit(emb.dimensions),
      restNorms: [],
      sigs: [],
      ids: [],
      count: 0,
      cursor: (bounds.hi ?? 0) + 1,
      floor: bounds.lo ?? 0,
      complete: bounds.hi === null,
      truncated: false,
      building: null,
    }
    this.triageVecCache.set(store.path, cache)
    this.loadTriageVecPage(store, cache)
    if (!cache.complete) cache.building = this.buildTriageVecCache(store.path, cache)
    return cache
  }

  /** Suite de la construction, une page par tour de boucle d'événements (ticket #27). */
  private async buildTriageVecCache(path: string, cache: TriageVecCache): Promise<void> {
    try {
      while (!cache.complete) {
        await new Promise<void>(resolve => setImmediate(resolve))
        // Cache vidé (fin de passe, oubli, validation…) ou Memoria fermé : on s'arrête.
        if (this.closed || this.triageVecCache.get(path) !== cache) return
        this.loadTriageVecPage(this.openContent(path), cache)
      }
    } catch (err) {
      // Base illisible : le cache reste partiel (exacts et actifs toujours cherchés).
      cache.complete = true
      console.warn(`[memoria] cache des redites incomplet : ${(err as Error).message}`)
    } finally {
      cache.building = null
    }
  }

  /** Une page (fenêtre de rowid, du plus récent au plus ancien) de vecteurs de tri en attente. */
  private loadTriageVecPage(store: ContentStore, cache: TriageVecCache): void {
    if (cache.complete) return
    const lo = Math.max(cache.floor, cache.cursor - TRIAGE_VEC_PAGE)
    const rows = store.db.prepare(TRIAGE_VEC_PAGE_SQL).all(lo, cache.cursor, cache.model) as Array<{
      id: string
      fact: string
      vector: Buffer
      dimensions: number
    }>
    for (const r of rows) {
      if (r.dimensions !== cache.dims || r.vector.byteLength < cache.dims) continue
      if (!this.appendTriageVec(cache, r.id, r.fact, new Int8Array(r.vector.buffer, r.vector.byteOffset, cache.dims), 0)) {
        cache.complete = true
        return
      }
    }
    cache.cursor = lo
    if (lo <= cache.floor) cache.complete = true
  }

  /** Ajoute un vecteur int8 au cache ; false si le plafond (toutes bases, + marge) est atteint. */
  private appendTriageVec(cache: TriageVecCache, id: string, fact: string, vec: Int8Array, marginBytes: number): boolean {
    let used = 0
    for (const c of this.triageVecCache.values()) used += c.count * c.dims
    if (used + cache.dims > TRIAGE_VEC_MAX_BYTES + marginBytes) {
      cache.truncated = true
      if (!this.triageVecWarned) {
        this.triageVecWarned = true
        console.warn(
          `[memoria] cache des redites plein (${Math.round(TRIAGE_VEC_MAX_BYTES / 1_048_576)} Mo) : les faits en attente les plus anciens ne sont pas comparés`,
        )
      }
      return false
    }
    const j = cache.count % TRIAGE_VEC_BLOCK
    if (j === 0) cache.blocks.push(new Int8Array(TRIAGE_VEC_BLOCK * cache.dims))
    cache.blocks[cache.blocks.length - 1]!.set(vec, j * cache.dims)
    let head = 0
    let rest = 0
    for (let i = 0; i < cache.split; i++) head += vec[i]! * vec[i]!
    for (let i = cache.split; i < cache.dims; i++) rest += vec[i]! * vec[i]!
    const inv = head + rest > 0 ? 1 / Math.sqrt(head + rest) : 0
    cache.invNorms.push(inv)
    cache.restNorms.push(Math.sqrt(rest) * inv)
    cache.sigs.push(numberSignature(fact))
    cache.ids.push(id)
    cache.count++
    return true
  }

  close(): void {
    if (this.closed) return
    // Un tri en cours s'arrête entre deux lots (il lit `closed`).
    this.triage.cancel()
    this.closed = true
    this.dropTriageVecCache()
    if (this.indexTimer) {
      clearTimeout(this.indexTimer)
      this.indexTimer = null
    }
    if (this.cognitionTimer) {
      clearTimeout(this.cognitionTimer)
      this.cognitionTimer = null
    }
    for (const store of this.pool.values()) store.close()
    this.pool.clear()
    this.registry.close()
  }

  // ------------------------------------------------------------------ interne

  private assertOpen(): void {
    if (this.closed) throw new Error('Memoria est fermé (close() déjà appelé)')
  }

  /** Redaction des secrets avant tout stockage de fait → valeur au coffre, jamais en clair. */
  private redactBeforeStore(text: string): string {
    const result = this.redactor.redact(text)
    for (const secret of result.found) this.vaultSecret(secret)
    return result.text
  }

  /**
   * Met un secret détecté au coffre — JAMAIS silencieux, JAMAIS la valeur dans
   * un message. Le Trousseau peut refuser l'écriture (verrouillé, autorisation
   * annulée sous launchd/sandbox) : on replie alors sur le coffre AES local
   * avec un avertissement clair (nom + raison, sans valeur), et la référence
   * enregistrée pointe sur le coffre qui a RÉELLEMENT reçu la valeur. Si le
   * repli échoue aussi (ou si le coffre principal EST déjà l'AES), échec
   * bruyant : le fait n'est pas écrit — mieux qu'un secret perdu sans bruit.
   * Avant, l'échec était avalé par un warn qui contenait `-w <valeur>`.
   */
  private vaultSecret(secret: DetectedSecret): void {
    const candidates: SecretProvider[] = [this.secretProvider]
    if (this.secretProvider.kind !== 'aes-vault') {
      this.fallbackVault ??= new AesVaultProvider(this.paths.secretsDir)
      candidates.push(this.fallbackVault)
    }
    let lastFailure = ''
    for (const provider of candidates) {
      try {
        provider.set(secret.name, secret.value)
      } catch (err) {
        // Défense : quelle que soit l'origine de l'erreur, la valeur n'en sort pas.
        lastFailure = hideValue((err as Error)?.message ?? String(err), secret.value)
        continue
      }
      this.registry.upsertSecretRef(secret.name, provider.locationFor(secret.name), secret.kind)
      if (provider !== this.secretProvider) {
        console.warn(
          `[memoria] coffre « ${this.secretProvider.kind} » indisponible (${lastFailure}) — ` +
            `secret « ${secret.name} » mis au coffre AES local (${provider.locationFor(secret.name)})`,
        )
      }
      return
    }
    throw new Error(`mise au coffre du secret « ${secret.name} » impossible (${this.secretProvider.kind}) : ${lastFailure}`)
  }

  private mustInstance(instanceId: string): AssistantInstance {
    const instance = this.registry.getInstance(instanceId)
    if (!instance) throw new Error(`instance inconnue : ${instanceId}`)
    if (instance.revoked_at) throw new Error(`instance révoquée : ${instanceId}`)
    return instance
  }

  private openContent(path: string): ContentStore {
    let store = this.pool.get(path)
    if (!store) {
      store = new ContentStore(path)
      this.pool.set(path, store)
      if (!store.isRecallIndexReady()) this.scheduleRecallIndex(store)
    }
    return store
  }

  /**
   * Base à beaucoup de faits actifs : l'ouverture n'a rempli qu'une partie de
   * l'index de rappel (budget borné). La suite se fait par tranches espacées,
   * hors de tout appel, pour ne jamais figer la boucle (règle n°27). D'ici là,
   * le rappel de cette base garde l'ancien chemin, juste mais plus lent.
   */
  private scheduleRecallIndex(store: ContentStore, delayMs = RECALL_INDEX_STEP_DELAY_MS): void {
    const timer = setTimeout(() => {
      if (this.closed || !store.db.open) return
      try {
        if (!store.advanceRecallIndex(RECALL_FTS_OPEN_BUDGET_MS)) this.scheduleRecallIndex(store)
      } catch (err) {
        // Base verrouillée par un autre processus, disque plein… : on réessaie
        // plus tard ; le rappel reste juste entre-temps (ancien chemin).
        console.warn('[memoria] index de rappel : remplissage en échec, nouvel essai dans 60 s :', (err as Error).message)
        this.scheduleRecallIndex(store, RECALL_INDEX_RETRY_MS)
      }
    }, delayMs)
    timer.unref()
  }

  /** Scope cible d'une écriture : id, nom, ou défaut = privé de l'instance. */
  private resolveTargetScope(instance: AssistantInstance, scopeRef?: string): MemoryScope {
    if (!scopeRef) {
      const scope = this.registry.getScopeByName(`private:${instance.id}`)
      if (!scope) throw new Error(`scope privé introuvable pour l'instance ${instance.id}`)
      return scope
    }
    // `org` : l'espace de l'entreprise, quel que soit son identifiant (teamScope).
    const scope = this.resolveScopeRef(scopeRef)
    if (!scope) {
      throw new Error(
        scopeRef === TEAM_SCOPE_ALIAS ? "scope inconnu : org (aucun espace d'entreprise sur cette machine)" : `scope inconnu : ${scopeRef}`,
      )
    }
    return scope
  }

  /** DB qui héberge un scope (privé → DB d'instance ; partagé → shared/…). */
  private storeForScope(scope: MemoryScope, instance: AssistantInstance): ContentStore {
    if (scope.type === 'private') {
      return this.openContent(this.paths.assistantDb(instance.id))
    }
    const dbPath = this.sharedDbPath(scope)
    const store = this.openContent(dbPath)
    this.registry.registerDb({ kind: 'shared', path: dbPath, assistant_instance_id: null, scope_id: scope.id })
    return store
  }

  private sharedDbPath(scope: MemoryScope): string {
    switch (scope.type) {
      case 'user':
        return this.paths.sharedDb('user')
      case 'org':
        return this.paths.sharedDb(`companies/${scope.org_id ?? scope.id}`)
      case 'client':
        return this.paths.sharedDb(`clients/${scope.client_org_id ?? scope.id}`)
      case 'project':
        return this.paths.sharedDb(`projects/${scope.project_id ?? scope.id}`)
      case 'shared_topic':
        return this.paths.sharedDb(`topics/${scope.id}`)
      case 'legacy_to_review':
        return this.paths.sharedDb('legacy_to_review')
      default:
        throw new Error(`type de scope sans DB partagée : ${scope.type}`)
    }
  }

  /**
   * Cibles de lecture du fan-out : la DB privée de CETTE instance + chaque DB
   * partagée dont le scope est lisible (policy can_read). Les scopes privés
   * des AUTRES instances sont exclus structurellement.
   */
  private resolveReadTargets(instance: AssistantInstance): Array<{ dbPath: string; scopeIds: string[]; scopeNames: string[] }> {
    const targets = new Map<string, { scopeIds: string[]; scopeNames: string[] }>()

    const push = (dbPath: string, scope: MemoryScope) => {
      const entry = targets.get(dbPath) ?? { scopeIds: [], scopeNames: [] }
      entry.scopeIds.push(scope.id)
      entry.scopeNames.push(scope.name)
      targets.set(dbPath, entry)
    }

    for (const scope of this.registry.readableScopes(instance.assistant_id)) {
      if (scope.type === 'private') {
        if (scope.name !== `private:${instance.id}`) continue
        push(this.paths.assistantDb(instance.id), scope)
      } else if (scope.type === 'legacy_to_review') {
        // La quarantaine n'entre JAMAIS dans le recall (revue via UI uniquement)
        continue
      } else {
        const dbPath = this.sharedDbPath(scope)
        if (existsSync(dbPath)) push(dbPath, scope)
      }
    }

    return [...targets.entries()].map(([dbPath, v]) => ({ dbPath, ...v }))
  }
}

/**
 * Révisions PROPOSÉES (non tranchées) pour un lot de faits.
 *
 * `revision_proposals` appartient à la couche 18 (migrations 90-99), appliquée
 * paresseusement : la table peut ne pas exister. On ne fait donc jamais échouer
 * un recall pour une info d'affichage — absence de table = aucune contestation.
 */
function pendingRevisionsFor(store: ContentStore, ids: string[]): Map<string, PendingRevision> {
  const out = new Map<string, PendingRevision>()
  if (ids.length === 0) return out
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = store.db
      .prepare(
        `SELECT fact_id, kind, replacement_fact_id FROM revision_proposals
         WHERE status = 'proposed' AND fact_id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ fact_id: string; kind: PendingRevision['kind']; replacement_fact_id: string | null }>
    for (const r of rows) {
      out.set(r.fact_id, {
        kind: r.kind,
        ...(r.replacement_fact_id ? { replacement_fact_id: r.replacement_fact_id } : {}),
      })
    }
  } catch {
    /* table absente (couche révision jamais appliquée) : rien à signaler */
  }
  return out
}

/** Raisons de score qui ne viennent pas de la recherche : contexte actif, épinglage. */
function boostReasons(row: FactRow, context: ActiveContext | undefined): RecallMatch[] {
  const out: RecallMatch[] = []
  const inContext =
    !!context &&
    ((!!context.project_id && row.project_id === context.project_id) ||
      (!!context.client_org_id && row.client_org_id === context.client_org_id) ||
      (!!context.org_id && row.org_id === context.org_id))
  if (inContext) out.push('context')
  if (row.pinned) out.push('pinned')
  return out
}

/** Voisins de graphe ajoutés au rappel, par base. */
const GRAPH_MAX_NEIGHBORS = 8
/** Au-delà, une date d'expiration n'est pas « bientôt » : le statut `expiring` tromperait. */
const EXPIRING_WINDOW_MS = 30 * 86_400_000

/**
 * Filtres DURS du rappel, pour un fait relu hors de la recherche (voisin de
 * graphe). Ce sont ceux que la recherche directe applique dans son SQL
 * (searchFacts : non supersédé, actif, sensibilité, scopes) et après
 * (isolation client, expiration). Un seul endroit pour qu'un chemin d'accès
 * de plus ne devienne pas une fuite.
 */
function passesRecallHardFilters(
  row: FactRow,
  scopeIds: readonly string[],
  context: ActiveContext | undefined,
  now: number,
): boolean {
  if (row.superseded) return false
  if (row.lifecycle_state !== 'active') return false
  if (row.sensitivity !== 'normal' && row.sensitivity !== 'sensitive') return false
  if (!row.scope_id || !scopeIds.includes(row.scope_id)) return false
  if (row.expires_at && Date.parse(row.expires_at) <= now) return false
  return passesClientIsolation(row, context)
}

/** Une entité citée dans plus de faits que cela ne relie rien d'utile (et coûte cher à suivre). */
const LINK_MAX_MENTIONS = 30
const LINK_MAX_PER_ITEM = 3
const LINK_EXCERPT_CHARS = 60

interface EnrichOptions {
  now: number
  context: ActiveContext | undefined
  /** Scopes lisibles dans cette base : bornent les thèmes émis et les voisins. */
  scopeIds: string[]
  /** Voisins (`links`) demandés. */
  links: boolean
  /** Ids déjà rendus : un voisin doit apporter autre chose que le rappel lui-même. */
  exclude: ReadonlySet<string>
}

/**
 * Complète les souvenirs sélectionnés d'UNE base : thème, entités, statut,
 * confiance et, sur demande, voisins. Lectures groupées (`IN (...)`), jamais
 * une requête par souvenir : le rappel est sur le chemin de la réponse.
 *
 * Chaque lecture est isolée dans son `try` : une table de cognition absente
 * (base ancienne, couche jamais appliquée) retire une information d'affichage,
 * pas le rappel.
 */
function enrichRecallItems(
  store: ContentStore,
  selected: Array<{ item: RecallItem; row: FactRow }>,
  opts: EnrichOptions,
): void {
  if (selected.length === 0) return
  const ids = selected.map(s => s.item.id)
  const marks = ids.map(() => '?').join(',')

  // Confiance et statut « expire » : déjà dans la ligne, aucune requête.
  for (const { item, row } of selected) {
    item.trust = { confidence: row.confidence, used_count: row.used_count, recall_count: row.recall_count }
    if (item.revision) item.status = 'contested'
    else if (row.expires_at) {
      // « expiring » se lit « bientôt périmé » : seulement dans la fenêtre proche.
      const left = Date.parse(row.expires_at) - opts.now
      if (left > 0 && left <= EXPIRING_WINDOW_MS) item.status = 'expiring'
    }
  }

  // Statut « remplace » : un fait supersédé pointe sur ce fait. Servi par
  // l'index partiel idx_facts_superseded_by (migration 9), sinon c'était un
  // parcours complet de `facts` à chaque rappel.
  try {
    const rows = store.db
      .prepare(`SELECT DISTINCT superseded_by FROM facts WHERE superseded = 1 AND superseded_by IN (${marks})`)
      .all(...ids) as Array<{ superseded_by: string }>
    const replacing = new Set(rows.map(r => r.superseded_by))
    for (const { item } of selected) if (!item.status && replacing.has(item.id)) item.status = 'replaces'
  } catch {
    /* colonne absente : pas de statut « remplace » */
  }

  // Thème principal : le plus important, puis le plus fourni. Les thèmes sont
  // communs à toute la base et leur NOM est tiré de leurs faits : un thème qui
  // contient un fait hors de portée de ce rappel (dormant ou archivé, critical,
  // autre scope, client masqué) pourrait le révéler par son seul nom. Il n'est
  // donc émis que si TOUS ses faits sont lisibles ici. Supersédés et expirés
  // compris : une information qu'on a fait expirer est une information qu'on a
  // choisi d'oublier. Mesuré le 13/11/2026 sur les bases réelles : 1 thème sur
  // 3 000 touché par cette règle, aucune perte visible.
  //
  // L'expiration est jugée à part, en JS avec Date.parse, comme partout dans
  // le rappel : en SQL elle se comparait comme du texte, et une date écrite
  // « Jan 1 2020 » ou avec un décalage +05:00 paraissait vivante. Les deux
  // lectures passent par l'index idx_fact_topics_topic (migration 22).
  try {
    const scopeMarks = opts.scopeIds.map(() => '?').join(',')
    const rows = store.db
      .prepare(
        `SELECT ft.fact_id, t.id, t.name FROM fact_topics ft JOIN topics t ON t.id = ft.topic_id
         WHERE ft.fact_id IN (${marks})
           AND NOT EXISTS (
             SELECT 1 FROM fact_topics ft2 JOIN facts f2 ON f2.id = ft2.fact_id
             WHERE ft2.topic_id = t.id
               AND (f2.lifecycle_state != 'active'
                 OR f2.superseded = 1
                 OR f2.sensitivity NOT IN ('normal','sensitive')
                 OR f2.scope_id IS NULL OR f2.scope_id NOT IN (${scopeMarks})
                 OR (f2.client_org_id IS NOT NULL AND f2.client_org_id != '' AND f2.client_org_id IS NOT ?)))
         ORDER BY t.importance_score DESC, t.fact_count DESC, t.id`,
      )
      .all(...ids, ...opts.scopeIds, opts.context?.client_org_id ?? null) as Array<{ fact_id: string; id: string; name: string }>
    const topicIds = [...new Set(rows.map(r => r.id))]
    const expired = new Set<string>()
    if (topicIds.length > 0) {
      const dated = store.db
        .prepare(
          `SELECT ft.topic_id, f.expires_at FROM fact_topics ft JOIN facts f ON f.id = ft.fact_id
           WHERE ft.topic_id IN (${topicIds.map(() => '?').join(',')}) AND f.expires_at IS NOT NULL`,
        )
        .all(...topicIds) as Array<{ topic_id: string; expires_at: string }>
      // Même règle que passesRecallHardFilters : une date illisible n'expire pas.
      for (const d of dated) if (Date.parse(d.expires_at) <= opts.now) expired.add(d.topic_id)
    }
    const first = new Map<string, { id: string; name: string }>()
    for (const r of rows) if (r.name && !expired.has(r.id) && !first.has(r.fact_id)) first.set(r.fact_id, { id: r.id, name: r.name })
    for (const { item } of selected) {
      const topic = first.get(item.id)
      if (topic) item.topic = topic
    }
  } catch {
    /* thèmes absents */
  }

  // Entités signifiantes (et, plus bas, point de départ des voisins).
  const ranked = new Map<string, Array<{ id: string; name: string; type: string; mention_count: number }>>()
  try {
    const rows = store.db
      .prepare(
        `SELECT fe.fact_id, e.id, e.name, e.type, e.mention_count FROM fact_entities fe
         JOIN entities e ON e.id = fe.entity_id WHERE fe.fact_id IN (${marks})`,
      )
      .all(...ids) as Array<{ fact_id: string; id: string; name: string; type: string; mention_count: number }>
    const byFact = new Map<string, typeof rows>()
    for (const r of rows) byFact.set(r.fact_id, [...(byFact.get(r.fact_id) ?? []), r])
    for (const { item } of selected) {
      const best = rankEntities(byFact.get(item.id) ?? [])
      if (best.length === 0) continue
      ranked.set(item.id, best)
      item.entities = best.map(e => e.name)
    }
  } catch {
    /* graphe d'entités absent */
  }

  if (!opts.links || opts.scopeIds.length === 0 || ranked.size === 0) return

  // VOISINS : faits qui partagent une entité RARE avec un souvenir rendu. Mêmes
  // filtres durs que la recherche (actif, non supersédé, sensibilité, scopes,
  // isolation client, non expiré) : un lien ne doit jamais devenir une fuite.
  const entityIds = [
    ...new Set(
      [...ranked.values()].flatMap(list => list.filter(e => e.mention_count <= LINK_MAX_MENTIONS).map(e => e.id)),
    ),
  ]
  if (entityIds.length === 0) return
  try {
    const rows = store.db
      .prepare(
        `SELECT fe.entity_id, f.id, f.fact, f.created_at, f.client_org_id, f.expires_at
         FROM fact_entities fe JOIN facts f ON f.id = fe.fact_id
         WHERE fe.entity_id IN (${entityIds.map(() => '?').join(',')})
           AND f.superseded = 0 AND f.lifecycle_state = 'active' AND f.sensitivity IN ('normal','sensitive')
           AND f.scope_id IN (${opts.scopeIds.map(() => '?').join(',')})
         ORDER BY f.created_at DESC`,
      )
      .all(...entityIds, ...opts.scopeIds) as Array<{
      entity_id: string
      id: string
      fact: string
      created_at: string
      client_org_id: string | null
      expires_at: string | null
    }>
    const byEntity = new Map<string, typeof rows>()
    for (const r of rows) {
      if (opts.exclude.has(r.id)) continue
      if (!passesClientIsolation(r, opts.context)) continue
      if (r.expires_at && Date.parse(r.expires_at) <= opts.now) continue
      byEntity.set(r.entity_id, [...(byEntity.get(r.entity_id) ?? []), r])
    }
    for (const { item } of selected) {
      const links: RecallLink[] = []
      const seen = new Set<string>()
      // Entités dans l'ordre de signifiance, voisins du plus récent au plus ancien.
      for (const entity of ranked.get(item.id) ?? []) {
        for (const n of byEntity.get(entity.id) ?? []) {
          if (links.length >= LINK_MAX_PER_ITEM) break
          if (seen.has(n.id)) continue
          seen.add(n.id)
          links.push({ id: n.id, excerpt: n.fact.replace(/\s+/g, ' ').trim().slice(0, LINK_EXCERPT_CHARS), via: entity.name })
        }
      }
      if (links.length > 0) item.links = links
    }
  } catch {
    /* pas de voisins : le rappel reste complet */
  }
}

/**
 * Un fait dormant au moment de la migration 11 a reçu le marqueur `backfill`
 * comme tous les faits existants, sans jamais être relié. Une fois validé, ce
 * marqueur l'excluait de tout passage ordinaire : il recevait un thème, mais
 * aucune entité tant qu'on ne lançait pas le rattrapage à la main. Sans
 * marqueur, le passage suivant le traite. Un fait déjà relié garde le sien.
 */
function resetBackfillMarkers(store: ContentStore, factIds: string[]): void {
  if (factIds.length === 0) return
  store.db
    .prepare(
      `DELETE FROM fact_cognition WHERE via = 'backfill' AND fact_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = fact_cognition.fact_id)`,
    )
    .run(JSON.stringify(factIds))
}

/** Masque toute occurrence d'une valeur de secret dans un message d'erreur. */
function hideValue(message: string, value: string): string {
  return value.length > 0 ? message.split(value).join('[secret]') : message
}

/** Lit `clé=mot` dans une raison d'audit (`provider=openai purpose=extraction`). */
function field(reason: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}=([^\\s]+)`).exec(reason)
  return m ? m[1] : undefined
}

/** Lit `clé=nombre` dans une raison d'audit (`returned=3 tokens=120 ms=41`). */
function metric(reason: string, key: string): number | undefined {
  const m = new RegExp(`\\b${key}=(\\d+)\\b`).exec(reason)
  return m ? Number(m[1]) : undefined
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** p95 sur un petit échantillon : tri complet, pas d'estimateur approché. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]!
}
