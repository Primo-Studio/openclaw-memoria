/**
 * Sous-système LLM (spec §14) — factory de profils + exports.
 * resolveLlmProfile() ne retourne QUE des providers vérifiés disponibles :
 * jamais un nom de modèle inexistant (anti-exemple legacy : `gpt-5.4-nano`).
 * Ce qui n'est pas disponible vaut null — les couches LLM se désactivent
 * PROPREMENT, l'appelant teste isAvailable().
 */
import type { MemoriaConfig } from '../config.js'
import type { EmbeddingProvider, LlmProfile, LlmProvider } from './provider.js'
import { AnthropicProvider } from './anthropic.js'
import { DEFAULT_LOCAL_EXTRACTION_MODEL, OllamaEmbeddingProvider, OllamaProvider } from './ollama.js'
import { LmStudioProvider } from './lmstudio.js'
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  OpenAiProvider,
  OpenAiEmbeddingProvider,
  resolveOpenAiApiKey,
} from './openai.js'

export type {
  CompleteOptions,
  EmbeddingProvider,
  LlmProfile,
  LlmProvider,
} from './provider.js'
export { NullLlmProvider } from './provider.js'
export {
  DEFAULT_LOCAL_EXTRACTION_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_EMBEDDING_DIMENSIONS,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  OllamaEmbeddingProvider,
  OllamaProvider,
  modelMatches,
} from './ollama.js'
export type { OllamaEmbeddingProviderOptions, OllamaProviderOptions } from './ollama.js'
export {
  DEFAULT_LMSTUDIO_BASE_URL,
  LMSTUDIO_AUTO_MODEL,
  LmStudioProvider,
  lmstudioListModels,
} from './lmstudio.js'
export type { LmStudioModelsResult, LmStudioProviderOptions } from './lmstudio.js'
export {
  copyOpenClawKey,
  writeProviderKey,
  defaultHasCommand,
  detectLlmOptions,
  scanOpenClawCredentials,
} from './detect.js'
export type {
  ApiKeyOption,
  CopyOpenClawKeyResult,
  DetectLlmOptionsInput,
  LlmOptions,
  LmStudioOption,
  OllamaOption,
  OpenClawKeyCandidate,
  OpenClawOption,
  OpenClawScan,
  ReusableProvider,
} from './detect.js'
export {
  ANTHROPIC_API_VERSION,
  AnthropicProvider,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  defaultAnthropicKeyFile,
  resolveAnthropicApiKey,
} from './anthropic.js'
export type { AnthropicKeyOptions, AnthropicProviderOptions } from './anthropic.js'
export {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_BASE_URL,
  OpenAiProvider,
  OpenAiEmbeddingProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  resolveOpenAiApiKey,
  defaultOpenAiKeyFile,
  defaultOpenRouterKeyFile,
} from './openai.js'
export type { OpenAiKeyOptions, OpenAiProviderOptions, OpenAiFlavor, OpenAiEmbeddingProviderOptions } from './openai.js'
export { assertVectorDimensions, cosineSimilarity } from './embeddings-guard.js'
export { auditExtraction, auditEmbeddings, isCloudProvider, formatCloudSend } from './cloud-audit.js'
export * from './usage-meter.js'
export * from './pricing.js'
export type { CloudSend, CloudAuditSink } from './cloud-audit.js'

export type LlmProfileName = '100-local' | 'local-plus-cloud' | 'cloud'

