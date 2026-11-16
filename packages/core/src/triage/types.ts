/**
 * TRI DES SOUVENIRS : le contrat.
 *
 * Partagé par le moteur de tri (core), la passe sur les messages de
 * l'utilisateur (`user-messages.ts`), la passe styles (`styles-pass.ts`) et
 * les surfaces (daemon, CLI, MCP, web).
 * Toute modification de ce fichier passe par la session principale : les
 * autres modules s'y alignent.
 *
 * Principe : le tri n'écrit JAMAIS dans `facts` (ni cycle de vie, ni
 * catégorie, ni texte), ni dans `embeddings`, ni dans l'index vec0, ni dans le
 * graphe d'entités. Il écrit une ligne `fact_triage` par fait (et, pour les
 * faits en attente, un vecteur quantifié dans `fact_triage_vectors`). Un fait
 * dormant reste invisible au rappel tant qu'il n'est pas validé (`promote`).
 */
import type { CompleteOptions, CompletionResult } from '../llm/provider.js'
import type { ActiveContext } from '../types.js'

/** Version du prompt de classement. Une ligne d'une version plus ancienne n'est reclassée qu'avec `reclassify`. */
export const TRIAGE_PROMPT_VERSION = 'tri-v3'

/**
 * Version du prompt de la passe styles (`styles-pass.ts`), notée dans la ligne
 * de tri et dans l'état. Ici pour que l'hôte écarte ces faits des sources du
 * mode person sans importer la passe.
 */
export const STYLES_PROMPT_VERSION = 'styles-v1'

export const GENRES = [
  'idee',
  'decision',
  'process',
  'lecon',
  'preference',
  'style',
  'savoir',
  'fait',
  'chronologie',
  'ephemere',
] as const
export type Genre = (typeof GENRES)[number]

/** Sous-type, seulement pour le genre `idee`. */
export const SOUS_TYPES = ['app', 'business', 'contenu', 'outil', 'amelioration', 'autre'] as const
export type SousType = (typeof SOUS_TYPES)[number]

/** Rubriques d'entité (étiquettes, plusieurs possibles). Un seul nom : « rubriques ». */
export const RUBRIQUES = [
  'clients',
  'vente',
  'rh',
  'erreurs',
  'outils',
  'savoir_entreprise',
  'projet',
  'app',
  'contenu',
  'finance',
  'juridique',
  'infra',
] as const
export type Rubrique = (typeof RUBRIQUES)[number]

/** Portée PROPOSÉE (jamais appliquée par le tri). */
export const PORTEES = ['perso', 'user', 'entite'] as const
export type Portee = (typeof PORTEES)[number]

// ---------------------------------------------------------------- espace d'équipe (`org`)

/**
 * Ce qui peut entrer dans l'espace d'équipe (`org`, partagé avec les Mac de
 * l'équipe) et ce qui n'y entre jamais. Contrôlé CÔTÉ SERVEUR, au partage
 * (shareFacts, promotion du tri) : un écran ou un agent ne peut pas le contourner.
 *
 * Liste d'AUTORISATION pour les genres (plus de la moitié des faits « entité »
 * n'ont aucune rubrique : refuser seulement par rubrique laisserait passer le
 * reste) ; liste de REFUS pour les rubriques.
 */
export const TEAM_SHARE_GENRES: readonly Genre[] = ['process', 'savoir', 'lecon', 'decision']

/** Rubriques qui n'entrent jamais dans l'espace d'équipe. */
export const TEAM_REFUSED_RUBRIQUES: readonly Rubrique[] = ['rh', 'finance', 'juridique', 'clients', 'vente']

/**
 * Filtre « candidats équipe » du tri (`team: true`) : plus strict que le
 * partage. Les décisions n'y sont pas : elles passent au cas par cas.
 */
export const TEAM_CANDIDATE_GENRES: readonly Genre[] = ['process', 'savoir', 'lecon']

/** Le candidat porte au moins une de ces rubriques. */
export const TEAM_CANDIDATE_RUBRIQUES: readonly Rubrique[] = ['app', 'outils', 'contenu', 'infra', 'erreurs', 'savoir_entreprise']

