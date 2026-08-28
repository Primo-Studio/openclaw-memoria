/**
 * Tests du sous-système LLM (spec §14/§16) : fetch 100 % mocké (jamais de
 * réseau), HOME jamais touché (clé Anthropic via fichier tmp injecté).
 * Chaque chemin actif prouve qu'il S'EXÉCUTE — y compris les chemins d'erreur
 * (HTTP 500, réseau KO) qui doivent être BRUYANTS, pas silencieux.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_EXTRACTION_MODEL,
  OllamaEmbeddingProvider,
  OllamaProvider,
  assertVectorDimensions,
  cosineSimilarity,
  resolveAnthropicApiKey,
  resolveLlmProfile,
} from '../src/llm/index.js'

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn<FetchFn>>
let warnSpy: ReturnType<typeof vi.spyOn>
let tmp: string

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Corps JSON envoyé au i-ème appel fetch mocké. */
function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'memoria-llm-test-'))
  fetchMock = vi.fn<FetchFn>()
  vi.stubGlobal('fetch', fetchMock)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe('OllamaProvider', () => {
  it('complete : POST /api/chat avec stream:false, num_predict, format json', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: { role: 'assistant', content: '{"ok":true}' } }))
    const p = new OllamaProvider({ model: 'qwen2.5:3b', baseUrl: 'http://127.0.0.1:11434' })
    const out = await p.complete({ system: 'Tu extrais des faits.', prompt: 'extrais', json: true, maxTokens: 256 })
    expect(out).toBe('{"ok":true}')

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/api/chat')
    const body = sentBody()
    expect(body['model']).toBe('qwen2.5:3b')
    expect(body['stream']).toBe(false)
    expect(body['format']).toBe('json')
    expect((body['options'] as Record<string, unknown>)['num_predict']).toBe(256)
    expect(body['messages']).toEqual([
      { role: 'system', content: 'Tu extrais des faits.' },
      { role: 'user', content: 'extrais' },
    ])
  })

  it('complete : HTTP 500 → erreur claire (pas silencieuse)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom interne', { status: 500 }))
    const p = new OllamaProvider({ model: 'qwen2.5:3b' })
    await expect(p.complete({ prompt: 'x' })).rejects.toThrow(/HTTP 500.*qwen2\.5:3b/)
  })

  it('complete : réponse sans message.content → erreur explicite', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ done: true }))
    const p = new OllamaProvider({ model: 'qwen2.5:3b' })
    await expect(p.complete({ prompt: 'x' })).rejects.toThrow(/message\.content absent/)
  })

  it('isAvailable : true si /api/tags liste le modèle (tag :latest accepté)', async () => {
    // Réponse fraîche à chaque appel : un body de Response ne se lit qu'une fois.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ models: [{ name: 'qwen2.5:3b' }, { name: 'nomic-embed-text:latest' }] }),
    )
    await expect(new OllamaProvider({ model: 'qwen2.5:3b' }).isAvailable()).resolves.toBe(true)
    await expect(new OllamaEmbeddingProvider({ model: 'nomic-embed-text' }).isAvailable()).resolves.toBe(true)
    await expect(new OllamaProvider({ model: 'gemma3:4b' }).isAvailable()).resolves.toBe(false)
  })

  it('isAvailable : réseau KO → false + console.warn (jamais avalé en silence)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(new OllamaProvider({ model: 'qwen2.5:3b' }).isAvailable()).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ollama injoignable'))
  })

  it('isAvailable : /api/tags HTTP 500 → false + warn', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ko', { status: 500 }))
    await expect(new OllamaProvider({ model: 'qwen2.5:3b' }).isAvailable()).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))
  })
})