export interface ResolveLlmProfileOptions {
  /** URL du serveur Ollama (défaut http://127.0.0.1:11434). */
  ollamaBaseUrl?: string
  /** URL du serveur LM Studio (défaut http://127.0.0.1:1234/v1). */
  lmstudioBaseUrl?: string
  /** Environnement injectable pour les tests. */
  env?: NodeJS.ProcessEnv
  /** Chemin du fichier de clé Anthropic, injectable pour les tests. */
  anthropicKeyFile?: string
  /**
   * Chemin du fichier de clé OpenAI, injectable pour les tests.
   *
   * Sans lui, `resolveOpenAiApiKey` retombe sur le fichier de HOME : un test
   * lancé sur une machine réellement configurée lisait la VRAIE clé et passait
   * (ou échouait) pour de mauvaises raisons. Même exigence que pour Anthropic.
   */
  openaiKeyFile?: string
  /**
   * Modèles déjà présents en base (`SELECT DISTINCT model FROM embeddings`).
   * Si fourni, l'avertissement de non-comparabilité n'est émis QUE s'il existe
   * au moins un modèle différent de celui retenu — plus de cri au loup à chaque
   * boot OpenAI quand la base est déjà homogène.
   */
  knownEmbeddingModels?: readonly string[]
}

function normalizeProfileName(raw: string | undefined): LlmProfileName {
  if (raw === undefined || raw === '100-local' || raw === 'custom') return raw === 'custom' ? '100-local' : '100-local'
  if (raw === 'local-plus-cloud' || raw === 'cloud') return raw
  console.warn(`[memoria:llm] profil LLM inconnu « ${raw} » — repli sur 100-local`)
  return '100-local'
}

/** Construit un provider d'extraction nommé explicitement, ou null si indispo. */
async function buildExplicitProvider(
  provider: string,
  model: string | undefined,
  opts: ResolveLlmProfileOptions,
  baseUrl?: string,
): Promise<LlmProvider | null> {
  let p: LlmProvider | null = null
  switch (provider) {
    case 'ollama':
      p = new OllamaProvider({ model: model ?? DEFAULT_LOCAL_EXTRACTION_MODEL, baseUrl: baseUrl ?? opts.ollamaBaseUrl })
      break
    case 'lmstudio':
      p = new LmStudioProvider({ ...(model ? { model } : {}), baseUrl: baseUrl ?? opts.lmstudioBaseUrl })
      break
    case 'anthropic':
      p = new AnthropicProvider({ env: opts.env, keyFilePath: opts.anthropicKeyFile, ...(model ? { model } : {}) })
      break
    case 'openai':
      p = new OpenAiProvider({
        flavor: 'openai',
        env: opts.env,
        ...(opts.openaiKeyFile ? { keyFilePath: opts.openaiKeyFile } : {}),
        model: model ?? DEFAULT_OPENAI_MODEL,
      })
      break
    case 'openrouter':
      p = new OpenAiProvider({
        flavor: 'openrouter',
        env: opts.env,
        ...(opts.openaiKeyFile ? { keyFilePath: opts.openaiKeyFile } : {}),
        model: model ?? DEFAULT_OPENROUTER_MODEL,
      })
      break
    default:
      console.warn(`[memoria:llm] provider inconnu « ${provider} »`)
      return null
  }
  return (await p.isAvailable()) ? p : null
}

/**
 * Dimensions connues par modèle d'embedding.
 *
 * Les dimensions sont GRAVÉES avec chaque vecteur (cf. `assertVectorDimensions`) :
 * en déduire une fausse corrompt la base silencieusement. Épingler
 * `text-embedding-3-large` (3072d) en héritant du défaut 1536 produirait
 * exactement ce dégât — d'où cette table, et un avertissement franc quand le
 * modèle demandé n'y figure pas.
 */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
}

