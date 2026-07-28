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
 *  2. On ne journalise JAMAIS le contenu — seulement de quoi rendre des comptes :
 *     fournisseur, modèle, finalité, nombre d'éléments, VOLUME en caractères,
 *     durée, succès. Un journal de confidentialité qui recopierait les données
 *     serait une fuite de plus, pas une garantie.
 *
 * Le gate secrets s'applique en amont (capture.ts étape 0) : ce qui part au
 * cloud est déjà expurgé de ses secrets connus.
 */
import type { EmbeddingProvider, LlmProvider, CompleteOptions } from './provider.js'

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
}

export type CloudAuditSink = (send: CloudSend) => void

/**
 * Enveloppe un provider d'extraction. Renvoie l'original si local — inutile de
 * journaliser ce qui ne sort pas, et ça évite une indirection en pure perte.
 */
export function auditExtraction(provider: LlmProvider, sink: CloudAuditSink): LlmProvider {
  if (!isCloudProvider(provider.name)) return provider
  return {
    name: provider.name,
    model: provider.model,
    isAvailable: () => provider.isAvailable(),
    async complete(opts: CompleteOptions): Promise<string> {
      const chars = (opts.system?.length ?? 0) + opts.prompt.length
      const started = Date.now()
      try {
        const out = await provider.complete(opts)
        sink({ provider: provider.name, model: provider.model, purpose: 'extraction', items: 1, chars, ms: Date.now() - started, ok: true })
        return out
      } catch (err) {
        // Un envoi RATÉ reste un envoi : les données ont quitté la machine même
        // si la réponse n'est jamais revenue. Le taire fausserait le journal.
        sink({ provider: provider.name, model: provider.model, purpose: 'extraction', items: 1, chars, ms: Date.now() - started, ok: false })
        throw err
      }
    },
  }
}

/** Idem pour les embeddings — même règle, même discrétion. */
export function auditEmbeddings(provider: EmbeddingProvider, sink: CloudAuditSink): EmbeddingProvider {
  if (!isCloudProvider(provider.name)) return provider
  return {
    name: provider.name,
    model: provider.model,
    dimensions: provider.dimensions,
    isAvailable: () => provider.isAvailable(),
    async embed(texts: string[]): Promise<Float32Array[]> {
      const chars = texts.reduce((n, t) => n + t.length, 0)
      const started = Date.now()
      try {
        const out = await provider.embed(texts)
        sink({ provider: provider.name, model: provider.model, purpose: 'embeddings', items: texts.length, chars, ms: Date.now() - started, ok: true })
        return out
      } catch (err) {
        sink({ provider: provider.name, model: provider.model, purpose: 'embeddings', items: texts.length, chars, ms: Date.now() - started, ok: false })
        throw err
      }
    },
  }
}

/** Sérialise en `clé=valeur`, format déjà utilisé par l'audit (reparsable). */
export function formatCloudSend(s: CloudSend): string {
  return `provider=${s.provider} model=${s.model} purpose=${s.purpose} items=${s.items} chars=${s.chars} ms=${s.ms} ok=${s.ok}`
}
