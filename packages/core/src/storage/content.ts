/**
 * ContentStore — accès à UNE DB de contenu (privée d'instance ou partagée de scope).
 * Le pool (engine) décide quelles DB ouvrir ; ce module ne connaît qu'un fichier.
 */
import type { Database } from 'better-sqlite3'
import { openDatabase } from './sqlite.js'
import { runMigrations } from './migrations.js'
import { contentMigrations, RECALL_FTS_STATE_KEY } from './content-schema.js'
import { cognitionMigrations } from './cognition-schema.js'
import { topicMigrations } from '../cognition/topics.js'
import { patternMigrations } from '../cognition/patterns.js'
import { proceduralMigrations } from '../cognition/procedural.js'
import { feedbackMigrations } from '../cognition/feedback.js'
import { clusterMigrations } from '../cognition/clusters.js'
import { selfObservationMigrations } from '../cognition/self-observation.js'
import { revisionMigrations } from '../cognition/revision.js'
import { triageMigrations } from '../triage/schema.js'
import { loadVecExtension, purgeFactVectors } from '../vector/vec-table.js'
import { factNormHash, fromJsonArray, newId, nowISO, toJson } from '../util.js'
import type { Fact, LifecycleState, Sensitivity, Visibility, WalEntry } from '../types.js'

export interface FactRow {
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
  tags: string
  entity_ids: string
  lifecycle_state: LifecycleState
  superseded: number
  superseded_by: string | null
  /** Épinglé par l'utilisateur : jamais atténué, prioritaire au recall. */
  pinned?: number
  /** Date d'expiration ISO : au-delà, le fait n'est plus rappelé (jamais supprimé). */
  expires_at?: string | null
  usefulness: number
  recall_count: number
  used_count: number
  relevance_weight: number
  created_at: string
  updated_at: string
  last_accessed_at: string | null
  /** Provenance & LWW pour la synchro inter-machines (colonnes v2 ; optionnelles côté types pour les fixtures). */
  origin_machine_id?: string | null
  origin_rev?: number
  content_hash?: string | null
  deleted_at?: string | null
}

export interface InsertFactInput {
  id?: string
  fact: string
  category?: string
  fact_type?: string
  confidence?: number
  source?: string
  assistant_instance_id?: string | null
  user_id?: string | null
  org_id?: string | null
  client_org_id?: string | null
  project_id?: string | null
  topic_id?: string | null
  scope_id: string
  sensitivity?: Sensitivity
  visibility?: Visibility
  tags?: string[]
  entity_ids?: string[]
  /** 'dormant' = en attente de revue (review-first) — exclu du recall par défaut. */
  lifecycle_state?: LifecycleState
  /** Provenance synchro (posée par l'engine pour les scopes partagés). */
  origin_machine_id?: string | null
  origin_rev?: number
  content_hash?: string | null
}

export interface FtsSearchOptions {
  limit?: number
  includeDormant?: boolean
  /** Sensibilité maximale autorisée pour le lecteur. */
  maxSensitivity?: Sensitivity
  scopeIds?: string[]
}

export interface ContentStoreOptions {
  /**
   * Remplissage de l'index de rappel : faits par tranche, budget à l'ouverture
   * (0 = une seule tranche). Défauts de production ; les tests les réduisent
   * pour observer un remplissage inachevé.
   */
  recallIndex?: { chunk?: number; openBudgetMs?: number }
}

export interface FtsHit {
  row: FactRow
  /** Pertinence FTS positive (plus haut = meilleur). */
  relevance: number
  /**
   * Branche qui a trouvé le fait. Absent = texte (recherche FTS seule) ; la
   * recherche hybride précise 'meaning' (vecteurs seuls) ou 'both'. Sert au
   * rappel à dire POURQUOI un souvenir est sorti.
   */
  via?: 'text' | 'meaning' | 'both'
}

