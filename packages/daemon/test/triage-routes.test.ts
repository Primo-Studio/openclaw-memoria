/**
 * Routes du TRI DES SOUVENIRS (admin + jeton d'instance) :
 *  - POST /v1/admin/triage/run rend 202 tout de suite, le daemon répond
 *    pendant le passage (ticket #27), un second lancement → 409 ;
 *  - refus traduits : pause → 423, sans LLM ou prix inconnu → 422, corps → 400 ;
 *  - un fait de paie n'est JAMAIS envoyé au LLM, même lancé par la route ;
 *  - liste filtrée et paginée par curseur opaque, stats, promotion, correction,
 *    verdict ;
 *  - /v1/memory/ideas ne rend que des faits validés (les en attente sont
 *    comptés, jamais montrés) ; en pause, 200 `disabled` et pas 404 ;
 *  - passe sur les messages en job ; mise à jour refusée pendant un tri.
 * Données fictives uniquement ; faux LLM « ollama » (prix local), aucun réseau,
 * racines des transcriptions dans le tmpdir (jamais ~/.claude).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompleteOptions, CompletionResult, EmbeddingProvider, LlmProvider, Memoria } from '@memoria/core'
import { startDaemon, type RunningDaemon } from '../src/index.js'
import { decodeTriageCursor, encodeTriageCursor } from '../src/triage-routes.js'

/** Genre d'un texte fictif, par mots-clés. */
function genreOf(text: string): string {
  if (/tests passent|commit/i.test(text)) return 'ephemere'
  if (/pourrait|idée/i.test(text)) return 'idee'
  if (/a décidé/i.test(text)) return 'decision'
  if (/écrit des messages/i.test(text)) return 'style'
  if (/toujours|jamais/i.test(text)) return 'preference'
  return 'fait'
}

/** Faux LLM de tri : répond au prompt de tri, enregistre chaque prompt, peut être retenu (gate). */
class TriageLlm implements LlmProvider {
  readonly prompts: string[] = []
  calls = 0
  gate: Promise<void> | null = null
  constructor(
    readonly name = 'ollama',
    readonly model = 'tri-fictif',
  ) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  async complete(opts: CompleteOptions): Promise<string> {
    return (await this.completeDetailed(opts)).text
  }
  async completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
    this.calls++
    this.prompts.push(`${opts.system ?? ''}\n${opts.prompt}`)
    if (this.gate) await this.gate
    if (!(opts.system ?? '').includes('Tu tries des souvenirs')) return { text: '{"facts":[],"entities":[],"relations":[]}' }
    const entries: Array<{ n: number; texte: string }> = []
    for (const line of opts.prompt.split('\n').slice(1)) {
      try {
        entries.push(JSON.parse(line) as { n: number; texte: string })
      } catch {
        /* ligne d'en-tête */
      }
    }
    const items = entries.map(e => {
      const genre = genreOf(e.texte)
      return {
        n: e.n,
        utile_3_mois: genre !== 'ephemere',
        genre,
        ...(genre === 'idee' ? { sous_type: 'app', titre: `Idée ${e.n}`, auteur: 'assistant' } : {}),
        ...(genre === 'decision' ? { auteur: 'owner' } : {}),
        ...(genre === 'style' || genre === 'preference' ? { personne: 'owner' } : {}),
        rubriques: genre === 'ephemere' ? [] : ['projet'],
        durabilite: genre === 'ephemere' ? 0 : 2,
        importance: genre === 'ephemere' ? 0 : 2,
        autonome: true,
        projet: 'Projet Fictif',
        entites: ['Lumen'],
      }
    })
    return { text: JSON.stringify({ items }) }
  }
}

/** Faux vecteurs (sac de mots, 32 dimensions), fournisseur local. */
class BagEmbedder implements EmbeddingProvider {
  readonly name = 'ollama'
  readonly model = 'vec-fictif'
  readonly dimensions = 32
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(
      texts.map(t => {
        const v = new Float32Array(this.dimensions)
        for (const w of t.toLowerCase().match(/[a-zà-ÿ]{3,}/g) ?? ['vide']) {
          let h = 2166136261
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619)
          v[Math.abs(h) % this.dimensions]! += 1
        }
        return v
      }),
    )
  }
}

