/**
 * MOTEUR DE TRI : un passage sur les bases de contenu.
 *
 * Par base : d'abord les faits ACTIFS (ils donnent leur genre aux redites),
 * puis les faits EN ATTENTE. Par unité (les faits d'une même source) :
 *  1. provenance (date de la conversation, origine) ;
 *  2. filtre sensible local : rien ne part, genre NULL ;
 *  3. secrets masqués (valeur au coffre) avant tout envoi ;
 *  4. vecteurs : ceux d'`embeddings` pour un actif, sinon `fact_triage_vectors`,
 *     sinon calculés et rangés dans `fact_triage_vectors` (int8), JAMAIS dans
 *     `embeddings` ni dans l'index vec0 ;
 *  5. redite d'un ACTIF (exacte, ou par le sens ≥ 0,92 avec garde chiffres) :
 *     le genre de l'actif est hérité, aucun appel LLM ;
 *  6. amas de redites dans la source, un représentant par amas ;
 *  7. classement LLM des représentants par lots (20, deux en parallèle),
 *     sortie validée, manquants et genres hors grille renvoyés une fois ;
 *  8. auteur vérifié dans les vrais messages (idées et décisions) ;
 *  9. écriture : une transaction par lot.
 * En fin de base : amas entre sources pour les genres durables.
 *
 * Garde-fous : main rendue entre deux lots (setImmediate), requêtes par pages,
 * pause / annulation / fermeture lues entre deux lots, plafond de dépense
 * vérifié avant chaque appel, coupe-circuit après 3 échecs d'appel d'affilée
 * (les faits ne sont alors PAS marqués : ils restent à trier).
 */
import type { Database, Statement } from 'better-sqlite3'
import { completeDetailed, embedDetailed, LlmTimeoutError, LlmTruncatedError, type EmbeddingProvider, type LlmProvider } from '../llm/provider.js'
import type { ContentStore } from '../storage/content.js'
import { normalizeFact } from '../engine/selective.js'
import { sha256Hex } from '../util.js'
import { knn, listVecTables, vecTableName } from '../vector/vec-table.js'
import { judgeAuthor, loadTranscriptMessages, type TranscriptMessages } from './authorship.js'
import type { TriageBudget } from './budget.js'
import {
  clusterAsync,
  dequantizeInt8,
  dot,
  float32FromBlob,
  normalizeVector,
  numberSignature,
  quantizeInt8,
  REDITE_THRESHOLD,
  representativeOrder,
  sameNumbers,
  type AmasCandidate,
} from './dedup.js'
import { renderTriageBatch, parseTriageBatch, type ParsedTriageItem } from './prompt.js'
import { directProvenance, resolveSourceProvenance, type Provenance, type SourceRecord } from './provenance.js'
import { isSensitive } from './sensitive.js'
import { emptyRow, readTriageRows, upsertTriageRows } from './store.js'
import {
  CROSS_SOURCE_GENRES,
  TRIAGE_PROMPT_VERSION,
  TriageBudgetError,
  type Auteur,
  type Genre,
  type TriageRoots,
  type TriageRow,
  type TriageRunStatus,
  type TriageStopReason,
} from './types.js'

/** Échecs de classement d'un fait au-delà desquels il n'est plus renvoyé au LLM. */
export const MAX_LLM_FAILURES = 3
/** Échecs d'appel d'affilée qui arrêtent le passage (API en panne, quota, réseau). */
export const CIRCUIT_BREAKER_FAILURES = 3
/** Faits relus par requête lors du repérage des faits à trier. */
const SCAN_PAGE = 5000
/**
 * Lignes qu'un reclassement (`reclassify`, version de prompt changée) peut
 * réécrire (alias t = fact_triage, f = facts) : ni corrigée à la main, ni
 * sensible, ni venue de la passe sur les messages (`facts.source =
 * 'user-messages'`). Cette passe a lu le vrai message : auteur vérifié,
 * citation, accord du propriétaire, date du message. Le moteur ne relit que le
 * fait et sa source : il les effacerait. Les lignes du moteur dont l'auteur a
 * été vérifié dans la transcription (`auteur_source = 'message'`) restent
 * reclassées : la vérification est refaite au passage.
 */
const RECLASSIFY_ROW = "t.corrected_at IS NULL AND t.sensible = 0 AND f.source != 'user-messages'"
/** Taille maximale d'une unité (faits d'une source traités ensemble). */
const UNIT_MAX = 2000
/** Faits sans source regroupés par unités de cette taille. */
const LOOSE_UNIT = 200
/** Textes par appel de vecteurs. */
const EMBED_BATCH = 96
/** Voisins demandés à l'index des actifs (sur-demandés : l'index contient aussi d'anciens dormants). */
const KNN_K = 16
/** Représentants tous comparables entre eux qui fixent le plafond ci-dessous (repère historique). */
export const CROSS_SOURCE_MAX = 8000
/**
 * Comparaisons de vecteurs (1 536 composantes) au-delà desquelles l'amas entre
 * sources d'un genre est sauté (calcul trop long), et c'est dit dans l'état du
 * passage : environ une minute de calcul découpé. Un passage incrémental
 * (quelques centaines de nouveaux représentants) reste loin dessous, même
 * face à des dizaines de milliers de représentants existants.
 */
export const CROSS_SOURCE_MAX_COMPARISONS = (CROSS_SOURCE_MAX * CROSS_SOURCE_MAX) / 2
/** Jetons de sortie par fait prévus au pire (validé : 35 à 50 mesurés). */
export const MAX_OUTPUT_TOKENS_PER_FACT = 120

export interface EngineDb {
  path: string
  store: ContentStore
}

