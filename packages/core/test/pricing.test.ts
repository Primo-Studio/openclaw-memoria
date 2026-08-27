/**
 * Tarifs indicatifs : on n'invente JAMAIS un prix (inconnu → null), le local
 * vaut 0, et la résolution du nom de modèle tolère préfixes/dates/points.
 */
import { describe, expect, it } from 'vitest'
import { PRICING_AS_OF, estimateCostUsd, normalizeModelName, priceFor } from '../src/index.js'

describe('normalizeModelName', () => {
  it('minuscules, préfixe fournisseur retiré, date finale retirée, points → tirets', () => {
    expect(normalizeModelName('GPT-4o-mini')).toBe('gpt-4o-mini')
    expect(normalizeModelName('openai/gpt-4o-mini')).toBe('gpt-4o-mini')
    expect(normalizeModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModelName('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini')
    expect(normalizeModelName('anthropic/claude-3.5-haiku')).toBe('claude-3-5-haiku')
  })
})

describe('priceFor', () => {
  it('modèles connus (OpenAI chat + embeddings, Anthropic)', () => {
    expect(priceFor('openai', 'gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6 })
    expect(priceFor('openai', 'text-embedding-3-small')).toEqual({ input: 0.02, output: 0 })
    expect(priceFor('anthropic', 'claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 })
  })

  it('OpenRouter : « openai/gpt-4o-mini » et « anthropic/claude-3.5-haiku » résolus', () => {
    expect(priceFor('openrouter', 'openai/gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6 })
    expect(priceFor('openrouter', 'anthropic/claude-3.5-haiku')).toEqual({ input: 0.8, output: 4 })
  })

  it('préfixe le plus long : « gpt-4o-2024-08-06 » → gpt-4o, PAS gpt-4o-mini ; et inversement', () => {
    expect(priceFor('openai', 'gpt-4o-2024-08-06')).toEqual({ input: 2.5, output: 10 })
    expect(priceFor('openai', 'gpt-4o-mini-2024-07-18')).toEqual({ input: 0.15, output: 0.6 })
    // « gpt-4omega » ne doit pas matcher « gpt-4o » (frontière exigée)
    expect(priceFor('openai', 'gpt-4omega')).toBeNull()
  })

  it('inconnu → null, jamais un zéro trompeur ; local → 0', () => {
    expect(priceFor('openai', 'modele-du-futur-9000')).toBeNull()
    expect(priceFor('ollama', 'qwen2.5:3b')).toEqual({ input: 0, output: 0 })
    expect(priceFor('lmstudio', 'n-importe-quoi')).toEqual({ input: 0, output: 0 })
  })
})

describe('estimateCostUsd', () => {
  it('1M tokens entrés sur gpt-4o-mini = 0,15 $ ; sortie facturée à part', () => {
    expect(estimateCostUsd('openai', 'gpt-4o-mini', 1_000_000, 0)).toBe(0.15)
    expect(estimateCostUsd('openai', 'gpt-4o-mini', 0, 1_000_000)).toBe(0.6)
    expect(estimateCostUsd('openai', 'gpt-4o-mini', 1000, 100)).toBeCloseTo(0.00021, 6)
  })

  it('cloud non mesuré → null (pas gratuit : on ne sait pas) ; local non mesuré → 0', () => {
    expect(estimateCostUsd('openai', 'gpt-4o-mini', null, null)).toBeNull()
    expect(estimateCostUsd('ollama', 'qwen2.5:3b', null, null)).toBe(0)
    expect(estimateCostUsd('ollama', 'qwen2.5:3b', 50_000, 3_000)).toBe(0)
  })

  it('tarif inconnu → null même avec des tokens', () => {
    expect(estimateCostUsd('openai', 'modele-du-futur-9000', 1000, 10)).toBeNull()
  })

  it('la date de référence des tarifs est exposée (affichée à l’utilisateur)', () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}$/)
  })
})
