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
import type { CompleteOptions, LlmProvider } from './provider.js'

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
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
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
    // Une réponse VIDE n'est pas une réponse. Remonter `""` laissait l'appelant
    // échouer plus loin sur « sans JSON : «  » », sans jamais dire POURQUOI.
    // On expose ici les seuls éléments qui permettent de trancher : la raison
    // d'arrêt et le détail des tokens (dont ceux de raisonnement).
    if (content.trim() === '') {
      const finish = choice?.finish_reason ?? 'inconnu'
      const usage = data.usage
      const reasoning = usage?.completion_tokens_details?.reasoning_tokens
      const budget = usesCompletionTokens(this.model)
        ? Math.max(opts.maxTokens ?? 1024, REASONING_TOKEN_FLOOR)
        : (opts.maxTokens ?? 1024)
      const hint =
        finish === 'length'
          ? ` — budget épuisé avant la réponse (max=${budget}${reasoning !== undefined ? `, raisonnement=${reasoning}` : ''}) : augmenter maxTokens ou baisser reasoning_effort`
          : ''
      throw new Error(
        `${this.flavor} a renvoyé une réponse VIDE (modèle ${this.model}, finish_reason=${finish})${hint}`,
      )
    }
    return content
  }
}