export interface EngineContext {
  dbs: EngineDb[]
  llm: LlmProvider | null
  embedder: EmbeddingProvider | null
  budget: TriageBudget
  roots: TriageRoots
  system: string
  batchSize: number
  concurrency: number
  maxFacts: number | null
  reclassify: boolean
  /** Masque les secrets (et met leur valeur au coffre). */
  redact(text: string): { text: string; secrets: number }
  /** Agent d'une instance (claude, codex, gpt…), pour `ia:<agent>`. */
  agentOf(instanceId: string | null): string
  /** Fiche Person d'un prénom cité, ou null. */
  personId(name: string): string | null
  /** Pause, annulation, fermeture. */
  shouldStop(): TriageStopReason | null
  /** Après chaque lot écrit (persistance de l'état). */
  onProgress(): void
  status: TriageRunStatus
  now(): string
  /** Pause avant la reprise d'un appel en échec passager (limite de débit, délai). */
  retryDelayMs: number
  /** Plafond de comparaisons de l'amas entre sources (défaut CROSS_SOURCE_MAX_COMPARISONS). */
  crossSourceMaxComparisons?: number
}

/** Échec passager d'un appel : limite de débit, délai dépassé, serveur saturé ou réseau. */
export function isTransient(err: unknown): boolean {
  if (err instanceof LlmTimeoutError) return true
  const message = (err as Error)?.message ?? ''
  return /\b(429|500|502|503|504)\b|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)
}

/** Connexion jamais établie (DNS introuvable, refus, réseau coupé) : la requête n'est pas partie. */
const NETWORK_DOWN_CODES = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|UND_ERR_CONNECT_TIMEOUT)\b/
/** Connexion perdue en cours d'échange : la requête a pu partir (et être facturée). */
const CONNECTION_LOST_CODES = /\b(ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CLOSED)\b/

interface ErrorParts {
  code?: unknown
  message?: unknown
  syscall?: unknown
  cause?: unknown
  errors?: unknown
}

/** L'erreur, sa cause, et les erreurs d'une AggregateError (Node essaie IPv4 puis IPv6 à la connexion). */
function errorChain(err: unknown): ErrorParts[] {
  const e = err as ErrorParts | undefined
  if (!e) return []
  const cause = e.cause as ErrorParts | undefined
  const inner = Array.isArray(cause?.errors) ? (cause.errors as ErrorParts[]) : []
  return [e, ...(cause ? [cause] : []), ...inner].filter(Boolean)
}

function chainText(chain: ErrorParts[]): string {
  return chain
    .flatMap(p => [p.code, p.message])
    .filter(v => typeof v === 'string')
    .join(' ')
}

/**
 * Réseau coupé, requête jamais partie : `fetch failed` porte le code dans `err.cause`
 * (étape `getaddrinfo` ou `connect`). Mesuré le 15/11 : des coupures DNS de quelques
 * secondes arrêtaient le tri au 3e échec d'affilée, réseau revenu ou non.
 */
export function isNetworkDown(err: unknown): boolean {
  const chain = errorChain(err)
  return chain.some(p => p.syscall === 'getaddrinfo' || p.syscall === 'connect') || NETWORK_DOWN_CODES.test(chainText(chain))
}

/**
 * Panne de réseau sans réponse HTTP (coupure, connexion perdue en route) : on attend
 * le retour du réseau au lieu de compter un échec. Une erreur HTTP n'en est pas une.
 */
export function isNetworkError(err: unknown): boolean {
  if (isNetworkDown(err)) return true
  const chain = errorChain(err)
  return /^fetch failed$/i.test(String((err as ErrorParts | undefined)?.message ?? '')) || CONNECTION_LOST_CODES.test(chainText(chain.slice(1)))
}

/** Message d'erreur avec sa cause réseau : « fetch failed » seul ne dit pas quoi faire. */
export function describeError(err: unknown): string {
  const chain = errorChain(err)
  const message = typeof chain[0]?.message === 'string' ? chain[0].message : String(err)
  const detail = chain
    .slice(1, 3)
    .flatMap(p => [p.code, p.message])
    .filter((v, i, all): v is string => typeof v === 'string' && v !== '' && all.indexOf(v) === i)
    .join(' ')
  return detail ? `${message} (cause : ${detail})` : message
}

/** Essais d'un appel quand le réseau est coupé, avant de compter un échec (≈ 9 min avec une pause de 5 s). */
export const NETWORK_DOWN_RETRIES = 12
const NETWORK_DOWN_MAX_DELAY_MS = 60_000

/** Pause doublée à chaque essai, plafonnée à une minute. */
export function networkDownDelay(baseMs: number, attempt: number): number {
  return Math.min(NETWORK_DOWN_MAX_DELAY_MS, baseMs * 2 ** attempt)
}

/** Pause en tranches d'une seconde : une annulation n'attend pas la fin d'une longue pause. */
export async function pauseUnlessStopped(ms: number, stopped: () => boolean): Promise<void> {
  const end = Date.now() + ms
  while (!stopped()) {
    const left = end - Date.now()
    if (left <= 0) return
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, left)))
  }
}

class StopSignal extends Error {
  constructor(readonly reason: TriageStopReason) {
    super(reason)
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * Délai d'un appel de tri. Un lot de 20 faits produit ~700 jetons : à 30 s (défaut
 * du fournisseur), un modèle lent coupait un appel sur six, déjà facturé (mesuré le 15/11).
 */
export const TRIAGE_LLM_TIMEOUT_MS = 90_000

/** Temps de calcul maximal entre deux retours à la boucle d'événements dans une unité (ms). */
const SLICE_MS = 10

/** Rend la main si la tranche de calcul en cours dépasse SLICE_MS (une unité peut compter 2 000 faits). */
function slicer(): () => Promise<void> {
  let start = Date.now()
  return async () => {
    if (Date.now() - start < SLICE_MS) return
    await yieldToEventLoop()
    start = Date.now()
  }
}

interface FactRecord {
  id: string
  text: string
  category: string
  created_at: string
  lifecycle_state: string
  instance_id: string | null
  norm_hash: string | null
  source_id: string | null
  failures: number
}

interface WorkFact extends FactRecord {
  prov: Provenance
  sensible: boolean
  safeText: string
  secret: boolean
  vector: Float32Array | null
  exactKey: string
}

/** Passage complet. Rend la raison d'arrêt, ou null s'il est allé au bout. */
export async function runTriagePass(ctx: EngineContext): Promise<TriageStopReason | null> {
  const failures = { consecutive: 0 }
  for (const db of ctx.dbs) {
    try {
      await new DbPass(ctx, db, failures).run()
    } catch (err) {
      if (err instanceof StopSignal) return err.reason
      throw err
    }
    ctx.status.dbs_done++
    ctx.onProgress()
  }
  return null
}

class DbPass {
  private readonly db: Database
  private readonly sources = new Map<string, Promise<Provenance>>()
  private readonly transcripts = new Map<string, Promise<TranscriptMessages | null>>()
  /** Représentants écrits par CE passage (candidats aux amas entre sources). */
  private readonly newReps = new Set<string>()
  private readonly vecTable: string | null
  /** Représentants en attente de classement, et leurs amas. */
  private readonly queue: WorkFact[] = []
  private readonly groups = new Map<string, WorkFact[]>()