/**
 * Raisons d'un refus de partage vers l'espace d'équipe, dans l'ordre où elles
 * sont testées (un fait compte pour la première qui s'applique) :
 *  - `critical`, `sensible` : sensibilité du fait, marque de tri ou filtre sensible local ;
 *  - `secret` : secret trouvé au tri, référence `[secret:…]` ou secret en clair ;
 *  - `client` : fait marqué d'un client (ou d'un projet de client) ;
 *  - `redite` : fait supersédé (une redite ne voyage pas sans son représentant) ;
 *  - `sans_tri` : aucune ligne de tri, ou classement sans genre ;
 *  - `portee` : fait sur une personne (portée `user` ou `perso`, ou `person_id`),
 *    ou fait de l'espace `user` sans portée `entite` confirmée à la main ;
 *  - `faux` : marqué faux au tri ;
 *  - `rubrique` : rubrique refusée (rh, finance, juridique, clients, vente) ;
 *  - `genre` : genre hors de la liste d'autorisation.
 */
export const TEAM_SHARE_REFUSALS = ['critical', 'sensible', 'secret', 'client', 'redite', 'sans_tri', 'faux', 'rubrique', 'genre', 'portee'] as const
export type TeamShareRefusal = (typeof TEAM_SHARE_REFUSALS)[number]

/** Faits écartés d'un partage vers l'espace d'équipe, par raison (toutes les clés, 0 compris). */
export type TeamShareRefusedCounts = Record<TeamShareRefusal, number>

/**
 * Auteur : `owner` (le propriétaire de la mémoire), `ia:<agent>` (claude,
 * codex, gpt, grok…), `person:<person_id>` (une fiche Person du registre),
 * `inconnu`. Jamais un prénom en dur.
 */
export type Auteur = 'owner' | 'inconnu' | `ia:${string}` | `person:${string}`

/** D'où vient l'auteur : vérifié dans les vrais messages, deviné par le LLM, ou inconnu. */
export type AuteurSource = 'message' | 'llm' | 'inconnu'

/** Transcription d'une session principale, ou d'un sous-agent (« l'utilisateur » y est l'agent chef). */
export type Origine = 'session' | 'sous-agent'

/**
 * D'où vient `conversation_at` :
 *  - `fichier` : premier horodatage du fichier source encore présent ;
 *  - `archive` : idem, depuis la copie d'archive ;
 *  - `etat` : date de modification notée par l'import (transcript_file_state) ;
 *  - `metadata` : date de la source (export ChatGPT : first_message_at) ;
 *  - `creation` : fait sans source d'import (capture en direct, déclaration) : sa date de création ;
 *  - `import` : date de l'import de la source (approximative : date l'import, pas la conversation) ;
 *  - `inconnu`.
 * Hors `fichier`, `archive`, `metadata` et `creation`, l'écran affiche « date approximative ».
 */
export type ConversationAtSource = 'fichier' | 'archive' | 'etat' | 'metadata' | 'creation' | 'import' | 'inconnu'

export type TriageVerdict = 'faux'

/** Genres dont les redites entre sources (sessions différentes) sont regroupées en amas. */
export const CROSS_SOURCE_GENRES: readonly Genre[] = ['idee', 'decision', 'process', 'lecon', 'preference', 'style']

/** Preuve d'auteur : le message qui ressemble le plus au fait, et son score de recouvrement. */
export interface AuteurPreuve {
  role: 'user' | 'assistant'
  /** Recouvrement des mots du fait avec le meilleur message de ce rôle (0 à 1). */
  score: number
  /** Même mesure pour l'autre rôle. */
  other: number
  /** Horodatage du message retenu, s'il en a un. */
  ts: string | null
}

/** Une ligne de tri (table `fact_triage`), désérialisée. */
export interface TriageRow {
  fact_id: string
  /** null : sensible (jamais envoyé), ou classement en échec (voir llm_failures). */
  genre: Genre | null
  sous_type: SousType | null
  rubriques: Rubrique[]
  portee: Portee | null
  /** Personne concernée par une préférence ou un style (null = le propriétaire). */
  person_id: string | null
  auteur: Auteur | null
  auteur_source: AuteurSource
  auteur_preuve: AuteurPreuve | null
  /** Idée d'une IA approuvée par le propriétaire (passe sur les messages). */
  approuve_par_owner: boolean
  durabilite: number | null
  importance: number | null
  autonome: boolean | null
  projet: string | null
  titre: string | null
  /** Citation courte du message d'origine (passe sur les messages). */
  citation: string | null
  /** Noms d'entités proposés par le LLM du tri (jamais la table `entities`). */
  entites: string[]
  conversation_at: string | null
  conversation_at_source: ConversationAtSource
  origine: Origine | null
  /** fact_id du représentant de l'amas (= fact_id pour le représentant lui-même). */
  amas_id: string | null
  /** Taille de l'amas (« dit N fois »), portée par chaque membre. */
  amas_size: number
  /** Redite d'un fait déjà ACTIF de la même base : son id (le genre en est hérité). */
  same_as_active: string | null
  /** Filtre sensible local : jamais envoyé au LLM ni aux vecteurs. */
  sensible: boolean
  /** Un secret en clair a été trouvé (et mis au coffre) : la promotion re-masque le texte. */
  secret_found: boolean
  verdict: TriageVerdict | null
  raison: string | null
  modele: string | null
  prompt_version: string | null
  triaged_at: string
  corrected_at: string | null
  corrected_fields: string[]
  llm_failures: number
}

