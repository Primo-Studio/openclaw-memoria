/**
 * Service de tri : l'API publique (`memoria.triage`). Tient l'état du passage
 * (un seul à la fois, sur sa propre file : jamais la file de cognition, qu'un
 * tri de plusieurs heures retiendrait), le persiste dans les réglages du
 * registre (`triage.status`) après chaque lot, et le relit au démarrage : un
 * passage mort avec le processus s'affiche `interrupted`, et sa dépense compte
 * dans le plafond du passage suivant (reprise).
 *
 * Jamais automatique (ni au démarrage, ni après un import) : lancé par la
 * CLI ou une route d'administration.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { completeDetailed, embedDetailed, type EmbeddingProvider, type LlmProvider } from '../llm/provider.js'
import { priceFor } from '../llm/pricing.js'
import { newId, nowISO } from '../util.js'
import type { ActiveContext } from '../types.js'
import { assertPriced, DEFAULT_TRIAGE_BUDGET_USD, estimateTokensFromChars, TriageBudget } from './budget.js'
import { countPending, CROSS_SOURCE_MAX_COMPARISONS, MAX_OUTPUT_TOKENS_PER_FACT, runTriagePass, type EngineDb } from './engine.js'
import { buildTriageSystem } from './prompt.js'
import { isSensitive } from './sensitive.js'
import { addStats, addStatsAsync, applyCorrection, emptyStats, listPage } from './store.js'
import {
  TriageRefusedError,
  type IdeasFilter,
  type IdeasResult,
  type SemanticDuplicate,
  type StorePendingTriagedInput,
  type StorePendingTriagedResult,
  type StylesQuery,
  type StylesResult,
  type TriageApi,
  type TriageCorrection,
  type TriageCursor,
  type TriageEstimate,
  type TriageHost,
  type TriageListFilter,
  type TriageListItem,
  type TriageListPage,
  type TriagePromoteOptions,
  type TriagePromoteResult,
  type TriageRoots,
  type TriageRunOptions,
  type TriageRunState,
  type TriageRunStatus,
  type TriageStats,
  type TriageStopReason,
  type TriageVerdict,
  type UserMessageSourceKind,
  type UserMessagesPassFn,
  type UserMessagesPassOptions,
  type UserMessagesReport,
} from './types.js'

/** Jetons de sortie par fait retenus pour l'estimation (mesuré : 46,7 par fait envoyé avec tri-v3, renvois compris). */
export const ESTIMATE_OUTPUT_TOKENS_PER_FACT = 47
/** Clé du réglage qui garde l'état du dernier passage réel. */
export const TRIAGE_STATUS_SETTING = 'triage.status'
/** Clé du réglage qui garde la dernière estimation (dry-run). */
export const TRIAGE_ESTIMATE_SETTING = 'triage.last_estimate'
/**
 * Clé du réglage qui garde la dépense du passage en cours, écrite après CHAQUE
 * appel payé (écriture légère : `{ run_id, spent_usd }`). L'état complet
 * (`triage.status`) n'est écrit qu'une fois par seconde ; après une coupure,
 * la reprise comptait donc moins que dépensé.
 */
export const TRIAGE_SPENT_SETTING = 'triage.spent'

/** Réglages `[triage]` de config.toml. */
export interface TriageConfig {
  budget_usd?: number
  claude_projects_dir?: string
  codex_sessions_dir?: string
  codex_history_file?: string
  archive_dir?: string
}

