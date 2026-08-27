/**
 * Délai dépassé : `AbortSignal.timeout` lève un DOMException anonyme (« The
 * operation was aborted due to timeout ») — sans provider, modèle ni durée, la
 * signature WAL et les logs ne disaient pas QUI avait expiré. Chaque provider
 * doit relancer une erreur qui le dit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AnthropicProvider,
  LlmTimeoutError,
  LmStudioProvider,
  OllamaEmbeddingProvider,
  OllamaProvider,
  OpenAiEmbeddingProvider,
  OpenAiProvider,
} from '../src/llm/index.js'

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>

beforeEach(() => {
  fetchMock = vi.fn<FetchFn>()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const timeoutAbort = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

describe('délai dépassé → erreur nommant provider, modèle et durée', () => {
  it('Ollama chat + embeddings', async () => {
    fetchMock.mockRejectedValue(timeoutAbort())
    await expect(new OllamaProvider({ model: 'qwen2.5:3b', timeoutMs: 1234 }).complete({ prompt: 'x' })).rejects.toThrow(
      /ollama.*qwen2\.5:3b.*délai dépassé.*1234 ms/s,
    )
    await expect(new OllamaEmbeddingProvider({ timeoutMs: 777 }).embed(['a'])).rejects.toThrow(/ollama.*nomic-embed-text.*777 ms/s)
  })

  it('OpenAI chat + embeddings, Anthropic, LM Studio', async () => {
    fetchMock.mockRejectedValue(timeoutAbort())
    await expect(new OpenAiProvider({ apiKey: 'k', model: 'gpt-4o-mini', timeoutMs: 500 }).complete({ prompt: 'x' })).rejects.toThrow(
      /openai.*gpt-4o-mini.*500 ms/s,
    )
    await expect(new OpenAiEmbeddingProvider({ apiKey: 'k', timeoutMs: 600 }).embed(['a'])).rejects.toThrow(/openai.*text-embedding-3-small.*600 ms/s)
    await expect(new AnthropicProvider({ apiKey: 'k', timeoutMs: 700 }).complete({ prompt: 'x' })).rejects.toThrow(/anthropic.*claude-haiku.*700 ms/s)
    await expect(new LmStudioProvider({ model: 'm1', timeoutMs: 800 }).complete({ prompt: 'x' })).rejects.toThrow(/lmstudio.*m1.*800 ms/s)
  })

  it('l’erreur est typée (LlmTimeoutError) et une autre erreur réseau passe inchangée', async () => {
    fetchMock.mockRejectedValue(timeoutAbort())
    const err = await new OllamaProvider({ model: 'm', timeoutMs: 10 }).complete({ prompt: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmTimeoutError)
    expect((err as LlmTimeoutError).timeoutMs).toBe(10)

    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(new OllamaProvider({ model: 'm' }).complete({ prompt: 'x' })).rejects.toThrow(/fetch failed/)
  })
})