const IDEA = 'On pourrait proposer une app de suivi des semis pour les jardins partagés.'
const IDEA_2 = 'Idée : un carnet de recettes partagé entre voisins, classé par saison.'
const DECISION = 'L’équipe a décidé d’héberger le site vitrine chez Brumehost.'
const STYLE = 'Le propriétaire écrit des messages courts et directs, sans formule de politesse.'
const EPHEMERAL = 'Les tests passent après le correctif du bouton de connexion.'
/** Fictif : une donnée de paie. Ne doit jamais partir au LLM. */
const PAYROLL = 'Le salaire brut de Paul Exemple est de 2 000 euros par mois.'

let root: string
let daemon: RunningDaemon
let llm: TriageLlm
let instance: string
let instanceToken: string
let pullAndBuild: ReturnType<typeof vi.fn>

async function boot(opts: { llm?: LlmProvider | null; embeddings?: EmbeddingProvider | null } = {}): Promise<void> {
  const claude = join(root, 'claude-projects')
  mkdirSync(claude, { recursive: true })
  // Racines des transcriptions DANS le tmpdir : sans elles, le tri lirait ~/.claude et ~/.codex.
  writeFileSync(
    join(root, 'config.toml'),
    `[triage]\nclaude_projects_dir = "${claude}"\narchive_dir = "${join(root, 'archive')}"\ncodex_sessions_dir = "${join(root, 'codex')}"\ncodex_history_file = "${join(root, 'codex-history.jsonl')}"\n`,
  )
  daemon = await startDaemon({
    storageRoot: join(root, 'storage'),
    configPath: join(root, 'config.toml'),
    agentsHome: join(root, 'home'),
    checkCli: () => false,
    registrar: host => ({ host: 'generic', registered: false, detail: `stub ${host}` }),
    credentialsDir: join(root, 'credentials'),
    llm: { extraction: opts.llm === undefined ? llm : opts.llm, embeddings: opts.embeddings === undefined ? new BagEmbedder() : opts.embeddings },
    updater: {
      pullAndBuild: (pullAndBuild = vi.fn(async () => ({ ok: true, is_git: true, before: 'a', after: 'b', changed: false, built: false, rebuilt: false, log: '' }))),
      scheduleRestart: vi.fn(),
    },
  })
  const m = daemon.memoria
  m.cognitionDebounceMs = 60_000
  m.triage.retryDelayMs = 0
  const paired = m.pairAssistant({ type: 'claude-code', display_name: 'Agent fictif' })
  const done = m.completePairing(paired.pairing_code)!
  instance = done.assistant_instance_id
  instanceToken = done.instance_token
}

function contentDb(m: Memoria): Database {
  return (m as unknown as { openContent(p: string): { db: Database } }).openContent(m.registry.dbForInstance(instance)!.path).db
}

/** Fait EN ATTENTE (dormant), comme un import de transcription. */
function seedPending(text: string, extra: { client_org_id?: string } = {}): string {
  const fact = daemon.memoria.storeFact({ instance, content: text, source: 'transcript-import', ...extra })
  contentDb(daemon.memoria).prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(fact.id)
  return fact.id
}

function url(path: string): string {
  return `http://127.0.0.1:${daemon.state.port}${path}`
}

async function call(method: string, path: string, body?: unknown, token = daemon.state.admin_token): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url(path), {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('délai dépassé')
    await new Promise(r => setTimeout(r, 20))
  }
}

/** Lance un passage par la route et attend sa fin. */
async function runToEnd(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const started = await call('POST', '/v1/admin/triage/run', body)
  expect(started.status).toBe(202)
  let last: Record<string, unknown> = started.json
  await waitFor(async () => {
    last = (await call('GET', '/v1/admin/triage/run')).json
    return last['state'] !== 'running'
  })
  return last
}

type Item = { fact_id: string; text: string; genre: string | null; validated: boolean; sensible: boolean }
const items = (json: Record<string, unknown>): Item[] => json['items'] as Item[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-triage-routes-'))
  llm = new TriageLlm()
})