  constructor(
    private readonly ctx: EngineContext,
    private readonly target: EngineDb,
    private readonly failures: { consecutive: number },
  ) {
    this.db = target.store.db
    const e = ctx.embedder
    this.vecTable = e && listVecTables(this.db).includes(vecTableName({ model: e.model, dimensions: e.dimensions })) ? vecTableName({ model: e.model, dimensions: e.dimensions }) : null
  }

  private checkStop(): void {
    const reason = this.ctx.shouldStop()
    if (reason) throw new StopSignal(reason)
    if (this.ctx.maxFacts !== null && this.ctx.status.facts_done >= this.ctx.maxFacts) throw new StopSignal('max_facts')
  }

  async run(): Promise<void> {
    for (const phase of ['active', 'dormant'] as const) {
      const pending = await this.scan(phase)
      for (const unit of units(pending)) {
        this.checkStop()
        await this.processUnit(unit, phase)
        await yieldToEventLoop()
      }
      // Fin de phase : tout est classé (les actifs avant les faits en attente, qui en héritent).
      this.checkStop()
      await this.flush(true)
    }
    this.checkStop()
    await this.crossSource()
  }

  /** Faits à trier d'une phase : (id, source), par pages de rowid. */
  private async scan(phase: 'active' | 'dormant'): Promise<Array<{ id: string; source_id: string | null }>> {
    const out: Array<{ id: string; source_id: string | null }> = []
    const stmt = this.db.prepare(
      `SELECT f.rowid AS rid, f.id AS id,
              (SELECT i.source_id FROM memory_import_items i WHERE i.target_memory_id = f.id LIMIT 1) AS source_id
       FROM facts f LEFT JOIN fact_triage t ON t.fact_id = f.id
       WHERE f.rowid > ? AND f.superseded = 0 AND f.deleted_at IS NULL AND f.lifecycle_state = ?
         AND (t.fact_id IS NULL
           OR (t.corrected_at IS NULL AND t.verdict IS NULL AND t.sensible = 0 AND t.genre IS NULL
               AND t.llm_failures BETWEEN 1 AND ${MAX_LLM_FAILURES - 1})
           OR (? = 1 AND ${RECLASSIFY_ROW}
               AND (t.prompt_version IS NULL OR t.prompt_version != ?)))
       ORDER BY f.rowid LIMIT ?`,
    )
    let last = 0
    for (;;) {
      const rows = stmt.all(last, phase, this.ctx.reclassify ? 1 : 0, TRIAGE_PROMPT_VERSION, SCAN_PAGE) as Array<{
        rid: number
        id: string
        source_id: string | null
      }>
      if (rows.length === 0) break
      for (const r of rows) out.push({ id: r.id, source_id: r.source_id })
      last = rows[rows.length - 1]!.rid
      await yieldToEventLoop()
    }
    return out
  }

  private loadFacts(ids: string[]): FactRecord[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.fact, f.category, f.created_at, f.lifecycle_state, f.assistant_instance_id, f.norm_hash,
                (SELECT i.source_id FROM memory_import_items i WHERE i.target_memory_id = f.id LIMIT 1) AS source_id,
                COALESCE(t.llm_failures, 0) AS failures
         FROM facts f LEFT JOIN fact_triage t ON t.fact_id = f.id
         WHERE f.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as Array<Record<string, unknown>>
    return rows.map(r => ({
      id: String(r.id),
      text: String(r.fact),
      category: String(r.category),
      created_at: String(r.created_at),
      lifecycle_state: String(r.lifecycle_state),
      instance_id: (r.assistant_instance_id as string | null) ?? null,
      norm_hash: (r.norm_hash as string | null) ?? null,
      source_id: (r.source_id as string | null) ?? null,
      failures: Number(r.failures ?? 0),
    }))
  }

  private provenance(fact: FactRecord): Promise<Provenance> {
    if (!fact.source_id) return Promise.resolve(directProvenance(fact.created_at))
    let p = this.sources.get(fact.source_id)
    if (!p) {
      const source = this.db
        .prepare('SELECT id AS source_id, source_type, source_path, imported_at, metadata FROM memory_sources WHERE id = ?')
        .get(fact.source_id) as SourceRecord | undefined
      p = source
        ? resolveSourceProvenance(source, {
            roots: this.ctx.roots,
            fileMtime: path => {
              const r = this.db.prepare('SELECT mtime_ms FROM transcript_file_state WHERE path = ?').get(path) as { mtime_ms: number } | undefined
              return r ? r.mtime_ms : null
            },
          })
        : Promise.resolve(directProvenance(fact.created_at))
      this.sources.set(fact.source_id, p)
    }
    return p.then(prov =>
      prov.conversation_at_source === 'creation' && prov.conversation_at === null
        ? { ...directProvenance(fact.created_at), origine: prov.origine }
        : prov,
    )
  }

