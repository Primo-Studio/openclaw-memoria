/**
 * CognitionEngine — couches cognitives bucket B (async, spec §12).
 *
 * Tourne EN ASYNC, hors du chemin de réponse du recall : l'intégrateur appelle
 * `processFact(factId)` après capture (fire-and-forget, comme indexEmbeddings)
 * et `expandEntities(...)` au recall (SQL pur, 0 LLM).
 *
 * Responsabilités :
 *  - processFact : extrait entités+relations+observations d'UN fait ; idempotent
 *    (re-process ne duplique ni entité ni relation) ;
 *  - expandEntities : à partir de faits germes, propose des faits LIÉS par
 *    entités partagées, STRICTEMENT bornés aux scopes autorisés (anti-fuite) ;
 *  - decay : affaiblit/élague les arêtes (job quotidien daemon).
 *
 * Le LLM est OPTIONNEL : sans provider (ou indisponible), l'extraction d'entités
 * retombe sur l'heuristique FR/EN — le graphe se peuple quand même.
 */
import type { Database } from 'better-sqlite3'
import type { ContentStore } from '../storage/content.js'
import { isSensitiveContentError, type LlmProvider } from '../llm/provider.js'
import { ensureCognitionSchema } from '../storage/cognition-schema.js'
import {
  heuristicEntities,
  llmExtract,
  upsertEntity,
  type Extraction,
} from './entities.js'
import {
  applyDecay,
  expandByEntities,
  graphStats,
  linkFactEntity,
  onFactSuperseded,
  reinforceCooccurrence,
  upsertRelation,
  type DecayConfig,
  type GraphStats,
} from './graph.js'
import {
  observationStats,
  upsertObservation,
  type ObservationStats,
} from './observations.js'

export interface CognitionEngineOptions {
  store: ContentStore
  /** LLM d'extraction graphe (optionnel). null/absent → heuristique pure. */
  llm?: LlmProvider | null
}

export interface ProcessFactResult {
  fact_id: string
  entities: number
  relations: number
  observation_created: boolean
  /** false si le fait n'existe pas / est vide (no-op annoncé). */
  processed: boolean
  /** 'llm' si l'extraction a utilisé le LLM, 'heuristic' sinon. */
  via: 'llm' | 'heuristic'
  /** Mode `llmOnly` : l'extraction LLM a échoué et RIEN n'a été écrit (processed = false). */
  llm_failed?: boolean
  /**
   * Texte sensible refusé par la garde (`llm.sensitive_gate`) : rien n'est
   * parti. Hors `llmOnly`, le fait est traité en heuristique (local) ; en
   * `llmOnly`, rien n'est écrit. Ni une panne ni un échec : l'appelant ne le
   * repropose plus au LLM.
   */
  sensitive?: boolean
}

/**
 * Extractions LLM ratées au-delà desquelles un fait ne repart plus au LLM, ni
 * au passage ordinaire ni au rattrapage (compteur `fact_cognition.llm_failures`).
 * Sans borne, un fait dont l'extraction échoue toujours repartait au LLM à
 * chaque redémarrage, et trois tels faits en tête de liste arrêtaient chaque
 * rattrapage avant les autres.
 */
export const LLM_EXTRACTION_MAX_FAILURES = 3

export interface ExpandResult {
  fact_id: string
  score: number
  hops: number
  /** Nom de l'entité partagée qui explique le lien (voir expandByEntities). */
  via_entity?: string
}

export class CognitionEngine {
  private readonly store: ContentStore
  private llm: LlmProvider | null

  constructor(opts: CognitionEngineOptions) {
    this.store = opts.store
    this.llm = opts.llm ?? null
    // Schéma cognition appliqué paresseusement (idempotent) : la cognition est
    // utilisable même avant que l'intégrateur ne câble les migrations au tronc.
    ensureCognitionSchema(this.store.db)
  }

  get db(): Database {
    return this.store.db
  }

  /** Un LLM d'extraction graphe est-il branché ? */
  get hasLlm(): boolean {
    return this.llm !== null
  }

  /**
   * Branche (ou remplace) le LLM après coup. Le moteur est mis en cache PAR
   * STORE côté Memoria : sans ceci, un premier appel de lecture (llm=null)
   * condamnait le store à l'heuristique pour toute la vie du processus.
   */
  setLlm(llm: LlmProvider | null): void {
    this.llm = llm
  }