/** Ce que Memoria prête au service (accès internes, jamais exposés tels quels). */
export interface TriageServiceHost {
  /** Bases de contenu (toutes, ou celles lisibles par une instance), existantes sur disque. */
  dbs(instanceId?: string): EngineDb[]
  /** Chemin d'une base relatif à la racine du stockage. */
  relativeDb(path: string): string
  profile(): Promise<{ extraction: LlmProvider | null; embeddings: EmbeddingProvider | null }>
  redact(text: string): { text: string; secrets: number }
  isEnabled(): boolean
  isClosed(): boolean
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  config(): TriageConfig
  /** Dossier de config.toml (racine par défaut de l'archive des sessions). */
  configDir(): string
  agentOf(instanceId: string | null): string
  persons(): Array<{ id: string; display_name: string }>
  audit(action: string, reason: string): void
  promote(opts: TriagePromoteOptions): TriagePromoteResult
  ideas(instanceId: string, filter: IdeasFilter, context: ActiveContext | undefined): IdeasResult
  styles(instanceId: string, query: StylesQuery): StylesResult
  storePendingTriaged(input: StorePendingTriagedInput): StorePendingTriagedResult
  resolveInstanceForSource(source: { kind: UserMessageSourceKind; path?: string }): string | null
  findSemanticDuplicate(instanceId: string, text: string, vector?: Float32Array): SemanticDuplicate | null
  /** Base privée d'une instance (état par message), ou null. */
  instanceDb(instanceId: string): EngineDb | null
  userMessagesPass(): UserMessagesPassFn | null
}

function idleStatus(budget: number): TriageRunStatus {
  return {
    run_id: null,
    state: 'idle',
    dry_run: false,
    instance: null,
    started_at: null,
    updated_at: null,
    finished_at: null,
    budget_usd: budget,
    spent_usd: 0,
    total_spent_usd: 0,
    dbs_total: 0,
    dbs_done: 0,
    facts_done: 0,
    classified: 0,
    inherited: 0,
    sensible: 0,
    failed: 0,
    llm_calls: 0,
    embed_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    embed_tokens: 0,
    max_block_ms: null,
    cross_source_skipped: [],
    error: null,
    estimate: null,
  }
}

function stateFor(reason: TriageStopReason | null): TriageRunState {
  switch (reason) {
    case null:
    case 'max_facts':
      return 'done'
    case 'cancelled':
    case 'closed':
      return 'cancelled'
    case 'paused':
      return 'paused'
    case 'budget':
      return 'budget'
    case 'circuit':
      return 'error'
  }
}

/** Nom normalisé pour relier un prénom cité à une fiche Person. */
function personKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .trim()
}

interface ActiveRun {
  status: TriageRunStatus
  cancelled: boolean
  promise: Promise<TriageRunStatus> | null
}

export class TriageService implements TriageApi {
  /** Pause avant la reprise d'un appel LLM en échec passager (public pour les tests : 0). */
  retryDelayMs = 5000
  /** Plafond de comparaisons de l'amas entre sources (public pour les tests ; défaut du moteur). */
  crossSourceMaxComparisons = CROSS_SOURCE_MAX_COMPARISONS
  private active: ActiveRun | null = null
  private messages: { cancelled: boolean } | null = null

  constructor(private readonly host: TriageServiceHost) {}

  // ---------------------------------------------------------------- réglages

  defaultBudget(): number {
    const b = this.host.config().budget_usd
    return typeof b === 'number' && b >= 0 ? b : DEFAULT_TRIAGE_BUDGET_USD
  }

  roots(): TriageRoots {
    const c = this.host.config()
    const home = homedir()
    return {
      claudeProjectsDir: c.claude_projects_dir ?? join(home, '.claude', 'projects'),
      codexSessionsDir: c.codex_sessions_dir ?? join(home, '.codex', 'sessions'),
      codexHistoryFile: c.codex_history_file ?? join(home, '.codex', 'history.jsonl'),
      archiveDir: c.archive_dir ?? join(this.host.configDir(), 'archive', 'claude-code-sessions'),
    }
  }

  owner(): { display_name: string | null; context: string | null } {
    return { display_name: this.host.getSetting('owner.display_name'), context: this.host.getSetting('owner.context') }
  }