/** Choix explicite du provider d'embeddings, ou null si indisponible/inconnu. */
async function buildExplicitEmbeddings(
  provider: string,
  model: string | undefined,
  dimensions: number | undefined,
  opts: ResolveLlmProfileOptions,
  baseUrl?: string,
): Promise<EmbeddingProvider | null> {
  // Dimensions : config > table connue > défaut du provider. On n'avertit que
  // si le modèle est nommé ET inconnu ET sans dimensions déclarées : c'est le
  // seul cas où le défaut a des chances d'être faux.
  const known = model ? EMBEDDING_DIMENSIONS[model] : undefined
  if (model && known === undefined && dimensions === undefined) {
    console.warn(
      `[memoria:llm] dimensions inconnues pour le modèle d'embeddings « ${model} » — ` +
        `le défaut du provider sera utilisé. Si elles diffèrent, déclare llm.embeddings.dimensions : ` +
        `les dimensions sont gravées avec chaque vecteur et une valeur fausse corrompt la base.`,
    )
  }
  const dims = dimensions ?? known

  let p: EmbeddingProvider | null = null
  switch (provider) {
    case 'ollama':
      p = new OllamaEmbeddingProvider({
        ...(model ? { model } : {}),
        ...(dims ? { dimensions: dims } : {}),
        baseUrl: baseUrl ?? opts.ollamaBaseUrl,
      })
      break
    case 'openai':
      p = new OpenAiEmbeddingProvider({
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.openaiKeyFile ? { keyFilePath: opts.openaiKeyFile } : {}),
        ...(model ? { model } : {}),
        ...(dims ? { dimensions: dims } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      })
      break
    default:
      console.warn(`[memoria:llm] provider d'embeddings inconnu « ${provider} » — repli sur la détection automatique`)
      return null
  }
  return (await p.isAvailable()) ? p : null
}

/**
 * Résout le profil LLM depuis la config :
 * - '100-local'       : extraction Ollama qwen2.5:3b · embeddings Ollama nomic-embed-text.
 * - 'local-plus-cloud': extraction Anthropic Haiku si clé, sinon Ollama · embeddings Ollama.
 * - 'cloud'           : extraction Anthropic si clé · embeddings Ollama.
 *
 * `llm.extraction` et `llm.embeddings` priment chacun sur le profil pour leur
 * couche : le profil est un raccourci, pas une contrainte.
 * Chaque slot indisponible vaut null (et c'est dit dans les logs).
 */