// ---------------------------------------------------------------- liste (admin)

export interface TriageListFilter {
  genre?: Genre | Genre[]
  sous_type?: SousType
  /** Exact (`owner`, `inconnu`, `ia:claude`, `person:<id>`), ou famille : `ia`, `person`. */
  auteur?: string
  auteur_source?: AuteurSource
  rubrique?: Rubrique
  portee?: Portee
  /** Sous-chaîne, sans casse. */
  projet?: string
  importance_min?: number
  /** Recherche plein texte (facts_fts, dormants compris : liste d'administration). */
  q?: string
  /** Bases lisibles par cette instance (défaut : toutes). */
  instance?: string
  /** true = actifs (validés), false = en attente (dormants). Absent : les deux. */
  validated?: boolean
  /** Personne concernée (null = propriétaire). Absent : toutes. */
  person_id?: string | null
  /** Membres d'amas en plus des représentants (défaut false : un par amas). */
  include_members?: boolean
  /** Faits marqués faux (défaut false : cachés). */
  include_faux?: boolean
  /** true = seulement les sensibles ; false = sans eux ; absent = tous. */
  sensible?: boolean
  /** Bornes ISO sur conversation_at. */
  since?: string
  until?: string
  /**
   * Candidats pour l'espace d'équipe : genre process, savoir ou lecon, au
   * moins une rubrique de TEAM_CANDIDATE_RUBRIQUES et aucune de
   * TEAM_REFUSED_RUBRIQUES, ni client, ni sensible, ni secret, importance et
   * durabilité ≥ 2, représentant d'un amas seulement (même avec
   * `include_members`), hors faits déjà dans l'espace d'équipe.
   */
  team?: boolean
}

/** Curseur de pagination : (conversation_at, fact_id) du dernier élément rendu. `conversation_at` vide = date inconnue. */
export interface TriageCursor {
  conversation_at: string
  fact_id: string
}

export interface TriageListItem extends TriageRow {
  text: string
  category: string
  /** Statut « validé » : dérivé de facts.lifecycle_state, jamais stocké. */
  validated: boolean
  /** Base relative à la racine du stockage. */
  source_db: string
  instance_id: string | null
  /** Chemin ou clé de la conversation source (memory_sources.source_path), si connue. */
  source_path: string | null
}

export interface TriageListPage {
  items: TriageListItem[]
  next_cursor: TriageCursor | null
}

export interface TriageGenreStats {
  total: number
  validated: number
  pending: number
}

export interface TriageStats {
  /** Faits non supersédés (actifs + dormants) des bases couvertes. */
  facts_total: number
  triaged: number
  /** Faits sans ligne de tri. */
  untriaged: number
  /**
   * Sensibles que montre la liste par défaut (`list({ sensible: true })`) :
   * un par amas, ni redite d'un actif, ni marqué faux. Compteur de l'onglet.
   */
  sensible: number
  /** Classement en échec (genre null, non sensible, llm_failures > 0). */
  failed: number
  faux: number
  same_as_active: number
  /** Amas de plus d'un fait. */
  amas: number
  /** Membres d'amas qui ne sont pas le représentant (redites). */
  redites: number
  /**
   * Par genre, les lignes que montre la liste par défaut (`list({ genre })`) :
   * le représentant de chaque amas seulement, ni redite d'un actif, ni faux.
   * Les redites sont comptées à part (`redites`, `same_as_active`).
   */
  by_genre: Record<string, TriageGenreStats>
  /** owner / ia / person / inconnu / null. */
  by_auteur: Record<string, number>
}

// ---------------------------------------------------------------- passage

