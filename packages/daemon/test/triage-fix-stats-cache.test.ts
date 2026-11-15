/**
 * Compteurs du tri gardés par le daemon :
 *  - TriageStatsCache : 30 s hors passage, 5 s pendant, recalcul au départ et à
 *    la fin d'un passage, calcul en cours partagé, échec non gardé ;
 *  - route : un GET de l'état du passage ne vide plus le cache (l'écran
 *    l'interroge chaque seconde) ; la fin du passage le recalcule.
 * Données fictives ; faux LLM « ollama » (prix local), aucun réseau, racines
 * des transcriptions dans le tmpdir.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompleteOptions, CompletionResult, LlmProvider, Memoria, TriageStats } from '@memoria/core'
import { startDaemon, type RunningDaemon } from '../src/index.js'
import { TRIAGE_STATS_RUNNING_TTL_MS, TRIAGE_STATS_TTL_MS, TriageStatsCache } from '../src/triage-routes.js'

const emptyStats = (): TriageStats => ({
  facts_total: 0,
  triaged: 0,
  untriaged: 0,
  sensible: 0,
  failed: 0,
  faux: 0,
  same_as_active: 0,
  amas: 0,
  redites: 0,
  by_genre: {},
  by_auteur: {},
})

describe('TriageStatsCache', () => {
  function setup() {
    let now = 1_000_000
    const state = { key: 'r1:done:t1', running: false }
    let n = 0
    const compute = vi.fn(async (): Promise<TriageStats> => ({ ...emptyStats(), triaged: ++n }))
    const cache = new TriageStatsCache({ compute, stamp: () => ({ ...state }) }, () => now)
    return { cache, compute, state, advance: (ms: number) => (now += ms) }
  }

  it('hors passage : gardés 30 s ; pendant : 5 s ; départ et fin d’un passage : recalcul', async () => {
    const { cache, compute, state, advance } = setup()
    expect((await cache.get(undefined)).triaged).toBe(1)
    advance(TRIAGE_STATS_TTL_MS - 1)
    expect((await cache.get(undefined)).triaged).toBe(1)
    advance(2)
    expect((await cache.get(undefined)).triaged).toBe(2)
    // Un passage démarre : l'empreinte change.
    Object.assign(state, { key: 'r2:running:null', running: true })
    expect((await cache.get(undefined)).triaged).toBe(3)
    advance(TRIAGE_STATS_RUNNING_TTL_MS - 1)
    expect((await cache.get(undefined)).triaged).toBe(3)
    advance(2)
    expect((await cache.get(undefined)).triaged).toBe(4)
    // Fin du passage : recalcul immédiat.
    Object.assign(state, { key: 'r2:done:t2', running: false })
    expect((await cache.get(undefined)).triaged).toBe(5)
    // Par instance.
    expect((await cache.get('i-1')).triaged).toBe(6)
    expect(compute).toHaveBeenLastCalledWith('i-1')
    cache.invalidate()
    expect((await cache.get(undefined)).triaged).toBe(7)
  })

  it('deux demandes simultanées : un seul calcul ; un échec n’est pas gardé', async () => {
    const { cache, compute } = setup()
    const [a, b] = await Promise.all([cache.get(undefined), cache.get(undefined)])
    expect(a).toBe(b)
    expect(compute).toHaveBeenCalledTimes(1)
    cache.invalidate()
    compute.mockRejectedValueOnce(new Error('base fermée'))
    await expect(cache.get(undefined)).rejects.toThrow('base fermée')
    expect((await cache.get(undefined)).triaged).toBe(2)
  })
})

/** Faux LLM du tri : répond par genre selon le texte, peut être retenu. */
class GatedLlm implements LlmProvider {
  readonly name = 'ollama'
  readonly model = 'tri-fictif'
  calls = 0
  gate: Promise<void> | null = null
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  async complete(opts: CompleteOptions): Promise<string> {
    return (await this.completeDetailed(opts)).text
  }
  async completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
    this.calls++
    if (this.gate) await this.gate
    const entries: Array<{ n: number; texte: string }> = []
    for (const line of opts.prompt.split('\n').slice(1)) {
      try {
        entries.push(JSON.parse(line) as { n: number; texte: string })
      } catch {
        /* en-tête */
      }
    }
    const items = entries.map(e => ({
      n: e.n,
      utile_3_mois: true,
      genre: /pourrait/.test(e.texte) ? 'idee' : 'fait',
      ...(/pourrait/.test(e.texte) ? { sous_type: 'app', titre: `Idée ${e.n}`, auteur: 'assistant' } : {}),
      rubriques: ['projet'],
      durabilite: 2,
      importance: 2,
      autonome: true,
      projet: 'Projet Fictif',
      entites: ['Lumen'],
    }))
    return { text: JSON.stringify({ items }) }
  }
}

