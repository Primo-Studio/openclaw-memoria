/**
 * Outils communs des tests du tri. Données fictives uniquement (dépôt public).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import {
  LlmTruncatedError,
  Memoria,
  newId,
  type CompleteOptions,
  type CompletionResult,
  type EmbeddingProvider,
  type LlmProvider,
} from '../src/index.js'

/** Genre attendu d'un texte fictif, par mots-clés (le faux LLM s'en sert). */
export function genreOf(text: string): string {
  if (/tests passent|commit|build/i.test(text)) return 'ephemere'
  if (/pourrait|idée|proposer une app/i.test(text)) return 'idee'
  if (/a décidé|retenu/i.test(text)) return 'decision'
  if (/toujours|jamais/i.test(text)) return 'preference'
  if (/écrit des messages|dicte/i.test(text)) return 'style'
  return 'fait'
}

/** Erreur de `fetch` quand le DNS ne trouve pas l'hôte (forme réelle de Node : code dans `cause`). */
export function networkDownError(code = 'ENOTFOUND'): TypeError {
  const cause = Object.assign(new Error(`getaddrinfo ${code} api.exemple.test`), { code })
  return new TypeError('fetch failed', { cause })
}

export interface LlmBehaviour {
  /** Lève cette erreur à chaque appel (ou aux appels pour lesquels elle rend une erreur). */
  fail?: (call: number) => Error | null
  /** Coupe (LlmTruncatedError) tout lot plus grand que ce nombre. */
  truncateAbove?: number
  /** Omet les entrées dont le texte correspond. */
  drop?: RegExp
  /** Genre hors grille pour les entrées dont le texte correspond. */
  invalid?: RegExp
  /** Appelé avant de répondre (pause, annulation pendant un appel). */
  onCall?: (call: number) => void | Promise<void>
  /** Auteur rendu pour les idées. */
  auteur?: 'owner' | 'assistant' | 'inconnu'
  /** Usage rendu (absent : pas d'usage). */
  usage?: { input_tokens: number; output_tokens: number }
}

/** Faux LLM qui ENREGISTRE chaque prompt (système et utilisateur) et répond selon le texte. */
export class RecordingLlm implements LlmProvider {
  readonly prompts: string[] = []
  /** Délai demandé par chaque appel (undefined : celui du fournisseur). */
  readonly timeouts: Array<number | undefined> = []
  calls = 0
  constructor(
    readonly name = 'ollama',
    readonly model = 'tri-fictif',
    public behaviour: LlmBehaviour = {},
  ) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  async complete(opts: CompleteOptions): Promise<string> {
    return (await this.completeDetailed(opts)).text
  }
  async completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
    this.calls++
    this.prompts.push(`${opts.system ?? ''}\n${opts.prompt}`)
    this.timeouts.push(opts.timeoutMs)
    await this.behaviour.onCall?.(this.calls)
    const failure = this.behaviour.fail?.(this.calls)
    if (failure) throw failure
    const entries = opts.prompt
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map(l => JSON.parse(l) as { n: number; texte: string; origine: string })
    if (this.behaviour.truncateAbove !== undefined && entries.length > this.behaviour.truncateAbove) {
      throw new LlmTruncatedError({ provider: this.name, model: this.model, budget: opts.maxTokens ?? 0, empty: false, finishField: 'finish_reason=length' })
    }
    const items = entries
      .filter(e => !this.behaviour.drop?.test(e.texte))
      .map(e => {
        const genre = this.behaviour.invalid?.test(e.texte) ? 'config' : genreOf(e.texte)
        return {
          n: e.n,
          utile_3_mois: genre !== 'ephemere',
          genre,
          ...(genre === 'idee' ? { sous_type: 'app', titre: `Titre ${e.n}`, auteur: this.behaviour.auteur ?? 'assistant' } : {}),
          ...(genre === 'decision' ? { auteur: this.behaviour.auteur ?? 'owner' } : {}),
          ...(genre === 'style' || genre === 'preference' ? { personne: 'owner' } : {}),
          rubriques: genre === 'ephemere' ? [] : ['projet'],
          durabilite: genre === 'ephemere' ? 0 : 2,
          importance: genre === 'ephemere' ? 0 : 2,
          autonome: true,
          projet: 'Projet Fictif',
          entites: ['Lumen'],
        }
      })
    return { text: JSON.stringify({ items }), ...(this.behaviour.usage ? { usage: this.behaviour.usage } : {}) }
  }
}