export async function resolveLlmProfile(
  config: MemoriaConfig,
  opts: ResolveLlmProfileOptions = {},
): Promise<LlmProfile> {
  const ollamaExtraction = new OllamaProvider({
    model: DEFAULT_LOCAL_EXTRACTION_MODEL,
    baseUrl: opts.ollamaBaseUrl,
  })
  const ollamaEmbeddings = new OllamaEmbeddingProvider({ baseUrl: opts.ollamaBaseUrl })
  const anthropic = new AnthropicProvider({ env: opts.env, keyFilePath: opts.anthropicKeyFile })

  let extraction: LlmProvider | null = null

  // 1) Choix EXPLICITE du provider/modèle (prioritaire) — le « l'utilisateur décide ».
  const explicit = config.llm?.extraction
  if (explicit?.provider) {
    extraction = await buildExplicitProvider(explicit.provider, explicit.model, opts, explicit.base_url)
    if (extraction === null) {
      console.warn(`[memoria:llm] provider d'extraction « ${explicit.provider} » indisponible (clé/modèle ?) — repli profil`)
    }
  }

  // 2) Sinon, profil raccourci.
  if (extraction === null) {
    const profile = normalizeProfileName(config.llm?.profile)
    switch (profile) {
      case '100-local':
        extraction = (await ollamaExtraction.isAvailable()) ? ollamaExtraction : null
        break
      case 'local-plus-cloud':
        if (await anthropic.isAvailable()) extraction = anthropic
        else extraction = (await ollamaExtraction.isAvailable()) ? ollamaExtraction : null
        break
      case 'cloud':
        extraction = (await anthropic.isAvailable()) ? anthropic : null
        break
    }
  }

  // Embeddings — (0) choix EXPLICITE, (1) Ollama, (2) repli cloud.
  //
  // Le choix explicite prime sur tout : la détection automatique préfère Ollama
  // dès qu'il RÉPOND, ce qui suffisait à faire rebasculer les embeddings en local
  // le jour où un Ollama tournait pour un autre projet — et à remplir la base de
  // vecteurs de deux modèles différents, non comparables entre eux. Un parc qui a
  // choisi le cloud (machines trop justes pour du local) doit pouvoir l'épingler.
  //
  // Il prime AUSSI sur la garde `cloudAllowed` ci-dessous : elle protège d'un
  // départ vers le cloud SUBI, pas d'un départ DEMANDÉ. Nommer openai dans sa
  // config est une action explicite — c'est précisément ce que le principe
  // local-first réserve à l'utilisateur. L'audit cloud (`auditEmbeddings`)
  // continue de journaliser chaque envoi dans tous les cas.
  let embeddings: EmbeddingProvider | null = null
  const explicitEmbeddings = config.llm?.embeddings
  if (explicitEmbeddings?.provider) {
    embeddings = await buildExplicitEmbeddings(
      explicitEmbeddings.provider,
      explicitEmbeddings.model,
      explicitEmbeddings.dimensions,
      opts,
      explicitEmbeddings.base_url,
    )
    if (embeddings === null) {
      console.warn(
        `[memoria:llm] provider d'embeddings « ${explicitEmbeddings.provider} » indisponible ` +
          `(clé/modèle ?) — repli sur la détection automatique`,
      )
    }
  }

  // (1) LOCAL-FIRST : Ollama garde la priorité dès qu'il est disponible, quel que
  // soit le profil. Une installation tout-local conserve exactement le
  // comportement d'avant.
  //
  // (2) Repli CLOUD (OpenAI) seulement si Ollama n'a pas le modèle : sans lui, une
  // machine sans modèle local n'avait AUCUNE recherche sémantique, et le seul
  // remède était d'installer Ollama. Anthropic n'expose pas d'embeddings, d'où
  // le choix d'OpenAI ici.
  // Le repli cloud n'est autorisé QUE si l'extraction passe déjà par OpenAI :
  // même fournisseur, donc aucun nouveau destinataire des données. Un profil
  // 100-local, ou une extraction Anthropic/LM Studio, ne doit JAMAIS voir ses
  // souvenirs partir vers un tiers pour cause d'embeddings manquants.
  const openaiEmbeddings = new OpenAiEmbeddingProvider({
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.openaiKeyFile ? { keyFilePath: opts.openaiKeyFile } : {}),
  })
  const cloudAllowed = extraction?.name === 'openai'
  if (embeddings !== null) {
    /* choix explicite honoré : ni détection, ni repli */
  } else if (await ollamaEmbeddings.isAvailable()) {
    embeddings = ollamaEmbeddings
  } else if (cloudAllowed && (await openaiEmbeddings.isAvailable())) {
    embeddings = openaiEmbeddings
  }

  if (extraction === null) {
    console.warn(`[memoria:llm] aucun provider d'extraction disponible — couches LLM d'extraction désactivées`)
  }
  if (embeddings === null) {
    console.warn(`[memoria:llm] embeddings indisponibles — recherche sémantique désactivée (FTS seul)`)
  } else {
    // Avertissement cross-modèle : uniquement si la base est connue ET hétérogène.
    // Sans knownEmbeddingModels, silence (évite le faux positif à chaque boot).
    maybeWarnEmbeddingMismatch(embeddings.model, opts.knownEmbeddingModels)
  }

  return { extraction, embeddings }
}

/**
 * Émet l'avertissement cross-modèle uniquement si la base expose déjà des
 * vecteurs d'un autre modèle que celui retenu.
 */
export function maybeWarnEmbeddingMismatch(
  activeModel: string,
  knownModels: readonly string[] | undefined,
): void {
  if (!knownModels || knownModels.length === 0) return
  const foreign = knownModels.filter(m => m !== activeModel)
  if (foreign.length === 0) return
  console.warn(
    `[memoria:llm] embeddings actifs « ${activeModel} » alors que la base contient ` +
      `déjà [${foreign.join(', ')}] — vecteurs non comparables entre modèles : ` +
      `le rattrapage d'indexation (boot daemon) comble les faits manquants pour le modèle actif ; ` +
      `les anciens vecteurs restent sous leur propre model.`,
  )
}