const SENSITIVITY_ORDER: Record<Sensitivity, number> = { normal: 0, sensitive: 1, critical: 2 }

/**
 * Remplissage de `facts_recall_fts` (migration 100) : faits par tranche, et
 * budget de temps par appel. Les 1 288 actifs de la plus grosse base réelle se
 * remplissent en 6 à 34 ms (cache chaud / copie fraîche) ; le découpage ne sert
 * qu'aux bases à beaucoup d'actifs, pour que le boot ne fige pas la boucle
 * (règle n°27). Le rappel, lui, n'écrit jamais : il lit l'indicateur.
 */
const RECALL_FTS_CHUNK = 500
/** Budget à l'ouverture de la base (boot), et de chaque reprise de fond du moteur. */
export const RECALL_FTS_OPEN_BUDGET_MS = 40

/**
 * Un token est-il un MOT de contenu (utile en thème/recall) ? Rejette les
 * nombres purs, les hex courts et les jetons à >40 % de chiffres (audit QW3 :
 * « 20b 255 analyse » ne doit pas devenir un libellé de thème). Garde en
 * revanche les identifiants courts à casse mixte ou avec chiffre (X, v2, S3, k8s).
 */
export function isContentWord(token: string): boolean {
  if (token.length < 2) return false
  if (/^\d+$/.test(token)) return false // nombre pur
  if (/^[0-9a-f]{1,8}$/i.test(token) && /\d/.test(token)) return false // hex court
  const digits = (token.match(/\d/g) ?? []).length
  if (digits / token.length > 0.4) return false // majoritairement numérique
  return true
}

/**
 * Tokens significatifs d'une requête. Garde les ≥3 caractères ET les tokens
 * courts discriminants (chiffre ou casse mixte : « X », « v2 », « S3 ») pour ne
 * pas confondre « projet X » et « projet Y » (audit QW5).
 */
export function queryTokens(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(t => t.trim())
    // garder ≥3 car., OU court avec chiffre/majuscule (identifiant : X, v2, S3)
    .filter(t => t.length > 2 || /[0-9A-Z]/.test(t))
    .map(t => normalizeText(t))
    .filter(t => t.length > 0)
}

/** Échappe une requête utilisateur en expression FTS5 sûre (tokens cités, OR). */
export function toFtsQuery(query: string): string | null {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return null
  return tokens.map(t => `"${t.replaceAll('"', '')}"`).join(' OR ')
}

/** Normalisation commune requête/texte (minuscules + sans diacritiques, aligné sur unicode61). */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
}

export class ContentStore {
  readonly db: Database
  readonly path: string
  readonly journalMode: string
  readonly onNetworkVolume: boolean
  /** `facts_recall_fts` complet : le rappel peut s'y fier (jamais remis à false). */
  private recallIndexReady = false
  private readonly recallIndexChunk: number

  constructor(path: string, opts: ContentStoreOptions = {}) {
    this.recallIndexChunk = Math.max(1, opts.recallIndex?.chunk ?? RECALL_FTS_CHUNK)
    const opened = openDatabase(path)
    this.db = opened.db
    this.path = path
    this.journalMode = opened.journalMode
    this.onNetworkVolume = opened.onNetworkVolume
    // Tronc + cognition (≥10) + topics (20-29) + patterns (30-39), sans
    // collision : toute DB de contenu a le schéma cognitif complet d'office.
    runMigrations(this.db, [
      ...contentMigrations,
      ...cognitionMigrations,
      ...topicMigrations,
      ...patternMigrations,
      ...proceduralMigrations,
      ...feedbackMigrations,
      ...clusterMigrations,
      ...selfObservationMigrations,
      ...revisionMigrations,
      ...triageMigrations,
    ])
    // Première tranche du remplissage de l'index de rappel, bornée en temps :
    // les bases réelles (≤ 2 000 actifs) sont prêtes dès l'ouverture. Un échec
    // ne bloque pas l'ouverture : le rappel garde alors l'ancien chemin.
    try {
      this.advanceRecallIndex(opts.recallIndex?.openBudgetMs ?? RECALL_FTS_OPEN_BUDGET_MS)
    } catch (err) {
      console.warn('[memoria] index de rappel : remplissage différé :', (err as Error).message)
    }
  }

