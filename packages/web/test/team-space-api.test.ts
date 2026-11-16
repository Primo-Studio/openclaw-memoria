/**
 * Client de l'espace d'équipe (pas encore d'écran) : filtre « candidats
 * équipe » (`team=true`), promotion `share: 'org'`, `share: true` inchangé,
 * partage vers `org` avec les comptes écartés. Aucun réseau : fetch stubé.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTeamCandidates, promoteTriage, shareFacts, triageQuery } from '../src/api'

function stubBrowser(): void {
  vi.stubGlobal('sessionStorage', { getItem: () => 'tok-admin', setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('location', { hash: '', pathname: '/ui/', search: '' })
  vi.stubGlobal('history', { replaceState: vi.fn() })
}

function fetchReturning(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const callOf = (fetchMock: ReturnType<typeof vi.fn>, i = 0): { url: string; body: Record<string, unknown> | null } => {
  const [url, init] = fetchMock.mock.calls[i] as unknown as [string, RequestInit]
  return { url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('espace d’équipe (client)', () => {
  it('triageQuery : `team=true` seulement quand demandé', () => {
    expect(triageQuery({ team: true })).toBe('?team=true')
    expect(triageQuery({ team: false })).toBe('')
  })

  it('getTeamCandidates appelle la liste du tri avec team=true', async () => {
    stubBrowser()
    const fetchMock = fetchReturning({ items: [], next_cursor: null })
    await getTeamCandidates({ instance: 'i-1' }, { limit: 20 })
    expect(callOf(fetchMock).url).toBe('/v1/admin/triage?instance=i-1&team=true&limit=20')
  })

  it("promoteTriage : share 'org' part tel quel, true reste true, absent ne part pas", async () => {
    stubBrowser()
    const fetchMock = fetchReturning({ promoted: 1, shared: 1, share_refused: { genre: 0 } })
    await promoteTriage(['f-1'], { share: 'org' })
    await promoteTriage(['f-1'], { share: true })
    await promoteTriage(['f-1'])
    expect(callOf(fetchMock, 0).body).toEqual({ fact_ids: ['f-1'], share: 'org' })
    expect(callOf(fetchMock, 1).body).toEqual({ fact_ids: ['f-1'], share: true })
    expect(callOf(fetchMock, 2).body).toEqual({ fact_ids: ['f-1'] })
  })

  it('shareFacts vers org rend les comptes écartés', async () => {
    stubBrowser()
    fetchReturning({ shared: 1, scope: 'org:x', refused: { genre: 2 } })
    const r = await shareFacts(['f-1', 'f-2', 'f-3'], 'org')
    expect(r.refused?.genre).toBe(2)
  })
})