  private async processUnit(ids: string[], phase: 'active' | 'dormant'): Promise<void> {
    const facts: FactRecord[] = []
    for (let i = 0; i < ids.length; i += 200) {
      facts.push(...this.loadFacts(ids.slice(i, i + 200)))
      if (i + 200 < ids.length) await yieldToEventLoop()
    }
    const work: WorkFact[] = []
    // Filtre sensible et masquage des secrets sont synchrones : découpés en tranches.
    const slice = slicer()
    for (const f of facts) {
      await slice()
      const prov = await this.provenance(f)
      const sensible = isSensitive(f.text)
      let safeText = f.text
      let secret = false
      if (!sensible) {
        const r = this.ctx.redact(f.text)
        safeText = r.text
        secret = r.secrets > 0
      }
      work.push({ ...f, prov, sensible, safeText, secret, vector: null, exactKey: f.norm_hash ?? sha256Hex(normalizeFact(f.text)) })
    }
    await this.attachVectors(work)
    const now = this.ctx.now()
    const immediate: TriageRow[] = []
    const remaining: WorkFact[] = []

    // Redites d'un fait ACTIF (phase des faits en attente seulement).
    if (phase === 'dormant') {
      for (const w of work) {
        // Une recherche de voisins par fait : découpée aussi.
        await slice()
        const active = this.activeTwin(w)
        const inherited = active ? readTriageRows(this.db, [active])[0] : undefined
        if (active && inherited && inherited.genre) {
          immediate.push({ ...this.inheritRow(w, inherited, now), same_as_active: active, amas_id: null, amas_size: 1 })
          this.ctx.status.inherited++
        } else remaining.push(w)
      }
    } else remaining.push(...work)

    // Amas dans la source.
    const candidates: AmasCandidate[] = remaining.map(w => ({
      id: w.id,
      text: w.text,
      conversation_at: w.prov.conversation_at,
      vector: w.sensible ? null : w.vector,
      exactKey: w.exactKey,
    }))
    const repOf = await clusterAsync(candidates, { shouldStop: () => this.ctx.shouldStop() !== null })
    if (this.ctx.shouldStop()) this.checkStop()
    const members = new Map<string, WorkFact[]>()
    const byId = new Map(remaining.map(w => [w.id, w]))
    for (const w of remaining) {
      const rep = repOf.get(w.id) ?? w.id
      const list = members.get(rep) ?? []
      list.push(w)
      members.set(rep, list)
    }
    const reps = [...members.keys()].map(id => byId.get(id)!).filter(Boolean)

    // Sensibles : écrits tout de suite, jamais envoyés.
    for (const rep of reps.filter(r => r.sensible)) {
      const group = members.get(rep.id)!
      for (const w of group) {
        immediate.push({
          ...this.baseRow(w, now),
          sensible: true,
          amas_id: rep.id,
          amas_size: group.length,
          raison: 'filtre sensible local',
        })
        this.ctx.status.sensible++
      }
    }
    if (immediate.length > 0) this.write(immediate)

    // Représentants mis en file : les lots du LLM se remplissent ENTRE les sources
    // (beaucoup de sources n'ont que quelques faits ; un lot par source paierait
    // le prompt système bien plus souvent).
    for (const rep of reps) {
      if (rep.sensible) continue
      this.queue.push(rep)
      this.groups.set(rep.id, members.get(rep.id) ?? [rep])
    }
    await this.flush(false)
  }

  /** Classe les lots pleins de la file (tous avec `final`, en fin de phase). */
  private async flush(final: boolean): Promise<void> {
    const size = this.ctx.batchSize
    if (!final && this.queue.length < size * this.ctx.concurrency) return
    const take = final ? this.queue.length : Math.floor(this.queue.length / size) * size
    if (take === 0) return
    const batch = this.queue.splice(0, take)
    const chunks: WorkFact[][] = []
    for (let i = 0; i < batch.length; i += size) chunks.push(batch.slice(i, i + size))
    try {
      await this.classifyChunks(chunks, this.groups, this.ctx.now())
    } finally {
      for (const w of batch) this.groups.delete(w.id)
    }
  }

