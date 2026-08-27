/**
 * Compteur de consommation des modèles — TOUS les fournisseurs, locaux compris.
 *
 * Distinct du journal cloud (`cloud-audit.ts`), qui répond à « qu'est-ce qui a
 * QUITTÉ la machine ? » : ici on répond à « combien chaque modèle a-t-il
 * consommé ? » (appels, tokens en entrée/sortie, durée, échecs). Un modèle
 * local ne coûte rien, mais savoir qu'il a traité 40 000 tokens en une nuit
 * reste une information (charge machine, temps).
 *
 * Même discrétion que l'audit : on ne garde JAMAIS le contenu, seulement des
 * nombres. Les tokens viennent du fournisseur lui-même (`usage` OpenAI/
 * Anthropic, `eval_count` Ollama) — quand il ne les donne pas, on enregistre
 * `null`, pas 0 : « non mesuré » n'est pas « rien ».
 */
import {
  completeDetailed,
  embedDetailed,
  type CompleteOptions,
  type CompletionResult,
  type EmbeddingProvider,
  type EmbeddingResult,
  type LlmProvider,
  type LlmUsage,
} from './provider.js'
import { isCloudProvider } from './cloud-audit.js'

export interface LlmCall {
  provider: string
  model: string
  purpose: 'extraction' | 'embeddings'
  /** Vrai si le modèle tourne sur la machine (rien ne sort, coût nul). */
  local: boolean
  /** 1 requête d'extraction, N textes à embedder. */
  items: number
  /** Volume envoyé en caractères — jamais le contenu. */
  chars: number
  ms: number
  ok: boolean
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
}

export type UsageSink = (call: LlmCall) => void

function tokensOf(usage: LlmUsage | undefined): Pick<LlmCall, 'input_tokens' | 'output_tokens' | 'reasoning_tokens'> {
  return {
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    reasoning_tokens: usage?.reasoning_tokens ?? null,
  }
}

/** Le compteur ne doit JAMAIS faire échouer l'appel qu'il mesure. */
function safeSink(sink: UsageSink, call: LlmCall): void {
  try {
    sink(call)
  } catch (err) {
    console.warn(`[memoria:llm] compteur de consommation en erreur (ignoré) : ${(err as Error).message}`)
  }
}

/** Enveloppe un provider d'extraction : chaque appel est compté, réussi ou non. */
export function meterExtraction(provider: LlmProvider, sink: UsageSink): LlmProvider {
  const local = !isCloudProvider(provider.name)
  const run = async (opts: CompleteOptions): Promise<CompletionResult> => {
    const chars = (opts.system?.length ?? 0) + opts.prompt.length
    const started = Date.now()
    const base = { provider: provider.name, model: provider.model, purpose: 'extraction' as const, local, items: 1, chars }
    try {
      const result = await completeDetailed(provider, opts)
      safeSink(sink, { ...base, ms: Date.now() - started, ok: true, ...tokensOf(result.usage) })
      return result
    } catch (err) {
      safeSink(sink, { ...base, ms: Date.now() - started, ok: false, ...tokensOf(undefined) })
      throw err
    }
  }
  return {
    name: provider.name,
    model: provider.model,
    isAvailable: () => provider.isAvailable(),
    completeDetailed: run,
    complete: async opts => (await run(opts)).text,
  }
}

/** Idem pour les embeddings — N textes par appel. */
export function meterEmbeddings(provider: EmbeddingProvider, sink: UsageSink): EmbeddingProvider {
  const local = !isCloudProvider(provider.name)
  const run = async (texts: string[]): Promise<EmbeddingResult> => {
    const chars = texts.reduce((n, t) => n + t.length, 0)
    const started = Date.now()
    const base = { provider: provider.name, model: provider.model, purpose: 'embeddings' as const, local, items: texts.length, chars }
    try {
      const result = await embedDetailed(provider, texts)
      safeSink(sink, { ...base, ms: Date.now() - started, ok: true, ...tokensOf(result.usage) })
      return result
    } catch (err) {
      safeSink(sink, { ...base, ms: Date.now() - started, ok: false, ...tokensOf(undefined) })
      throw err
    }
  }
  return {
    name: provider.name,
    model: provider.model,
    dimensions: provider.dimensions,
    isAvailable: () => provider.isAvailable(),
    embedDetailed: run,
    embed: async texts => (await run(texts)).vectors,
  }
}