export interface TriageRunOptions {
  /** Bases lisibles par cette instance (défaut : toutes les bases de contenu). */
  instance?: string
  /**
   * Estime sans aucun appel (ni LLM, ni vecteurs) et sans toucher au tri : la
   * seule écriture est la dernière estimation (réglage `triage.last_estimate`).
   */
  dryRun?: boolean
  /** Plafond de dépense (USD) ; défaut : config `[triage] budget_usd`, sinon 5. Arrêt net au plafond. */
  budgetUsd?: number
  /** Nombre maximal de faits traités par ce passage. */
  maxFacts?: number
  /** Reclasse les lignes d'une version de prompt plus ancienne (jamais une ligne corrigée à la main). */
  reclassify?: boolean
  /** Appels LLM en parallèle (défaut 2). */
  concurrency?: number
  /** Taille des lots LLM (défaut 20). */
  batchSize?: number
  /** Défaut true : la dépense d'un passage interrompu (arrêt du daemon) compte dans le plafond du suivant. */
  resume?: boolean
}

export type TriageRunState = 'idle' | 'running' | 'done' | 'cancelled' | 'paused' | 'budget' | 'error' | 'interrupted'

export interface TriageEstimate {
  facts_pending: number
  /** Parmi eux, faits actifs (triés en premier). */
  facts_active: number
  facts_sensible: number
  /** Faits sans vecteur utilisable (à calculer). */
  facts_to_embed: number
  /** Borne haute : tous les non sensibles partent au LLM (les redites réduisent ce nombre). */
  llm_facts_max: number
  llm_calls_max: number
  tokens_in: number
  tokens_out: number
  embed_tokens: number
  llm_usd: number | null
  embeddings_usd: number | null
  /** null si un prix est inconnu. */
  cost_usd: number | null
  provider: string | null
  model: string | null
  embeddings_model: string | null
  budget_usd: number
  within_budget: boolean
}

export interface TriageRunStatus {
  run_id: string | null
  state: TriageRunState
  dry_run: boolean
  instance: string | null
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
  budget_usd: number
  /** Dépense de ce passage (reprise comprise). */
  spent_usd: number
  /** Dépense cumulée de tous les passages. */
  total_spent_usd: number
  dbs_total: number
  dbs_done: number
  /** Faits examinés (ligne écrite). */
  facts_done: number
  /** Classés par le LLM. */
  classified: number
  /** Genre hérité d'un représentant ou d'un actif identique (sans LLM). */
  inherited: number
  sensible: number
  /** Classement en échec ce passage (genre manquant ou hors grille après renvoi). */
  failed: number
  llm_calls: number
  embed_calls: number
  tokens_in: number
  tokens_out: number
  embed_tokens: number
  /** Plus long blocage de la boucle d'événements pendant le passage (ticket #27). */
  max_block_ms: number | null
  /**
   * Genres dont l'amas entre sources a été SAUTÉ ce passage (calcul trop long :
   * trop de comparaisons de vecteurs). Les redites entre sessions de ces genres
   * restent alors des souvenirs séparés. Absent ou vide : rien de sauté.
   */
  cross_source_skipped?: Array<{ genre: string; reps: number; comparisons: number }>
  error: string | null
  /** Rempli par un dry-run. */
  estimate: TriageEstimate | null
}

/** Pourquoi un passage s'arrête avant la fin. */
export type TriageStopReason = 'cancelled' | 'paused' | 'budget' | 'circuit' | 'closed' | 'max_facts'

export type TriageRefusalCode = 'running' | 'paused' | 'no-llm' | 'price-unknown' | 'closed' | 'not-registered' | 'bad-request' | 'not-found'

/** Refus AVANT tout travail. Le daemon le traduit : running → 409, paused → 423, no-llm / price-unknown → 422, not-found → 404. */
export class TriageRefusedError extends Error {
  readonly code: TriageRefusalCode
  constructor(code: TriageRefusalCode, message: string) {
    super(message)
    this.name = 'TriageRefusedError'
    this.code = code
  }
}

/** Le prochain appel dépasserait le plafond (pire cas) : il n'est pas fait. */
export class TriageBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriageBudgetError'
  }
}

// ---------------------------------------------------------------- corrections, verdict, promotion

export interface TriageCorrection {
  fact_id: string
  genre?: Genre
  sous_type?: SousType | null
  auteur?: Auteur
  rubriques?: Rubrique[]
  portee?: Portee | null
  projet?: string | null
  titre?: string | null
  importance?: number
  person_id?: string | null
  /** Lever (false) ou poser (true) la marque sensible à la main. */
  sensible?: boolean
}

