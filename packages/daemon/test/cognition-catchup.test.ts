/**
 * T30, zone cognition, côté daemon :
 *  - un fait posé par store_fact (HTTP) rejoint le graphe sans capture ;
 *  - au démarrage, un passage de cognition différé relie les faits restés en
 *    attente (pas de rattrapage complet automatique) ;
 *  - POST /v1/admin/cognition_catchup lance le rattrapage en arrière-plan,
 *    GET en donne l'état.
 *
 * Daemon réel sur 127.0.0.1, stockage en tmpdir, aucun LLM, données fictives.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Memoria, type CompleteOptions, type LlmProvider } from '@memoria/core'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon | null = null

type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } }
const dbOf = (m: Memoria, instance: string): Db => m['openContent'](m.paths.assistantDb(instance)).db as unknown as Db
const marker = (db: Db, id: string): string | undefined =>
  (db.prepare('SELECT via FROM fact_cognition WHERE fact_id = ?').get(id) as { via: string } | undefined)?.via
const entities = (db: Db, id: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?').get(id) as { n: number }).n

async function boot(bootCognitionDelayMs = 60_000, extraction: LlmProvider | null = null): Promise<RunningDaemon> {
  daemon = await startDaemon({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction },
    bootCognitionDelayMs,
  })
  return daemon
}

/** LLM d'extraction factice, en mémoire : sonde lente, extraction lente, panne sur commande. */
class FakeLlm implements LlmProvider {
  readonly name = 'openai'
  readonly model = 'gpt-4o-mini'
  available = true
  probeDelayMs = 0
  extractDelayMs = 0
  probes = 0
  graph = 0
  /** Appelé à chaque sonde, avant de répondre (pour tomber en panne au bon moment). */
  onProbe: (() => void) | null = null
  async isAvailable(): Promise<boolean> {
    this.probes++
    this.onProbe?.()
    if (this.probeDelayMs > 0) await new Promise(r => setTimeout(r, this.probeDelayMs))
    return this.available
  }
  async complete(opts: CompleteOptions): Promise<string> {
    if ((opts.system ?? '').includes('knowledge graph')) {
      this.graph++
      if (this.extractDelayMs > 0) await new Promise(r => setTimeout(r, this.extractDelayMs))
      return '{"entities":[{"name":"Orion","type":"project"}],"relations":[]}'
    }
    return 'Sujet Test'
  }
}

/** Faits « d'avant la migration » : marqués backfill, sans graphe. Rend leurs ids. */
async function seedBackfill(d: RunningDaemon, agent: { id: string; token: string }, names: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const name of names) {
    const s = await call('/v1/memory/store_fact', { content: `Le projet ${name} est suivi par l’agence Brumehost` }, agent.token)
    ids.push((s.json['fact'] as { id: string }).id)
  }
  const db = dbOf(d.memoria, agent.id)
  for (const id of ids) {
    db.prepare("INSERT OR REPLACE INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, '2020-01-01T00:00:00.000Z', 'backfill', 0)").run(id)
  }
  return ids
}
const state = async (d: RunningDaemon): Promise<Record<string, unknown>> =>
  (await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'GET')).json

async function call(path: string, body: unknown, token: string | null, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.state.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function pair(d: RunningDaemon): Promise<{ id: string; token: string }> {
  const paired = await new DaemonClient(d.state, d.state.admin_token).pair('claude-code')
  const done = await new DaemonClient(d.state).completePairing(paired.pairing_code)
  return { id: done.assistant_instance_id, token: done.instance_token }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cog-catchup-'))
})

