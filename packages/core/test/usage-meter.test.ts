/**
 * Compteur de consommation des modèles (usage-meter).
 *
 * Invariants :
 *  - TOUS les providers sont comptés, locaux compris (≠ audit cloud) ;
 *  - tokens absents = null, jamais 0 (« non mesuré » ≠ « rien ») ;
 *  - un échec est compté (ok:false) et l'erreur remonte intacte ;
 *  - le compteur ne fait JAMAIS échouer l'appel qu'il mesure ;
 *  - jamais de contenu dans la mesure.
 */
import { describe, expect, it, vi } from 'vitest'
import { meterEmbeddings, meterExtraction, type LlmCall, type LlmProvider, type EmbeddingProvider } from '../src/index.js'

const SECRET = 'mot de passe wifi Hunter2Hunter2'

function detailedLlm(name: string, model = 'm-1'): LlmProvider {
  return {
    name,
    model,
    isAvailable: async () => true,
    complete: async () => 'jamais appelé si completeDetailed existe',
    completeDetailed: async () => ({ text: '{"facts":[]}', usage: { input_tokens: 120, output_tokens: 30, reasoning_tokens: 5 } }),
  }
}

function muteLlm(name: string): LlmProvider {
  return { name, model: 'm-2', isAvailable: async () => true, complete: async () => '{"facts":[]}' }
}

function detailedEmbed(name: string): EmbeddingProvider {
  return {
    name,
    model: 'e-1',
    dimensions: 3,
    isAvailable: async () => true,
    embed: async texts => texts.map(() => Float32Array.from([0, 0, 0])),
    embedDetailed: async texts => ({ vectors: texts.map(() => Float32Array.from([0, 0, 0])), usage: { input_tokens: 7 } }),
  }
}

describe('meterExtraction', () => {
  it('compte les tokens rapportés par le provider (cloud → local:false)', async () => {
    const calls: LlmCall[] = []
    const p = meterExtraction(detailedLlm('openai', 'gpt-4o-mini'), c => calls.push(c))
    expect(await p.complete({ prompt: 'abc', system: 'sys' })).toBe('{"facts":[]}')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      purpose: 'extraction',
      local: false,
      items: 1,
      chars: 6,
      ok: true,
      input_tokens: 120,
      output_tokens: 30,
      reasoning_tokens: 5,
    })
    expect(calls[0]!.ms).toBeGreaterThanOrEqual(0)
  })

  it('expose aussi completeDetailed (pour un enveloppeur extérieur)', async () => {
    const calls: LlmCall[] = []
    const p = meterExtraction(detailedLlm('openai'), c => calls.push(c))
    const out = await p.completeDetailed!({ prompt: 'x' })
    expect(out.usage?.input_tokens).toBe(120)
    expect(calls).toHaveLength(1)
  })

  it('provider muet (complete seul) → tokens null, PAS 0 ; provider local → local:true', async () => {
    const calls: LlmCall[] = []
    const p = meterExtraction(muteLlm('ollama'), c => calls.push(c))
    await p.complete({ prompt: 'x' })
    expect(calls[0]).toMatchObject({ local: true, ok: true, input_tokens: null, output_tokens: null, reasoning_tokens: null })
  })

  it('un échec est compté (ok:false, tokens null) et l’erreur remonte telle quelle', async () => {
    const calls: LlmCall[] = []
    const p = meterExtraction(
      { ...muteLlm('anthropic'), complete: async () => { throw new Error('HTTP 429') } },
      c => calls.push(c),
    )
    await expect(p.complete({ prompt: 'x' })).rejects.toThrow('HTTP 429')
    expect(calls[0]).toMatchObject({ provider: 'anthropic', ok: false, input_tokens: null, output_tokens: null })
  })

  it('un sink qui jette ne casse jamais l’appel mesuré', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = meterExtraction(detailedLlm('openai'), () => { throw new Error('disque plein') })
    await expect(p.complete({ prompt: 'x' })).resolves.toBe('{"facts":[]}')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('la mesure ne contient JAMAIS le contenu', async () => {
    const calls: LlmCall[] = []
    const p = meterExtraction(detailedLlm('openai'), c => calls.push(c))
    await p.complete({ prompt: SECRET })
    expect(JSON.stringify(calls)).not.toContain('Hunter2')
  })

  it('name/model/isAvailable sont relayés', async () => {
    const p = meterExtraction(detailedLlm('openrouter', 'openai/gpt-4o-mini'), () => {})
    expect(p.name).toBe('openrouter')
    expect(p.model).toBe('openai/gpt-4o-mini')
    await expect(p.isAvailable()).resolves.toBe(true)
  })
})

describe('meterEmbeddings', () => {
  it('compte N textes, chars cumulés, tokens d’entrée', async () => {
    const calls: LlmCall[] = []
    const p = meterEmbeddings(detailedEmbed('openai'), c => calls.push(c))
    const vectors = await p.embed(['aa', 'bbb'])
    expect(vectors).toHaveLength(2)
    expect(calls[0]).toMatchObject({ purpose: 'embeddings', local: false, items: 2, chars: 5, ok: true, input_tokens: 7, output_tokens: null })
    expect(p.dimensions).toBe(3)
  })

  it('provider local muet → local:true, tokens null', async () => {
    const calls: LlmCall[] = []
    const local: EmbeddingProvider = {
      name: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 3,
      isAvailable: async () => true,
      embed: async texts => texts.map(() => Float32Array.from([1, 1, 1])),
    }
    const p = meterEmbeddings(local, c => calls.push(c))
    await p.embed(['x'])
    expect(calls[0]).toMatchObject({ local: true, input_tokens: null })
  })

  it('échec → ok:false, erreur propagée', async () => {
    const calls: LlmCall[] = []
    const p = meterEmbeddings({ ...detailedEmbed('openai'), embedDetailed: async () => { throw new Error('HTTP 500') } }, c => calls.push(c))
    await expect(p.embed(['x'])).rejects.toThrow('HTTP 500')
    expect(calls[0]).toMatchObject({ ok: false, items: 1 })
  })
})