export interface TriagePromoteOptions {
  /** Ids de faits (toutes bases). */
  fact_ids?: string[]
  /** Ou un filtre de liste (en attente seulement ; éphémères et sensibles exclus par défaut). */
  filter?: TriageListFilter
  /**
   * Partager après validation. `true` ou `'user'` : espace `user` (toutes les
   * IA du propriétaire). `'org'` : espace d'équipe, avec les garde-fous du
   * partage (TEAM_SHARE_REFUSALS) ; un fait désigné par son id et déjà validé
   * y part aussi.
   */
  share?: boolean | 'user' | 'org'
  /** Valider aussi les faits sensibles, en sensitivity = 'critical' (gardés, invisibles au rappel). */
  allow_sensitive?: boolean
  /** Plafond par appel (défaut et maximum 500). */
  max?: number
}

export interface TriagePromoteResult {
  promoted: number
  /** Membres d'amas supersédés vers leur représentant validé (items de revue en `duplicate`). */
  merged_members: number
  /** Redites d'un fait actif : supersédées vers lui au lieu d'être validées. */
  merged_into_active: number
  skipped_sensitive: number
  skipped_faux: number
  already_active: number
  not_found: number
  shared: number
  /** `share: 'org'` seulement : faits validés mais écartés de l'espace d'équipe, par raison. */
  share_refused?: TeamShareRefusedCounts
  secrets_masked: number
  /** Passage ordinaire de cognition déclenché : jusqu'à un appel LLM par fait validé. */
  cognition_calls_estimate: number
}

// ---------------------------------------------------------------- lectures pour les agents (jeton d'instance)

export interface IdeasFilter {
  genre?: Genre | Genre[]
  sous_type?: SousType
  /** Comme TriageListFilter.auteur. */
  auteur?: string
  projet?: string
  q?: string
  importance_min?: number
  /** Défaut 30, maximum 200. */
  limit?: number
}

export interface IdeaItem {
  id: string
  text: string
  titre: string | null
  genre: Genre
  sous_type: SousType | null
  auteur: Auteur | null
  auteur_source: AuteurSource
  projet: string | null
  importance: number | null
  rubriques: Rubrique[]
  conversation_at: string | null
  amas_size: number
  /** Toujours vrai : seuls des faits actifs sont rendus. */
  validated: true
}

export interface IdeasResult {
  items: IdeaItem[]
  /** Faits en attente de validation, par genre, SANS leur texte. */
  pending_counts: Record<string, number>
}

export interface StylesQuery {
  /** Personne (fiche Person) ; null ou absent = le propriétaire. */
  person_id?: string | null
  active_context?: ActiveContext
  /** Défaut 10. */
  limit?: number
}

export interface StyleItem {
  id: string
  text: string
  titre: string | null
  conversation_at: string | null
}

export interface StylesResult {
  person_id: string | null
  /** Du plus récent au plus ancien : un style garde sa date, on suit son évolution. */
  items: StyleItem[]
}

// ---------------------------------------------------------------- passe sur les messages (hôte)

/** Racines des transcriptions (config `[triage]`), jamais en dur dans le code appelant. */
export interface TriageRoots {
  claudeProjectsDir: string
  codexSessionsDir: string
  codexHistoryFile: string
  archiveDir: string
}

export type UserMessageSourceKind = 'claude-code' | 'chatgpt' | 'codex-history'

export interface StorePendingTriagedInput {
  instance: string
  /** Texte du fait (déjà masqué ; il est re-masqué par sécurité). */
  content: string
  category?: string
  /** Champs de tri proposés ; `auteur_source` vaut `message` par défaut. */
  triage: Partial<Omit<TriageRow, 'fact_id' | 'triaged_at'>>
  /** Provenance : une `memory_sources` de type `user-messages` par clé. */
  source: { key: string; path?: string | null; metadata?: Record<string, unknown> }
  /** Vecteur du texte (modèle de vecteurs configuré), rangé dans `fact_triage_vectors` pour les redites suivantes. */
  vector?: Float32Array
  /** Un jumeau exact expiré reste expiré (passe styles : elle ne réveille jamais un fait). Défaut : il est réveillé. */
  noRevive?: boolean
}

export interface StorePendingTriagedResult {
  fact_id: string
  /** false : un fait identique existait déjà (rien n'est activé ni réécrit ; expiré, il est réveillé, sauf `noRevive`). */
  created: boolean
}

export interface SemanticDuplicate {
  fact_id: string
  score: number
  kind: 'exact' | 'meaning'
}