  /** Vecteurs des faits non sensibles : existants (actif, ou vecteur de tri), sinon calculés et rangés à part. */
  private async attachVectors(work: WorkFact[]): Promise<void> {
    const e = this.ctx.embedder
    if (!e) return
    const fromEmb = this.db.prepare("SELECT vector, dimensions FROM embeddings WHERE owner_type = 'fact' AND owner_id = ? AND model = ?")
    const fromTriage = this.db.prepare('SELECT vector, dimensions FROM fact_triage_vectors WHERE fact_id = ? AND model = ?')
    const missing: WorkFact[] = []
    for (const w of work) {
      if (w.sensible) continue
      if (w.lifecycle_state === 'active') {
        const r = fromEmb.get(w.id, e.model) as { vector: Buffer; dimensions: number } | undefined
        if (r) {
          w.vector = float32FromBlob(r.vector, r.dimensions)
          continue
        }
      }
      const t = fromTriage.get(w.id, e.model) as { vector: Buffer; dimensions: number } | undefined
      if (t) w.vector = dequantizeInt8(t.vector, t.dimensions)
      else missing.push(w)
    }
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO fact_triage_vectors (fact_id, model, dimensions, vector) VALUES (?, ?, ?, ?)',
    )
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      this.checkStop()
      const batch = missing.slice(i, i + EMBED_BATCH)
      const chars = batch.reduce((n, w) => n + w.safeText.length, 0)
      let reservation
      try {
        reservation = this.ctx.budget.reserveEmbeddings(chars)
      } catch (err) {
        if (err instanceof TriageBudgetError) throw new StopSignal('budget')
        throw err
      }
      let vectors: Float32Array[]
      try {
        const res = await embedDetailed(e, batch.map(w => w.safeText))
        this.ctx.budget.settleEmbeddings(reservation, res.usage)
        vectors = res.vectors
        this.failures.consecutive = 0
      } catch (err) {
        this.ctx.budget.fail(reservation)
        this.syncCounters()
        this.countFailure(err)
        // Sans vecteurs, ces faits ne sont regroupés qu'à l'identique : le tri continue.
        continue
      }
      this.syncCounters()
      if (vectors.length !== batch.length) continue
      // Écriture par petites transactions : la quantification de 1 536 composantes par fait n'est pas gratuite.
      for (let from = 0; from < batch.length; from += 32) {
        this.db.transaction(() => {
          for (let k = from; k < Math.min(batch.length, from + 32); k++) {
            const v = vectors[k]!
            if (v.length !== e.dimensions) continue
            batch[k]!.vector = normalizeVector(v)
            insert.run(batch[k]!.id, e.model, e.dimensions, quantizeInt8(v))
          }
        })()
        await yieldToEventLoop()
      }
    }
  }

  /**
   * Recherche du jumeau exact par l'index (scope_id, norm_hash). Les scopes de
   * la base sont lus une fois par passage (un actif identique d'un AUTRE scope
   * de la même base compte toujours). Le `+` devant lifecycle_state écarte
   * idx_facts_lifecycle, que SQLite préférait : il parcourait alors tous les
   * actifs pour chaque fait en attente.
   */
  private exactTwinStmt: { stmt: Statement; scopes: string } | null = null

  private exactTwin(w: WorkFact): string | null {
    if (!this.exactTwinStmt) {
      const scopes = (this.db.prepare('SELECT DISTINCT scope_id FROM facts').all() as Array<{ scope_id: string }>).map(r => r.scope_id)
      this.exactTwinStmt = {
        scopes: JSON.stringify(scopes),
        stmt: this.db.prepare(
          `SELECT id FROM facts
           WHERE scope_id IN (SELECT value FROM json_each(?)) AND norm_hash = ?
             AND +lifecycle_state = 'active' AND superseded = 0 AND deleted_at IS NULL AND id != ? LIMIT 1`,
        ),
      }
    }
    const { stmt, scopes } = this.exactTwinStmt
    return (stmt.get(scopes, w.exactKey, w.id) as { id: string } | undefined)?.id ?? null
  }

  /** Fait ACTIF identique (texte) ou redite par le sens (≥ 0,92, mêmes nombres), dans cette base. */
  private activeTwin(w: WorkFact): string | null {
    const exact = this.exactTwin(w)
    if (exact) return exact
    if (w.sensible || !w.vector || !this.vecTable || !this.ctx.embedder) return null
    const e = this.ctx.embedder
    let hits: Array<{ fact_id: string }> = []
    try {
      hits = knn(this.db, { model: e.model, dimensions: e.dimensions }, w.vector, KNN_K)
    } catch {
      return null
    }
    if (hits.length === 0) return null
    const rows = this.db
      .prepare(
        `SELECT f.id, f.fact, e.vector, e.dimensions FROM facts f
         JOIN embeddings e ON e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ?
         WHERE f.id IN (SELECT value FROM json_each(?))
           AND f.lifecycle_state = 'active' AND f.superseded = 0 AND f.deleted_at IS NULL AND f.id != ?`,
      )
      .all(e.model, JSON.stringify(hits.map(h => h.fact_id)), w.id) as Array<{ id: string; fact: string; vector: Buffer; dimensions: number }>
    let best: { id: string; score: number } | null = null
    for (const r of rows) {
      const score = dot(w.vector, float32FromBlob(r.vector, r.dimensions))
      if (score >= REDITE_THRESHOLD && sameNumbers(w.text, r.fact) && (!best || score > best.score)) best = { id: r.id, score }
    }
    return best?.id ?? null
  }

  private baseRow(w: WorkFact, now: string): TriageRow {
    const row = emptyRow(w.id, now)
    row.conversation_at = w.prov.conversation_at
    row.conversation_at_source = w.prov.conversation_at_source
    row.origine = w.prov.origine
    row.secret_found = w.secret
    row.sensible = w.sensible
    row.prompt_version = TRIAGE_PROMPT_VERSION
    return row
  }

  /** Ligne d'un membre (ou d'une redite d'actif) : le classement du modèle, la provenance du fait. */
  private inheritRow(w: WorkFact, from: TriageRow, now: string): TriageRow {
    return {
      ...this.baseRow(w, now),
      genre: from.genre,
      sous_type: from.sous_type,
      rubriques: from.rubriques,
      portee: from.portee,
      person_id: from.person_id,
      auteur: from.auteur,
      // Une preuve par les messages ne vaut que pour le fait vérifié.
      auteur_source: from.auteur_source === 'message' ? 'llm' : from.auteur_source,
      durabilite: from.durabilite,
      importance: from.importance,
      autonome: from.autonome,
      projet: from.projet,
      titre: from.titre,
      entites: from.entites,
      modele: from.modele,
    }
  }

  private async classifyChunks(chunks: WorkFact[][], members: Map<string, WorkFact[]>, now: string): Promise<void> {
    let next = 0
    let stop: StopSignal | null = null
    const worker = async (limit = chunks.length): Promise<void> => {
      for (;;) {
        if (stop) return
        const reason = this.ctx.shouldStop()
        if (reason) {
          stop = new StopSignal(reason)
          return
        }
        if (next >= limit) return
        const chunk = chunks[next++]!
        try {
          const result = await this.classify(chunk, 0)
          await this.writeClassified(chunk, result, members, now)
          await yieldToEventLoop()
        } catch (err) {
          if (err instanceof StopSignal) {
            stop ??= err
            return
          }
          throw err
        }
      }
    }
    // Premier appel payant SEUL : tant qu'aucun usage réel n'est revenu, deux
    // appels en parallèle réserveraient sur l'estimation brute et pourraient
    // dépasser le plafond à eux deux (voir budget.ts).
    // Un appel en échec ne rend pas d'usage : le lot suivant part seul aussi.
    while (this.ctx.concurrency > 1 && this.ctx.budget.needsCalibration && next < chunks.length - 1 && !stop) await worker(next + 1)
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.ctx.concurrency, chunks.length - next)) }, () => worker()))
    if (stop) throw stop
  }

  /** Un appel : rend les entrées validées par id. Manquants et invalides : un renvoi, puis échec. */
  private async classify(chunk: WorkFact[], attempt: number, retried = false, outage = 0): Promise<Map<string, ParsedTriageItem>> {
    const llm = this.ctx.llm
    if (!llm) throw new StopSignal('circuit')
    const prompt = renderTriageBatch(chunk.map(w => ({ origine: w.prov.origine, cat: w.category, texte: w.safeText })))
    const maxTokens = Math.min(4096, 200 + MAX_OUTPUT_TOKENS_PER_FACT * chunk.length)
    let reservation
    try {
      reservation = this.ctx.budget.reserveCompletion(this.ctx.system.length + prompt.length, maxTokens)
    } catch (err) {
      if (err instanceof TriageBudgetError) throw new StopSignal('budget')
      throw err
    }
    let text: string
    try {
      const res = await completeDetailed(llm, {
        system: this.ctx.system,
        prompt,
        json: true,
        temperature: 0,
        maxTokens,
        timeoutMs: TRIAGE_LLM_TIMEOUT_MS,
      })
      this.ctx.budget.settleCompletion(reservation, res.usage, res.text.length)
      text = res.text
      this.failures.consecutive = 0
      if (outage > 0) this.ctx.status.error = null
    } catch (err) {
      this.ctx.budget.fail(reservation, { outputBilled: err instanceof LlmTimeoutError, notSent: isNetworkDown(err) })
      this.syncCounters()
      // Réseau coupé ou connexion perdue : on attend son retour, sans compter d'échec ; au-delà, échec ordinaire.
      if (isNetworkError(err) && outage < NETWORK_DOWN_RETRIES && !this.ctx.shouldStop()) {
        this.ctx.status.error = `réseau coupé, nouvel essai (${outage + 1}/${NETWORK_DOWN_RETRIES})`
        await pauseUnlessStopped(networkDownDelay(this.ctx.retryDelayMs, outage), () => this.ctx.shouldStop() !== null)
        this.checkStop()
        return this.classify(chunk, attempt, retried, outage + 1)
      }
      if (err instanceof LlmTruncatedError && chunk.length > 1) {
        // Sortie coupée : le lot est coupé en deux, chaque moitié repart.
        const half = Math.ceil(chunk.length / 2)
        const a = await this.classify(chunk.slice(0, half), attempt)
        const b = await this.classify(chunk.slice(half), attempt)
        return new Map([...a, ...b])
      }
      if (err instanceof LlmTruncatedError) return new Map()
      // Limite de débit, délai dépassé, serveur saturé : une seule reprise après
      // une pause, puis l'échec compte pour le coupe-circuit.
      if (!retried && isTransient(err) && !this.ctx.shouldStop()) {
        await new Promise(resolve => setTimeout(resolve, this.ctx.retryDelayMs))
        return this.classify(chunk, attempt, true, outage)
      }
      this.countFailure(err)
      return new Map()
    }
    this.syncCounters()
    const out = new Map<string, ParsedTriageItem>()
    try {
      const parsed = parseTriageBatch(text, chunk.length)
      chunk.forEach((w, i) => {
        const item = parsed.items.get(i + 1)
        if (item) out.set(w.id, item)
      })
    } catch {
      /* réponse illisible : tout le lot repart une fois */
    }
    const missing = chunk.filter(w => !out.has(w.id))
    if (missing.length > 0 && attempt === 0) {
      for (const [id, item] of await this.classify(missing, 1)) out.set(id, item)
    }
    return out
  }

  /** Échec d'appel : compté ; au 3e d'affilée, le passage s'arrête sans marquer les faits. */
  private countFailure(err: unknown): void {
    this.failures.consecutive++
    this.ctx.status.error = describeError(err)
    if (this.failures.consecutive >= CIRCUIT_BREAKER_FAILURES) throw new StopSignal('circuit')
  }

  private syncCounters(): void {
    const c = this.ctx.budget.counters
    const s = this.ctx.status
    s.spent_usd = c.spent_usd
    s.tokens_in = c.tokens_in
    s.tokens_out = c.tokens_out
    s.embed_tokens = c.embed_tokens
    s.llm_calls = c.llm_calls
    s.embed_calls = c.embed_calls
  }

  private async writeClassified(
    chunk: WorkFact[],
    result: Map<string, ParsedTriageItem>,
    members: Map<string, WorkFact[]>,
    now: string,
  ): Promise<void> {
    // Un appel en échec (API) ne marque rien : les faits restent à trier.
    if (result.size === 0 && this.failures.consecutive > 0) return
    const rows: TriageRow[] = []
    const model = this.ctx.llm ? `${this.ctx.llm.name}/${this.ctx.llm.model}` : null
    for (const rep of chunk) {
      const group = members.get(rep.id) ?? [rep]
      const item = result.get(rep.id)
      if (!item) {
        for (const w of group) {
          rows.push({
            ...this.baseRow(w, now),
            amas_id: rep.id,
            amas_size: group.length,
            llm_failures: w.failures + 1,
            raison: 'classement en échec (entrée absente ou genre hors grille)',
            modele: model,
          })
        }
        this.ctx.status.failed++
        continue
      }
      const repRow = await this.repRow(rep, item, now, model)
      repRow.amas_id = rep.id
      repRow.amas_size = group.length
      rows.push(repRow)
      this.newReps.add(rep.id)
      this.ctx.status.classified++
      for (const w of group) {
        if (w.id === rep.id) continue
        rows.push({ ...this.inheritRow(w, repRow, now), amas_id: rep.id, amas_size: group.length })
        this.ctx.status.inherited++
      }
    }
    this.write(rows)
  }

  private async repRow(rep: WorkFact, item: ParsedTriageItem, now: string, model: string | null): Promise<TriageRow> {
    const row = this.baseRow(rep, now)
    row.genre = item.genre
    row.sous_type = item.sous_type
    row.rubriques = item.rubriques
    row.portee = item.portee
    row.durabilite = item.durabilite
    row.importance = item.importance
    row.autonome = item.autonome
    row.projet = item.projet
    row.titre = item.titre
    row.entites = item.entites
    row.modele = model
    if (item.personne && !/^(owner|proprietaire|le proprietaire)$/i.test(item.personne)) {
      row.person_id = this.ctx.personId(item.personne)
      if (!row.person_id) row.raison = `personne non reliée à une fiche : ${item.personne}`
    }
    if (item.genre === 'idee' || item.genre === 'decision') {
      const agent = `ia:${this.ctx.agentOf(rep.instance_id)}` as Auteur
      // Sous-agent : « l'utilisateur » y est l'agent chef, jamais le propriétaire.
      const llmAuteur: Auteur =
        item.auteur === 'owner' ? (rep.prov.origine === 'sous-agent' ? 'inconnu' : 'owner') : item.auteur === 'assistant' ? agent : 'inconnu'
      row.auteur = llmAuteur
      row.auteur_source = llmAuteur === 'inconnu' ? 'inconnu' : 'llm'
      // Vérification par les messages : pour les IDÉES seulement (mesurée sur des
      // idées). Une décision du propriétaire est souvent reformulée par l'assistant
      // (« tu as décidé… ») : le recouvrement la donnerait à tort à l'IA.
      if (item.genre === 'idee' && rep.prov.transcript_path && rep.prov.origine === 'session') {
        const messages = await this.transcript(rep.prov.transcript_path)
        if (messages) {
          const judged = judgeAuthor(rep.safeText, messages)
          row.auteur_preuve = judged.preuve
          if (judged.verdict === 'ia') {
            row.auteur = agent
            row.auteur_source = 'message'
          } else if (judged.verdict === 'owner') {
            row.auteur = 'owner'
            row.auteur_source = 'message'
          }
        }
      }
    }
    return row
  }

  private transcript(path: string): Promise<TranscriptMessages | null> {
    let p = this.transcripts.get(path)
    if (!p) {
      if (this.transcripts.size >= 16) this.transcripts.delete(this.transcripts.keys().next().value as string)
      p = loadTranscriptMessages(path)
      this.transcripts.set(path, p)
    }
    return p
  }

  private write(rows: TriageRow[]): void {
    if (rows.length === 0) return
    const ids = rows.map(r => r.fact_id)
    this.db.transaction(() => upsertTriageRows(this.db, rows))()
    this.ctx.status.facts_done += new Set(ids).size
    this.syncCounters()
    this.ctx.onProgress()
  }

  /**
   * Amas entre sources (sessions différentes) pour les genres durables : seuls
   * les nouveaux représentants sont comparés, aux représentants existants et
   * entre eux.
   *
   * Un fait ACTIF n'est JAMAIS rattaché à un représentant EN ATTENTE : il
   * disparaîtrait de memoria_ideas (qui ne montre qu'un fait par amas). D'où
   * deux temps : les nouveaux actifs contre les actifs seulement ; puis les
   * nouveaux faits en attente contre les actifs d'abord (anciens, puis ceux
   * devenus représentants), et les faits en attente ensuite. Un actif proche
   * d'un ancien représentant en attente reste donc seul.
   *
   * Coût : le nombre de comparaisons de vecteurs, compté par signature de
   * nombres (la garde chiffres écarte les autres paires pour presque rien).
   * Au-delà de CROSS_SOURCE_MAX_COMPARISONS, le genre est sauté et c'est dit
   * dans l'état du passage (`cross_source_skipped`), pas seulement en console.
   */
  private async crossSource(): Promise<void> {
    if (this.newReps.size === 0) return
    const e = this.ctx.embedder
    const fromEmb = this.db.prepare("SELECT vector, dimensions FROM embeddings WHERE owner_type = 'fact' AND owner_id = ? AND model = ?")
    const fromTriage = this.db.prepare('SELECT vector, dimensions FROM fact_triage_vectors WHERE fact_id = ? AND model = ?')
    const shouldStop = (): boolean => this.ctx.shouldStop() !== null
    for (const genre of CROSS_SOURCE_GENRES) {
      this.checkStop()
      const reps = this.db
        .prepare(
          `SELECT t.fact_id AS id, f.fact AS text, t.conversation_at, f.norm_hash, f.lifecycle_state AS state
           FROM fact_triage t JOIN facts f ON f.id = t.fact_id
           WHERE t.genre = ? AND t.amas_id = t.fact_id AND t.sensible = 0 AND t.same_as_active IS NULL AND t.verdict IS NULL
             AND f.superseded = 0 AND f.deleted_at IS NULL AND f.lifecycle_state IN ('active','dormant')`,
        )
        .all(genre) as Array<{ id: string; text: string; conversation_at: string | null; norm_hash: string | null; state: string }>
      if (!reps.some(r => this.newReps.has(r.id))) continue

      // Signatures de nombres (découpé : plusieurs milliers de représentants par genre).
      const slice = slicer()
      const signature = new Map<string, string>()
      const bucket = new Map<string, { leaders: number; candidates: number }>()
      for (const r of reps) {
        await slice()
        const sig = numberSignature(r.text)
        signature.set(r.id, sig)
        const b = bucket.get(sig) ?? { leaders: 0, candidates: 0 }
        if (this.newReps.has(r.id)) b.candidates++
        else b.leaders++
        bucket.set(sig, b)
      }
      let comparisons = 0
      if (e) for (const b of bucket.values()) comparisons += b.candidates * (b.leaders + (b.candidates - 1) / 2)
      const cap = this.ctx.crossSourceMaxComparisons ?? CROSS_SOURCE_MAX_COMPARISONS
      if (comparisons > cap) {
        const skipped = { genre, reps: reps.length, comparisons: Math.round(comparisons) }
        this.ctx.status.cross_source_skipped = [...(this.ctx.status.cross_source_skipped ?? []).filter(x => x.genre !== genre), skipped]
        console.warn(
          `[memoria] tri : amas entre sources sautés pour « ${genre} » (${reps.length} représentants, ${skipped.comparisons} comparaisons, plafond ${cap})`,
        )
        this.ctx.onProgress()
        continue
      }

      const toCandidate = (r: (typeof reps)[number]): AmasCandidate => {
        let vector: Float32Array | null = null
        // Un ancien représentant n'est comparé par le sens qu'aux nouveaux de même
        // signature de nombres : sans eux, son vecteur ne sert à rien (le texte
        // identique, lui, reste reconnu).
        const useful = this.newReps.has(r.id) || (bucket.get(signature.get(r.id)!)?.candidates ?? 0) > 0
        if (e && useful) {
          const a = fromEmb.get(r.id, e.model) as { vector: Buffer; dimensions: number } | undefined
          if (a) vector = float32FromBlob(a.vector, a.dimensions)
          else {
            const t = fromTriage.get(r.id, e.model) as { vector: Buffer; dimensions: number } | undefined
            if (t) vector = dequantizeInt8(t.vector, t.dimensions)
          }
        }
        return { id: r.id, text: r.text, conversation_at: r.conversation_at, vector, exactKey: r.norm_hash ?? sha256Hex(normalizeFact(r.text)) }
      }
      const activeLeaders: AmasCandidate[] = []
      const pendingLeaders: AmasCandidate[] = []
      const activeCandidates: AmasCandidate[] = []
      const pendingCandidates: AmasCandidate[] = []
      const active = new Set<string>()
      for (const r of reps) {
        await slice()
        const isActive = r.state === 'active'
        if (isActive) active.add(r.id)
        const list = this.newReps.has(r.id) ? (isActive ? activeCandidates : pendingCandidates) : isActive ? activeLeaders : pendingLeaders
        list.push(toCandidate(r))
      }
      await yieldToEventLoop()
      // 1. Nouveaux actifs : contre les actifs seulement.
      const repOf = activeCandidates.length > 0 ? await clusterAsync(activeCandidates, { leaders: activeLeaders, shouldStop }) : new Map<string, string>()
      this.checkStop()
      // 2. Nouveaux faits en attente : les actifs d'abord (le premier assez proche l'emporte).
      const newActiveReps = activeCandidates.filter(c => repOf.get(c.id) === c.id).sort(representativeOrder)
      if (pendingCandidates.length > 0) {
        const pendingRepOf = await clusterAsync(pendingCandidates, { leaders: [...activeLeaders, ...newActiveReps, ...pendingLeaders], shouldStop })
        for (const [id, rep] of pendingRepOf) repOf.set(id, rep)
      }
      this.checkStop()
      const moves = [...repOf].filter(([id, rep]) => id !== rep)
      if (moves.length === 0) continue
      this.db.transaction(() => {
        const move = this.db.prepare('UPDATE fact_triage SET amas_id = ? WHERE amas_id = ?')
        const touched = new Set<string>()
        for (const [id, rep] of moves) {
          // Le représentant peut lui-même avoir été rattaché (chaîne) : on suit jusqu'au bout.
          let root = rep
          for (let guard = 0; repOf.get(root) && repOf.get(root) !== root && guard < 50; guard++) root = repOf.get(root)!
          // Garde : jamais un actif sous un représentant en attente.
          if (active.has(id) && !active.has(root)) continue
          move.run(root, id)
          touched.add(root)
        }
        const size = this.db.prepare('UPDATE fact_triage SET amas_size = (SELECT COUNT(*) FROM fact_triage t2 WHERE t2.amas_id = ?) WHERE amas_id = ?')
        for (const root of touched) size.run(root, root)
      })()
      await yieldToEventLoop()
    }
  }
}

