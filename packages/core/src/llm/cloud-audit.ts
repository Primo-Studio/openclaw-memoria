/**
 * Journal des envois vers le CLOUD (retour bêta, confidentialité).
 *
 * « Comme l'extraction passe par OpenAI en cloud, l'interface devrait indiquer
 * clairement ce qui a été envoyé » — et depuis l'ajout des embeddings OpenAI, il
 * y a DEUX chemins de sortie, pas un. Sans journal, l'utilisateur n'a aucun
 * moyen de savoir ce que sa mémoire a envoyé, à qui, ni quand.
 *
 * Deux principes :
 *
 *  1. On ne journalise QUE ce qui QUITTE la machine. Un provider local (Ollama,
 *     LM Studio) est renvoyé tel quel, non enveloppé : rien ne sort, il n'y a
 *     rien à déclarer, et une installation tout-local ne paie aucun surcoût.
 *     (La CONSOMMATION, elle, est comptée pour tous — voir `usage-meter.ts`.)
 *  2. On ne journalise JAMAIS le contenu — seulement de quoi rendre des comptes :
 *     fournisseur, modèle, finalité, nombre d'éléments, VOLUME en caractères,
 *     tokens rapportés par le fournisseur, durée, succès. Un journal de
 *     confidentialité qui recopierait les données serait une fuite de plus,
 *     pas une garantie.
 *
 * Le gate secrets s'applique en amont (capture.ts étape 0) : ce qui part au
 * cloud est déjà expurgé de ses secrets connus.
 */
import {
  completeDetailed,
  embedDetailed,
  type CompleteOptions,
  type CompletionResult,
  type EmbeddingProvider,
  type EmbeddingResult,
  type LlmProvider,
} from './provider.js'

/** Fournisseurs qui font sortir des données de la machine. */
const CLOUD_PROVIDERS = new Set(['openai', 'openrouter', 'anthropic'])

export function isCloudProvider(name: string): boolean {
  return CLOUD_PROVIDERS.has(name)
}

export interface CloudSend {
  provider: string
  model: string
  purpose: 'extraction' | 'embeddings'
  /** Nombre d'éléments envoyés (1 requête d'extraction, N textes à embedder). */
  items: number
  /** Volume en CARACTÈRES — jamais le contenu lui-même. */
  chars: number
  ms: number
  ok: boolean
  /** Tokens rapportés par le fournisseur (absents s'il ne les donne pas ou si l'envoi a échoué). */
  tokens_in?: number
  tokens_out?: number
  /** Classe courte de l'échec (`http_401`, `timeout`, `network`…) — jamais le message brut. */
  error?: string
}

/**
 * Classe COURTE et stable d'une erreur de provider, pour les journaux et le
 * doctor : « 26 échecs » ne dit rien, « 20 http_429, 6 timeout » dit quoi
 * faire. Jamais le message brut (il peut contenir un extrait de réponse).
 */
export function classifyLlmError(err: unknown): string {
  if (!(err instanceof Error)) return 'other'
  const msg = err.message
  if (err.name === 'TimeoutError' || err.name === 'LlmTimeoutError' || /délai dépassé/.test(msg)) return 'timeout'
  if (err.name === 'LlmTruncatedError' || /tronquée|budget de tokens/.test(msg)) return 'truncated'
  const http = /HTTP (\d{3})/.exec(msg)
  if (http) return `http_${http[1]}`
  if (err.name === 'TypeError' || /fetch failed|ECONNREFUSED|ENOTFOUND|injoignable/i.test(msg)) return 'network'
  if (/invalide|absent/.test(msg)) return 'invalid_response'
  return 'other'
}

export type CloudAuditSink = (send: CloudSend) => void

/**
 * Enveloppe un provider d'extraction. Renvoie l'original si local — inutile de
 * journaliser ce qui ne sort pas, et ça évite une indirection en pure perte.
 */
export function auditExtraction(provider: LlmProvider, sink: CloudAuditSink): LlmProvider {
  if (!isCloudProvider(provider.name)) return provider
  const run = async (opts: CompleteOptions): Promise<CompletionResult> => {
    const chars = (opts.system?.length ?? 0) + opts.prompt.length
    const started = Date.now()
    try {
      const out = await completeDetailed(provider, opts)
      sink({
        provider: provider.name,
        model: provider.model,
        purpose: 'extraction',
        items: 1,
        chars,
        ms: Date.now() - started,
        ok: true,
        ...(out.usage?.input_tokens !== undefined ? { tokens_in: out.usage.input_tokens } : {}),
        ...(out.usage?.output_tokens !== undefined ? { tokens_out: out.usage.output_tokens } : {}),
      })
      return out
    } catch (err) {
      // Un envoi RATÉ reste un envoi : les données ont quitté la machine même
      // si la réponse n'est jamais revenue. Le taire fausserait le journal.
      sink({ provider: provider.name, model: provider.model, purpose: 'extraction', items: 1, chars, ms: Date.now() - started, ok: false, error: classifyLlmError(err) })
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

/** Idem pour les embeddings — même règle, même discrétion. */
export function auditEmbeddings(provider: EmbeddingProvider, sink: CloudAuditSink): EmbeddingProvider {
  if (!isCloudProvider(provider.name)) return provider
  const run = async (texts: string[]): Promise<EmbeddingResult> => {
    const chars = texts.reduce((n, t) => n + t.length, 0)
    const started = Date.now()
    try {
      const out = await embedDetailed(provider, texts)
      sink({
        provider: provider.name,
        model: provider.model,
        purpose: 'embeddings',
        items: texts.length,
        chars,
        ms: Date.now() - started,
        ok: true,
        ...(out.usage?.input_tokens !== undefined ? { tokens_in: out.usage.input_tokens } : {}),
      })
      return out
    } catch (err) {
      sink({ provider: provider.name, model: provider.model, purpose: 'embeddings', items: texts.length, chars, ms: Date.now() - started, ok: false, error: classifyLlmError(err) })
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

/** Sérialise en `clé=valeur`, format déjà utilisé par l'audit (reparsable). */
export function formatCloudSend(s: CloudSend): string {
  let out = `provider=${s.provider} model=${s.model} purpose=${s.purpose} items=${s.items} chars=${s.chars} ms=${s.ms} ok=${s.ok}`
  if (s.tokens_in !== undefined) out += ` tokens_in=${s.tokens_in}`
  if (s.tokens_out !== undefined) out += ` tokens_out=${s.tokens_out}`
  if (s.error !== undefined) out += ` err=${s.error}`
  return out
}
