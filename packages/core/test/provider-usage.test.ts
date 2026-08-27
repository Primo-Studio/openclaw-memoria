/**
 * Chaque provider rapporte la consommation que son API renvoie — fetch stubé,
 * AUCUN réseau. Réponse sans `usage` → `usage` absent (jamais 0).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiEmbeddingProvider, OpenAiProvider } from '../src/llm/openai.js'
import { OllamaEmbeddingProvider, OllamaProvider } from '../src/llm/ollama.js'
import { AnthropicProvider } from '../src/llm/anthropic.js'
import { LmStudioProvider } from '../src/llm/lmstudio.js'

function stubFetch(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI', () => {
  it('chat : prompt_tokens / completion_tokens / reasoning_tokens', async () => {
    stubFetch({
      choices: [{ message: { content: '{"facts":[]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 321, completion_tokens: 45, completion_tokens_details: { reasoning_tokens: 12 } },
    })
    const p = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini' })
    const r = await p.completeDetailed({ prompt: 'x' })
    expect(r.text).toBe('{"facts":[]}')
    expect(r.usage).toEqual({ input_tokens: 321, output_tokens: 45, reasoning_tokens: 12 })
    // complete() reste le même texte
    expect(await p.complete({ prompt: 'x' })).toBe('{"facts":[]}')
  })

  it('chat sans usage → usage absent', async () => {
    stubFetch({ choices: [{ message: { content: 'ok' } }] })
    const r = await new OpenAiProvider({ apiKey: 'sk-test' }).completeDetailed({ prompt: 'x' })
    expect(r.usage).toBeUndefined()
  })

  it('embeddings : usage.prompt_tokens, vecteurs réordonnés', async () => {
    stubFetch({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
      usage: { prompt_tokens: 9 },
    })
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-test', dimensions: 3 })
    const r = await p.embedDetailed(['a', 'b'])
    expect(r.usage).toEqual({ input_tokens: 9 })
    expect(Array.from(r.vectors[0]!)).toEqual([1, 0, 0])
    expect(await p.embed(['a', 'b'])).toHaveLength(2)
  })

  it('embeddings : liste vide → aucun appel réseau, usage absent', async () => {
    const fetchFn = stubFetch({})
    const r = await new OpenAiEmbeddingProvider({ apiKey: 'sk-test', dimensions: 3 }).embedDetailed([])
    expect(r.vectors).toEqual([])
    expect(r.usage).toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('Ollama', () => {
  it('chat : prompt_eval_count → entrée, eval_count → sortie', async () => {
    stubFetch({ message: { content: '{"facts":[]}' }, prompt_eval_count: 200, eval_count: 30 })
    const r = await new OllamaProvider({ model: 'qwen2.5:3b' }).completeDetailed({ prompt: 'x' })
    expect(r.usage).toEqual({ input_tokens: 200, output_tokens: 30 })
  })

  it('chat sans compteurs → usage absent', async () => {
    stubFetch({ message: { content: 'ok' } })
    const r = await new OllamaProvider({ model: 'qwen2.5:3b' }).completeDetailed({ prompt: 'x' })
    expect(r.usage).toBeUndefined()
  })

  it('embed : prompt_eval_count → entrée', async () => {
    stubFetch({ embeddings: [[1, 0, 0]], prompt_eval_count: 4 })
    const r = await new OllamaEmbeddingProvider({ dimensions: 3 }).embedDetailed(['a'])
    expect(r.usage).toEqual({ input_tokens: 4 })
    expect(r.vectors).toHaveLength(1)
  })
})

describe('Anthropic', () => {
  it('messages : usage.input_tokens / output_tokens', async () => {
    stubFetch({ content: [{ type: 'text', text: '{"facts":[]}' }], usage: { input_tokens: 77, output_tokens: 11 } })
    const r = await new AnthropicProvider({ apiKey: 'sk-ant-test' }).completeDetailed({ prompt: 'x' })
    expect(r.text).toBe('{"facts":[]}')
    expect(r.usage).toEqual({ input_tokens: 77, output_tokens: 11 })
  })
})

describe('LM Studio', () => {
  it('chat/completions (compatible OpenAI) : usage relayé', async () => {
    const fn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fn)
    const r = await new LmStudioProvider({ model: 'qwen' }).completeDetailed({ prompt: 'x' })
    expect(r.text).toBe('ok')
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 2 })
  })
})
