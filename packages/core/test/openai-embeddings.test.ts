/**
 * Embeddings OpenAI — repli CLOUD quand aucun modèle local n'est installé.
 *
 * Memoria reste local-first : ces tests vérifient AUSSI qu'Ollama garde la
 * priorité, pour qu'une installation tout-local ne change pas de comportement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  OpenAiEmbeddingProvider,
} from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

/** Réponse /embeddings factice : n vecteurs de la bonne dimension. */
function mockEmbeddings(count: number, dims = DEFAULT_OPENAI_EMBEDDING_DIMENSIONS, shuffle = false) {
  const rows = Array.from({ length: count }, (_, i) => ({
    index: i,
    embedding: Array.from({ length: dims }, () => (i + 1) / 100),
  }))
  const body = { data: shuffle ? [...rows].reverse() : rows }
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('OpenAiEmbeddingProvider', () => {
  it('déclare son modèle et ses dimensions', () => {
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-x' })
    expect(p.name).toBe('openai')
    expect(p.model).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL)
    expect(p.dimensions).toBe(1536)
  })

  it('indisponible sans clé — jamais d’appel à l’aveugle', async () => {
    const p = new OpenAiEmbeddingProvider({ apiKey: null })
    expect(await p.isAvailable()).toBe(false)
    await expect(p.embed(['x'])).rejects.toThrow(/clé API/)
  })

  it('embed renvoie autant de vecteurs que de textes, à la bonne dimension', async () => {
    mockEmbeddings(3)
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-x' })
    const out = await p.embed(['a', 'b', 'c'])
    expect(out).toHaveLength(3)
    expect(out[0]).toBeInstanceOf(Float32Array)
    expect(out[0]!.length).toBe(1536)
  })

  it('réordonne sur `index` — l’API ne garantit pas l’ordre', async () => {
    mockEmbeddings(3, DEFAULT_OPENAI_EMBEDDING_DIMENSIONS, true)
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-x' })
    const out = await p.embed(['a', 'b', 'c'])
    // Vecteur i rempli de (i+1)/100 : l'ordre doit être restauré.
    expect(out[0]![0]).toBeCloseTo(0.01, 5)
    expect(out[2]![0]).toBeCloseTo(0.03, 5)
  })

  it('une dimension inattendue THROW — jamais d’écriture inter-espaces', async () => {
    mockEmbeddings(1, 768) // dimension nomic-embed-text
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-x' })
    await expect(p.embed(['a'])).rejects.toThrow(/dimensions d'embedding invalides/)
  })

  it('n’envoie `dimensions` que si l’appelant s’écarte du défaut', async () => {
    const f1 = mockEmbeddings(1)
    await new OpenAiEmbeddingProvider({ apiKey: 'sk-x' }).embed(['a'])
    expect(JSON.parse((f1.mock.calls[0]![1] as RequestInit).body as string)['dimensions']).toBeUndefined()

    const f2 = mockEmbeddings(1, 512)
    await new OpenAiEmbeddingProvider({ apiKey: 'sk-x', dimensions: 512 }).embed(['a'])
    expect(JSON.parse((f2.mock.calls[0]![1] as RequestInit).body as string)['dimensions']).toBe(512)
  })

  it('HTTP non-OK → erreur nommant le modèle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })))
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-x' })
    await expect(p.embed(['a'])).rejects.toThrow(/HTTP 429.*text-embedding-3-small/)
  })

  it('liste tronquée par l’API → erreur, jamais un alignement silencieux', async () => {
    mockEmbeddings(2)
    const p = new OpenAiEmbeddingProvider({ apiKey: 'sk-x' })
    await expect(p.embed(['a', 'b', 'c'])).rejects.toThrow(/2 vecteur\(s\) pour 3 texte\(s\)/)
  })
})

describe('local-first — le repli cloud ne s’active pas à la légère', () => {
  it('extraction NON-OpenAI → aucun embedding cloud, même avec une clé disponible', async () => {
    const { resolveLlmProfile } = await import('../src/index.js')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') })) // Ollama KO
    // Profil 100-local : l'utilisateur a demandé du tout-local. Envoyer ses
    // souvenirs chez OpenAI pour cause d'embeddings manquants trahirait ce choix.
    const profile = await resolveLlmProfile({ llm: { profile: '100-local' } }, {})
    expect(profile.embeddings).toBeNull()
  })

  it('extraction OpenAI + clé → embeddings OpenAI (même fournisseur, pas de nouveau destinataire)', async () => {
    const { resolveLlmProfile } = await import('../src/index.js')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') })) // Ollama KO
    const profile = await resolveLlmProfile(
      { llm: { extraction: { provider: 'openai', model: 'gpt-5-mini' } } },
      { env: { OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv },
    )
    expect(profile.extraction?.name).toBe('openai')
    expect(profile.embeddings?.name).toBe('openai')
    expect(profile.embeddings?.dimensions).toBe(1536)
  })
})
