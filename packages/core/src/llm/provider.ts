/**
 * Abstraction LLM (spec §14) — le core ne connaît AUCUN fournisseur en dur.
 * Implémentations : OllamaProvider (local, défaut), AnthropicProvider (cloud
 * opt-in, Haiku 4.5), NullProvider (aucun LLM : capture = WAL seul).
 * ⚠ Le défaut legacy `gpt-5.4-nano` (modèle INEXISTANT) est banni — aucun
 * nom de modèle en dur hors des profils de config.
 */

export interface CompleteOptions {
  system?: string
  prompt: string
  maxTokens?: number
  /** Si vrai, demande une sortie JSON (le provider fait au mieux). */
  json?: boolean
  temperature?: number
}

/**
 * Tokens consommés par UN appel, tels que rapportés par le fournisseur.
 * Champ absent = non rapporté (≠ 0) : on ne fabrique jamais une mesure.
 */
export interface LlmUsage {
  input_tokens?: number
  output_tokens?: number
  /** Sous-ensemble de `output_tokens` sur les modèles à raisonnement (gpt-5*, o*). */
  reasoning_tokens?: number
}

export interface CompletionResult {
  text: string
  usage?: LlmUsage
}

export interface EmbeddingResult {
  vectors: Float32Array[]
  usage?: LlmUsage
}

export interface LlmProvider {
  readonly name: string
  /** Modèle effectif (ex. `qwen2.5:3b`, `claude-haiku-4-5-20251001`). */
  readonly model: string
  isAvailable(): Promise<boolean>
  complete(opts: CompleteOptions): Promise<string>
  /**
   * Variante détaillée : texte + consommation. Optionnelle pour rester
   * compatible avec les providers tiers/tests qui n'implémentent que `complete`.
   */
  completeDetailed?(opts: CompleteOptions): Promise<CompletionResult>
}

export interface EmbeddingProvider {
  readonly name: string
  readonly model: string
  /** Dimensions FIXES du modèle — gravées avec chaque vecteur (anti-768/1536). */
  readonly dimensions: number
  isAvailable(): Promise<boolean>
  embed(texts: string[]): Promise<Float32Array[]>
  /** Variante détaillée : vecteurs + consommation (optionnelle, cf. `completeDetailed`). */
  embedDetailed?(texts: string[]): Promise<EmbeddingResult>
}

/**
 * Le modèle a été COUPÉ par le budget de tokens (`finish_reason: length`,
 * `stop_reason: max_tokens`, `done_reason: length`). Un JSON coupé rendu tel
 * quel échouait plus loin en « JSON invalide » sans jamais dire pourquoi : des
 * souvenirs perdus déguisés en erreur de format. Erreur typée pour que
 * l'appelant puisse retenter avec un budget plus large.
 */
export class LlmTruncatedError extends Error {
  readonly provider: string
  readonly model: string
  /** Budget de sortie demandé (tokens). */
  readonly budget: number
  constructor(opts: {
    provider: string
    model: string
    budget: number
    /** Contenu vide (tout le budget parti en raisonnement) ou coupé en route. */
    empty: boolean
    outputTokens?: number | undefined
    reasoningTokens?: number | undefined
    /** Champ d'arrêt tel que nommé par l'API (pour recouper avec ses logs). */
    finishField: string
  }) {
    const details = [`modèle ${opts.model}`, `${opts.finishField}`, `max=${opts.budget}`]
    if (opts.outputTokens !== undefined) details.push(`completion_tokens=${opts.outputTokens}`)
    if (opts.reasoningTokens !== undefined) details.push(`raisonnement=${opts.reasoningTokens}`)
    const remedy = opts.reasoningTokens !== undefined ? 'augmenter maxTokens ou baisser reasoning_effort' : 'augmenter maxTokens'
    super(
      `${opts.provider} : réponse ${opts.empty ? 'VIDE' : 'tronquée'} — budget de tokens épuisé (${details.join(', ')}) : ${remedy}`,
    )
    this.name = 'LlmTruncatedError'
    this.provider = opts.provider
    this.model = opts.model
    this.budget = opts.budget
  }
}

/** Appel détaillé si le provider le sait, sinon repli sur `complete` (usage absent). */
export async function completeDetailed(provider: LlmProvider, opts: CompleteOptions): Promise<CompletionResult> {
  if (provider.completeDetailed) return provider.completeDetailed(opts)
  return { text: await provider.complete(opts) }
}

/** Idem pour les embeddings. */
export async function embedDetailed(provider: EmbeddingProvider, texts: string[]): Promise<EmbeddingResult> {
  if (provider.embedDetailed) return provider.embedDetailed(texts)
  return { vectors: await provider.embed(texts) }
}

/** Profil de modèles par couche (spec §14) — résolu depuis config.toml. */
export interface LlmProfile {
  extraction: LlmProvider | null
  embeddings: EmbeddingProvider | null
}

/** NullProvider : pas de LLM disponible → les couches LLM se désactivent PROPREMENT (pas de mort silencieuse : l'appelant teste isAvailable). */
export class NullLlmProvider implements LlmProvider {
  readonly name = 'null'
  readonly model = 'none'
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false)
  }
  complete(): Promise<string> {
    return Promise.reject(new Error('aucun LLM configuré (NullLlmProvider)'))
  }
}
