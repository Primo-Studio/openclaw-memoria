/**
 * Client de la route « consommation des modèles » — fetch stubé, AUCUN réseau :
 * chemin, période, méthode et auth vérifiés.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getLlmUsage, type LlmUsageReport } from '../src/api'

const TOKEN_KEY = 'memoria.admin_token'

function stubBrowser(token = 'tok-admin'): void {
  const store = new Map<string, string>([[TOKEN_KEY, token]])
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const EMPTY: LlmUsageReport = {
  period: '7d',
  since: '2026-08-20T00:00:00.000Z',
  generated_at: '2026-08-27T00:00:00.000Z',
  pricing_as_of: '2026-08',
  rows: [],
  totals: { calls: 0, failures: 0, input_tokens: null, output_tokens: null, estimated_cost_usd: 0, unpriced_calls: 0, unmetered_calls: 0 },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLlmUsage', () => {
  it('GET /v1/admin/llm_usage?period=7d avec le token admin', async () => {
    stubBrowser()
    const fetchFn = vi.fn(async () => jsonResponse(EMPTY))
    vi.stubGlobal('fetch', fetchFn)

    const report = await getLlmUsage('7d')
    expect(report.period).toBe('7d')
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toMatch(/\/v1\/admin\/llm_usage\?period=7d$/)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-admin')
  })

  it('période par défaut = 24h', async () => {
    stubBrowser()
    const fetchFn = vi.fn(async () => jsonResponse({ ...EMPTY, period: '24h' }))
    vi.stubGlobal('fetch', fetchFn)
    await getLlmUsage()
    const [url] = fetchFn.mock.calls[0] as unknown as [string]
    expect(String(url)).toMatch(/period=24h$/)
  })

  it('daemon plus ancien (404) → ApiError, l’UI affiche « non disponible »', async () => {
    stubBrowser()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'not found' }, 404)))
    await expect(getLlmUsage()).rejects.toBeInstanceOf(ApiError)
  })
})
