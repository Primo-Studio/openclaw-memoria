/**
 * Réponse TRONQUÉE par le budget de tokens (finish_reason=length,
 * stop_reason=max_tokens, done_reason=length) : un contenu non vide mais coupé
 * remontait tel quel et échouait plus loin en « JSON invalide », sans jamais
 * dire pourquoi — des souvenirs perdus déguisés en erreur de format. Chaque
 * provider doit lever une erreur qui nomme le modèle et le budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider, LlmTruncatedError, LmStudioProvider, OllamaProvider, OpenAiProvider } from '../src/llm/index.js'

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>

const CUT = '{"facts":[{"fact":"Le devis GIREM est à 1 209 €","category":"savoir"},{"fact":"Le bui'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  fetchMock = vi.fn<FetchFn>()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('réponse tronquée par le budget → erreur explicite (jamais un JSON coupé rendu tel quel)', () => {
  it('OpenAI : finish_reason=length avec contenu partiel → erreur nommant modèle, budget et tokens', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: CUT }, finish_reason: 'length' }], usage: { completion_tokens: 1024 } }),
    )
    const p = new OpenAiProvider({ apiKey: 'sk-x', model: 'gpt-4o-mini' })
    await expect(p.complete({ prompt: 'json', json: true, maxTokens: 1024 })).rejects.toThrow(
      /tronquée.*gpt-4o-mini.*max=1024.*completion_tokens=1024.*maxTokens/s,
    )
  })

  it('l’erreur est typée (LlmTruncatedError, budget exposé) pour qu’un appelant puisse retenter plus large', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: CUT }, finish_reason: 'length' }] }))
    const p = new OpenAiProvider({ apiKey: 'sk-x', model: 'gpt-4o-mini' })
    const err = await p.complete({ prompt: 'json', maxTokens: 512 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmTruncatedError)
    expect((err as LlmTruncatedError).budget).toBe(512)
    expect((err as LlmTruncatedError).model).toBe('gpt-4o-mini')
  })

  it('OpenAI : finish_reason=stop → contenu rendu tel quel', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"facts":[]}' }, finish_reason: 'stop' }] }))
    const p = new OpenAiProvider({ apiKey: 'sk-x', model: 'gpt-4o-mini' })
    await expect(p.complete({ prompt: 'json' })).resolves.toBe('{"facts":[]}')
  })

  it('Anthropic : stop_reason=max_tokens → erreur nommant modèle et budget', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: CUT }], stop_reason: 'max_tokens', usage: { input_tokens: 900, output_tokens: 512 } }),
    )
    const p = new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-haiku-4-5-20251001' })
    await expect(p.complete({ prompt: 'json', maxTokens: 512 })).rejects.toThrow(/tronquée.*claude-haiku-4-5.*max=512/s)
  })

  it('Ollama : done_reason=length → erreur nommant modèle et budget', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { role: 'assistant', content: CUT }, done_reason: 'length', eval_count: 256 }))
    const p = new OllamaProvider({ model: 'qwen2.5:3b' })
    await expect(p.complete({ prompt: 'json', maxTokens: 256 })).rejects.toThrow(/tronquée.*qwen2\.5:3b.*max=256/s)
  })

  it('LM Studio : finish_reason=length → erreur nommant le modèle EFFECTIF et le budget', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] })
      return jsonResponse({ choices: [{ message: { content: CUT }, finish_reason: 'length' }] })
    })
    const p = new LmStudioProvider()
    await expect(p.complete({ prompt: 'json', maxTokens: 300 })).rejects.toThrow(/tronquée.*qwen2\.5-7b-instruct.*max=300/s)
  })
})