  /**
   * Peuple entités/relations/observation pour UN fait (async, post-capture).
   * IDEMPOTENT : entités dédupliquées par nom (NOCASE), liens fact↔entité par PK
   * composite, observation upsert par sujet → re-process ne duplique rien.
   * Erreur LLM = NON avalée : log + bascule heuristique (jamais de mort
   * silencieuse — règle V3, le pattern qui a tué Hebbian).
   *
   * `llmOnly` : pas de bascule. Si le LLM ne rend rien, le fait est laissé tel
   * quel (ni entité, ni observation, ni marqueur) et `llm_failed` le dit. Sert
   * au rattrapage LLM et aux nouveaux essais d'un fait déjà vu en heuristique :
   * écrire l'heuristique faisait sortir le fait de la sélection du rattrapage
   * (qui exige « sans entité »), ou réempilait les mêmes entités à chaque essai.
   *
   * Un fait `critical` n'est jamais traité : son texte partirait au LLM, et ses
   * entités le relieraient aux autres.
   */
  async processFact(factId: string, opts: { llmOnly?: boolean } = {}): Promise<ProcessFactResult> {
    const empty: ProcessFactResult = {
      fact_id: factId,
      entities: 0,
      relations: 0,
      observation_created: false,
      processed: false,
      via: 'heuristic',
    }
    const fact = this.store.getFact(factId)
    if (!fact || !fact.fact.trim() || fact.sensitivity === 'critical') return empty

    // 1. Extraction — LLM si dispo, sinon heuristique (jamais silencieux).
    let extraction: Extraction
    let via: 'llm' | 'heuristic' = 'heuristic'
    let sensitive = false
    if (this.llm) {
      try {
        const result = await llmExtract(this.llm, fact.fact)
        if (result) {
          extraction = result
          via = 'llm'
        } else if (opts.llmOnly) {
          return { ...empty, llm_failed: true }
        } else {
          extraction = { entities: heuristicEntities(fact.fact), relations: [] }
        }
      } catch (err) {
        if (isSensitiveContentError(err)) {
          // Garde sensible : le texte n'est pas parti. En llmOnly rien n'est
          // écrit (les entités d'un essai précédent ne s'empilent pas) ;
          // sinon l'heuristique, locale, relie le fait comme sans LLM.
          if (opts.llmOnly) return { ...empty, sensitive: true }
          sensitive = true
        } else if (opts.llmOnly) {
          console.warn(`[memoria] extraction graphe LLM en échec (fait ${factId}), fait laissé intact :`, (err as Error).message)
          return { ...empty, llm_failed: true }
        } else {
          console.warn(`[memoria] extraction graphe LLM en échec (fait ${factId}) — heuristique :`, (err as Error).message)
        }
        extraction = { entities: heuristicEntities(fact.fact), relations: [] }
      }
    } else if (opts.llmOnly) {
      return { ...empty, llm_failed: true }
    } else {
      extraction = { entities: heuristicEntities(fact.fact), relations: [] }
    }

    // 2. Persistance graphe (transaction → cohérence + idempotence).
    let entityCount = 0
    let relationCount = 0
    const persist = this.db.transaction(() => {
      // Nom normalisé → id d'entité (upsert dédupliqué).
      const nameToId = new Map<string, string>()
      for (const e of extraction.entities) {
        const id = upsertEntity(this.db, e.name, e.type)
        nameToId.set(e.name.toLowerCase(), id)
        linkFactEntity(this.db, factId, id)
        entityCount++
      }
      // Relations typées explicites (LLM) — bornées aux entités connues.
      for (const r of extraction.relations) {
        const fromId = nameToId.get(r.from.toLowerCase())
        const toId = nameToId.get(r.to.toLowerCase())
        if (!fromId || !toId || fromId === toId) continue
        upsertRelation(this.db, fromId, toId, r.type, factId)
        relationCount++
      }
      // Renforcement de co-occurrence (GE-1) : toutes les paires d'entités du
      // fait. Les arêtes sont non-dirigées + dédupliquées → re-process ne crée
      // pas de doublon, il renforce (poids croissant cap 1.0).
      reinforceCooccurrence(this.db, [...nameToId.values()], factId)
    })
    persist()

    // 3. Observation agrégée par catégorie+sujet (upsert idempotent).
    const subject = observationSubject(fact.category, fact.fact)
    const obs = upsertObservation(this.db, {
      subject,
      content: fact.fact,
      confidence: fact.confidence,
    })

    // 4. Marqueur « traité » — y compris quand rien n'a été trouvé : c'est
    // précisément ce cas qui repartait au LLM à chaque capture.
    this.db
      .prepare('INSERT OR REPLACE INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, ?, ?, ?)')
      .run(factId, new Date().toISOString(), via, entityCount)

    return {
      fact_id: factId,
      entities: entityCount,
      relations: relationCount,
      observation_created: obs.created,
      processed: true,
      via,
      ...(sensitive ? { sensitive: true } : {}),
    }
  }