  /** L'index des faits rappelables est-il complet ? (lecture de l'état en cache) */
  isRecallIndexReady(): boolean {
    return this.recallIndexReady
  }

  /**
   * Fait avancer le remplissage de `facts_recall_fts` par tranches de
   * RECALL_FTS_CHUNK faits actifs (ordre des rowid, curseur dans `meta`),
   * jusqu'à la fin ou jusqu'à épuisement du budget. Retourne true quand
   * l'index est complet. Chaque tranche est une transaction : le curseur et
   * les lignes avancent ensemble, et une autre connexion (CLI) peut reprendre.
   *
   * Pourquoi c'est juste pendant le remplissage : les déclencheurs (migration
   * 100) maintiennent TOUTE ligne qui devient ou reste rappelable, qu'elle soit
   * avant ou après le curseur, et ne suppriment que ce qui est indexé. Une
   * tranche saute donc les faits déjà indexés par un déclencheur. Quand la
   * dernière tranche ne trouve plus d'actif après le curseur, tout actif a été
   * indexé par une tranche ou par un déclencheur : l'état passe à 'ready'.
   */
  advanceRecallIndex(budgetMs: number): boolean {
    if (this.recallIndexReady) return true
    // Dans une transaction englobante, un retour arrière effacerait la tranche
    // (et l'état 'ready') alors que l'indicateur en mémoire resterait levé : le
    // rappel se fierait à un index incomplet jusqu'au redémarrage. On attend.
    if (this.db.inTransaction) return false
    const getState = this.db.prepare('SELECT value FROM meta WHERE key = ?')
    const setState = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    const nextIds = this.db.prepare(
      `SELECT rowid AS r FROM facts WHERE lifecycle_state = 'active' AND superseded = 0 AND rowid > ? ORDER BY rowid LIMIT ?`,
    )
    const fill = this.db.prepare(
      `INSERT INTO facts_recall_fts(rowid, fact, category, tags)
       SELECT rowid, fact, category, tags FROM facts
       WHERE lifecycle_state = 'active' AND superseded = 0 AND rowid > ? AND rowid <= ?
         AND NOT EXISTS (SELECT 1 FROM facts_recall_fts_docsize d WHERE d.id = facts.rowid)`,
    )
    const step = this.db.transaction((): boolean => {
      const state = (getState.get(RECALL_FTS_STATE_KEY) as { value: string } | undefined)?.value
      if (state === 'ready') return true
      const parsed = Number(state ?? 0)
      const cursor = Number.isFinite(parsed) ? parsed : 0
      const ids = nextIds.all(cursor, this.recallIndexChunk) as Array<{ r: number }>
      if (ids.length === 0) {
        setState.run(RECALL_FTS_STATE_KEY, 'ready')
        return true
      }
      const last = ids[ids.length - 1]!.r
      fill.run(cursor, last)
      setState.run(RECALL_FTS_STATE_KEY, String(last))
      return false
    })
    const deadline = performance.now() + budgetMs
    do {
      if (step()) {
        this.recallIndexReady = true
        return true
      }
    } while (performance.now() < deadline)
    return false
  }

