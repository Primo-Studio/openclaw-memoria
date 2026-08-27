/**
 * Consommation des modèles dans le MOTEUR : capture → extraction (fake LLM
 * avec `usage`) → ligne `llm_usage` → rapport agrégé par période → doctor.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Memoria, type CompleteOptions, type CompletionResult, type LlmProvider } from '../src/index.js'

/** Extraction déterministe qui RAPPORTE ses tokens (comme OpenAI/Ollama). */
class MeteredExtraction implements LlmProvider {
  calls = 0
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly usage: CompletionResult['usage'],
  ) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    return this.completeDetailed(opts).then(r => r.text)
  }
  completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
    this.calls++
    const sys = opts.system ?? ''
    const text = sys.includes('knowledge graph')
      ? '{"entities":[{"name":"Vercel","type":"tool"}],"relations":[]}'
      : sys.includes('topic title')
        ? 'Déploiement Primo'
        : JSON.stringify([{ fact: `Néto déploie le site Primo sur Vercel (appel ${this.calls})`, category: 'config', confidence: 0.9 }])
    return Promise.resolve({ text, usage: this.usage })
  }
}

/** Extraction MUETTE : n'implémente que `complete` (provider tiers minimal). */
class MuteExtraction implements LlmProvider {
  readonly name = 'anthropic'
  readonly model = 'modele-inconnu-x'
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(): Promise<string> {
    return Promise.resolve(JSON.stringify([{ fact: 'Néto travaille depuis Saint-Laurent-du-Maroni', category: 'context', confidence: 0.9 }]))
  }
}

let root: string
let m: Memoria | null = null

function open(extraction: LlmProvider): Memoria {
  root = mkdtempSync(join(tmpdir(), 'memoria-usage-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction }, secretsVault: 'aes-vault' })
  return m
}

async function captureOnce(mem: Memoria): Promise<string> {
  const a = mem.pairAssistant({ type: 'claude-code' })
  await mem.captureTurn({
    instance: a.assistant_instance_id,
    messages: [
      { role: 'user', content: 'On déploie le site sur quoi déjà ?' },
      { role: 'assistant', content: 'Sur Vercel, avec le compte dédié Primo.' },
    ],
  })
  // La cognition post-capture (extraction graphe LLM) part en fire-and-forget :
  // on la laisse se poser pour que CHAQUE appel soit dans le compteur.
  await mem.processCognition(a.assistant_instance_id)
  await new Promise(r => setTimeout(r, 50))
  return a.assistant_instance_id
}

afterEach(() => {
  m?.close()
  m = null
  rmSync(root, { recursive: true, force: true })
})

describe('llmUsage', () => {
  it('sans aucun appel : rapport vide, totaux à 0, coût 0', () => {
    const mem = open(new MeteredExtraction('openai', 'gpt-4o-mini', { input_tokens: 1, output_tokens: 1 }))
    const r = mem.llmUsage('24h')
    expect(r.period).toBe('24h')
    expect(r.since).not.toBeNull()
    expect(r.rows).toEqual([])
    expect(r.totals).toMatchObject({ calls: 0, failures: 0, input_tokens: null, output_tokens: null, estimated_cost_usd: 0, unmetered_calls: 0 })
    expect(r.pricing_as_of).toMatch(/^\d{4}-\d{2}$/)
  })

  it('cloud mesuré : tokens agrégés + coût estimé ; visible en 24h ET all', async () => {
    const fake = new MeteredExtraction('openai', 'gpt-4o-mini', { input_tokens: 1000, output_tokens: 100, reasoning_tokens: 10 })
    const mem = open(fake)
    await captureOnce(mem)
    expect(fake.calls).toBeGreaterThan(0)

    for (const period of ['24h', '7d', '30d', 'all'] as const) {
      const r = mem.llmUsage(period)
      expect(r.rows).toHaveLength(1)
      const row = r.rows[0]!
      expect(row).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', purpose: 'extraction', local: false, calls: fake.calls, failures: 0 })
      expect(row.input_tokens).toBe(1000 * fake.calls)
      expect(row.output_tokens).toBe(100 * fake.calls)
      expect(row.reasoning_tokens).toBe(10 * fake.calls)
      expect(row.calls_metered).toBe(fake.calls)
      expect(row.price_known).toBe(true)
      // (1000×0,15 + 100×0,6) / 1M par appel
      expect(row.estimated_cost_usd).toBeCloseTo(0.00021 * fake.calls, 6)
      expect(r.totals.estimated_cost_usd).toBeCloseTo(0.00021 * fake.calls, 6)
      expect(r.totals.unmetered_calls).toBe(0)
      expect(r.totals.unpriced_calls).toBe(0)
    }
    expect(mem.llmUsage('all').since).toBeNull()
  })

  it('provider local : compté, local:true, coût 0 même sans tokens', async () => {
    const mem = open(new MeteredExtraction('ollama', 'qwen2.5:3b', undefined))
    await captureOnce(mem)
    const row = mem.llmUsage('all').rows[0]!
    expect(row).toMatchObject({ provider: 'ollama', local: true, input_tokens: null, output_tokens: null, calls_metered: 0, estimated_cost_usd: 0, price_known: true })
    expect(mem.llmUsage('all').totals.estimated_cost_usd).toBe(0)
  })

  it('cloud muet + tarif inconnu : tokens null (pas 0), coût null, appels comptés comme non mesurés', async () => {
    const mem = open(new MuteExtraction())
    await captureOnce(mem)
    const r = mem.llmUsage('all')
    const row = r.rows[0]!
    expect(row).toMatchObject({ provider: 'anthropic', local: false, input_tokens: null, output_tokens: null, estimated_cost_usd: null, price_known: false })
    expect(r.totals.estimated_cost_usd).toBeNull()
    expect(r.totals.unmetered_calls).toBe(row.calls)
    expect(r.totals.unpriced_calls).toBe(row.calls)
  })

  it('le doctor embarque la consommation 24 h', async () => {
    const mem = open(new MeteredExtraction('openai', 'gpt-4o-mini', { input_tokens: 10, output_tokens: 2 }))
    await captureOnce(mem)
    const report = mem.doctor()
    expect(report.usage.period).toBe('24h')
    expect(report.usage.rows[0]?.provider).toBe('openai')
    expect(report.usage.totals.calls).toBeGreaterThan(0)
  })

  it('la mesure ne contient jamais le contenu des messages', async () => {
    const mem = open(new MeteredExtraction('openai', 'gpt-4o-mini', { input_tokens: 10, output_tokens: 2 }))
    await captureOnce(mem)
    expect(JSON.stringify(mem.llmUsage('all'))).not.toContain('Vercel')
  })
})