describe('OllamaEmbeddingProvider', () => {
  it('embed : POST /api/embed batch → Float32Array aux bonnes dimensions', async () => {
    const vec = Array.from({ length: 768 }, (_, i) => i / 768)
    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [vec, vec] }))
    const p = new OllamaEmbeddingProvider()
    expect(p.model).toBe('nomic-embed-text')
    expect(p.dimensions).toBe(768)

    const out = await p.embed(['a', 'b'])
    expect(out).toHaveLength(2)
    expect(out[0]).toBeInstanceOf(Float32Array)
    expect(out[0]!.length).toBe(768)
    const body = sentBody()
    expect(body['model']).toBe('nomic-embed-text')
    expect(body['input']).toEqual(['a', 'b'])
  })

  it('GARDE anti-768/1536 : vecteur 1536 sur provider déclaré 768 → throw', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [new Array(1536).fill(0.5)] }))
    const p = new OllamaEmbeddingProvider()
    await expect(p.embed(['a'])).rejects.toThrow(/reçu 1536, attendu 768/)
  })

  it('embed : HTTP 500 → erreur claire ; nombre de vecteurs ≠ nombre de textes → throw', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ko', { status: 500 }))
    const p = new OllamaEmbeddingProvider()
    await expect(p.embed(['a'])).rejects.toThrow(/HTTP 500/)

    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [] }))
    await expect(p.embed(['a'])).rejects.toThrow(/0 vecteurs pour 1 textes/)
  })

  it('embed([]) : aucun appel réseau, retour []', async () => {
    await expect(new OllamaEmbeddingProvider().embed([])).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('embeddings-guard', () => {
  it('cosineSimilarity : identiques → 1, orthogonaux → 0', () => {
    const a = Float32Array.from([1, 0, 0])
    expect(cosineSimilarity(a, Float32Array.from([1, 0, 0]))).toBeCloseTo(1)
    expect(cosineSimilarity(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0)
  })

  it('cosineSimilarity inter-dimensions → THROW (le legacy retournait 0 en silence)', () => {
    const a = new Float32Array(768)
    const b = new Float32Array(1536)
    expect(() => cosineSimilarity(a, b)).toThrow(/768 vs 1536/)
    expect(() => cosineSimilarity(new Float32Array(0), new Float32Array(0))).toThrow(/vides/)
  })

  it('assertVectorDimensions : mauvaise taille → throw nommant le modèle', () => {
    expect(() => assertVectorDimensions(new Float32Array(1536), 768, 'nomic-embed-text')).toThrow(
      /nomic-embed-text.*reçu 1536, attendu 768/,
    )
    expect(() => assertVectorDimensions(new Float32Array(768), 768, 'nomic-embed-text')).not.toThrow()
  })
})

describe('AnthropicProvider', () => {
  it('clé : param > env > fichier (chemin injecté, jamais le vrai HOME)', () => {
    const keyFile = join(tmp, 'api_key')
    writeFileSync(keyFile, 'sk-ant-fichier\n', 'utf8')
    expect(resolveAnthropicApiKey({ apiKey: 'sk-param', env: { ANTHROPIC_API_KEY: 'sk-env' }, keyFilePath: keyFile })).toBe('sk-param')
    expect(resolveAnthropicApiKey({ env: { ANTHROPIC_API_KEY: 'sk-env' }, keyFilePath: keyFile })).toBe('sk-env')
    expect(resolveAnthropicApiKey({ env: {}, keyFilePath: keyFile })).toBe('sk-ant-fichier')
    expect(resolveAnthropicApiKey({ env: {}, keyFilePath: join(tmp, 'absent') })).toBeNull()
  })

  it('isAvailable : clé présente → true SANS appel réseau ; absente → false', async () => {
    const keyFile = join(tmp, 'api_key')
    writeFileSync(keyFile, 'sk-ant-test', 'utf8')
    const avec = new AnthropicProvider({ env: {}, keyFilePath: keyFile })
    const sans = new AnthropicProvider({ env: {}, keyFilePath: join(tmp, 'absent') })
    await expect(avec.isAvailable()).resolves.toBe(true)
    await expect(sans.isAvailable()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(avec.model).toBe(DEFAULT_ANTHROPIC_MODEL)
  })

  it('complete : POST /v1/messages avec headers x-api-key + anthropic-version, extrait content[0].text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'fait extrait' }] }))
    const p = new AnthropicProvider({ apiKey: 'sk-ant-test', env: {}, keyFilePath: join(tmp, 'absent') })
    const out = await p.complete({ system: 'extrais', prompt: 'texte', maxTokens: 512 })
    expect(out).toBe('fait extrait')

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.anthropic.com/v1/messages')
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = sentBody()
    expect(body['model']).toBe(DEFAULT_ANTHROPIC_MODEL)
    expect(body['max_tokens']).toBe(512)
    expect(body['messages']).toEqual([{ role: 'user', content: 'texte' }])
  })

  it('complete : HTTP 500 → erreur claire ; sans clé → erreur SANS appel réseau', async () => {
    fetchMock.mockResolvedValueOnce(new Response('overloaded', { status: 500 }))
    const avec = new AnthropicProvider({ apiKey: 'sk-ant-test', env: {}, keyFilePath: join(tmp, 'absent') })
    await expect(avec.complete({ prompt: 'x' })).rejects.toThrow(/HTTP 500.*overloaded/)

    const sans = new AnthropicProvider({ env: {}, keyFilePath: join(tmp, 'absent') })
    await expect(sans.complete({ prompt: 'x' })).rejects.toThrow(/aucune clé API/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('resolveLlmProfile', () => {
  const noKey = () => ({ env: {} as NodeJS.ProcessEnv, anthropicKeyFile: join(tmp, 'absent') })
  /** Implémentation fetch : /api/tags frais à chaque appel (body single-use). */
  const tagsWithAll = async (): Promise<Response> =>
    jsonResponse({ models: [{ name: 'qwen2.5:3b' }, { name: 'nomic-embed-text:latest' }] })

  it('rien de disponible (réseau KO, pas de clé) → tout null, et c’est dit dans les logs', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const profile = await resolveLlmProfile({ llm: { profile: '100-local' } }, noKey())
    expect(profile.extraction).toBeNull()
    expect(profile.embeddings).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("aucun provider d'extraction"))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('embeddings indisponibles'))
  })

  it('100-local : Ollama dispo → extraction qwen2.5:3b + embeddings nomic-embed-text', async () => {
    fetchMock.mockImplementation(tagsWithAll)
    const profile = await resolveLlmProfile({}, noKey()) // défaut = 100-local
    expect(profile.extraction?.name).toBe('ollama')
    expect(profile.extraction?.model).toBe(DEFAULT_LOCAL_EXTRACTION_MODEL)
    expect(profile.embeddings?.model).toBe('nomic-embed-text')
    expect(profile.embeddings?.dimensions).toBe(768)
  })

  it('local-plus-cloud : clé présente → extraction Anthropic Haiku, embeddings Ollama', async () => {
    fetchMock.mockImplementation(tagsWithAll)
    const keyFile = join(tmp, 'api_key')
    writeFileSync(keyFile, 'sk-ant-test', 'utf8')
    const profile = await resolveLlmProfile(
      { llm: { profile: 'local-plus-cloud' } },
      { env: {}, anthropicKeyFile: keyFile },
    )
    expect(profile.extraction?.name).toBe('anthropic')
    expect(profile.extraction?.model).toBe(DEFAULT_ANTHROPIC_MODEL)
    expect(profile.embeddings?.name).toBe('ollama')
  })

  it('local-plus-cloud sans clé → repli extraction Ollama ; cloud sans clé → extraction null', async () => {
    fetchMock.mockImplementation(tagsWithAll)
    const repli = await resolveLlmProfile({ llm: { profile: 'local-plus-cloud' } }, noKey())
    expect(repli.extraction?.name).toBe('ollama')

    const cloud = await resolveLlmProfile({ llm: { profile: 'cloud' } }, noKey())
    expect(cloud.extraction).toBeNull()
    expect(cloud.embeddings?.name).toBe('ollama')
  })

  it('profil inconnu → warn + repli 100-local (jamais de modèle inventé façon gpt-5.4-nano)', async () => {
    fetchMock.mockImplementation(tagsWithAll)
    const profile = await resolveLlmProfile({ llm: { profile: 'gpt-5.4-nano' } }, noKey())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('profil LLM inconnu'))
    expect(profile.extraction?.model).toBe(DEFAULT_LOCAL_EXTRACTION_MODEL)
  })
})

/**
 * `llm.embeddings` était déclaré dans la config mais lu NULLE PART : impossible
 * d'épingler un provider. Conséquence concrète en production : Ollama gardant la
 * priorité dès qu'il répond, un Ollama démarré pour un autre projet captait les
 * embeddings et la base accumulait des vecteurs de deux modèles — non
 * comparables, donc rappel sémantique faux.
 */
describe('resolveLlmProfile — embeddings épinglés (llm.embeddings)', () => {
  /** Clés injectées : sans keyFile explicite, on lirait la VRAIE clé de la machine. */
  const noKey = () => ({
    env: {} as NodeJS.ProcessEnv,
    anthropicKeyFile: join(tmp, 'absent-anthropic'),
    openaiKeyFile: join(tmp, 'absent-openai'),
  })
  const withOpenAiKey = () => ({
    env: { OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv,
    anthropicKeyFile: join(tmp, 'absent-anthropic'),
    openaiKeyFile: join(tmp, 'absent-openai'),
  })
  const tagsWithAll = async (): Promise<Response> =>
    jsonResponse({ models: [{ name: 'qwen2.5:3b' }, { name: 'nomic-embed-text:latest' }] })

  it('openai épinglé gagne sur Ollama, MÊME disponible — c’est tout l’objet du réglage', async () => {
    fetchMock.mockImplementation(tagsWithAll) // Ollama répond et a le modèle
    const profile = await resolveLlmProfile(
      { llm: { profile: '100-local', embeddings: { provider: 'openai' } } },
      withOpenAiKey(),
    )
    expect(profile.embeddings?.name).toBe('openai')
    expect(profile.embeddings?.model).toBe('text-embedding-3-small')
    expect(profile.embeddings?.dimensions).toBe(1536)
  })

  it('openai épinglé gagne même sans extraction OpenAI : le cloud DEMANDÉ n’est pas le cloud SUBI', async () => {
    // La garde `cloudAllowed` protège du repli automatique, pas du choix explicite.
    fetchMock.mockRejectedValue(new TypeError('fetch failed')) // Ollama absent
    const profile = await resolveLlmProfile(
      { llm: { profile: '100-local', embeddings: { provider: 'openai' } } },
      withOpenAiKey(),
    )
    expect(profile.extraction).toBeNull() // aucune extraction dispo
    expect(profile.embeddings?.name).toBe('openai')
  })

  it('ollama épinglé reste honoré', async () => {
    fetchMock.mockImplementation(tagsWithAll)
    const profile = await resolveLlmProfile({ llm: { embeddings: { provider: 'ollama' } } }, withOpenAiKey())
    expect(profile.embeddings?.name).toBe('ollama')
  })

  it('modèle épinglé connu → dimensions de la table, pas le défaut du provider', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const profile = await resolveLlmProfile(
      { llm: { embeddings: { provider: 'openai', model: 'text-embedding-3-large' } } },
      withOpenAiKey(),
    )
    // 3072 et non 1536 : hériter du défaut graverait des dimensions fausses.
    expect(profile.embeddings?.dimensions).toBe(3072)
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('dimensions inconnues'))
  })

  it('modèle inconnu sans dimensions → warn explicite (une valeur fausse corrompt la base)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await resolveLlmProfile(
      { llm: { embeddings: { provider: 'openai', model: 'text-embedding-9-experimental' } } },
      withOpenAiKey(),
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dimensions inconnues'))
  })

  it('dimensions déclarées → pas de warn, valeur respectée', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const profile = await resolveLlmProfile(
      { llm: { embeddings: { provider: 'openai', model: 'maison-v1', dimensions: 512 } } },
      withOpenAiKey(),
    )
    expect(profile.embeddings?.dimensions).toBe(512)
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('dimensions inconnues'))
  })

  it('provider épinglé indisponible (pas de clé) → warn + AUCUN repli : embeddings null, pas de plantage', async () => {
    // Replier sur Ollama, c'est exactement le mélange de vecteurs que
    // l'épinglage doit empêcher — et l'utilisateur croyait tourner sur OpenAI.
    fetchMock.mockImplementation(tagsWithAll) // Ollama dispo
    const profile = await resolveLlmProfile({ llm: { embeddings: { provider: 'openai' } } }, noKey())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("provider d'embeddings « openai » indisponible"))
    expect(profile.embeddings).toBeNull()
  })

  it('provider épinglé inconnu → warn + AUCUN repli, jamais d’embeddings inventés', async () => {
    fetchMock.mockImplementation(tagsWithAll)
    const profile = await resolveLlmProfile({ llm: { embeddings: { provider: 'mistral' } } }, noKey())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("provider d'embeddings inconnu « mistral »"))
    expect(profile.embeddings).toBeNull()
  })

  it('extraction épinglée indisponible (openai sans clé) → extraction null, pas de repli profil vers Ollama', async () => {
    fetchMock.mockImplementation(tagsWithAll) // Ollama dispo avec qwen
    const profile = await resolveLlmProfile({ llm: { profile: '100-local', extraction: { provider: 'openai' } } }, noKey())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("provider d'extraction « openai » indisponible"))
    expect(profile.extraction).toBeNull()
  })

  it('dimensions non numériques dans la config → ignorées avec avertissement (jamais gravées)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const profile = await resolveLlmProfile(
      { llm: { embeddings: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 'abc' as unknown as number } } },
      withOpenAiKey(),
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dimensions'))
    expect(profile.embeddings?.dimensions).toBe(1536) // table connue, pas "abc"
  })

  it('sans llm.embeddings, le comportement d’avant est INCHANGÉ (Ollama prioritaire)', async () => {
    fetchMock.mockImplementation(tagsWithAll)
    const profile = await resolveLlmProfile({ llm: { profile: '100-local' } }, withOpenAiKey())
    expect(profile.embeddings?.name).toBe('ollama')
  })

  it('repli cloud OpenAI sans knownEmbeddingModels → plus de cri au loup systématique', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed')) // Ollama KO
    warnSpy.mockClear()
    await resolveLlmProfile(
      { llm: { extraction: { provider: 'openai', model: 'gpt-5-mini' } } },
      withOpenAiKey(),
    )
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('ne sont plus comparables'))
  })

  it('knownEmbeddingModels hétérogène → warn conditionnel au contenu réel de la base', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    warnSpy.mockClear()
    await resolveLlmProfile(
      { llm: { extraction: { provider: 'openai' }, embeddings: { provider: 'openai' } } },
      { ...withOpenAiKey(), knownEmbeddingModels: ['nomic-embed-text'] },
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nomic-embed-text'))
  })
})

describe('maybeWarnEmbeddingMismatch', () => {
  it('silence si knownModels vide/homogène ; warn seulement si modèle étranger', async () => {
    const { maybeWarnEmbeddingMismatch } = await import('../src/index.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    maybeWarnEmbeddingMismatch('text-embedding-3-small', undefined)
    maybeWarnEmbeddingMismatch('text-embedding-3-small', [])
    maybeWarnEmbeddingMismatch('text-embedding-3-small', ['text-embedding-3-small'])
    expect(warn).not.toHaveBeenCalled()
    maybeWarnEmbeddingMismatch('text-embedding-3-small', ['nomic-embed-text'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/nomic-embed-text/)
    warn.mockRestore()
  })
})