  insertFact(input: InsertFactInput): Fact {
    const ts = nowISO()
    const row: FactRow = {
      id: input.id ?? newId(),
      fact: input.fact,
      category: input.category ?? 'general',
      fact_type: input.fact_type ?? 'statement',
      confidence: input.confidence ?? 0.8,
      source: input.source ?? 'manual',
      assistant_instance_id: input.assistant_instance_id ?? null,
      user_id: input.user_id ?? null,
      org_id: input.org_id ?? null,
      client_org_id: input.client_org_id ?? null,
      project_id: input.project_id ?? null,
      topic_id: input.topic_id ?? null,
      scope_id: input.scope_id,
      sensitivity: input.sensitivity ?? 'normal',
      visibility: input.visibility ?? 'private',
      tags: toJson(input.tags ?? []),
      entity_ids: toJson(input.entity_ids ?? []),
      lifecycle_state: input.lifecycle_state ?? 'active',
      superseded: 0,
      superseded_by: null,
      usefulness: 0,
      recall_count: 0,
      used_count: 0,
      relevance_weight: 1.0,
      created_at: ts,
      updated_at: ts,
      last_accessed_at: null,
      origin_machine_id: input.origin_machine_id ?? null,
      origin_rev: input.origin_rev ?? 0,
      content_hash: input.content_hash ?? null,
      deleted_at: null,
    }
    this.db
      .prepare(
        `INSERT INTO facts (
          id, fact, category, fact_type, confidence, source,
          assistant_instance_id, user_id, org_id, client_org_id, project_id, topic_id, scope_id,
          sensitivity, visibility, tags, entity_ids,
          lifecycle_state, superseded, superseded_by,
          usefulness, recall_count, used_count, relevance_weight,
          created_at, updated_at, last_accessed_at,
          origin_machine_id, origin_rev, content_hash, deleted_at, norm_hash
        ) VALUES (
          @id, @fact, @category, @fact_type, @confidence, @source,
          @assistant_instance_id, @user_id, @org_id, @client_org_id, @project_id, @topic_id, @scope_id,
          @sensitivity, @visibility, @tags, @entity_ids,
          @lifecycle_state, @superseded, @superseded_by,
          @usefulness, @recall_count, @used_count, @relevance_weight,
          @created_at, @updated_at, @last_accessed_at,
          @origin_machine_id, @origin_rev, @content_hash, @deleted_at, @norm_hash
        )`,
      )
      .run({ ...row, norm_hash: factNormHash(row.fact) })
    return rowToFact(row)
  }

  getFact(id: string): Fact | null {
    const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as FactRow | undefined
    return row ? rowToFact(row) : null
  }

  // ----------------------------------------------------------- synchro (SyncStore)

  /** Champs nécessaires au LWW d'un fait local (provenance). */
  getMergeFields(id: string): { id: string; origin_rev: number; updated_at: string; origin_machine_id: string | null } | undefined {
    const r = this.db.prepare('SELECT id, origin_rev, updated_at, origin_machine_id FROM facts WHERE id = ?').get(id) as
      | { id: string; origin_rev: number | null; updated_at: string; origin_machine_id: string | null }
      | undefined
    if (!r) return undefined
    return { id: r.id, origin_rev: r.origin_rev ?? 0, updated_at: r.updated_at, origin_machine_id: r.origin_machine_id }
  }

  /** Premier fait actif partageant ce hash de contenu (dédup inter-machines). */
  findIdByContentHash(hash: string): string | null {
    const r = this.db.prepare('SELECT id FROM facts WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1').get(hash) as { id: string } | undefined
    return r?.id ?? null
  }