export interface SemanticDuplicateOptions {
  /**
   * Seuls comptent les faits dont la ligne de tri porte ce person_id (null :
   * aucune ligne, ou fait du propriétaire) ; les autres sont sautés et la
   * recherche continue. Absent : aucun filtre.
   */
  personId?: string | null
}

/**
 * Ce que le moteur prête à la passe sur les messages. Tout passe par ici :
 * le module n'ouvre aucune base, n'appelle aucun fournisseur directement.
 */
export interface TriageHost {
  readonly roots: TriageRoots
  /** Contexte du propriétaire (réglages locaux du registre, jamais le dépôt). */
  readonly owner: { display_name: string | null; context: string | null }
  /** Masque les secrets (valeur au coffre, référence dans le texte). */
  redact(text: string): { text: string; secrets: number }
  /** Filtre sensible local (paie, impôts, santé, mots de passe…). */
  isSensitive(text: string): boolean
  /**
   * Appel LLM d'extraction, compté dans la dépense du passage. Le plafond est
   * vérifié AVANT l'appel au pire cas (TriageBudgetError, rien n'est envoyé).
   */
  complete(opts: CompleteOptions): Promise<CompletionResult>
  /** Vecteurs de textes déjà masqués et non sensibles (comptés aussi). */
  embed(texts: string[]): Promise<Float32Array[]>
  /** Coût estimé d'un appel (USD), pour un dry-run. null si prix inconnu. */
  estimateCost(inputChars: number, outputTokens: number): number | null
  /** Doublon dans les bases de l'instance (exact, ou par le sens ≥ 0,92 avec garde chiffres), filtré par personne si demandé. */
  findSemanticDuplicate(instanceId: string, text: string, vector?: Float32Array, opts?: SemanticDuplicateOptions): SemanticDuplicate | null
  /** Écrit un fait EN ATTENTE (dormant) + sa ligne de tri, dans une seule transaction. */
  storePendingTriaged(input: StorePendingTriagedInput): StorePendingTriagedResult
  /** Instance d'origine d'une source de messages, ou null. */
  resolveInstanceForSource(source: { kind: UserMessageSourceKind; path?: string }): string | null
  /** État par message (migration 81), dans la base de l'instance. */
  messageDone(instanceId: string, msgKey: string): boolean
  markMessage(
    instanceId: string,
    msgKey: string,
    info: { source_key: string; ts: string | null; status: 'done' | 'sensitive' | 'skipped' | 'failed'; facts: number },
  ): void
  /** Non null : la passe doit s'arrêter maintenant (pause, annulation, plafond, fermeture). */
  shouldStop(): TriageStopReason | null
  /** Dépense du passage en cours (USD). */
  spentUsd(): number
}

export interface UserMessagesPassOptions {
  dryRun?: boolean
  budgetUsd?: number
  sources?: UserMessageSourceKind[]
  /** Messages postérieurs à cette date ISO seulement. */
  since?: string
  maxMessages?: number
  onProgress?: (progress: UserMessagesProgress) => void
}

export interface UserMessagesProgress {
  sessions_done: number
  sessions_total: number
  messages_sent: number
  facts_created: number
  spent_usd: number
}

export interface UserMessagesReport {
  sessions_read: number
  messages_seen: number
  messages_known: number
  messages_sensitive: number
  messages_sent: number
  facts_created: number
  facts_duplicate: number
  llm_calls: number
  spent_usd: number
  /** Dry-run : coût estimé. */
  estimate_usd: number | null
  stopped: TriageStopReason | null
  errors: string[]
}

export type UserMessagesPassFn = (host: TriageHost, opts: UserMessagesPassOptions) => Promise<UserMessagesReport>

// ---------------------------------------------------------------- passe styles (hôte)

/**
 * `owner` : la manière d'échanger du propriétaire, mois par mois, tirée de ses
 * propres messages. `person` : comment échanger avec une personne (fiche
 * Person), tirée des notes déjà triées qui la citent.
 */
export type StylesPassMode = 'owner' | 'person'

/** État d'une période de la passe styles (table `style_pass_state`, base de l'instance). */
export interface StylesPeriodState {
  /** Messages (owner) ou faits sources (person) retenus au dernier envoi : base de la règle des 50 %. */
  items: number
  last_at: string | null
  /** Période finie au dernier envoi (mois écoulé ; toujours vrai en mode person). */
  closed: boolean
  facts: number
  prompt_version: string
  updated_at: string
}

