/**
 * memoria_get_context ne lance JAMAIS de daemon et n'attend pas plus d'une
 * seconde ses styles d'échange :
 *  - daemon absent (rien de vivant) : réponse immédiate, `connect` jamais appelé ;
 *  - daemon qui ne répond pas : réponse en ~1 s, styles marqués indisponibles ;
 *  - daemon vivant : la connexion trouvée sert aussi aux outils suivants ;
 *  - en prod, la recherche lit daemon.json et le PID, sans rien lancer.
 * Jamais de vrai daemon ni de réseau. Données fictives.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecallResult } from '@memoria/core'
import { writeDaemonState } from '@memoria/daemon'
import { ActiveContextTracker, buildServer, type DaemonGateway } from '../src/index.js'
import { GET_CONTEXT_STYLES_TIMEOUT_MS, liveDaemonGateway } from '../src/serve.js'

const RECALL_EMPTY: RecallResult = { items: [], totalFound: 0, tokens: 0, scopes_searched: [] }

afterEach(() => {
  vi.restoreAllMocks()
})

function gateway(over: Partial<DaemonGateway> = {}): DaemonGateway {
  const ok = async () => ({})
  return {
    recall: async () => RECALL_EMPTY,
    storeFact: ok,
    captureTurn: ok,
    identifyInterlocutor: ok,
    identifyOrCreateInterlocutor: ok,
    feedback: ok,
    captureStatus: ok,
    pin: ok,
    expiry: ok,
    correct: ok,
    ideas: ok,
    styles: async () => ({ items: [{ id: 's-1', text: 'Écrit des messages courts.', conversation_at: '2026-02-01T08:00:00.000Z' }] }),
    ...over,
  }
}

const parse = (r: { content: unknown[] }): Record<string, unknown> => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>

describe('memoria_get_context sans lancement de daemon', () => {
  it('aucun daemon vivant : réponse immédiate, styles indisponibles, aucun lancement', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tracker = new ActiveContextTracker()
    tracker.set({ project: 'jardins' })
    const connect = vi.fn(async (): Promise<DaemonGateway> => {
      await new Promise(r => setTimeout(r, 30_000)) // ce que coûtait ensureDaemon
      return gateway()
    })
    const peek = vi.fn(() => null)
    const { handlers } = buildServer({ instanceId: 'i', tracker, connect, peek })
    const t0 = Date.now()
    const out = parse(await handlers.getContext())
    expect(Date.now() - t0).toBeLessThan(200)
    expect(connect).not.toHaveBeenCalled()
    expect(peek).toHaveBeenCalledTimes(1)
    expect((out['active_context'] as Record<string, unknown>)['project_id']).toBe('jardins')
    expect(out['exchange_styles']).toEqual([])
    expect(out['exchange_styles_unavailable']).toBe(true)
  })

  it('daemon vivant qui ne répond pas : réponse en ~1 s, délai de garde passé à la gateway', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: Array<{ timeoutMs?: number } | undefined> = []
    const stuck = gateway({
      styles: (_input, opts) => {
        seen.push(opts)
        return new Promise(() => {}) // ne répond jamais
      },
    })
    const connect = vi.fn(async () => stuck)
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect, peek: () => stuck })
    const t0 = Date.now()
    const out = parse(await handlers.getContext())
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(GET_CONTEXT_STYLES_TIMEOUT_MS - 50)
    expect(elapsed).toBeLessThan(GET_CONTEXT_STYLES_TIMEOUT_MS + 500)
    expect(out['exchange_styles']).toEqual([])
    expect(out['exchange_styles_unavailable']).toBe(true)
    expect(seen).toEqual([{ timeoutMs: GET_CONTEXT_STYLES_TIMEOUT_MS }])
    expect(connect).not.toHaveBeenCalled()
  })

  it('daemon vivant : styles rendus, et la connexion trouvée sert aux outils suivants', async () => {
    const live = gateway()
    const connect = vi.fn(async () => gateway())
    const peek = vi.fn(() => live)
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect, peek })
    const out = parse(await handlers.getContext())
    expect(out['exchange_styles']).toEqual([{ id: 's-1', text: 'Écrit des messages courts.', date: '2026-02-01' }])
    expect(out['exchange_styles_unavailable']).toBeUndefined()
    await handlers.recall({ query: 'jardins' })
    await handlers.getContext()
    expect(connect).not.toHaveBeenCalled()
    expect(peek).toHaveBeenCalledTimes(1)
  })
})

describe('liveDaemonGateway (prod)', () => {
  it('rien dans le stockage ou PID mort : null ; PID vivant : une gateway, sans rien lancer', () => {
    const root = mkdtempSync(join(tmpdir(), 'memoria-mcp-peek-'))
    try {
      expect(liveDaemonGateway(root, 'jeton-fictif')).toBeNull()
      writeDaemonState(root, { daemon_id: 'd-fictif', port: 1, admin_token: 'a-fictif', pid: 2 ** 22 + 12_345, started_at: '2026-01-01T00:00:00.000Z' })
      expect(liveDaemonGateway(root, 'jeton-fictif')).toBeNull()
      writeDaemonState(root, { daemon_id: 'd-fictif', port: 1, admin_token: 'a-fictif', pid: process.pid, started_at: '2026-01-01T00:00:00.000Z' })
      expect(liveDaemonGateway(root, 'jeton-fictif')).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