  /**
   * Insère ou met à jour un fait reçu par synchro. La TÉLÉMÉTRIE LOCALE
   * (recall_count, used_count, usefulness, relevance_weight, last_accessed_at)
   * n'est JAMAIS écrasée — elle reste propre à chaque machine (SYNC §3.3 #4).
   */
  upsertSyncedFact(f: {
    id: string; fact: string; category: string; fact_type: string; confidence: number; source: string
    scope_id: string; sensitivity: string; visibility: string; tags: string; entity_ids: string
    lifecycle_state: string; superseded: number; superseded_by: string | null
    origin_machine_id: string | null; origin_rev: number; content_hash: string | null; deleted_at: string | null
    created_at: string; updated_at: string
    /** Expiration transportée (absente chez un pair d'avant : alors aucune). */
    expires_at?: string | null
  }): void {
    const exists = this.db.prepare('SELECT 1 FROM facts WHERE id = ?').get(f.id)
    // norm_hash est LOCAL (index de dédup) : recalculé ici, jamais synchronisé.
    // expires_at : toujours présent dans les paramètres (better-sqlite3 refuse
    // un paramètre nommé manquant, et un pair d'avant ne l'envoie pas).
    const params = { ...f, expires_at: f.expires_at ?? null, norm_hash: factNormHash(f.fact) }
    if (exists) {
      const update = this.db.prepare(
          `UPDATE facts SET fact=@fact, category=@category, fact_type=@fact_type, confidence=@confidence, source=@source,
             scope_id=@scope_id, sensitivity=@sensitivity, visibility=@visibility, tags=@tags, entity_ids=@entity_ids,
             lifecycle_state=@lifecycle_state, superseded=@superseded, superseded_by=@superseded_by,
             origin_machine_id=@origin_machine_id, origin_rev=@origin_rev, content_hash=@content_hash,
             deleted_at=@deleted_at, expires_at=@expires_at, updated_at=@updated_at, norm_hash=@norm_hash WHERE id=@id`,
      )
      // Le trigger facts_norm_hash_reset remet le hash à NULL quand le texte
      // change et que le hash reste le même : il ne distingue pas « hash
      // oublié » de « hash reposé à la même valeur », ce qui arrive quand la
      // synchro ne retouche que la ponctuation ou la casse. On le repose donc
      // dans la même transaction ; ce second UPDATE ne touche pas la colonne
      // `fact`, le trigger ne se déclenche pas.
      const restoreHash = this.db.prepare('UPDATE facts SET norm_hash = ? WHERE id = ? AND norm_hash IS NULL')
      this.db.transaction(() => {
        update.run(params)
        restoreHash.run(params.norm_hash, f.id)
      })()
    } else {
      this.db
        .prepare(
          `INSERT INTO facts (
            id, fact, category, fact_type, confidence, source,
            assistant_instance_id, user_id, org_id, client_org_id, project_id, topic_id, scope_id,
            sensitivity, visibility, tags, entity_ids,
            lifecycle_state, superseded, superseded_by,
            usefulness, recall_count, used_count, relevance_weight,
            created_at, updated_at, last_accessed_at,
            origin_machine_id, origin_rev, content_hash, deleted_at, expires_at, norm_hash
          ) VALUES (
            @id, @fact, @category, @fact_type, @confidence, @source,
            NULL, NULL, NULL, NULL, NULL, NULL, @scope_id,
            @sensitivity, @visibility, @tags, @entity_ids,
            @lifecycle_state, @superseded, @superseded_by,
            0, 0, 0, 1.0,
            @created_at, @updated_at, NULL,
            @origin_machine_id, @origin_rev, @content_hash, @deleted_at, @expires_at, @norm_hash
          )`,
        )
        .run(params)
    }
  }

  /** Suppression propagée = tombstone (jamais de DELETE dur, sinon résurrection). */
  applyTombstone(t: { id: string; deleted_at: string; origin_machine_id: string | null; origin_rev: number; updated_at: string }): boolean {
    const exists = this.db.prepare('SELECT 1 FROM facts WHERE id = ?').get(t.id)
    if (!exists) return false
    this.db
      .prepare(
        `UPDATE facts SET deleted_at=@deleted_at, lifecycle_state='archived', superseded=1,
           origin_machine_id=@origin_machine_id, origin_rev=@origin_rev, updated_at=@updated_at WHERE id=@id`,
      )
      .run(t)
    return true
  }

  countFacts(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM facts').get() as { c: number }
    return r.c
  }