describe('route GET /v1/admin/triage/stats pendant un passage', () => {
  let root: string
  let daemon: RunningDaemon | null = null
  afterEach(async () => {
    await daemon?.close()
    daemon = null
    rmSync(root, { recursive: true, force: true })
  })

  it('les GET de l’état ne vident pas le cache ; la fin du passage le recalcule', async () => {
    root = mkdtempSync(join(tmpdir(), 'memoria-triage-stats-cache-'))
    const claude = join(root, 'claude-projects')
    mkdirSync(claude, { recursive: true })
    writeFileSync(
      join(root, 'config.toml'),
      `[triage]\nclaude_projects_dir = "${claude}"\narchive_dir = "${join(root, 'archive')}"\ncodex_sessions_dir = "${join(root, 'codex')}"\ncodex_history_file = "${join(root, 'codex-history.jsonl')}"\n`,
    )
    const llm = new GatedLlm()
    daemon = await startDaemon({
      storageRoot: join(root, 'storage'),
      configPath: join(root, 'config.toml'),
      agentsHome: join(root, 'home'),
      checkCli: () => false,
      registrar: host => ({ host: 'generic', registered: false, detail: `stub ${host}` }),
      credentialsDir: join(root, 'credentials'),
      llm: { extraction: llm, embeddings: null },
      updater: { pullAndBuild: vi.fn(), scheduleRestart: vi.fn() },
    })
    const m: Memoria = daemon.memoria
    m.cognitionDebounceMs = 60_000
    m.triage.retryDelayMs = 0
    const paired = m.pairAssistant({ type: 'claude-code', display_name: 'Agent fictif' })
    const instance = m.completePairing(paired.pairing_code)!.assistant_instance_id
    const db = (m as unknown as { openContent(p: string): { db: Database } }).openContent(m.registry.dbForInstance(instance)!.path).db
    for (const text of ['On pourrait proposer une app de suivi des semis pour les jardins partagés.', 'Le site fictif Lumen est hébergé chez Brumehost.']) {
      const fact = m.storeFact({ instance, content: text, source: 'transcript-import' })
      db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(fact.id)
    }
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${daemon!.state.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${daemon!.state.admin_token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: (await res.json()) as Record<string, unknown> }
    }
    // Calculs des compteurs, par l'une ou l'autre méthode.
    const spies = [vi.spyOn(m.triage, 'stats'), vi.spyOn(m.triage, 'statsAsync')]
    const computed = (): number => spies.reduce((n, s) => n + s.mock.calls.length, 0)
    let release!: () => void
    llm.gate = new Promise<void>(r => (release = r))
    expect((await call('POST', '/v1/admin/triage/run', {})).status).toBe(202)
    for (let k = 0; k < 500 && llm.calls === 0; k++) await new Promise(r => setTimeout(r, 10))
    expect(llm.calls).toBeGreaterThan(0)

    const during = await call('GET', '/v1/admin/triage/stats')
    expect(during.status).toBe(200)
    expect(during.json['triaged']).toBe(0)
    for (let k = 0; k < 5; k++) expect((await call('GET', '/v1/admin/triage/run')).json['state']).toBe('running')
    await call('GET', '/v1/admin/triage/stats')
    expect(computed()).toBe(1)

    release()
    for (let k = 0; k < 500 && (await call('GET', '/v1/admin/triage/run')).json['state'] === 'running'; k++) await new Promise(r => setTimeout(r, 10))
    const after = await call('GET', '/v1/admin/triage/stats')
    expect(after.json['triaged']).toBe(2)
    expect((after.json['by_genre'] as Record<string, { pending: number }>)['idee']?.pending).toBe(1)
    expect(computed()).toBe(2)
  })
})
