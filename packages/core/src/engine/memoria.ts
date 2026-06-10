/**
 * Memoria — le moteur (spec §4). Aucune dépendance d'hôte.
 * P1 : identité/pairing, storeFact, recall fan-out gouverné, forget hard-delete,
 * doctor/stats. Capture pipeline (WAL→redaction→extraction) arrive en P2,
 * MCP/UI en P3 — voir docs/v3/STATUS.md.
 */
import { existsSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { relative } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import { importLegacyCognition } from '../migration/import-cognition.js'
import { importTranscripts } from '../migration/import-transcripts.js'
import {
  ensureStorageTree,
  resolveStorageRoot,
  saveConfigFile,
  storagePaths,
  type ResolveOptions,
  type ResolvedConfig,
} from '../config.js'
import { RegistryStore } from '../storage/registry.js'
import { ContentStore, rowToFact, type FactRow, type FtsHit, type FtsSearchOptions } from '../storage/content.js'
import { EmbeddingIndexer, hybridSearchFacts } from '../vector/index.js'
import {
  CognitionEngine,
  TopicEngine,
  PatternEngine,
  ProceduralEngine,
  FeedbackEngine,
  ClusterEngine,
  type TopicSummary,
  type Pattern,
  type ProcedureMatch,
  type ProceduralProcedure,
} from '../cognition/index.js'
import { estimateTokens, newId, sha256Hex } from '../util.js'
import { createSecretProvider, RegexRedactor } from '../secrets/index.js'
import type { SecretProvider } from '../secrets/types.js'
import { resolveLlmProfile } from '../llm/index.js'
import type { EmbeddingProvider, LlmProvider } from '../llm/provider.js'
import { CapturePipeline, type CaptureTurnInput, type CaptureTurnResult } from './capture.js'
import type { WalReplaySummary } from './wal.js'
import { passesClientIsolation, scoreFact } from './scoring.js'
import type {
  AssistantInstance,
  AssistantType,
  CaptureMode,
  DoctorReport,
  Fact,
  ForgetFilter,
  MemoryScope,
  RecallInput,
  RecallItem,
  RecallResult,
  StoreFactInput,
} from '../types.js'

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
}

const DEFAULT_TOKEN_BUDGET = 1500
const DEFAULT_RECALL_LIMIT = 12

export class Memoria {
  readonly resolved: ResolvedConfig
  readonly paths: ReturnType<typeof storagePaths>
  readonly registry: RegistryStore
  private readonly pool = new Map<string, ContentStore>()
  private closed = false

  private readonly secretProvider: SecretProvider
  private readonly redactor = new RegexRedactor()
  private readonly llmOverride: MemoriaInitOptions['llm']
  private pipelinePromise: Promise<CapturePipeline> | null = null
  private profilePromise: Promise<{ extraction: LlmProvider | null; embeddings: EmbeddingProvider | null }> | null = null
  private readonly indexers = new WeakMap<ContentStore, EmbeddingIndexer>()
  private readonly cognitionEngines = new WeakMap<ContentStore, CognitionEngine>()
  private readonly topicEngines = new WeakMap<ContentStore, TopicEngine>()
  private readonly patternEngines = new WeakMap<ContentStore, PatternEngine>()
  private readonly proceduralEngines = new WeakMap<ContentStore, ProceduralEngine>()
  private readonly feedbackEngines = new WeakMap<ContentStore, FeedbackEngine>()
  private readonly clusterEngines = new WeakMap<ContentStore, ClusterEngine>()