  /**
   * Recherche FTS avec PRÉ-FILTRE permissions dans le SQL (filtre DUR, spec §6.1) :
   * lifecycle / superseded / sensibilité / scopes autorisés.
   *
   * Sans `includeDormant` (le rappel des agents), le MATCH porte sur
   * `facts_recall_fts`, qui ne contient QUE les faits actifs et non supersédés :
   * les faits en attente ne sont plus parcourus puis jetés (règle n°27). Le
   * WHERE garde toutes ses conditions : l'ensemble rendu est le même, filtré
   * avant LIMIT comme avant. Seul bm25 change d'assiette (fréquences calculées
   * sur les faits rappelables), ce qui peut réordonner des faits voisins.
   * Tant que l'index n'est pas complet, l'ancien chemin (`facts_fts`) sert.
   * Aucune écriture ici (pas de tranche de remplissage) : un rappel ne doit
   * jamais attendre le verrou d'écriture d'un autre processus.
   */
  searchFacts(query: string, opts: FtsSearchOptions = {}): FtsHit[] {
    const match = toFtsQuery(query)
    if (!match) return []
    const limit = opts.limit ?? 50
    const maxSens = SENSITIVITY_ORDER[opts.maxSensitivity ?? 'normal']
    const lifecycleStates = opts.includeDormant ? ['active', 'dormant'] : ['active']
    const fts = !opts.includeDormant && this.recallIndexReady ? 'facts_recall_fts' : 'facts_fts'

    const conditions: string[] = [
      `f.superseded = 0`,
      `f.lifecycle_state IN (${lifecycleStates.map(() => '?').join(',')})`,
      `(CASE f.sensitivity WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 ELSE 2 END) <= ?`,
    ]
    const params: unknown[] = [...lifecycleStates, maxSens]

    if (opts.scopeIds && opts.scopeIds.length > 0) {
      conditions.push(`f.scope_id IN (${opts.scopeIds.map(() => '?').join(',')})`)
      params.push(...opts.scopeIds)
    }

    const sql = `
      SELECT f.*, -bm25(${fts}) AS fts_relevance
      FROM ${fts}
      JOIN facts f ON f.rowid = ${fts}.rowid
      WHERE ${fts} MATCH ?
        AND ${conditions.join(' AND ')}
      ORDER BY fts_relevance DESC
      LIMIT ?
    `
    const rows = this.db.prepare(sql).all(match, ...params, limit) as Array<FactRow & { fts_relevance: number }>

    // Pertinence COMPARABLE INTER-DB (le fan-out fusionne plusieurs DB dont
    // les stats bm25 divergent) : couverture de requête en facteur dominant,
    // bm25 normalisé localement comme simple départage.
    const tokens = queryTokens(query)
    const maxBm25 = Math.max(...rows.map(r => Math.max(0, r.fts_relevance)), 1e-9)
    return rows.map(r => {
      const text = normalizeText(r.fact)
      const matched = tokens.filter(t => text.includes(t)).length
      const coverage = tokens.length > 0 ? matched / tokens.length : 0
      const bm25Norm = Math.max(0, r.fts_relevance) / maxBm25
      return { row: r, relevance: coverage * (0.3 + 0.7 * bm25Norm) }
    })
  }

  /** Marque l'usage en recall (compteurs + dernier accès). */
  touchFacts(ids: string[]): void {
    if (ids.length === 0) return
    const ts = nowISO()
    const stmt = this.db.prepare(
      'UPDATE facts SET recall_count = recall_count + 1, last_accessed_at = ? WHERE id = ?',
    )
    const tx = this.db.transaction((all: string[]) => {
      for (const id of all) stmt.run(ts, id)
    })
    tx(ids)
  }