  private persisted(): TriageRunStatus | null {
    const raw = this.host.getSetting(TRIAGE_STATUS_SETTING)
    if (!raw) return null
    let status: TriageRunStatus
    try {
      status = { ...idleStatus(this.defaultBudget()), ...(JSON.parse(raw) as Partial<TriageRunStatus>) }
    } catch {
      return null
    }
    // Dépense écrite après chaque appel : plus fraîche que l'état si le
    // processus est mort entre deux écritures de l'état.
    const spent = this.persistedSpend()
    if (spent && spent.run_id === status.run_id && spent.spent_usd > status.spent_usd) {
      status.total_spent_usd += spent.spent_usd - status.spent_usd
      status.spent_usd = spent.spent_usd
    }
    return status
  }

  private persistedSpend(): { run_id: string; spent_usd: number } | null {
    try {
      const raw = this.host.getSetting(TRIAGE_SPENT_SETTING)
      if (!raw) return null
      const v = JSON.parse(raw) as { run_id?: unknown; spent_usd?: unknown }
      return typeof v.run_id === 'string' && typeof v.spent_usd === 'number' && Number.isFinite(v.spent_usd)
        ? { run_id: v.run_id, spent_usd: v.spent_usd }
        : null
    } catch {
      return null
    }
  }

  private persistSpend(runId: string | null, spentUsd: number): void {
    if (!runId || this.host.isClosed()) return
    try {
      this.host.setSetting(TRIAGE_SPENT_SETTING, JSON.stringify({ run_id: runId, spent_usd: spentUsd }))
    } catch {
      /* base fermée ou en lecture seule : l'état complet reste écrit à la fin */
    }
  }