/** Unités de travail : les faits d'une même source ensemble (bornées), les faits sans source par paquets. */
function units(pending: Array<{ id: string; source_id: string | null }>): string[][] {
  const bySource = new Map<string, string[]>()
  const loose: string[] = []
  for (const p of pending) {
    if (!p.source_id) {
      loose.push(p.id)
      continue
    }
    const list = bySource.get(p.source_id) ?? []
    list.push(p.id)
    bySource.set(p.source_id, list)
  }
  const out: string[][] = []
  for (const list of bySource.values()) for (let i = 0; i < list.length; i += UNIT_MAX) out.push(list.slice(i, i + UNIT_MAX))
  for (let i = 0; i < loose.length; i += LOOSE_UNIT) out.push(loose.slice(i, i + LOOSE_UNIT))
  return out
}

// ---------------------------------------------------------------- estimation (dry-run)

export interface EstimateCounts {
  facts_pending: number
  facts_active: number
  facts_sensible: number
  facts_to_embed: number
  /** Caractères des faits non sensibles (entrée LLM et vecteurs). */
  chars: number
}

/** Compte ce qu'un passage traiterait, sans aucun appel ni écriture. */
export async function countPending(
  dbs: EngineDb[],
  opts: { reclassify: boolean; embeddingsModel: string | null },
): Promise<EstimateCounts> {
  const out: EstimateCounts = { facts_pending: 0, facts_active: 0, facts_sensible: 0, facts_to_embed: 0, chars: 0 }
  for (const { store } of dbs) {
    const stmt = store.db.prepare(
      `SELECT f.rowid AS rid, f.fact, f.lifecycle_state,
              ${opts.embeddingsModel ? `(EXISTS (SELECT 1 FROM embeddings e WHERE e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = @model)
                OR EXISTS (SELECT 1 FROM fact_triage_vectors v WHERE v.fact_id = f.id AND v.model = @model))` : '1'} AS has_vector
       FROM facts f LEFT JOIN fact_triage t ON t.fact_id = f.id
       WHERE f.rowid > @last AND f.superseded = 0 AND f.deleted_at IS NULL AND f.lifecycle_state IN ('active','dormant')
         AND (t.fact_id IS NULL
           OR (t.corrected_at IS NULL AND t.verdict IS NULL AND t.sensible = 0 AND t.genre IS NULL
               AND t.llm_failures BETWEEN 1 AND ${MAX_LLM_FAILURES - 1})
           OR (@reclassify = 1 AND ${RECLASSIFY_ROW}
               AND (t.prompt_version IS NULL OR t.prompt_version != @version)))
       ORDER BY f.rowid LIMIT ${SCAN_PAGE}`,
    )
    let last = 0
    for (;;) {
      const params: Record<string, unknown> = { last, reclassify: opts.reclassify ? 1 : 0, version: TRIAGE_PROMPT_VERSION }
      if (opts.embeddingsModel) params.model = opts.embeddingsModel
      const rows = stmt.all(params) as Array<{ rid: number; fact: string; lifecycle_state: string; has_vector: number }>
      if (rows.length === 0) break
      // Le filtre sensible est synchrone : une page de 5 000 faits figeait la boucle ~350 ms (mesuré le 15/11).
      const slice = slicer()
      for (const r of rows) {
        await slice()
        out.facts_pending++
        if (r.lifecycle_state === 'active') out.facts_active++
        if (isSensitive(r.fact)) {
          out.facts_sensible++
          continue
        }
        out.chars += r.fact.length
        if (opts.embeddingsModel && !r.has_vector) out.facts_to_embed++
      }
      last = rows[rows.length - 1]!.rid
      await yieldToEventLoop()
    }
  }
  return out
}

/** Genre des membres et redites : réexporté pour les tests. */
export type { Genre }