  /**
   * HARD-DELETE (spec §11) : efface le fait ET toutes ses traces locales —
   * FTS (par trigger), embeddings, fact_topics, projection, WAL non traité.
   * Retourne le nombre de faits effacés.
   */
  hardDeleteFacts(ids: string[]): number {
    if (ids.length === 0) return 0
    const del = this.db.transaction((all: string[]) => {
      let n = 0
      const placeholders = all.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM embeddings WHERE owner_type = 'fact' AND owner_id IN (${placeholders})`).run(...all)
      this.db.prepare(`DELETE FROM fact_topics WHERE fact_id IN (${placeholders})`).run(...all)
      this.db.prepare(`DELETE FROM memory_projection WHERE fact_id IN (${placeholders})`).run(...all)
      // Carte des souvenirs (migration 8) : la table n'a ni clé étrangère ni
      // trigger, donc la position d'un fait effacé restait sur disque jusqu'au
      // prochain recalcul complet (et pour toujours sous un ancien modèle).
      this.db.prepare(`DELETE FROM fact_projection WHERE fact_id IN (${placeholders})`).run(...all)
      // Index vectoriels : legacy `vec_index_<dims>` ET nommés `vec_index_<dims>_<modèle>`
      // (depuis 27/08). Le filtre `/^vec_index_\d+$/` d'avant ignorait les index
      // nommés → le vecteur d'un fait effacé (oubli, rejet de revue, partage)
      // restait dans le KNN : « aucune trace » (spec §11) n'était plus tenu.
      // purgeFactVectors énumère les vraies tables vec0 (pas leurs shadow tables)
      // et charge l'extension dans CETTE connexion si besoin.
      if (loadVecExtension(this.db)) purgeFactVectors(this.db, all)
      const r = this.db.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...all)
      n = r.changes
      return n
    })
    return del(ids)
  }

  // --- WAL (spec §6.2) — la logique replay/retry vit dans engine/wal.ts ---

  walAppend(instanceId: string, role: WalEntry['role'], content: string): number {
    const r = this.db
      .prepare('INSERT INTO wal_buffer (ts, assistant_instance_id, role, content) VALUES (?, ?, ?, ?)')
      .run(nowISO(), instanceId, role, content)
    return Number(r.lastInsertRowid)
  }

  walPending(limit = 100): WalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM wal_buffer WHERE processed = 0 ORDER BY id LIMIT ?')
      .all(limit) as Array<Omit<WalEntry, 'processed'> & { processed: number }>
    return rows.map(r => ({ ...r, processed: r.processed === 1 }))
  }

  walMarkProcessed(ids: number[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE wal_buffer SET processed = 1 WHERE id IN (${placeholders})`).run(...ids)
  }

  walRecordAttempt(id: number): void {
    this.db.prepare('UPDATE wal_buffer SET attempts = attempts + 1 WHERE id = ?').run(id)
  }

  /** Cleanup BORNÉ (anti table illimitée du legacy) : purge le traité au-delà de maxRows/maxAgeDays. */
  walCleanup(maxRows = 5000, maxAgeDays = 14): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
    const r1 = this.db.prepare('DELETE FROM wal_buffer WHERE processed = 1 AND ts < ?').run(cutoff)
    const r2 = this.db
      .prepare(
        `DELETE FROM wal_buffer WHERE processed = 1 AND id NOT IN (
           SELECT id FROM wal_buffer WHERE processed = 1 ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(maxRows)
    return r1.changes + r2.changes
  }

  walPendingCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM wal_buffer WHERE processed = 0').get() as { c: number }
    return r.c
  }

  /** Modèles d'embedding déjà stockés (`SELECT DISTINCT model FROM embeddings`). */
  listEmbeddingModels(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT model FROM embeddings ORDER BY model').all() as Array<{
      model: string
    }>
    return rows.map(r => r.model)
  }

  close(): void {
    this.db.close()
  }
}

export function rowToFact(row: FactRow): Fact {
  return {
    ...row,
    tags: fromJsonArray(row.tags),
    entity_ids: fromJsonArray(row.entity_ids),
    superseded: row.superseded === 1,
  }
}