/** Faux vecteurs : sac de mots haché sur 32 dimensions (textes proches → cosinus proche de 1). Enregistre les textes. */
export class RecordingEmbedder implements EmbeddingProvider {
  readonly texts: string[] = []
  readonly dimensions = 32
  calls = 0
  constructor(
    readonly name = 'ollama',
    readonly model = 'vec-fictif',
  ) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++
    this.texts.push(...texts)
    return Promise.resolve(texts.map(t => bagOfWords(t, this.dimensions)))
  }
}

export function bagOfWords(text: string, dims = 32): Float32Array {
  const v = new Float32Array(dims)
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .match(/[a-z]{3,}/g) ?? ['vide']
  for (const w of words) {
    let h = 2166136261
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619)
    v[Math.abs(h) % dims]! += 1
  }
  return v
}

export interface TriageEnv {
  root: string
  m: Memoria
  instance: string
  llm: RecordingLlm
  embedder: RecordingEmbedder
  claudeDir: string
  archiveDir: string
  db(): Database
  dbFor(instanceId: string): Database
  close(): void
}

/** Memoria isolé (tmpdir), faux LLM et faux vecteurs, racines des transcriptions dans le tmpdir. */
export function setupTriage(opts: { llm?: RecordingLlm; embedder?: RecordingEmbedder | null; config?: string } = {}): TriageEnv {
  const root = mkdtempSync(join(tmpdir(), 'memoria-tri-'))
  const claudeDir = join(root, 'claude-projects')
  const archiveDir = join(root, 'archive')
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(
    join(root, 'config.toml'),
    `[triage]\nclaude_projects_dir = "${claudeDir}"\narchive_dir = "${archiveDir}"\ncodex_sessions_dir = "${join(root, 'codex')}"\n${opts.config ?? ''}`,
  )
  const llm = opts.llm ?? new RecordingLlm()
  const embedder = opts.embedder === undefined ? new RecordingEmbedder() : opts.embedder
  const m = Memoria.init({
    storageRoot: join(root, 'data'),
    configPath: join(root, 'config.toml'),
    llm: { extraction: llm, embeddings: embedder },
    secretsVault: 'aes-vault',
  })
  m.cognitionDebounceMs = 60_000
  m.triage.retryDelayMs = 0
  const instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
  const dbFor = (id: string): Database =>
    (m as unknown as { openContent(p: string): { db: Database } }).openContent(m.registry.dbForInstance(id)!.path).db
  return {
    root,
    m,
    instance,
    llm,
    embedder,
    claudeDir,
    archiveDir,
    db: () => dbFor(instance),
    dbFor,
    close: () => {
      m.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Fait EN ATTENTE issu d'un import de transcription (source + item de revue), comme l'import réel. */
export function seedPending(env: TriageEnv, text: string, source?: { path: string; sourceId?: string }, instance = env.instance): string {
  const fact = env.m.storeFact({ instance, content: text, source: 'transcript-import' })
  const db = env.dbFor(instance)
  db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(fact.id)
  const sourceId = source?.sourceId ?? ensureSource(db, source?.path ?? null)
  db.prepare(
    `INSERT INTO memory_import_items (id, source_id, target_memory_id, target_type, proposed_scope_id, status, confidence)
     VALUES (?, ?, ?, 'fact', ?, 'pending', 0.8)`,
  ).run(newId(), sourceId, fact.id, fact.scope_id)
  return fact.id
}

/** Source « transcript » (une par chemin). */
export function ensureSource(db: Database, path: string | null, metadata: Record<string, unknown> = {}): string {
  const key = `src:${path ?? 'aucun'}:${JSON.stringify(metadata)}`
  const existing = db.prepare('SELECT id FROM memory_sources WHERE source_hash = ?').get(key) as { id: string } | undefined
  if (existing) return existing.id
  const id = newId()
  db.prepare(
    `INSERT INTO memory_sources (id, source_type, source_path, source_hash, imported_at, metadata) VALUES (?, 'transcript', ?, ?, ?, ?)`,
  ).run(id, path, key, '2026-01-02T03:04:05.000Z', JSON.stringify(metadata))
  return id
}

/** Transcription Claude Code fictive : une ligne sans horodatage, puis des tours datés. */
export function writeTranscript(path: string, turns: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const lines = [JSON.stringify({ type: 'summary', summary: 'Session fictive' })]
  for (const t of turns) {
    lines.push(
      JSON.stringify(
        t.role === 'user'
          ? { type: 'user', timestamp: t.ts, message: { role: 'user', content: t.text } }
          : { type: 'assistant', timestamp: t.ts, message: { role: 'assistant', content: [{ type: 'text', text: t.text }] } },
      ),
    )
  }
  writeFileSync(path, lines.join('\n') + '\n')
}

/** Ligne de tri d'un fait. */
export function triageRow(db: Database, factId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM fact_triage WHERE fact_id = ?').get(factId) as Record<string, unknown> | undefined
}
