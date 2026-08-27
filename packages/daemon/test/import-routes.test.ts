/**
 * Job d'import asynchrone DANS le daemon (mission B3) :
 *  - transcripts : collecte selon le type d'agent + extraction mockée →
 *    quarantaine de revue, progression par polling, état done ;
 *  - 422 sans LLM (« Configure d'abord un moteur d'intelligence ») ;
 *  - 409 si un job tourne déjà (UN import à la fois) ;
 *  - legacy : snapshot → quarantaine → adoption immédiate (sans LLM) ;
 *  - garde-fou : quarantaine legacy non vide → 409 ;
 *  - erreurs d'entrée : instance inconnue (404), kind invalide (400),
 *    transcripts pour openclaw (400), legacy_path manquant (400).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyntheticLegacyDb, importLegacyDb, type CompleteOptions, type LlmProvider } from '@memoria/core'
import { startDaemon, type ImportJobStatus, type RunningDaemon } from '../src/index.js'

/** Extraction mockée : 1 fait déterministe par fenêtre, latence injectable. */
class FakeExtraction implements LlmProvider {
  readonly name = 'fake'
  readonly model = 'fake'
  calls = 0
  constructor(private readonly delayMs = 0) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  async complete(opts: CompleteOptions): Promise<string> {
    this.calls++
    if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs))
    const m = opts.prompt.match(/\b(scaleway|convex|vitest|postgres)\b/i)
    const topic = m ? m[1]!.toLowerCase() : `sujet${this.calls}`
    return JSON.stringify({
      facts: [{ fact: `Le projet de test s'appuie sur ${topic} comme brique de référence`, category: 'config', confidence: 0.9 }],
    })
  }
}

let root: string
let home: string
let daemon: RunningDaemon | null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-import-routes-'))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  daemon = null
})