/** Observation proposée par le LLM, après lecture de sa sortie (avant les gardes du code). */
export interface StyleObservationDraft {
  texte: string
  titre: string | null
  /** Numéros (à partir de 1) des éléments qui l'appuient, distincts et dans le lot. */
  appuis: number[]
}

/** Fait trié candidat du mode person (lu par l'hôte, jamais modifié). */
export interface StyleSourceFact {
  id: string
  text: string
  /** `conversation_at` de la ligne de tri, sinon date de création du fait. */
  at: string
  at_source: ConversationAtSource
  rubriques: Rubrique[]
}

/**
 * Ce que le moteur prête à la passe styles : l'hôte de la passe sur les
 * messages, plus la fiche Person, le parcours des faits triés et l'état par
 * période. Le module n'ouvre toujours aucune base.
 */
export interface StylesHost extends TriageHost {
  /** Fiche Person : nom affiché et alias (identifiants `handle` ou `other`, jamais un numéro ni un e-mail), ou null. */
  person(personId: string): { id: string; display_name: string; aliases: string[] } | null
  /** Noms affichés de toutes les fiches Person (garde « aucun nom de tiers »). */
  personNames(): string[]
  /** Agent d'une instance (claude, codex, gpt…), pour `ia:<agent>`. */
  agentOf(instanceId: string): string
  /**
   * Faits TRIÉS des bases lisibles par l'instance, bornés à ses scopes
   * lisibles (comme le rappel) : genre connu hors `ephemere`, ni faux, ni
   * sensibles (marque ou `sensitivity`), ni oubliés, ni remplacés, ni
   * archivés, ni expirés, ni rattachés à un client (filtre dur du rappel :
   * le style écrit n'a pas de client, il serait lisible partout), ni tirés
   * par la passe styles elle-même ; parcourus par fenêtres de rowid en rendant
   * la main entre deux fenêtres. Seuls ceux dont le texte vérifie `match` sont
   * rendus.
   */
  styleSourceFacts(query: {
    /** L'instance où la passe écrit : seules ses bases et ses scopes lisibles sont parcourus. */
    instance: string
    match: (text: string) => boolean
    /** Arrêt demandé : le parcours s'interrompt à la fenêtre suivante. */
    stop?: () => boolean
  }): Promise<{ facts: StyleSourceFact[]; scanned: number }>
  /**
   * Vrai si ces appels LLM tiennent ENSEMBLE sous le plafond, chacun à son
   * pire cas (même calcul que la réservation faite par `complete` : entrée
   * estimée et corrigée, plus `maxTokens` entiers), en plus de la dépense déjà
   * engagée. Mode person en deux appels : vérifié avant le premier.
   */
  completionsFit(calls: ReadonlyArray<{ inputChars: number; maxTokens: number }>): boolean
  /**
   * Sortie validée d'un appel de la passe styles, gardée en mémoire par le
   * service (perdue au redémarrage) tant que sa période n'est pas écrite :
   * un arrêt, une pause ou un échec sur le second appel ne fait pas repayer
   * le premier. null : rien de gardé.
   */
  styleCallMemo(key: string): StyleObservationDraft[] | null
  /** Garde (ou, avec null, efface) la sortie validée d'un appel. */
  rememberStyleCall(key: string, items: StyleObservationDraft[] | null): void
  stylesState(instanceId: string, stateKey: string): StylesPeriodState | null
  markStyles(
    instanceId: string,
    stateKey: string,
    info: { mode: StylesPassMode; person_id: string | null; period: string; items: number; last_at: string | null; closed: boolean; facts: number },
  ): void
}