  private constructor(resolved: ResolvedConfig, opts: MemoriaInitOptions) {
    this.resolved = resolved
    this.paths = storagePaths(resolved.storageRoot)
    ensureStorageTree(resolved.storageRoot)
    this.registry = new RegistryStore(this.paths.registry)
    this.registry.bootstrap(opts.userDisplayName)
    this.registry.registerDb({ kind: 'registry', path: this.paths.registry, assistant_instance_id: null, scope_id: null })
    this.secretProvider = createSecretProvider(this.paths.secretsDir, { force: opts.secretsVault })
    this.llmOverride = opts.llm
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

    // Policies par défaut : privé = lecture/écriture ; `user` = lecture (partage volontaire en P5)
    this.registry.setPolicy({
      assistant_id: assistant.id,
      scope_id: privateScope.id,
      can_read: true,
      can_write: true,
      can_share: false,
      secret_access: 'none',
    })
    const userScope = this.registry.getScopeByName('user')
    if (userScope) {
      this.registry.setPolicy({
        assistant_id: assistant.id,
        scope_id: userScope.id,
        can_read: true,
        can_write: false,
        can_share: false,
        secret_access: 'none',
      })
    }

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

  /** Authentifie un token d'instance (utilisé par le daemon). */
  authenticate(token: string): AssistantInstance | null {
    this.assertOpen()
    const inst = this.registry.verifyInstanceToken(token)
    if (inst) this.registry.touchInstance(inst.id)
    return inst
  }

  // ------------------------------------------------------------------- mémoire

  storeFact(input: StoreFactInput): Fact {
    this.assertOpen()
    const instance = this.mustInstance(input.instance)
    const scope = this.resolveTargetScope(instance, input.scope)

    if (scope.type !== 'private') {
      const policy = this.registry.getPolicy(instance.assistant_id, scope.id)
      if (!policy?.can_write) {
        throw new Error(`écriture refusée : l'assistant n'a pas can_write sur le scope « ${scope.name} »`)
      }
    }

    const store = this.storeForScope(scope, instance)
    const fact = store.insertFact({
      fact: input.content,
      category: input.category,
      fact_type: input.fact_type,
      confidence: input.confidence,
      source: input.source ?? 'manual',
      assistant_instance_id: instance.id,
      org_id: input.org_id ?? scope.org_id,
      client_org_id: input.client_org_id ?? scope.client_org_id,
      project_id: input.project_id ?? scope.project_id,
      scope_id: scope.id,
      sensitivity: input.sensitivity,
      tags: input.tags,
      visibility: scope.type === 'private' ? 'private' : 'shared',
    })
    this.registry.audit({
      actor_type: 'assistant',
      actor_id: instance.id,
      action: 'store_fact',
      target_id_hash: sha256Hex(fact.id),
      scope_id: scope.id,
      reason: null,
    })
    return fact
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
      hybridSearchFacts(store, query, { ...searchOpts, queryVector: vec, dimensions: provider.dimensions }),
    )
  }

