/**
 * Provider OpenAI + OpenRouter (spec §14) — API « chat completions »
 * compatible. Un seul code, deux fournisseurs :
 *  - OpenAI : base `https://api.openai.com/v1`, clé ~/.openai/api_key.
 *  - OpenRouter : base `https://openrouter.ai/api/v1`, clé ~/.openrouter/api_key
 *    (catalogue énorme : permet aussi des modèles tiers via une seule clé).
 *
 * Subtilité API : les modèles gpt-5* exigent `max_completion_tokens` (et non
 * `max_tokens`) — géré automatiquement.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmTruncatedError, type CompleteOptions, type CompletionResult, type EmbeddingProvider, type EmbeddingResult, type LlmProvider, type LlmUsage } from './provider.js'
import { assertVectorDimensions } from './embeddings-guard.js'

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini'
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export type OpenAiFlavor = 'openai' | 'openrouter'

export function defaultOpenAiKeyFile(): string {
  return join(homedir(), '.openai', 'api_key')
}
export function defaultOpenRouterKeyFile(): string {
  return join(homedir(), '.openrouter', 'api_key')
}

export interface OpenAiKeyOptions {
  apiKey?: string
  env?: NodeJS.ProcessEnv
  keyFilePath?: string
  flavor?: OpenAiFlavor
}

/** Résout la clé : param > env > fichier. null si rien. */
export function resolveOpenAiApiKey(opts: OpenAiKeyOptions = {}): string | null {
  if (opts.apiKey && opts.apiKey.trim() !== '') return opts.apiKey.trim()

  const env = opts.env ?? process.env
  const flavor = opts.flavor ?? 'openai'
  const envVar = flavor === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
  const fromEnv = env[envVar]
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()

  const keyFile = opts.keyFilePath ?? (flavor === 'openrouter' ? defaultOpenRouterKeyFile() : defaultOpenAiKeyFile())
  try {
    if (!existsSync(keyFile)) return null
    const raw = readFileSync(keyFile, 'utf8').trim()
    return raw === '' ? null : raw
  } catch (err) {
    console.warn(`[memoria:llm] clé ${flavor} illisible (${keyFile}) : ${(err as Error).message}`)
    return null
  }
}

export interface OpenAiProviderOptions extends OpenAiKeyOptions {
  model?: string
  baseUrl?: string
  timeoutMs?: number
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

/** `usage` OpenAI → mesure Memoria. `undefined` si l'API n'a rien dit. */
function usageOf(u: ChatCompletionResponse['usage']): LlmUsage | undefined {
  if (!u) return undefined
  const out: LlmUsage = {}
  if (typeof u.prompt_tokens === 'number') out.input_tokens = u.prompt_tokens
  if (typeof u.completion_tokens === 'number') out.output_tokens = u.completion_tokens
  const reasoning = u.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number') out.reasoning_tokens = reasoning
  return Object.keys(out).length > 0 ? out : undefined
}

/** Modèles à génération de tokens « completion » (gpt-5*, o1*, o3*…). */
function usesCompletionTokens(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)/.test(model)
}

/**
 * Plancher de `max_completion_tokens` sur les modèles à raisonnement : le budget
 * couvre raisonnement + réponse, et 1024 ne suffit pas à garantir qu'il reste de
 * quoi écrire la réponse une fois le raisonnement payé.
 */
const REASONING_TOKEN_FLOOR = 4096

export class OpenAiProvider implements LlmProvider {
  readonly name: string
  readonly model: string
  private readonly apiKey: string | null
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly flavor: OpenAiFlavor