afterEach(async () => {
  await daemon?.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

async function boot(extraction: LlmProvider | null): Promise<RunningDaemon> {
  daemon = await startDaemon({
    storageRoot: join(root, 'storage'),
    configPath: join(root, 'config.toml'),
    agentsHome: home,
    checkCli: () => false,
    registrar: (host, id) => ({ host: 'generic', registered: true, detail: `stub ${host}/${id}` }),
    credentialsDir: join(root, 'credentials'),
    llm: { extraction },
  })
  return daemon
}

function url(path: string): string {
  return `http://127.0.0.1:${daemon!.state.port}${path}`
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${daemon!.state.admin_token}`, 'content-type': 'application/json' }
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url(path), { method: 'POST', headers: adminHeaders(), body: JSON.stringify(body) })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url(path), { headers: adminHeaders() })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/** Connecte un agent par la route 1 clic et retourne son instance_id. */
async function connect(kind: string): Promise<string> {
  const { status, json } = await post('/v1/admin/agents_connect', { kind })
  expect(status).toBe(200)
  return json['instance_id'] as string
}

/** Poll import_status jusqu'à l'état final (done/error) — timeout 15 s. */
async function waitJob(): Promise<ImportJobStatus> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const { json } = await get('/v1/admin/import_status')
    const status = json as unknown as ImportJobStatus
    if (status.state === 'done' || status.state === 'error') return status
    if (Date.now() > deadline) throw new Error(`job d'import jamais terminé : ${JSON.stringify(status)}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

/** Transcript Claude Code minuscule (2 tours) dans le faux HOME. */
function writeClaudeTranscript(name: string, topic: string): void {
  const dir = join(home, '.claude', 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-05T10:00:00.000Z', message: { role: 'user', content: `On part sur ${topic} pour ce projet.` } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-05T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `Très bien, ${topic} est configuré.` }] } }),
  ]
  writeFileSync(join(dir, name), lines.join('\n'))
}

describe('import_status', () => {
  it('au boot : état idle, aucune progression', async () => {
    await boot(new FakeExtraction())
    const { status, json } = await get('/v1/admin/import_status')
    expect(status).toBe(200)
    expect(json).toMatchObject({ state: 'idle', kind: null, instance_id: null })
  })
})

describe('import_start — transcripts', () => {
  it('collecte les .jsonl, extrait (LLM mocké), quarantaine + progression + done', async () => {
    const fake = new FakeExtraction()
    await boot(fake)
    const instance = await connect('claude-code')
    writeClaudeTranscript('a.jsonl', 'scaleway')
    writeClaudeTranscript('b.jsonl', 'convex')

    const started = await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    expect(started.status).toBe(200)
    expect(started.json).toMatchObject({ state: 'running', kind: 'transcripts', instance_id: instance })

    const done = await waitJob()
    expect(done.state).toBe('done')
    expect(done.error).toBeNull()
    expect(done.progress).toMatchObject({ files_done: 2, files_total: 2 })
    expect(done.progress.facts_imported).toBeGreaterThanOrEqual(2)
    expect(done.started_at).toBeTruthy()
    expect(done.finished_at).toBeTruthy()
    expect(fake.calls).toBeGreaterThanOrEqual(2)

    // les faits attendent en REVUE (dormants), provenance transcript
    const review = await get('/v1/admin/review')
    const items = review.json['items'] as Array<Record<string, unknown>>
    expect(items.length).toBe(done.progress.facts_imported)
    expect(items.every(i => i['source_type'] === 'transcript')).toBe(true)
  })

  it('sans LLM → 422 « Configure d’abord un moteur d’intelligence » (pas de job)', async () => {
    await boot(null)
    const instance = await connect('claude-code')
    writeClaudeTranscript('a.jsonl', 'scaleway')

    const { status, json } = await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    expect(status).toBe(422)
    expect(String(json['error'])).toContain('moteur d’intelligence')
    expect((await get('/v1/admin/import_status')).json['state']).toBe('idle')
  })

  it('UN job à la fois : second démarrage pendant le run → 409', async () => {
    await boot(new FakeExtraction(150)) // extraction lente → le job reste running
    const instance = await connect('claude-code')
    writeClaudeTranscript('a.jsonl', 'scaleway')

    const first = await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    expect(first.status).toBe(200)
    const second = await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    expect(second.status).toBe(409)
    expect(String(second.json['error'])).toContain('déjà en cours')

    const done = await waitJob()
    expect(done.state).toBe('done')
  })

  it('erreurs d’entrée : instance inconnue 404, kind invalide 400, openclaw 400, aucune conversation 404', async () => {
    await boot(new FakeExtraction())
    expect((await post('/v1/admin/import_start', { instance_id: 'fantome', kind: 'transcripts' })).status).toBe(404)
    const instance = await connect('claude-code')
    expect((await post('/v1/admin/import_start', { instance_id: instance, kind: 'n-importe' })).status).toBe(400)

    const ocInstance = await connect('openclaw')
    const oc = await post('/v1/admin/import_start', { instance_id: ocInstance, kind: 'transcripts' })
    expect(oc.status).toBe(400)
    expect(String(oc.json['error'])).toContain('legacy')

    // HOME sans aucun .jsonl → 404 clair (pas de job vide)
    const empty = await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    expect(empty.status).toBe(404)
    expect(String(empty.json['error'])).toContain('aucune conversation')
  })
})

describe('import_start — legacy', () => {
  it('snapshot → quarantaine → adoption immédiate dans la mémoire privée (sans LLM)', async () => {
    await boot(null) // l'import legacy ne requiert AUCUN LLM
    const instance = await connect('openclaw')
    const legacyPath = join(root, 'legacy.db')
    createSyntheticLegacyDb(legacyPath, { factCount: 25, procedureCount: 4 })

    const started = await post('/v1/admin/import_start', { instance_id: instance, kind: 'legacy', legacy_path: legacyPath })
    expect(started.status).toBe(200)
    expect(started.json).toMatchObject({ kind: 'legacy', instance_id: instance })

    const done = await waitJob()
    expect(done.state).toBe('done')
    expect(done.error).toBeNull()
    expect(done.progress.files_done).toBe(1)
    expect(done.progress.facts_imported).toBeGreaterThan(0)

    // adoptés = actifs et recallables dans la mémoire PRIVÉE de l'instance
    const recall = daemon!.memoria.recall({ instance, query: 'Directus Cloudflare deploiement', limit: 50 })
    expect(recall.items.length).toBeGreaterThan(0)
    // quarantaine vidée par l'adoption
    expect(daemon!.memoria.legacyQuarantineCount()).toBe(0)
  })

  it('garde-fou : quarantaine legacy non vide → 409 (une seule base à la fois)', async () => {
    await boot(null)
    const instance = await connect('openclaw')
    const firstLegacy = join(root, 'legacy1.db')
    createSyntheticLegacyDb(firstLegacy, { factCount: 10, procedureCount: 0 })
    // pré-remplit la quarantaine SANS adopter (état « adoption en attente »)
    const report = importLegacyDb({ legacyPath: firstLegacy, memoria: daemon!.memoria })
    expect(report.facts_imported).toBeGreaterThan(0)

    const secondLegacy = join(root, 'legacy2.db')
    createSyntheticLegacyDb(secondLegacy, { factCount: 5, procedureCount: 0 })
    const { status, json } = await post('/v1/admin/import_start', { instance_id: instance, kind: 'legacy', legacy_path: secondLegacy })
    expect(status).toBe(409)
    expect(String(json['error'])).toContain('quarantaine')
  })

  it('legacy_path manquant → 400 ; introuvable → 404 ; fichier corrompu → job en erreur VISIBLE', async () => {
    await boot(null)
    const instance = await connect('openclaw')
    expect((await post('/v1/admin/import_start', { instance_id: instance, kind: 'legacy' })).status).toBe(400)
    expect(
      (await post('/v1/admin/import_start', { instance_id: instance, kind: 'legacy', legacy_path: join(root, 'absent.db') })).status,
    ).toBe(404)

    // un fichier qui n'est pas une base SQLite → state 'error' + message précis
    const bogus = join(root, 'bogus.db')
    writeFileSync(bogus, 'pas une base sqlite du tout')
    const started = await post('/v1/admin/import_start', { instance_id: instance, kind: 'legacy', legacy_path: bogus })
    expect(started.status).toBe(200)
    const done = await waitJob()
    expect(done.state).toBe('error')
    expect(done.error).toBeTruthy()
  })
})

/**
 * Arrêt du daemon PENDANT un import (stop, mise à jour, crash) : l'état ne
 * vivait qu'en mémoire → au redémarrage import_status disait « idle », et
 * l'utilisateur qui avait lancé 1 355 fichiers ne savait ni que c'était
 * coupé, ni où. Désormais : persisté sur disque, `interrupted` annoncé.
 */
describe('import interrompu par l’arrêt du daemon', () => {
  it('close() pendant le job → au redémarrage, state interrupted + progression atteinte + message', async () => {
    await boot(new FakeExtraction(300))
    const instance = await connect('claude-code')
    writeClaudeTranscript('a.jsonl', 'scaleway')
    writeClaudeTranscript('b.jsonl', 'convex')
    writeClaudeTranscript('c.jsonl', 'vitest')
    const started = await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    expect(started.status).toBe(200)
    await new Promise(r => setTimeout(r, 100))
    expect((await get('/v1/admin/import_status')).json['state']).toBe('running')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await daemon!.close()
    warn.mockRestore()
    daemon = null

    // Le daemon suivant relit le statut : interrompu, pas « idle ».
    await boot(new FakeExtraction())
    const after = (await get('/v1/admin/import_status')).json as unknown as ImportJobStatus
    expect(after.state).toBe('interrupted')
    expect(after.kind).toBe('transcripts')
    expect(after.instance_id).toBe(instance)
    expect(after.progress.files_total).toBe(3)
    expect(after.error).toContain('interrompu')
    expect(after.error).toContain('relance')
    expect(after.finished_at).toBeTruthy()
    // et un nouvel import repart (l'état interrompu ne bloque pas)
    expect((await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })).status).toBe(200)
    expect((await waitJob()).state).toBe('done')
  }, 30_000)

  it('crash (statut « running » laissé sur disque) → interrupted au boot', async () => {
    await boot(new FakeExtraction())
    const root0 = join(root, 'storage')
    await daemon!.close()
    daemon = null
    const { writeFileSync: write } = await import('node:fs')
    write(
      join(root0, 'import-status.json'),
      JSON.stringify({ state: 'running', kind: 'transcripts', instance_id: 'i1', progress: { files_done: 508, files_total: 1355, facts_imported: 12 }, error: null, errors: [], started_at: '2026-08-26T19:00:00.000Z', finished_at: null }),
    )
    await boot(new FakeExtraction())
    const s = (await get('/v1/admin/import_status')).json as unknown as ImportJobStatus
    expect(s.state).toBe('interrupted')
    expect(s.progress).toEqual({ files_done: 508, files_total: 1355, facts_imported: 12 })
    expect(s.error).toContain('508/1355')
  })

  it('le résultat d’un import terminé survit au redémarrage (l’utilisateur revoit le bilan)', async () => {
    await boot(new FakeExtraction())
    const instance = await connect('claude-code')
    writeClaudeTranscript('a.jsonl', 'postgres')
    await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    const done = await waitJob()
    expect(done.state).toBe('done')
    await daemon!.close()
    daemon = null
    await boot(new FakeExtraction())
    const s = (await get('/v1/admin/import_status')).json as unknown as ImportJobStatus
    expect(s.state).toBe('done')
    expect(s.progress.facts_imported).toBe(done.progress.facts_imported)
  })

  it('POST /v1/admin/update pendant un import → 409 (une mise à jour redémarre le daemon)', async () => {
    await boot(new FakeExtraction(300))
    const instance = await connect('claude-code')
    writeClaudeTranscript('a.jsonl', 'scaleway')
    writeClaudeTranscript('b.jsonl', 'convex')
    await post('/v1/admin/import_start', { instance_id: instance, kind: 'transcripts' })
    const r = await post('/v1/admin/update', {})
    expect(r.status).toBe(409)
    expect(String(r.json['error'])).toContain('import')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await daemon!.close() // interrompt proprement, le job ne pollue pas le test suivant
    warn.mockRestore()
    daemon = null
  }, 30_000)
})