  private performRecall(
    input: RecallInput,
    search: (store: ContentStore, query: string, opts: FtsSearchOptions) => FtsHit[],
  ): RecallResult {
    const instance = this.mustInstance(input.instance)
    const budget = input.token_budget ?? DEFAULT_TOKEN_BUDGET
    const limit = input.limit ?? DEFAULT_RECALL_LIMIT

    // CONTEXT-TREE (couche 9) : un contexte « projet » remonte sa hiérarchie
    // (projet → client → organisation) → le boost s'applique à tous les niveaux.
    const context = this.expandContextTree(input.active_context)
    const searchTargets = this.resolveReadTargets(instance)
    const now = Date.now()
    const candidates: Array<{ item: RecallItem; store: ContentStore }> = []
    let totalFound = 0

    for (const target of searchTargets) {
      const store = this.openContent(target.dbPath)
      const hits = search(store, input.query, {
        limit: 50,
        includeDormant: input.include_dormant ?? false,
        maxSensitivity: 'sensitive',
        scopeIds: target.scopeIds,
      })
      totalFound += hits.length
      for (const hit of hits) {
        // FILTRE DUR anti-fuite inter-clients — jamais un boost, une exclusion.
        if (!passesClientIsolation(hit.row, context)) continue
        const parts = scoreFact(hit.row, hit.relevance, context, now)
        if (parts.total <= 0) continue
        candidates.push({
          store,
          item: {
            kind: 'fact',
            id: hit.row.id,
            content: hit.row.fact,
            category: hit.row.category,
            scope_id: hit.row.scope_id,
            source_db: relative(this.paths.root, target.dbPath),
            score: parts.total,
            created_at: hit.row.created_at,
          },
        })
      }
    }

    // --- Expansion graphe (bucket B au recall, §6.1 étape 4) : SQL pur, 0 LLM.
    // L'anti-fuite est garantie par expandEntities (bornée aux scopes autorisés).
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
        const expanded = this.cognitionFor(store, null).expandEntities(seeds, meta.scopeIds, { maxHops: 2, maxFacts: 8 })
        for (const ex of expanded) {
          if (existing.has(ex.fact_id)) continue
          const row = store.db.prepare('SELECT * FROM facts WHERE id = ?').get(ex.fact_id) as FactRow | undefined
          if (!row) continue
          if (!passesClientIsolation(row, context)) continue
          // relevance dérivée du lien graphe, fortement escomptée (un voisin n'est
          // jamais aussi pertinent qu'un hit direct) ; on garde recency/confiance.
          const parts = scoreFact(row, Math.min(0.4, ex.score) * 0.5, context, now)
          if (parts.total <= 0) continue
          existing.add(ex.fact_id)
          candidates.push({
            store,
            item: {
              kind: 'fact',
              id: row.id,
              content: row.fact,
              category: row.category,
              scope_id: row.scope_id,
              source_db: relative(this.paths.root, meta.dbPath),
              score: parts.total,
              created_at: row.created_at,
            },
          })
        }
      }
    }

    candidates.sort((a, b) => b.item.score - a.item.score)

    // CAP DUR de tokens (corrige format.ts legacy : aucun cap global)
    const selected: Array<{ item: RecallItem; store: ContentStore }> = []
    let tokens = 0
    for (const c of candidates) {
      if (selected.length >= limit) break
      const cost = estimateTokens(c.item.content)
      if (tokens + cost > budget && selected.length > 0) continue
      tokens += cost
      selected.push(c)
    }

    // Compteurs d'usage par DB d'origine
    const byStore = new Map<ContentStore, string[]>()
    for (const s of selected) {
      const arr = byStore.get(s.store) ?? []
      arr.push(s.item.id)
      byStore.set(s.store, arr)
    }
    for (const [store, ids] of byStore) store.touchFacts(ids)

    this.registry.audit({
      actor_type: 'assistant',
      actor_id: instance.id,
      action: 'recall',
      target_id_hash: null,
      scope_id: null,
      reason: `returned=${selected.length}`,
    })

    return {
      items: selected.map(s => s.item),
      totalFound,
      tokens,
      scopes_searched: searchTargets.flatMap(t => t.scopeNames),
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
      return { appended: 0, processed: 0, facts_created: 0, deferred: 0, failed: 0, abandoned: 0, mode }
    }
    const pipeline = await this.ensurePipeline()
    const result = await pipeline.captureTurn(input)
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
   * Traite les faits sans graphe (entités/relations/observations) d'une
   * instance. Async, bucket B — appelé après capture (fire-and-forget) et au
   * boot du daemon. LLM d'extraction optionnel (heuristique sinon).
   */
  async processCognition(instanceId?: string): Promise<{ processed: number }> {
    this.assertOpen()
    const { extraction } = await this.ensureProfile()
    const targets = instanceId
      ? [this.registry.dbForInstance(instanceId)].filter(Boolean)
      : this.registry.listDbs().filter(e => e.kind !== 'registry')
    let processed = 0
    for (const entry of targets) {
      if (!entry || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      const engine = this.cognitionFor(store, extraction)
      // faits actifs sans entité encore liée
      const pending = store.db
        .prepare(
          `SELECT f.id FROM facts f
           WHERE f.superseded = 0
             AND NOT EXISTS (SELECT 1 FROM fact_entities fe WHERE fe.fact_id = f.id)
           LIMIT 2000`,
        )
        .all() as Array<{ id: string }>
      for (const row of pending) {
        const r = await engine.processFact(row.id)
        if (r.processed) processed++
      }
      // TOPICS : ranger les faits par thème APRÈS que les entités existent (entité-first).
      await this.topicFor(store, extraction).assignPending(2000)
    }
    return { processed }
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

  decidePattern(instanceId: string, patternId: string, decision: 'accept' | 'dismiss'): { ok: boolean } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { ok: false }
    const engine = this.patternFor(this.openContent(db.path))
    const result = decision === 'accept' ? engine.accept(patternId) : engine.dismiss(patternId)
    this.registry.audit({
      actor_type: 'user',
      actor_id: 'local',
      action: `pattern_${decision}`,
      target_id_hash: sha256Hex(patternId),
      scope_id: null,
      reason: null,
    })
    return { ok: result !== null }
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

  /** Renforce/atténue des faits selon leur usage réel dans une réponse. */
  reinforceFacts(instanceId: string, factIds: string[], used: boolean): void {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db) return
    this.feedbackFor(this.openContent(db.path)).reinforce(factIds, { used })
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
      feedback.updateExpertise(t.name, Math.log1p(t.fact_count))
      domains++
    }
    return { domains }
  }

  // ---------------------------------------------------------- clusters (couche 16)

  rebuildClusters(instanceId: string): { clusters: number } {
    this.assertOpen()
    const db = this.registry.dbForInstance(instanceId)
    if (!db || !existsSync(db.path)) return { clusters: 0 }
    const r = this.clusterFor(this.openContent(db.path)).rebuild()
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
    opts: { sinceDate?: string; maxWindowsPerFile?: number; dryRun?: boolean } = {},
  ): Promise<import('../migration/import-transcripts.js').ImportTranscriptsReport> {
    this.assertOpen()
    this.mustInstance(instanceId)
    const { extraction } = await this.ensureProfile()
    const report = await importTranscripts({
      files,
      memoria: this,
      instanceId,
      extraction,
      sinceDate: opts.sinceDate,
      maxWindowsPerFile: opts.maxWindowsPerFile,
      dryRun: opts.dryRun,
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
    }
    return engine
  }

  /**
   * Indexe les faits sans embedding (une instance, ou toutes). Appelé après
   * chaque capture (fire-and-forget) et au boot du daemon. Sans provider
   * d'embeddings → no-op.
   */
  async indexEmbeddings(instanceId?: string): Promise<{ indexed: number }> {
    this.assertOpen()
    const provider = await this.ensureEmbeddings()
    if (!provider) return { indexed: 0 }
    let indexed = 0
    const targets = instanceId
      ? [this.registry.dbForInstance(instanceId)].filter(Boolean)
      : this.registry.listDbs().filter(e => e.kind !== 'registry')
    for (const entry of targets) {
      if (!entry || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
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

  /** Profil LLM résolu UNE fois (override tests/daemon > résolution auto). */
  private ensureProfile(): Promise<{ extraction: LlmProvider | null; embeddings: EmbeddingProvider | null }> {
    this.profilePromise ??= (async () => {
      if (this.llmOverride !== undefined) {
        return { extraction: this.llmOverride.extraction, embeddings: this.llmOverride.embeddings ?? null }
      }
      const profile = await resolveLlmProfile(this.resolved.config)
      return { extraction: profile.extraction, embeddings: profile.embeddings }
    })()
    return this.profilePromise
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
        audit: entry => this.registry.audit(entry),
        redactor: this.redactor,
        secretSink: s => {
          this.secretProvider.set(s.name, s.value)
          this.registry.upsertSecretRef(s.name, this.secretProvider.locationFor(s.name), s.kind)
        },
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
    const fact = this.storeFact({ ...input, source: input.source ?? 'capture' })
    if (this.getCaptureMode() !== 'review-first') return fact

    const store = this.openContent(this.paths.assistantDb(input.instance))
    store.db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(fact.id)
    const sourceId = this.ensureReviewSource(store, input.instance)
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
           FROM memory_import_items i
           JOIN memory_sources s ON s.id = i.source_id
           JOIN facts f ON f.id = i.target_memory_id
           WHERE i.status = 'pending' AND i.target_type = 'fact'
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

  /** Approuve (active) ou rejette (hard-delete) des items de revue. */
  reviewDecision(itemIds: string[], decision: 'accepted' | 'rejected'): { updated: number } {
    this.assertOpen()
    if (itemIds.length === 0) return { updated: 0 }
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
        } else {
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
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: `review_${decision}`,
        target_id_hash: sha256Hex(rows.map(r => r.target_memory_id).sort().join(',')),
        scope_id: null,
        reason: `items=${rows.length}`,
      })
    }
    return { updated }
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
        insertFact.run({ ...row, scope_id: privateScope.id, assistant_instance_id: instanceId, visibility: 'private', lifecycle_state: 'active' })
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
   */
  shareFacts(factIds: string[], targetScopeRef: string): { shared: number; scope: string } {
    this.assertOpen()
    if (factIds.length === 0) return { shared: 0, scope: targetScopeRef }
    const scope = this.registry.getScope(targetScopeRef) ?? this.registry.getScopeByName(targetScopeRef)
    if (!scope) throw new Error(`scope cible inconnu : ${targetScopeRef}`)
    if (scope.type === 'private' || scope.type === 'legacy_to_review') {
      throw new Error(`partage interdit vers un scope ${scope.type}`)
    }
    const targetPath = this.sharedDbPathPublic(scope)
    const target = this.openContent(targetPath)
    this.registry.registerDb({ kind: 'shared', path: targetPath, assistant_instance_id: null, scope_id: scope.id })

    const idSet = new Set(factIds)
    let shared = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry' || entry.path === targetPath || !existsSync(entry.path)) continue
      const store = this.openContent(entry.path)
      const placeholders = [...idSet].map(() => '?').join(',')
      const rows = store.db.prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`).all(...idSet) as FactRow[]
      if (rows.length === 0) continue
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
            org_id: scope.org_id ?? row.org_id,
            client_org_id: scope.client_org_id ?? row.client_org_id,
            project_id: scope.project_id ?? row.project_id,
          })
          shared++
        }
      })
      tx()
      store.hardDeleteFacts(rows.map(r => r.id))
    }
    if (shared > 0) {
      this.registry.audit({
        actor_type: 'user',
        actor_id: 'local',
        action: 'share_facts',
        target_id_hash: sha256Hex([...idSet].sort().join(',')),
        scope_id: scope.id,
        reason: `shared=${shared}`,
      })
    }
    return { shared, scope: scope.name }
  }

  /** Scopes + agents qui peuvent les lire (matrice de partage UI). */
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
    const rows = store.db.prepare('SELECT * FROM facts WHERE superseded = 0').all() as FactRow[]
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

  /** Hard-delete gouverné (spec §11). */
  forget(filter: ForgetFilter): { deleted: number } {
    this.assertOpen()
    const hasIds = (filter.ids?.length ?? 0) > 0
    if (!hasIds && !filter.query && !filter.category && !filter.scope_id) {
      throw new Error('forget : filtre vide refusé')
    }
    if (!hasIds && !filter.query && filter.confirm_bulk !== true) {
      throw new Error('forget : suppression en masse — confirm_bulk requis')
    }

    let deleted = 0
    for (const entry of this.registry.listDbs()) {
      if (entry.kind === 'registry') continue
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
          rows = store
            .searchFacts(filter.query, { limit: 500, includeDormant: true, maxSensitivity: 'critical', scopeIds: filter.scope_id ? [filter.scope_id] : undefined })
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
      // Nettoyer thèmes + récurrences AVANT le hard-delete (lisent fact_topics).
      this.topicFor(store, null).onForget(ids)
      this.patternFor(store).onForget(ids)
      const n = store.hardDeleteFacts(ids)
      deleted += n
      if (n > 0) {
        this.registry.audit({
          actor_type: 'user',
          actor_id: 'local',
          action: 'forget',
          target_id_hash: sha256Hex(ids.slice().sort().join(',')),
          scope_id: filter.scope_id ?? null,
          reason: `deleted=${n}`,
        })
      }
    }
    return { deleted }
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
   * Détection des moteurs d'IA disponibles (onboarding/réglages §14) :
   * Ollama (modèles présents), LM Studio, clé Anthropic. Sans réseau bloquant.
   */
  async detectProviders(): Promise<{
    ollama: { available: boolean; models: string[]; base_url: string }
    lmstudio: { available: boolean }
    anthropic: { available: boolean }
    openai: { available: boolean }
    openrouter: { available: boolean }
  }> {
    this.assertOpen()
    const { resolveAnthropicApiKey, resolveOpenAiApiKey, DEFAULT_OLLAMA_BASE_URL } = await import('../llm/index.js')
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
    let lmstudio = false
    try {
      lmstudio = (await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(1000) })).ok
    } catch {
      lmstudio = false
    }
    return {
      ollama: { available: ollamaUp, models: ollamaModels, base_url: ollamaBase },
      lmstudio: { available: lmstudio },
      anthropic: { available: resolveAnthropicApiKey({}) !== null },
      openai: { available: resolveOpenAiApiKey({ flavor: 'openai' }) !== null },
      openrouter: { available: resolveOpenAiApiKey({ flavor: 'openrouter' }) !== null },
    }
  }

  /** Profil LLM courant (config) + choix explicite d'extraction s'il existe. */
  getLlmProfile(): { profile: string; extraction?: { provider?: string; model?: string } } {
    this.assertOpen()
    return {
      profile: this.resolved.config.llm?.profile ?? '100-local',
      extraction: this.resolved.config.llm?.extraction,
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
   * provider ∈ ollama|anthropic|openai|openrouter.
   */
  setExtractionProvider(provider: string, model?: string): void {
    this.assertOpen()
    this.resolved.config.llm = {
      ...this.resolved.config.llm,
      profile: 'custom',
      extraction: { provider, ...(model ? { model } : {}) },
    }
    this.persistLlmConfig(`set_extraction:${provider}${model ? `:${model}` : ''}`)
  }

  private persistLlmConfig(action: string): void {
    saveConfigFile(this.resolved.config, this.resolved.configPath)
    // invalide la résolution mémoïsée → re-résolue au prochain usage
    this.profilePromise = null
    this.pipelinePromise = null
    this.registry.audit({ actor_type: 'user', actor_id: 'local', action, target_id_hash: null, scope_id: null, reason: null })
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
    return {
      ok: warnings.length === 0,
      storage_root: this.paths.root,
      config_path: this.resolved.configPath,
      registry_path: this.paths.registry,
      databases,
      network_guard: { on_network_volume: onNetwork, journal_mode: journalMode },
      warnings,
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const store of this.pool.values()) store.close()
    this.pool.clear()
    this.registry.close()
  }

  // ------------------------------------------------------------------ interne

  private assertOpen(): void {
    if (this.closed) throw new Error('Memoria est fermé (close() déjà appelé)')
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
    }
    return store
  }

  /** Scope cible d'une écriture : id, nom, ou défaut = privé de l'instance. */
  private resolveTargetScope(instance: AssistantInstance, scopeRef?: string): MemoryScope {
    if (!scopeRef) {
      const scope = this.registry.getScopeByName(`private:${instance.id}`)
      if (!scope) throw new Error(`scope privé introuvable pour l'instance ${instance.id}`)
      return scope
    }
    const scope = this.registry.getScope(scopeRef) ?? this.registry.getScopeByName(scopeRef)
    if (!scope) throw new Error(`scope inconnu : ${scopeRef}`)
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