afterEach(async () => {
  await daemon?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('POST/GET/DELETE /v1/admin/triage/run', () => {
  it('dry-run : 202 avec l’estimation, aucun appel au LLM', async () => {
    await boot()
    seedPending(IDEA)
    seedPending(DECISION)
    const r = await call('POST', '/v1/admin/triage/run', { dry_run: true })
    expect(r.status).toBe(202)
    const estimate = r.json['estimate'] as Record<string, number>
    expect(estimate['facts_pending']).toBeGreaterThanOrEqual(2)
    expect(llm.calls).toBe(0)
  })

  it('passage réel : 202 tout de suite, le daemon répond pendant le passage, second lancement 409, annulation', async () => {
    await boot()
    for (const t of [IDEA, DECISION, STYLE, EPHEMERAL]) seedPending(t)
    let release!: () => void
    llm.gate = new Promise<void>(r => (release = r))
    const started = await call('POST', '/v1/admin/triage/run', {})
    expect(started.status).toBe(202)
    expect(started.json['state']).toBe('running')
    await waitFor(() => llm.calls > 0)
    // L'appel LLM est retenu : le daemon doit pourtant répondre (jamais bloqué).
    const health = await fetch(url('/v1/health'))
    expect(health.status).toBe(200)
    expect((await call('GET', '/v1/admin/triage/run')).json['state']).toBe('running')
    const again = await call('POST', '/v1/admin/triage/run', {})
    expect(again.status).toBe(409)
    const cancel = await call('DELETE', '/v1/admin/triage/run')
    expect(cancel).toEqual({ status: 200, json: { cancelled: true } })
    release()
    await waitFor(async () => (await call('GET', '/v1/admin/triage/run')).json['state'] !== 'running')
    expect((await call('DELETE', '/v1/admin/triage/run')).json).toEqual({ cancelled: false })
  })

  it('refus traduits : pause 423, corps invalide 400, instance inconnue 404', async () => {
    await boot()
    expect((await call('POST', '/v1/admin/triage/run', { budget_usd: 'beaucoup' })).status).toBe(400)
    expect((await call('POST', '/v1/admin/triage/run', { concurrency: 99 })).status).toBe(400)
    expect((await call('POST', '/v1/admin/triage/run', { instance: 'inconnue' })).status).toBe(404)
    daemon.memoria.setEnabled(false)
    const paused = await call('POST', '/v1/admin/triage/run', {})
    expect(paused.status).toBe(423)
    expect(llm.calls).toBe(0)
  })

  it('sans LLM d’extraction → 422 ; prix inconnu chez un fournisseur cloud → 422', async () => {
    await boot({ llm: null })
    const r = await call('POST', '/v1/admin/triage/run', {})
    expect(r.status).toBe(422)
    expect(String(r.json['error'])).toMatch(/LLM/)
    await daemon.close()
    rmSync(join(root, 'storage'), { recursive: true, force: true })
    await boot({ llm: new TriageLlm('openai', 'modele-sans-tarif') })
    const priced = await call('POST', '/v1/admin/triage/run', {})
    expect(priced.status).toBe(422)
    expect(String(priced.json['error'])).toMatch(/prix inconnu/)
  })

  it('un fait de paie n’est JAMAIS envoyé au LLM, même lancé par la route ; il reste visible en « sensible »', async () => {
    await boot()
    seedPending(IDEA)
    const payroll = seedPending(PAYROLL)
    const end = await runToEnd()
    expect(end['state']).toBe('done')
    expect(llm.calls).toBeGreaterThan(0)
    for (const p of llm.prompts) {
      expect(p).not.toContain('Paul Exemple')
      expect(p).not.toContain('salaire')
    }
    const sensibles = await call('GET', '/v1/admin/triage?sensible=true')
    expect(items(sensibles.json).map(i => i.fact_id)).toEqual([payroll])
  })
})

describe('GET /v1/admin/triage et /stats', () => {
  it('filtre par genre, pagine par curseur opaque, refuse les valeurs hors grille', async () => {
    await boot()
    const ideas = [seedPending(IDEA), seedPending(IDEA_2)]
    seedPending(DECISION)
    await runToEnd()
    const all = await call('GET', '/v1/admin/triage?genre=idee')
    expect(all.status).toBe(200)
    expect(items(all.json).map(i => i.genre)).toEqual(['idee', 'idee'])
    const first = await call('GET', '/v1/admin/triage?genre=idee&limit=1')
    const cursor = first.json['next_cursor']
    expect(typeof cursor).toBe('string')
    // Opaque : du base64url, pas un objet ni une chaîne JSON.
    expect(String(cursor)).toMatch(/^[A-Za-z0-9_-]+$/)
    const second = await call('GET', `/v1/admin/triage?genre=idee&limit=1&cursor=${cursor}`)
    const seen = [...items(first.json), ...items(second.json)].map(i => i.fact_id)
    expect(seen.sort()).toEqual([...ideas].sort())
    // Deux genres à la fois.
    expect(items((await call('GET', '/v1/admin/triage?genre=idee,decision')).json)).toHaveLength(3)
    expect((await call('GET', '/v1/admin/triage?genre=config')).status).toBe(400)
    expect((await call('GET', '/v1/admin/triage?cursor=pas-un-curseur')).status).toBe(400)
    expect((await call('GET', '/v1/admin/triage?limit=501')).status).toBe(400)
    expect((await call('GET', '/v1/admin/triage?validated=peut-etre')).status).toBe(400)
    expect((await call('GET', '/v1/admin/triage?auteur=moi')).status).toBe(400)
    expect((await call('GET', '/v1/admin/triage?instance=inconnue')).status).toBe(404)
  })

  it('le curseur fait l’aller-retour (base64url du JSON)', () => {
    const c = { conversation_at: '2026-01-02T03:04:05.000Z', fact_id: 'f-1' }
    const encoded = encodeTriageCursor(c)!
    expect(encoded).not.toContain('{')
    expect(decodeTriageCursor(encoded)).toEqual(c)
    expect(encodeTriageCursor(null)).toBeNull()
    expect(() => decodeTriageCursor(Buffer.from('{"conversation_at":"","fact_id":""}').toString('base64url'))).toThrow(/cursor invalide/)
    expect(() => decodeTriageCursor(Buffer.from('{"fact_id":"f-1"}').toString('base64url'))).toThrow(/cursor invalide/)
  })

  it('stats par genre (en attente et validés)', async () => {
    await boot()
    seedPending(IDEA)
    seedPending(DECISION)
    await runToEnd()
    const s = await call('GET', '/v1/admin/triage/stats')
    expect(s.status).toBe(200)
    const byGenre = s.json['by_genre'] as Record<string, { pending: number; validated: number }>
    expect(byGenre['idee']?.pending).toBe(1)
    expect(byGenre['decision']?.pending).toBe(1)
    expect((await call('GET', '/v1/admin/triage/stats?instance=inconnue')).status).toBe(404)
  })

  it('compteurs gardés 30 s (environ 400 ms de SQL bloquant sur une grosse base), vidés après une validation', async () => {
    await boot()
    const idea = seedPending(IDEA)
    await runToEnd()
    const spy = vi.spyOn(daemon.memoria.triage, 'statsAsync')
    await call('GET', '/v1/admin/triage/stats')
    await call('GET', '/v1/admin/triage/stats')
    expect(spy).toHaveBeenCalledTimes(1)
    await call('POST', '/v1/admin/triage/promote', { fact_ids: [idea] })
    const after = (await call('GET', '/v1/admin/triage/stats')).json['by_genre'] as Record<string, { pending: number; validated: number }>
    expect(after['idee']).toMatchObject({ pending: 0, validated: 1 })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('promote, correct, verdict', () => {
  it('valider un fait le rend actif ; corriger son genre ; marquer faux le cache', async () => {
    await boot()
    const idea = seedPending(IDEA)
    const decision = seedPending(DECISION)
    await runToEnd()
    const promoted = await call('POST', '/v1/admin/triage/promote', { fact_ids: [idea] })
    expect(promoted.status).toBe(200)
    expect(promoted.json['promoted']).toBe(1)
    const validated = await call('GET', '/v1/admin/triage?validated=true')
    expect(items(validated.json).map(i => i.fact_id)).toEqual([idea])

    const corrected = await call('POST', '/v1/admin/triage/correct', { fact_id: decision, genre: 'lecon' })
    expect(corrected).toEqual({ status: 200, json: { updated: true } })
    expect(items((await call('GET', '/v1/admin/triage?genre=lecon')).json).map(i => i.fact_id)).toEqual([decision])
    expect((await call('POST', '/v1/admin/triage/correct', { fact_id: 'inconnu', genre: 'lecon' })).status).toBe(404)
    expect((await call('POST', '/v1/admin/triage/correct', { fact_id: decision })).status).toBe(400)
    expect((await call('POST', '/v1/admin/triage/correct', { fact_id: decision, genre: 'config' })).status).toBe(400)

    expect((await call('POST', '/v1/admin/triage/verdict', { fact_ids: [decision], verdict: 'faux' })).json).toEqual({ updated: 1 })
    expect(items((await call('GET', '/v1/admin/triage?genre=lecon')).json)).toHaveLength(0)
    expect(items((await call('GET', '/v1/admin/triage?genre=lecon&include_faux=true')).json)).toHaveLength(1)
    expect((await call('POST', '/v1/admin/triage/verdict', { fact_ids: [decision] })).status).toBe(400)
    expect((await call('POST', '/v1/admin/triage/verdict', { fact_ids: [decision], verdict: null })).json).toEqual({ updated: 1 })

    expect((await call('POST', '/v1/admin/triage/promote', {})).status).toBe(400)
    expect((await call('POST', '/v1/admin/triage/promote', { filter: { genre: 'config' } })).status).toBe(400)
  })
})

describe('routes mémoire (jeton d’instance)', () => {
  it('/v1/memory/ideas : seuls les faits validés reviennent ; les en attente sont comptés, sans texte', async () => {
    await boot()
    const validatedIdea = seedPending(IDEA)
    seedPending(IDEA_2)
    seedPending(PAYROLL)
    await runToEnd()
    await call('POST', '/v1/admin/triage/promote', { fact_ids: [validatedIdea] })
    const r = await call('POST', '/v1/memory/ideas', { genre: 'idee', include_members: true, validated: false, sensible: true }, instanceToken)
    expect(r.status).toBe(200)
    const got = r.json['items'] as Array<{ id: string; validated: boolean }>
    expect(got.map(i => i.id)).toEqual([validatedIdea])
    expect(got.every(i => i.validated === true)).toBe(true)
    expect((r.json['pending_counts'] as Record<string, number>)['idee']).toBe(1)
    const raw = JSON.stringify(r.json)
    expect(raw).not.toContain('carnet de recettes')
    expect(raw).not.toContain('Paul Exemple')
    expect((await call('POST', '/v1/memory/ideas', { genre: 'config' }, instanceToken)).status).toBe(400)
    expect((await call('POST', '/v1/memory/ideas', {}, 'jeton-faux')).status).toBe(401)
  })

  it('/v1/memory/ideas applique l’isolation client et les scopes du rappel', async () => {
    await boot()
    const forA = seedPending('On pourrait proposer au client A un portail de suivi des chantiers.', { client_org_id: 'client-a' })
    seedPending('Idée : un rappel automatique des visites de chantier pour le client A.', { client_org_id: 'client-a' })
    await runToEnd()
    await call('POST', '/v1/admin/triage/promote', { fact_ids: [forA] })
    const ideasFor = async (client: string, token = instanceToken) =>
      (await call('POST', '/v1/memory/ideas', { genre: 'idee', active_context: { client_org_id: client } }, token)).json
    const a = await ideasFor('client-a')
    expect((a['items'] as Array<{ id: string }>).map(i => i.id)).toEqual([forA])
    expect((a['pending_counts'] as Record<string, number>)['idee']).toBe(1)
    const b = await ideasFor('client-b')
    expect(b['items']).toEqual([])
    expect(b['pending_counts']).toEqual({})
    // Un autre agent ne lit pas la mémoire privée du premier.
    const other = daemon.memoria.completePairing(daemon.memoria.pairAssistant({ type: 'codex', display_name: 'Autre agent' }).pairing_code)!
    const fromOther = await ideasFor('client-a', other.instance_token)
    expect(fromOther['items']).toEqual([])
    expect(fromOther['pending_counts']).toEqual({})
  })

  it('un fait de paie validé à la main (critique) ne revient jamais à un agent', async () => {
    await boot()
    const payroll = seedPending(PAYROLL)
    await runToEnd()
    await call('POST', '/v1/admin/triage/correct', { fact_id: payroll, genre: 'fait' })
    const promoted = await call('POST', '/v1/admin/triage/promote', { fact_ids: [payroll], allow_sensitive: true })
    expect(promoted.json['promoted']).toBe(1)
    const r = await call('POST', '/v1/memory/ideas', { genre: 'fait' }, instanceToken)
    expect(JSON.stringify(r.json)).not.toContain('Paul Exemple')
  })

  it('/v1/memory/styles rend les styles validés du propriétaire, du plus récent au plus ancien', async () => {
    await boot()
    const style = seedPending(STYLE)
    await runToEnd()
    expect(((await call('POST', '/v1/memory/styles', {}, instanceToken)).json['items'] as unknown[]).length).toBe(0)
    await call('POST', '/v1/admin/triage/promote', { fact_ids: [style] })
    const r = await call('POST', '/v1/memory/styles', {}, instanceToken)
    expect(r.status).toBe(200)
    expect((r.json['items'] as Array<{ id: string }>).map(i => i.id)).toEqual([style])
    expect((await call('POST', '/v1/memory/styles', { limit: 0 }, instanceToken)).status).toBe(400)
  })

  it('en pause : ideas et styles répondent 200 `disabled`, jamais 404', async () => {
    await boot()
    daemon.memoria.setEnabled(false)
    const ideas = await call('POST', '/v1/memory/ideas', {}, instanceToken)
    expect(ideas).toEqual({ status: 200, json: { items: [], pending_counts: {}, disabled: true } })
    const styles = await call('POST', '/v1/memory/styles', {}, instanceToken)
    expect(styles).toEqual({ status: 200, json: { person_id: null, items: [], disabled: true } })
  })
})

describe('passe sur les messages et mise à jour', () => {
  it('POST /v1/admin/triage/messages lance la passe branchée au démarrage (job), GET rend son bilan', async () => {
    await boot()
    const r = await call('POST', '/v1/admin/triage/messages', { dry_run: true, sources: ['claude-code'] })
    expect(r.status).toBe(202)
    expect(r.json['status']).toBe('running')
    let state: Record<string, unknown> = {}
    await waitFor(async () => {
      state = (await call('GET', '/v1/admin/triage/messages')).json
      return state['status'] !== 'running'
    })
    expect(state['status']).toBe('done')
    expect(state['refusal']).toBeNull()
    expect((state['report'] as Record<string, unknown>)['estimate_usd']).toBe(0)
    expect((await call('POST', '/v1/admin/triage/messages', { sources: ['mail'] })).status).toBe(400)
  })

  it('passe sur les messages ou mise à jour pendant un tri → 409, sans rien lancer', async () => {
    await boot()
    seedPending(IDEA)
    let release!: () => void
    llm.gate = new Promise<void>(r => (release = r))
    expect((await call('POST', '/v1/admin/triage/run', {})).status).toBe(202)
    await waitFor(() => llm.calls > 0)
    expect((await call('POST', '/v1/admin/triage/messages', { dry_run: true })).status).toBe(409)
    const update = await call('POST', '/v1/admin/update', {})
    expect(update.status).toBe(409)
    expect(String(update.json['error'])).toMatch(/tri/)
    expect(pullAndBuild).not.toHaveBeenCalled()
    release()
    await waitFor(async () => (await call('GET', '/v1/admin/triage/run')).json['state'] !== 'running')
    const after = await call('POST', '/v1/admin/update', {})
    expect(after.status).toBe(200)
  })
})