afterEach(async () => {
  if (daemon) await daemon.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

describe('cognition des faits déclarés (daemon)', () => {
  it('store_fact par HTTP : le fait est relié au graphe peu après, sans capture', async () => {
    const d = await boot()
    d.memoria.cognitionDebounceMs = 0
    const agent = await pair(d)
    const stored = await call('/v1/memory/store_fact', { content: 'Le site Orion est hébergé chez Brumehost' }, agent.token)
    expect(stored.status).toBe(200)
    const id = (stored.json['fact'] as { id: string }).id
    const db = dbOf(d.memoria, agent.id)
    await vi.waitFor(() => expect(marker(db, id)).toBe('heuristic'))
    expect(entities(db, id)).toBeGreaterThan(0)
  })

  it('au démarrage : un passage différé relie les faits restés sans cognition, pas les faits backfill', async () => {
    // Faits écrits « daemon arrêté » : le moteur est fermé avant tout passage.
    const m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
    const instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const pending = m.storeFact({ instance, content: 'Le projet Kestrel exporte en ProRes' }).id
    const old = m.storeFact({ instance, content: 'Le projet Nimbus passe en abonnement' }).id
    dbOf(m, instance)
      .prepare("INSERT INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, '2020-01-01T00:00:00.000Z', 'backfill', 0)")
      .run(old)
    m.close()

    const d = await boot(10)
    const db = dbOf(d.memoria, instance)
    await vi.waitFor(() => expect(marker(db, pending)).toBe('heuristic'))
    expect(entities(db, pending)).toBeGreaterThan(0)
    // Pas de rattrapage complet automatique : le fait d'avant la migration attend la demande.
    expect(marker(db, old)).toBe('backfill')
    expect(entities(db, old)).toBe(0)
  })

  it('arrêt avant le passage différé : rien ne tourne après close()', async () => {
    const d = await boot(20)
    const spy = vi.spyOn(d.memoria, 'processCognition')
    await d.close()
    daemon = null
    await new Promise(r => setTimeout(r, 60))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('POST/GET /v1/admin/cognition_catchup', () => {
  it('état initial : idle', async () => {
    const d = await boot()
    const r = await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'GET')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ status: 'idle', processed: 0 })
  })

  it('lance le rattrapage en arrière-plan (heuristique par défaut) et expose l’état', async () => {
    const d = await boot()
    const agent = await pair(d)
    const ids: string[] = []
    for (const name of ['Orion', 'Kestrel', 'Nimbus']) {
      const s = await call('/v1/memory/store_fact', { content: `Le projet ${name} est suivi par l’agence Brumehost` }, agent.token)
      ids.push((s.json['fact'] as { id: string }).id)
    }
    const db = dbOf(d.memoria, agent.id)
    for (const id of ids) {
      db.prepare("INSERT INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, '2020-01-01T00:00:00.000Z', 'backfill', 0)").run(id)
    }

    const started = await call('/v1/admin/cognition_catchup', {}, d.state.admin_token)
    expect(started.status).toBe(200)
    // Retour immédiat : le travail n'est pas fini quand la réponse part.
    expect(started.json).toMatchObject({ status: 'running', mode: 'heuristic', instance: null, max_facts: null, processed: 0 })

    await vi.waitFor(async () => {
      const s = await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'GET')
      expect(s.json['status']).toBe('done')
    })
    const done = (await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'GET')).json
    expect(done).toMatchObject({ status: 'done', processed: 3, llm_facts: 0, errors: 0, capped: false, error: null })
    expect(done['clusters_rebuilt']).toBeGreaterThanOrEqual(1)
    expect(typeof done['finished_at']).toBe('string')
    for (const id of ids) {
      expect(marker(db, id)).toBe('backfill')
      expect(entities(db, id)).toBeGreaterThan(0)
    }
  })

  it('refuse : sans token admin, instance inconnue, max_facts invalide, mode LLM sans moteur', async () => {
    const d = await boot()
    expect((await call('/v1/admin/cognition_catchup', {}, null)).status).toBe(401)
    expect((await call('/v1/admin/cognition_catchup', { instance: 'inconnue' }, d.state.admin_token)).status).toBe(404)
    expect((await call('/v1/admin/cognition_catchup', { max_facts: 0 }, d.state.admin_token)).status).toBe(400)
    const noLlm = await call('/v1/admin/cognition_catchup', { llm: true }, d.state.admin_token)
    expect(noLlm.status).toBe(422)
    // Aucun de ces refus n'a lancé de travail.
    expect((await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'GET')).json['status']).toBe('idle')
  })

  it('un seul rattrapage à la fois : 409 pendant qu’il tourne', async () => {
    const d = await boot()
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    vi.spyOn(d.memoria, 'processCognition').mockImplementation(async () => {
      await gate
      return { processed: 0, llm_facts: 0, errors: 0, clusters_rebuilt: 0 }
    })
    expect((await call('/v1/admin/cognition_catchup', {}, d.state.admin_token)).status).toBe(200)
    expect((await call('/v1/admin/cognition_catchup', {}, d.state.admin_token)).status).toBe(409)
    release()
    await vi.waitFor(async () => {
      expect((await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'GET')).json['status']).toBe('done')
    })
    expect((await call('/v1/admin/cognition_catchup', {}, d.state.admin_token)).status).toBe(200)
  })

  it('deux POST simultanés en mode LLM : un seul rattrapage part, l’autre reçoit 409', async () => {
    const llm = new FakeLlm()
    // La sonde du LLM prend du temps : c'est pendant ce temps que le second POST arrivait.
    llm.probeDelayMs = 40
    const d = await boot(60_000, llm)
    const spy = vi.spyOn(d.memoria, 'processCognition')
    const [a, b] = await Promise.all([
      call('/v1/admin/cognition_catchup', { llm: true }, d.state.admin_token),
      call('/v1/admin/cognition_catchup', { llm: true }, d.state.admin_token),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => expect((await state(d))['status']).toBe('done'))
  })

  it('en pause : le mode LLM est refusé (423), l’heuristique reste permise', async () => {
    const llm = new FakeLlm()
    const d = await boot(60_000, llm)
    d.memoria.setEnabled(false)
    const refused = await call('/v1/admin/cognition_catchup', { llm: true }, d.state.admin_token)
    expect(refused.status).toBe(423)
    expect(String(refused.json['error'])).toContain('pause')
    expect((await state(d))['status']).toBe('idle')
    expect(llm.graph).toBe(0)
    expect((await call('/v1/admin/cognition_catchup', {}, d.state.admin_token)).status).toBe(200)
    await vi.waitFor(async () => expect((await state(d))['status']).toBe('done'))
  })

  it('LLM qui ne répond plus après le lancement : état « error », aucun fait marqué', async () => {
    const llm = new FakeLlm()
    const d = await boot(60_000, llm)
    const agent = await pair(d)
    const ids = await seedBackfill(d, agent, ['Orion', 'Kestrel', 'Nimbus'])
    // La route voit le LLM (une sonde), puis il tombe avant que le travail commence.
    const before = llm.probes
    llm.onProbe = () => {
      if (llm.probes > before + 1) llm.available = false
    }
    expect((await call('/v1/admin/cognition_catchup', { llm: true }, d.state.admin_token)).status).toBe(200)
    await vi.waitFor(async () => expect((await state(d))['status']).toBe('error'))
    const done = await state(d)
    expect(String(done['error'])).toContain('LLM')
    expect(done['processed']).toBe(0)
    expect(llm.graph).toBe(0)
    const db = dbOf(d.memoria, agent.id)
    for (const id of ids) {
      expect(marker(db, id)).toBe('backfill')
      expect(entities(db, id)).toBe(0)
    }
  })

  it('DELETE annule le rattrapage en cours ; rien à annuler = 409', async () => {
    const llm = new FakeLlm()
    llm.extractDelayMs = 40
    const d = await boot(60_000, llm)
    expect((await call('/v1/admin/cognition_catchup', undefined, null, 'DELETE')).status).toBe(401)
    expect((await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'DELETE')).status).toBe(409)

    const agent = await pair(d)
    const ids = await seedBackfill(d, agent, ['Orion', 'Kestrel', 'Nimbus', 'Borealis', 'Halcyon'])
    expect((await call('/v1/admin/cognition_catchup', { llm: true }, d.state.admin_token)).status).toBe(200)
    await vi.waitFor(() => expect(llm.graph).toBeGreaterThan(0))
    const cancel = await call('/v1/admin/cognition_catchup', undefined, d.state.admin_token, 'DELETE')
    expect(cancel.status).toBe(202)

    await vi.waitFor(async () => expect((await state(d))['status']).toBe('cancelled'))
    const done = await state(d)
    expect(done['processed']).toBeLessThan(ids.length)
    expect(typeof done['finished_at']).toBe('string')
    // Le reste attend : un nouveau lancement est accepté et finit le travail.
    llm.extractDelayMs = 0
    expect((await call('/v1/admin/cognition_catchup', { llm: true }, d.state.admin_token)).status).toBe(200)
    await vi.waitFor(async () => expect((await state(d))['status']).toBe('done'))
    const db = dbOf(d.memoria, agent.id)
    for (const id of ids) expect(marker(db, id)).toBe('llm')
  })
})