  /**
   * Faits actifs jamais traités — ou vus en heuristique seulement, si un LLM
   * est là pour mieux faire.
   *
   * ACTIFS au sens du cycle de vie : un fait dormant (en attente de validation)
   * ou archivé n'entre pas dans le graphe. Sinon il recevait des entités et
   * devenait atteignable par ses voisins, alors qu'il doit rester invisible au
   * rappel. Il n'a pas de marqueur : il sort ici dès qu'il est validé.
   *
   * `includeBackfill` (rattrapage demandé à la main) reprend aussi les faits
   * que la migration 11 a marqués `backfill` sans jamais les traiter : c'est le
   * seul moyen de relier au graphe ce qui existait avant la migration. Un fait
   * `backfill` n'est « à rattraper » que si son marqueur date de la migration :
   * le rattrapage heuristique laisse `via = 'backfill'` (pour qu'aucun passage
   * ordinaire ne renvoie ensuite toute la base au LLM) mais rafraîchit
   * `processed_at`, ce qui le sort de cette sélection. Sans trace de la
   * migration (schéma posé autrement), tous les `backfill` sont repris.
   *
   * Seuls les `backfill` SANS entité sont repris : la migration a aussi marqué
   * `backfill` des faits déjà reliés. Les retraiter gonflait mention_count et
   * les poids de co-occurrence, et empilait des entités heuristiques sur
   * celles du LLM.
   *
   * Un fait `critical` n'est jamais repris (voir processFact). Avec un LLM, un
   * fait dont l'extraction a déjà échoué LLM_EXTRACTION_MAX_FAILURES fois
   * n'est plus repris ; les faits déjà en échec passent après les autres.
   */
  pendingFactIds(llmAvailable: boolean, limit = 2000, opts: { includeBackfill?: boolean } = {}): string[] {
    const rows = this.db
      .prepare(
        `SELECT f.id FROM facts f
         LEFT JOIN fact_cognition fc ON fc.fact_id = f.id
         WHERE f.superseded = 0
           AND f.lifecycle_state = 'active'
           AND f.sensitivity IN ('normal','sensitive')
           AND (fc.fact_id IS NULL
             OR (fc.via = 'heuristic' AND @llm = 1 AND fc.llm_failures < @maxFailures)
             OR (@backfill = 1 AND fc.via = 'backfill' AND fc.processed_at <= COALESCE(
                  (SELECT MAX(applied_at) FROM schema_migrations WHERE name = 'cognition-processed'), '9999')
                AND NOT EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = f.id)
                AND (@llm = 0 OR fc.llm_failures < @maxFailures)))
         ORDER BY COALESCE(fc.llm_failures, 0), f.created_at
         LIMIT @limit`,
      )
      .all({
        llm: llmAvailable ? 1 : 0,
        backfill: opts.includeBackfill ? 1 : 0,
        maxFailures: LLM_EXTRACTION_MAX_FAILURES,
        limit,
      }) as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  /**
   * Oubli (forget, rejet en revue) ou fait qui n'aurait jamais dû être relié
   * (critical) : retire ces faits du graphe, en une lecture groupée pour tous
   * les faits (onFactSuperseded relit toute la table des relations pour
   * CHAQUE fait, trop lent pour un oubli en masse sur le fil du daemon).
   *
   *  - relations : même règle que onFactSuperseded (contexte vidé, arête
   *    supprimée ; sinon affaiblie de 0,15, plancher 0,1) ;
   *  - fact_entities du fait ;
   *  - entités que plus aucun fait ne cite : leur nom venait de ces faits ;
   *  - observations dont le texte est celui d'un de ces faits (upsertObservation
   *    recopie le fait en entier) : sinon le texte oublié restait sur le disque.
   *
   * Retourne le nombre de relations touchées.
   */
  detachFacts(factIds: string[]): number {
    const unique = [...new Set(factIds)]
    if (unique.length === 0) return 0
    const ids = JSON.stringify(unique)
    const gone = new Set(unique)
    const tx = this.db.transaction((): number => {
      const entityIds = (
        this.db
          .prepare('SELECT DISTINCT entity_id FROM fact_entities WHERE fact_id IN (SELECT value FROM json_each(?))')
          .all(ids) as Array<{ entity_id: string }>
      ).map(r => r.entity_id)
      // Une relation ne cite un fait que si ses DEUX entités sont liées à ce
      // fait : processFact pose liens et relations ensemble. On ne lit donc que
      // les paires d'entités de chaque fait, par la clé de fact_entities et
      // l'index unique des paires, au lieu de relire toute la table (321 ms
      // pour 15 000 relations sur la base fictive de 70 000 faits).
      const rels = this.db
        .prepare(
          `SELECT DISTINCT r.id, r.context
           FROM fact_entities fa
           JOIN fact_entities fb ON fb.fact_id = fa.fact_id AND fb.entity_id > fa.entity_id
           JOIN relations r ON r.from_entity = fa.entity_id AND r.to_entity = fb.entity_id
           WHERE fa.fact_id IN (SELECT value FROM json_each(?))`,
        )
        .all(ids) as Array<{ id: string; context: string }>
      const remove = this.db.prepare('DELETE FROM relations WHERE id = ?')
      const weaken = this.db.prepare('UPDATE relations SET context = ?, weight = MAX(weight - 0.15, 0.1) WHERE id = ?')
      let affected = 0
      for (const rel of rels) {
        let ctx: string[]
        try {
          const parsed: unknown = JSON.parse(rel.context || '[]')
          ctx = Array.isArray(parsed) ? parsed.map(String) : []
        } catch {
          // Contexte illisible : rien à retirer, l'oubli ne doit pas échouer pour autant.
          continue
        }
        const kept = ctx.filter(id => !gone.has(id))
        if (kept.length === ctx.length) continue
        if (kept.length === 0) remove.run(rel.id)
        else weaken.run(JSON.stringify(kept), rel.id)
        affected++
      }
      // mention_count compte une apparition par lien fait-entité : le retirer,
      // sinon les faits oubliés pesaient encore sur l'ordre des entités, le
      // seuil des liens et le libellé des thèmes.
      this.db
        .prepare(
          `UPDATE entities SET mention_count = MAX(mention_count - (
             SELECT COUNT(*) FROM fact_entities fe
             WHERE fe.entity_id = entities.id AND fe.fact_id IN (SELECT value FROM json_each(?))
           ), 0)
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .run(ids, JSON.stringify(entityIds))
      this.db.prepare('DELETE FROM fact_entities WHERE fact_id IN (SELECT value FROM json_each(?))').run(ids)
      // Listes calculées en JS puis passées en JSON : un `IN (json_each)`
      // corrélé relisait toute la liste à chaque ligne (60 à 100 ms pour 1 000 faits).
      const cited = this.db.prepare('SELECT 1 FROM fact_entities WHERE entity_id = ? LIMIT 1')
      const orphans = JSON.stringify(entityIds.filter(id => cited.get(id) === undefined))
      this.db.prepare('DELETE FROM topic_entities WHERE entity_id IN (SELECT value FROM json_each(?))').run(orphans)
      this.db.prepare('DELETE FROM entities WHERE id IN (SELECT value FROM json_each(?))').run(orphans)
      const texts = (this.db.prepare('SELECT fact FROM facts WHERE id IN (SELECT value FROM json_each(?))').all(ids) as Array<{ fact: string }>).map(
        r => r.fact,
      )
      this.db.prepare('DELETE FROM observations WHERE content IN (SELECT value FROM json_each(?))').run(JSON.stringify(texts))
      return affected
    })
    return tx()
  }

  /**
   * Expansion graphe au recall (§6.1 étape 4). À partir de `seedFactIds`,
   * retourne des fact_ids LIÉS par entités partagées. Chaque fait traversé,
   * pont compris, est un fait que ce rappel pourrait rendre : non remplacé,
   * actif, de sensibilité rappelable, dans `allowedScopeIds`, non expiré, et
   * sans client ou du client `clientOrgId` (le contexte actif). Sinon un fait
   * caché reliait deux faits lisibles et trahissait son association.
   * SQL pur, 0 LLM, lectures bornées : utilisable dans le chemin de réponse.
   */
  expandEntities(
    seedFactIds: string[],
    allowedScopeIds: Iterable<string>,
    opts: { maxHops?: number; maxFacts?: number; clientOrgId?: string | null; now?: number } = {},
  ): ExpandResult[] {
    const { clientOrgId, now, ...walk } = opts
    return expandByEntities(this.db, seedFactIds, { scopeIds: [...allowedScopeIds], clientOrgId, now }, walk)
  }

  /** Decay du graphe (job quotidien daemon) — affaiblit/élague les arêtes. */
  decay(config?: DecayConfig, now?: number): { decayed: number; pruned: number } {
    return applyDecay(this.db, config, now)
  }

  /** Propagation de supersession (retrait du graphe + jointures). */
  onFactSuperseded(factId: string): number {
    return onFactSuperseded(this.db, factId)
  }

  stats(): GraphStats & { observations: ObservationStats } {
    return { ...graphStats(this.db), observations: observationStats(this.db) }
  }
}

/**
 * Clé d'agrégation d'observation : catégorie + premiers mots significatifs du
 * fait. Volontairement grossière (V1) — deux faits proches partagent un sujet
 * et s'agrègent ; l'affinage par embedding est Phase 6.
 */
function observationSubject(category: string, factText: string): string {
  const words = factText
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length > 3)
    .slice(0, 3)
  const tail = words.length > 0 ? words.join(' ') : 'general'
  return `${category}: ${tail}`
}

export {
  // Sous-modules — exposés pour l'intégrateur (wiring) et les tests.
  heuristicEntities,
  llmExtract,
  parseExtraction,
  upsertEntity,
  normalizeEntityType,
  normalizeRelationType,
  ENTITY_TYPES,
  RELATION_TYPES,
} from './entities.js'
export type {
  EntityType,
  RelationType,
  ExtractedEntity,
  ExtractedRelation,
  Extraction as GraphExtraction,
  EntityRow,
} from './entities.js'
export {
  upsertRelation,
  reinforceCooccurrence,
  expandByEntities,
  applyDecay,
  onFactSuperseded,
  linkFactEntity,
  graphStats,
  DEFAULT_DECAY,
} from './graph.js'
export type { RelationRow, DecayConfig, GraphStats } from './graph.js'
export { upsertObservation, getObservation, observationStats } from './observations.js'
export type { ObservationRow, UpsertObservationInput, ObservationStats } from './observations.js'
export { cognitionMigrations, ensureCognitionSchema } from '../storage/cognition-schema.js'
export { TopicEngine, topicMigrations, ensureTopicSchema, topicKeywords, topicKeywordSurfaces, cleanTopicLabel, topicSlug } from './topics.js'
export type { TopicSummary, AssignResult, TopicEngineOptions, TopicRelation, TopicGraph } from './topics.js'
export { PatternEngine, patternMigrations, ensurePatternSchema, significantTokens } from './patterns.js'
export type { Pattern, DetectOptions, DetectResult, ConsolidateResult, PatternEngineOptions } from './patterns.js'
export { ProceduralEngine, proceduralMigrations, ensureProceduralSchema } from './procedural.js'
export type { Procedure as ProceduralProcedure, ProcedureMatch, StoreProcedureInput, RecordExecutionInput, ProceduralEngineOptions } from './procedural.js'
export { FeedbackEngine, feedbackMigrations, ensureFeedbackSchema } from './feedback.js'
export type { FeedbackEngineOptions, ReinforceOptions, ReinforceResult, Expertise, FeedbackStats } from './feedback.js'
export { ClusterEngine, clusterMigrations, ensureClusterSchema } from './clusters.js'
export type { ClusterEngineOptions, RebuildAsyncOptions as ClusterRebuildAsyncOptions } from './clusters.js'
export { detectContradiction } from './contradiction.js'
export type { Contradiction, DetectContradictionOptions } from './contradiction.js'
export { SelfObservationEngine, selfObservationMigrations, ensureSelfObservationSchema, SELF_OBSERVATION_KINDS } from './self-observation.js'
export type { SelfObservation, SelfObservationKind, SelfObservationEngineOptions } from './self-observation.js'
export { dialectic } from './dialectic.js'
export type { DialecticResult, DialecticOptions } from './dialectic.js'
export { MarkdownSync } from './markdown-sync.js'
export type { MarkdownSyncOptions, ExportOptions } from './markdown-sync.js'
export { RevisionEngine, revisionMigrations, ensureRevisionSchema } from './revision.js'
export type { RevisionProposal, RevisionKind, RevisionStatus, RevisionEngineOptions } from './revision.js'
export { AutoSkillEngine } from './auto-skill.js'
export type { AutoSkillEngineOptions, SkillSource } from './auto-skill.js'