  constructor(opts: OpenAiProviderOptions = {}) {
    this.flavor = opts.flavor ?? 'openai'
    this.name = this.flavor
    this.model = opts.model ?? (this.flavor === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_OPENAI_MODEL)
    this.apiKey = resolveOpenAiApiKey(opts)
    this.baseUrl = (opts.baseUrl ?? (this.flavor === 'openrouter' ? DEFAULT_OPENROUTER_BASE_URL : DEFAULT_OPENAI_BASE_URL)).replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.apiKey !== null)
  }

  async complete(opts: CompleteOptions): Promise<string> {
    return (await this.completeDetailed(opts)).text
  }

  async completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
    if (this.apiKey === null) {
      throw new Error(`${this.flavor} : aucune clé API (param, env ou fichier de clé)`)
    }

    // Le mode json_object d'OpenAI EXIGE que le mot « json » figure dans les
    // messages — on l'ajoute au system si besoin.
    let system = opts.system
    if (opts.json) {
      const hasJson = `${system ?? ''} ${opts.prompt}`.toLowerCase().includes('json')
      if (!hasJson) {
        const directive = 'Réponds uniquement avec un objet JSON valide.'
        system = system ? `${system}\n${directive}` : directive
      }
    }

    const messages: Array<{ role: string; content: string }> = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: opts.prompt })

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    }
    // gpt-5*/o* : max_completion_tokens ; autres : max_tokens.
    //
    // ⚠ Sur ces modèles, le budget couvre AUSSI les tokens de raisonnement, qui
    // sont facturés et consommés AVANT la réponse visible. Avec 1024, le
    // raisonnement absorbe tout le budget : l'API répond 200 avec un `content`
    // VIDE et `finish_reason: "length"`.
    //
    // REPRODUIT contre l'API (gpt-5-mini, prompt de 3131 tokens) :
    //   1024 sans reasoning_effort → finish_reason=length, raisonnement=1024,
    //                                content vide, 0 fait extrait ;
    //   4096 + reasoning_effort:low → finish_reason=stop, raisonnement=256,
    //                                 7 faits extraits.
    // Le seuil dépend de la LONGUEUR du tour : les tours courts passaient, les
    // longs échouaient — d'où 154 abandons intermittents et non une panne
    // franche, restée invisible dix jours.
    // On garantit donc un plancher de budget, et on demande un effort de
    // raisonnement FAIBLE : extraire des faits est une tâche structurée, pas un
    // problème de raisonnement.
    if (usesCompletionTokens(this.model)) {
      body['max_completion_tokens'] = Math.max(opts.maxTokens ?? 1024, REASONING_TOKEN_FLOOR)
      body['reasoning_effort'] = 'low'
    } else {
      body['max_tokens'] = opts.maxTokens ?? 1024
    }
    // Les modèles gpt-5*/o* ne prennent que temperature=1 (défaut) → on omet.
    if (opts.temperature !== undefined && !usesCompletionTokens(this.model)) body['temperature'] = opts.temperature
    if (opts.json) body['response_format'] = { type: 'json_object' }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }
    // OpenRouter recommande ces en-têtes d'attribution (facultatifs).
    if (this.flavor === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/Primo-Studio/openclaw-memoria'
      headers['X-Title'] = 'Memoria'
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${this.flavor} /chat/completions HTTP ${res.status} (modèle ${this.model}) : ${detail.slice(0, 200)}`)
    }
    const data = (await res.json()) as ChatCompletionResponse
    const choice = data.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string') {
      throw new Error(`réponse ${this.flavor} invalide : choices[0].message.content absent (modèle ${this.model})`)
    }
    // Budget épuisé (`finish_reason: length`) : contenu VIDE (tout parti en
    // raisonnement, cas gpt-5) ou COUPÉ en route (JSON incomplet). Dans les deux
    // cas, rendre le texte laissait l'appelant échouer plus loin sur « sans
    // JSON » / « JSON invalide » sans jamais dire POURQUOI. On expose ce qui
    // permet de trancher : la raison d'arrêt et le détail des tokens.
    const finish = choice?.finish_reason
    if (finish === 'length') {
      throw new LlmTruncatedError({
        provider: this.flavor,
        model: this.model,
        budget: usesCompletionTokens(this.model) ? Math.max(opts.maxTokens ?? 1024, REASONING_TOKEN_FLOOR) : (opts.maxTokens ?? 1024),
        empty: content.trim() === '',
        outputTokens: data.usage?.completion_tokens,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
        finishField: 'finish_reason=length',
      })
    }
    // Une réponse VIDE n'est pas une réponse, même hors troncature.
    if (content.trim() === '') {
      throw new Error(`${this.flavor} a renvoyé une réponse VIDE (modèle ${this.model}, finish_reason=${finish ?? 'inconnu'})`)
    }
    return { text: content, usage: usageOf(data.usage) }
  }
}

/** Modèle d'embeddings par défaut côté OpenAI (1536 dimensions). */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
export const DEFAULT_OPENAI_EMBEDDING_DIMENSIONS = 1536

export interface OpenAiEmbeddingProviderOptions {
  /** `undefined` = détection automatique ; `null` = explicitement aucune clé. */
  apiKey?: string | null
  env?: NodeJS.ProcessEnv
  keyFilePath?: string
  model?: string
  dimensions?: number
  baseUrl?: string
  timeoutMs?: number
}

/**
 * Embeddings OpenAI — alternative CLOUD à Ollama.
 *
 * Memoria reste local-first : Ollama garde la priorité dès qu'il est
 * disponible. Ce fournisseur existe pour les installations sans modèle local,
 * où la recherche sémantique était purement et simplement désactivée (repli FTS
 * seul, annoncé dans les logs mais irréparable sans installer Ollama).
 *
 * ⚠ Les dimensions (1536) diffèrent de nomic-embed-text (768). C'est VOULU et
 * sans danger : `dimensions` est gravé avec chaque vecteur et la garde
 * anti-768/1536 interdit toute comparaison inter-espaces. Changer de
 * fournisseur n'abîme donc aucun vecteur existant — il rend les anciens
 * inexploitables jusqu'à réindexation, ce qui est le comportement correct.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string
  readonly model: string
  readonly dimensions: number
  private readonly apiKey: string | null
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(opts: OpenAiEmbeddingProviderOptions = {}) {
    this.name = 'openai'
    this.model = opts.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL
    this.dimensions = opts.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS
    // `??` traiterait `null` comme « non renseigné » et relancerait la détection :
    // un appelant qui déclare explicitement l'absence de clé serait ignoré.
    this.apiKey =
      opts.apiKey === undefined
        ? resolveOpenAiApiKey({
            flavor: 'openai',
            ...(opts.env ? { env: opts.env } : {}),
            ...(opts.keyFilePath ? { keyFilePath: opts.keyFilePath } : {}),
          })
        : opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? 60_000
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.apiKey !== null && this.apiKey !== '')
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return (await this.embedDetailed(texts)).vectors
  }

  async embedDetailed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) return { vectors: [] }
    if (!this.apiKey) throw new Error('embeddings openai : aucune clé API disponible')
    const body: Record<string, unknown> = { model: this.model, input: texts }
    // `dimensions` n'est accepté que par les modèles v3 ; on ne l'envoie que si
    // l'appelant s'écarte du défaut du modèle.
    if (this.dimensions !== DEFAULT_OPENAI_EMBEDDING_DIMENSIONS) body['dimensions'] = this.dimensions

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`openai /embeddings HTTP ${res.status} (modèle ${this.model}) : ${detail.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>
      usage?: { prompt_tokens?: number }
    }
    const rows = data.data
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw new Error(`réponse openai /embeddings invalide : ${rows?.length ?? 0} vecteur(s) pour ${texts.length} texte(s)`)
    }
    // L'API ne garantit pas l'ordre : on réordonne sur `index` quand il est là.
    const ordered = rows.every(r => typeof r.index === 'number')
      ? [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      : rows
    const vectors = ordered.map(r => {
      const vec = r.embedding
      if (!Array.isArray(vec)) throw new Error('réponse openai /embeddings : vecteur absent')
      assertVectorDimensions(vec, this.dimensions, this.model)
      return Float32Array.from(vec)
    })
    const usage: LlmUsage | undefined =
      typeof data.usage?.prompt_tokens === 'number' ? { input_tokens: data.usage.prompt_tokens } : undefined
    return { vectors, usage }
  }
}