export interface StylesPassOptions {
  mode: StylesPassMode
  /** Obligatoire en mode person : une fiche Person du registre. */
  person_id?: string
  dryRun?: boolean
  budgetUsd?: number
  /** Messages (owner) ou faits sources (person) postérieurs à cette date ISO seulement. */
  since?: string
  /** Mode owner : sources de messages (défaut claude-code ; codex-history en option). */
  sources?: Array<Extract<UserMessageSourceKind, 'claude-code' | 'codex-history'>>
  /** Mode person : bases lisibles par cette instance, et instance où écrire (défaut : toutes les bases, l'agent principal de la machine). */
  instance?: string
  /** Refait une période même si elle n'a pas assez changé. */
  force?: boolean
  onProgress?: (progress: StylesProgress) => void
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
  /** Mode owner : sessions de messages. */
  sessions_found: number
  sessions_read: number
  sessions_no_instance: number
  sessions_unreadable: number
  sessions_twin: number
  /** Mode owner : messages humains gardés (non vides, non répétés). */
  messages_seen: number
  messages_undated: number
  messages_before_since: number
  /** Même message (date et texte) déjà vu dans une autre session. */
  messages_repeated: number
  messages_sensitive: number
  /** Mode person : faits parcourus, cités (nom trouvé), écartés (rubrique rh/finance/juridique, sensibles). */
  facts_scanned: number
  sources_matched: number
  sources_excluded_rubrique: number
  sources_sensitive: number
  /** Messages (owner) ou faits (person) envoyés au LLM ; en dry-run : qui le seraient. */
  items_sent: number
  /** Périodes : mois (owner) ou la personne (person). */
  periods_found: number
  /** Mois de moins de STYLE_MONTH_MIN_MESSAGES messages (ignorés). */
  periods_small: number
  /** Déjà traitées et pas assez changées : rien ne repart. */
  periods_known: number
  periods_sent: number
  /** Sortie illisible ou appel en échec : rien d'écrit ni de marqué, reprise au passage suivant. */
  periods_failed: number
  facts_created: number
  facts_duplicate: number
  /** Observations écartées, par raison (appuis, sensible, theme, tiers, surplus, invalide). */
  observations_rejected: Record<string, number>
  secrets_masked: number
  llm_calls: number
  llm_calls_estimate: number
  tokens_in_estimate: number
  spent_usd: number
  /** Dry-run : coût estimé (null si un prix est inconnu). */
  estimate_usd: number | null
  stopped: TriageStopReason | null
  errors: string[]
  /** Plus long blocage de la boucle d'événements pendant la passe (ms). */
  max_block_ms: number | null
}

export type StylesPassFn = (host: StylesHost, opts: StylesPassOptions) => Promise<StylesReport>

// ---------------------------------------------------------------- l'API publique

export interface TriageApi {
  /** Estimation sans aucun appel ni écriture. */
  estimate(opts?: TriageRunOptions): Promise<TriageEstimate>
  /**
   * Lance un passage en arrière-plan : la promesse se résout dès que le
   * passage a démarré (préconditions vérifiées : profil LLM, prix, pause), avec
   * son état. Rejet TriageRefusedError sinon (déjà en cours, pause, pas de LLM,
   * prix inconnu). La place est prise AVANT tout await : deux appels
   * simultanés ne lancent jamais deux passages.
   */
  start(opts?: TriageRunOptions): Promise<TriageRunStatus>
  /** Lance un passage et attend sa fin (CLI locale, tests). */
  run(opts?: TriageRunOptions): Promise<TriageRunStatus>
  /** Demande l'arrêt (passage ou passe sur les messages) entre deux lots. false s'il n'y a rien à arrêter. */
  cancel(): boolean
  /** État du passage en cours ou du dernier (persisté ; `interrupted` s'il est mort avec le processus). */
  status(): TriageRunStatus
  list(filter?: TriageListFilter, page?: { cursor?: TriageCursor | null; limit?: number }): TriageListPage
  stats(filter?: { instance?: string }): TriageStats
  /** Correction à la main (jamais réécrite par un passage, sauf `reclassify`… qui ne touche pas non plus aux lignes corrigées). */
  correct(correction: TriageCorrection): { updated: boolean }
  /** Marque faux (le fait reste dormant, caché par défaut) ou retire la marque. */
  setVerdict(factIds: string[], verdict: TriageVerdict | null): { updated: number }
  /** Valide (→ actif), option partage au scope user. */
  promote(opts: TriagePromoteOptions): TriagePromoteResult
  /** Faits ACTIFS triés lisibles par l'instance (mêmes filtres que le rappel) + compteurs en attente sans texte. */
  ideasForInstance(instanceId: string, filter?: IdeasFilter, activeContext?: ActiveContext): IdeasResult
  /** Styles d'échange VALIDÉS d'une personne, lisibles par l'instance. */
  stylesForInstance(instanceId: string, query?: StylesQuery): StylesResult
  /** Passe sur les messages de l'utilisateur (fonction branchée par registerUserMessagesPass). */
  runUserMessages(opts?: UserMessagesPassOptions): Promise<UserMessagesReport>
  /** Passe styles (fonction branchée par registerStylesPass). Mêmes refus, plus `not-found` (personne inconnue). */
  runStyles(opts: StylesPassOptions): Promise<StylesReport>
}