  private persist(status: TriageRunStatus): void {
    status.updated_at = nowISO()
    try {
      this.host.setSetting(TRIAGE_STATUS_SETTING, JSON.stringify({ ...status, estimate: null }))
    } catch (err) {
      console.warn(`[memoria] tri : état non enregistré : ${(err as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- passage

  status(): TriageRunStatus {
    if (this.active) return { ...this.active.status }
    const last = this.persisted()
    if (!last) return idleStatus(this.defaultBudget())
    // Mort avec le processus : ni fini, ni annulé.
    if (last.state === 'running') return { ...last, state: 'interrupted' }
    return last
  }

  cancel(): boolean {
    let any = false
    if (this.active) {
      this.active.cancelled = true
      any = true
    }
    if (this.messages) {
      this.messages.cancelled = true
      any = true
    }
    return any
  }

  async estimate(opts: TriageRunOptions = {}): Promise<TriageEstimate> {
    const { extraction, embeddings } = await this.host.profile()
    const dbs = this.host.dbs(opts.instance)
    const counts = await countPending(dbs, { reclassify: opts.reclassify === true, embeddingsModel: embeddings?.model ?? null })
    const batch = Math.max(1, opts.batchSize ?? 20)
    const llmFacts = counts.facts_pending - counts.facts_sensible
    const calls = Math.ceil(llmFacts / batch)
    const system = buildTriageSystem(this.owner())
    // Par fait : son texte et l'enveloppe JSON de la ligne (~60 caractères) ; par appel : le prompt système.
    const tokensIn = estimateTokensFromChars(counts.chars + llmFacts * 60 + calls * (system.length + 30))
    const tokensOut = llmFacts * ESTIMATE_OUTPUT_TOKENS_PER_FACT
    const embedTokens = embeddings ? estimateTokensFromChars(counts.chars * (counts.facts_to_embed / Math.max(1, llmFacts))) : 0
    const lp = extraction ? priceFor(extraction.name, extraction.model) : null
    const ep = embeddings ? priceFor(embeddings.name, embeddings.model) : null
    const llmUsd = lp ? (tokensIn * lp.input + tokensOut * lp.output) / 1_000_000 : null
    const embUsd = embeddings ? (ep ? (embedTokens * ep.input) / 1_000_000 : null) : 0
    const cost = llmUsd !== null && embUsd !== null ? llmUsd + embUsd : null
    const budget = opts.budgetUsd ?? this.defaultBudget()
    const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 10_000) / 10_000)
    return {
      facts_pending: counts.facts_pending,
      facts_active: counts.facts_active,
      facts_sensible: counts.facts_sensible,
      facts_to_embed: counts.facts_to_embed,
      llm_facts_max: llmFacts,
      llm_calls_max: calls,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      embed_tokens: embedTokens,
      llm_usd: round(llmUsd),
      embeddings_usd: round(embUsd),
      cost_usd: round(cost),
      provider: extraction?.name ?? null,
      model: extraction?.model ?? null,
      embeddings_model: embeddings?.model ?? null,
      budget_usd: budget,
      within_budget: cost !== null && cost <= budget,
    }
  }

  async start(opts: TriageRunOptions = {}): Promise<TriageRunStatus> {
    if (this.host.isClosed()) throw new TriageRefusedError('closed', 'Memoria est fermé')
    // Place prise AVANT le premier await : un second appel simultané est refusé.
    if (this.active || this.messages) throw new TriageRefusedError('running', 'un tri est déjà en cours')
    if (!opts.dryRun && !this.host.isEnabled()) {
      throw new TriageRefusedError('paused', 'Memoria est en pause : aucun tri ne part au LLM. Réactive Memoria pour lancer le tri.')
    }
    const budgetUsd = opts.budgetUsd ?? this.defaultBudget()
    if (!(budgetUsd >= 0)) throw new TriageRefusedError('bad-request', 'plafond de dépense invalide')
    const previous = this.persisted()
    const status: TriageRunStatus = {
      ...idleStatus(budgetUsd),
      run_id: newId(),
      state: 'running',
      dry_run: opts.dryRun === true,
      instance: opts.instance ?? null,
      started_at: nowISO(),
      total_spent_usd: previous?.total_spent_usd ?? 0,
    }
    const run: ActiveRun = { status, cancelled: false, promise: null }
    this.active = run
    try {
      if (opts.dryRun) {
        status.estimate = await this.estimate(opts)
        status.state = 'done'
        status.finished_at = nowISO()
        run.promise = Promise.resolve({ ...status })
        // Jamais dans `triage.status` : un dry-run effacerait l'état (et la dépense à
        // reprendre) d'un passage interrompu. L'estimation a sa propre clé.
        try {
          this.host.setSetting(TRIAGE_ESTIMATE_SETTING, JSON.stringify(status))
        } catch {
          /* l'estimation est rendue de toute façon */
        }
        this.active = null
        return { ...status }
      }
      const { extraction, embeddings } = await this.host.profile()
      if (!extraction) throw new TriageRefusedError('no-llm', 'aucun LLM d’extraction configuré : configure d’abord un moteur d’intelligence')
      const llmPrice = assertPriced(extraction.name, extraction.model, 'le LLM')
      const embPrice = embeddings ? assertPriced(embeddings.name, embeddings.model, 'les vecteurs') : null
      // Reprise : la dépense d'un passage mort avec le processus compte encore.
      const resumable = opts.resume !== false && previous && (previous.state === 'running' || previous.state === 'interrupted') ? previous : null
      const resumed = resumable !== null
      const spentBefore = resumable ? resumable.spent_usd : 0
      let lastSpent = spentBefore
      if (resumable) status.run_id = resumable.run_id ?? status.run_id
      const budget = new TriageBudget({
        budgetUsd,
        spentUsd: spentBefore,
        llmPrice,
        embeddingsPrice: embPrice,
        onSpend: spent => {
          // Écriture seulement si la dépense a bougé (un modèle local, gratuit, n'écrit jamais).
          if (spent === lastSpent) return
          lastSpent = spent
          this.persistSpend(status.run_id, spent)
        },
      })
      status.spent_usd = spentBefore
      const dbs = this.host.dbs(opts.instance)
      status.dbs_total = dbs.length
      const totalBefore = status.total_spent_usd - (resumed ? spentBefore : 0)
      this.persist(status)
      const persons = new Map(this.host.persons().map(p => [personKey(p.display_name), p.id]))
      const delay = monitorEventLoopDelay({ resolution: 20 })
      delay.enable()
      // État persisté au plus une fois par seconde (et à la fin) : une écriture
      // par lot dans le registre multipliait les points de contrôle du journal SQLite.
      let persistedAt = 0
      const progress = (force = false): void => {
        status.max_block_ms = Math.round(delay.max / 1e6)
        status.total_spent_usd = totalBefore + status.spent_usd
        if (!force && Date.now() - persistedAt < 1000) return
        persistedAt = Date.now()
        this.persist(status)
      }
      run.promise = (async () => {
        let reason: TriageStopReason | null = null
        try {
          reason = await runTriagePass({
            dbs,
            llm: extraction,
            embedder: embeddings,
            budget,
            roots: this.roots(),
            system: buildTriageSystem(this.owner()),
            batchSize: Math.max(1, Math.min(50, opts.batchSize ?? 20)),
            concurrency: Math.max(1, Math.min(4, opts.concurrency ?? 2)),
            maxFacts: typeof opts.maxFacts === 'number' && opts.maxFacts > 0 ? Math.floor(opts.maxFacts) : null,
            reclassify: opts.reclassify === true,
            redact: text => this.host.redact(text),
            agentOf: id => this.host.agentOf(id),
            personId: name => persons.get(personKey(name)) ?? null,
            shouldStop: () => {
              if (this.host.isClosed()) return 'closed'
              if (run.cancelled) return 'cancelled'
              if (!this.host.isEnabled()) return 'paused'
              return null
            },
            onProgress: () => progress(),
            retryDelayMs: this.retryDelayMs,
            crossSourceMaxComparisons: this.crossSourceMaxComparisons,
            status,
            now: nowISO,
          })
          if (reason !== 'circuit') status.error = null
        } catch (err) {
          reason = 'circuit'
          status.error = (err as Error)?.message ?? String(err)
        } finally {
          delay.disable()
        }
        status.state = stateFor(reason)
        if (reason === 'circuit' && !status.error) status.error = 'appels LLM en échec répété'
        status.finished_at = nowISO()
        progress(true)
        if (!this.host.isClosed()) {
          try {
            this.host.audit('triage_run', `state=${status.state} facts=${status.facts_done} spent_usd=${status.spent_usd.toFixed(4)}`)
          } catch {
            /* l'audit ne fait jamais échouer le tri */
          }
        }
        this.active = null
        return { ...status }
      })()
      return { ...status }
    } catch (err) {
      this.active = null
      throw err
    }
  }

  async run(opts: TriageRunOptions = {}): Promise<TriageRunStatus> {
    const started = await this.start(opts)
    const promise = this.active?.promise
    return promise ? promise : opts.dryRun ? started : this.status()
  }

  // ---------------------------------------------------------------- lectures (administration)

  list(filter: TriageListFilter = {}, page: { cursor?: TriageCursor | null; limit?: number } = {}): TriageListPage {
    const limit = Math.max(1, Math.min(500, page.limit ?? 50))
    const items: TriageListItem[] = []
    for (const db of this.host.dbs(filter.instance)) {
      for (const r of listPage(db.store.db, filter, page.cursor ?? null, limit)) {
        items.push({
          ...r.row,
          text: r.text,
          category: r.category,
          validated: r.lifecycle_state === 'active',
          source_db: this.host.relativeDb(db.path),
          instance_id: r.assistant_instance_id,
          source_path: r.source_path,
        })
      }
    }
    items.sort((a, b) => (b.conversation_at ?? '').localeCompare(a.conversation_at ?? '') || b.fact_id.localeCompare(a.fact_id))
    const kept = items.slice(0, limit)
    const last = kept[kept.length - 1]
    return {
      items: kept,
      next_cursor: kept.length === limit && last ? { conversation_at: last.conversation_at ?? '', fact_id: last.fact_id } : null,
    }
  }

  /** Compteurs (synchrone : une lecture groupée par table et par base, ~140 ms sur 70 000 faits fictifs). */
  stats(filter: { instance?: string } = {}): TriageStats {
    const out = emptyStats()
    for (const db of this.host.dbs(filter.instance)) addStats(db.store.db, out)
    out.untriaged = Math.max(0, out.facts_total - out.triaged)
    return out
  }

  /**
   * Mêmes compteurs, par tranches, en rendant la main à la boucle d'événements
   * entre deux tranches et entre deux bases (le daemon : ticket #27).
   */
  async statsAsync(filter: { instance?: string } = {}, opts: { sliceRows?: number } = {}): Promise<TriageStats> {
    const out = emptyStats()
    for (const db of this.host.dbs(filter.instance)) {
      if (this.host.isClosed()) throw new TriageRefusedError('closed', 'Memoria est fermé')
      await addStatsAsync(db.store.db, out, opts)
    }
    out.untriaged = Math.max(0, out.facts_total - out.triaged)
    return out
  }

  correct(correction: TriageCorrection): { updated: boolean } {
    const now = nowISO()
    for (const db of this.host.dbs()) {
      const exists = db.store.db.prepare('SELECT 1 FROM facts WHERE id = ?').get(correction.fact_id)
      if (!exists) continue
      const updated = db.store.db.transaction(() => applyCorrection(db.store.db, correction, now))()
      if (updated) this.host.audit('triage_correct', `fields=${Object.keys(correction).filter(k => k !== 'fact_id').join(',')}`)
      return { updated }
    }
    return { updated: false }
  }

  setVerdict(factIds: string[], verdict: TriageVerdict | null): { updated: number } {
    if (factIds.length === 0) return { updated: 0 }
    let updated = 0
    for (const db of this.host.dbs()) {
      const r = db.store.db
        .prepare('UPDATE fact_triage SET verdict = ? WHERE fact_id IN (SELECT value FROM json_each(?))')
        .run(verdict, JSON.stringify(factIds))
      updated += r.changes
    }
    if (updated > 0) this.host.audit('triage_verdict', `verdict=${verdict ?? 'aucun'} facts=${updated}`)
    return { updated }
  }

  promote(opts: TriagePromoteOptions): TriagePromoteResult {
    return this.host.promote(opts)
  }

  ideasForInstance(instanceId: string, filter: IdeasFilter = {}, activeContext?: ActiveContext): IdeasResult {
    return this.host.ideas(instanceId, filter, activeContext)
  }

  stylesForInstance(instanceId: string, query: StylesQuery = {}): StylesResult {
    return this.host.styles(instanceId, query)
  }

  // ---------------------------------------------------------------- passe sur les messages

  /**
   * Hôte prêté à la passe sur les messages. Public pour les tests de ce module ;
   * la passe elle-même passe par runUserMessages.
   */
  createHost(opts: {
    llm: LlmProvider | null
    embeddings: EmbeddingProvider | null
    budget: TriageBudget
    stop: () => TriageStopReason | null
  }): TriageHost {
    const { llm, embeddings, budget } = opts
    const host = this.host
    const stateStmt = (instanceId: string) => host.instanceDb(instanceId)?.store.db ?? null
    return {
      roots: this.roots(),
      owner: this.owner(),
      redact: text => host.redact(text),
      isSensitive,
      async complete(callOpts) {
        if (!llm) throw new TriageRefusedError('no-llm', 'aucun LLM d’extraction configuré')
        const r = budget.reserveCompletion((callOpts.system?.length ?? 0) + callOpts.prompt.length, callOpts.maxTokens ?? 1024)
        try {
          const res = await completeDetailed(llm, callOpts)
          budget.settleCompletion(r, res.usage, res.text.length)
          return res
        } catch (err) {
          budget.fail(r)
          throw err
        }
      },
      async embed(texts) {
        if (!embeddings) throw new Error('aucun fournisseur de vecteurs configuré')
        const r = budget.reserveEmbeddings(texts.reduce((n, t) => n + t.length, 0))
        try {
          const res = await embedDetailed(embeddings, texts)
          budget.settleEmbeddings(r, res.usage)
          return res.vectors
        } catch (err) {
          budget.fail(r)
          throw err
        }
      },
      estimateCost: (inputChars, outputTokens) => {
        if (!llm) return null
        const p = priceFor(llm.name, llm.model)
        return p ? (estimateTokensFromChars(inputChars) * p.input + outputTokens * p.output) / 1_000_000 : null
      },
      findSemanticDuplicate: (instanceId, text, vector) => host.findSemanticDuplicate(instanceId, text, vector),
      storePendingTriaged: input => host.storePendingTriaged(input),
      resolveInstanceForSource: source => host.resolveInstanceForSource(source),
      messageDone(instanceId, msgKey) {
        const db = stateStmt(instanceId)
        if (!db) return false
        return (
          db.prepare("SELECT 1 FROM user_message_state WHERE msg_key = ? AND status IN ('done','sensitive','skipped')").get(msgKey) !==
          undefined
        )
      },
      markMessage(instanceId, msgKey, info) {
        const db = stateStmt(instanceId)
        if (!db) return
        db.prepare(
          `INSERT INTO user_message_state (msg_key, source_key, ts, status, facts, attempts, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(msg_key) DO UPDATE SET status = excluded.status, facts = excluded.facts,
             attempts = user_message_state.attempts + 1, updated_at = excluded.updated_at`,
        ).run(msgKey, info.source_key, info.ts, info.status, info.facts, nowISO())
      },
      shouldStop: () => opts.stop() ?? (budget.spentUsd >= budget.budgetUsd ? 'budget' : null),
      spentUsd: () => budget.spentUsd,
    }
  }

  async runUserMessages(opts: UserMessagesPassOptions = {}): Promise<UserMessagesReport> {
    const pass = this.host.userMessagesPass()
    if (!pass) throw new TriageRefusedError('not-registered', 'passe sur les messages non branchée (registerUserMessagesPass)')
    if (this.host.isClosed()) throw new TriageRefusedError('closed', 'Memoria est fermé')
    if (this.active || this.messages) throw new TriageRefusedError('running', 'un tri est déjà en cours')
    if (!opts.dryRun && !this.host.isEnabled()) {
      throw new TriageRefusedError('paused', 'Memoria est en pause : la passe sur les messages est refusée.')
    }
    const flag = { cancelled: false }
    this.messages = flag
    try {
      const { extraction, embeddings } = await this.host.profile()
      if (!extraction && !opts.dryRun) throw new TriageRefusedError('no-llm', 'aucun LLM d’extraction configuré')
      const llmPrice = extraction ? assertPriced(extraction.name, extraction.model, 'le LLM') : null
      const embPrice = embeddings ? assertPriced(embeddings.name, embeddings.model, 'les vecteurs') : null
      const budget = new TriageBudget({ budgetUsd: opts.budgetUsd ?? this.defaultBudget(), llmPrice, embeddingsPrice: embPrice })
      const host = this.createHost({
        llm: extraction,
        embeddings,
        budget,
        stop: () => {
          if (this.host.isClosed()) return 'closed'
          if (flag.cancelled) return 'cancelled'
          if (!opts.dryRun && !this.host.isEnabled()) return 'paused'
          return null
        },
      })
      const report = await pass(host, opts)
      if (!this.host.isClosed()) {
        this.host.audit('triage_user_messages', `facts=${report.facts_created} spent_usd=${report.spent_usd.toFixed(4)}`)
      }
      return report
    } finally {
      this.messages = null
    }
  }
}

/** Sortie maximale d'un lot (réexportée pour l'estimation des surfaces). */
export { MAX_OUTPUT_TOKENS_PER_FACT }
