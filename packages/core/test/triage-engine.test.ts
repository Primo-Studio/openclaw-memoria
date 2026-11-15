/**
 * Moteur de tri : passage complet, invariance des tables existantes,
 * idempotence, incrémental, corrections, renvois, coupe-circuit, pause,
 * annulation, dry-run, boucle d'événements rendue.
 * Données fictives uniquement (dépôt public).
 */
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listVecTables, TriageRefusedError } from '../src/index.js'
import { RecordingLlm, seedPending, setupTriage, triageRow, writeTranscript, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

function snapshot(db: Database): string {
  const vec = listVecTables(db).map(t => `${t}=${(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n}`)
  return JSON.stringify({
    facts: db.prepare('SELECT * FROM facts ORDER BY id').all(),
    embeddings: db.prepare('SELECT owner_type, owner_id, model FROM embeddings ORDER BY owner_id').all(),
    vec,
    entities: db.prepare('SELECT COUNT(*) AS n FROM entities').get(),
    fact_entities: db.prepare('SELECT COUNT(*) AS n FROM fact_entities').get(),
    items: db.prepare('SELECT * FROM memory_import_items ORDER BY id').all(),
  })
}

describe('passage complet', () => {
  it('trie actifs et faits en attente, sans rien changer aux tables existantes ni ranger un vecteur de dormant dans embeddings ou vec0', async () => {
    env = setupTriage()
    const active = env.m.storeFact({ instance: env.instance, content: 'Le portail Lumen est hébergé chez Brumehost' }).id
    await env.m.indexEmbeddings()
    const path = join(env.claudeDir, 'projet', 'session-1.jsonl')
    writeTranscript(path, [
      { role: 'user', text: 'Que proposes-tu pour Lumen ?', ts: '2026-03-04T10:00:00.000Z' },
      { role: 'assistant', text: 'On pourrait proposer une app de suivi des colis Lumen.', ts: '2026-03-04T10:01:00.000Z' },
    ])
    const idea = seedPending(env, 'On pourrait proposer une app de suivi des colis Lumen', { path })
    const noise = seedPending(env, 'Les 42 tests passent et le commit est poussé', { path })
    const before = snapshot(env.db())

    const status = await env.m.triage.run()

    expect(status.state).toBe('done')
    expect(snapshot(env.db())).toBe(before)
    const activeRow = triageRow(env.db(), active)!
    expect(activeRow.genre).toBe('fait')
    const ideaRow = triageRow(env.db(), idea)!
    expect(ideaRow).toMatchObject({ genre: 'idee', sous_type: 'app', titre: expect.stringMatching(/^Titre \d$/), prompt_version: 'tri-v3', origine: 'session' })
    expect(ideaRow.conversation_at).toBe('2026-03-04T10:00:00.000Z')
    expect(ideaRow.conversation_at_source).toBe('fichier')
    // L'assistant a écrit l'idée mot pour mot : auteur vérifié dans les messages.
    expect(ideaRow).toMatchObject({ auteur: 'ia:claude', auteur_source: 'message' })
    expect(triageRow(env.db(), noise)!.genre).toBe('ephemere')
    // Vecteur du dormant : rangé à part, jamais dans embeddings.
    expect(env.db().prepare('SELECT COUNT(*) AS n FROM fact_triage_vectors WHERE fact_id = ?').get(idea)).toEqual({ n: 1 })
    expect(status.facts_done).toBe(3)
  })

  it('les actifs passent avant les faits en attente : une redite d’actif hérite de son genre sans LLM', async () => {
    env = setupTriage()
    env.m.storeFact({ instance: env.instance, content: 'Le client Zephyrcorp règle ses factures à soixante jours par virement bancaire' })
    await env.m.indexEmbeddings()
    const twin = seedPending(env, 'Le client Zephyrcorp règle ses factures à soixante jours par virement bancaire classique')
    await env.m.triage.run()
    const row = triageRow(env.db(), twin)!
    expect(row.same_as_active).not.toBeNull()
    expect(row.genre).toBe('fait')
    // Un seul appel LLM : celui de l'actif.
    expect(env.llm.prompts.filter(p => p.includes('Zephyrcorp')).length).toBe(1)
  })

  it('décision du propriétaire reformulée mot pour mot par l’assistant : l’auteur reste celui du LLM, jamais « vérifié »', async () => {
    env = setupTriage()
    const path = join(env.claudeDir, 'projet', 'session-2.jsonl')
    writeTranscript(path, [
      { role: 'user', text: 'on garde le forfait annuel', ts: '2026-03-05T10:00:00.000Z' },
      { role: 'assistant', text: 'Noté : le propriétaire a décidé de garder le forfait annuel pour les clients Lumen.', ts: '2026-03-05T10:01:00.000Z' },
    ])
    const id = seedPending(env, 'Le propriétaire a décidé de garder le forfait annuel pour les clients Lumen', { path })
    await env.m.triage.run()
    expect(triageRow(env.db(), id)).toMatchObject({ genre: 'decision', auteur: 'owner', auteur_source: 'llm' })
  })

  it('sous-agent : « l’utilisateur » n’est jamais le propriétaire', async () => {
    env = setupTriage({ llm: new RecordingLlm('ollama', 'tri-fictif', { auteur: 'owner' }) })
    const id = seedPending(env, 'L’utilisateur pourrait lancer une offre de formation', { path: join(env.claudeDir, 'p', 's', 'subagents', 'agent-1.jsonl') })
    await env.m.triage.run()
    expect(triageRow(env.db(), id)).toMatchObject({ origine: 'sous-agent', auteur: 'inconnu' })
  })
})

describe('reprise et incrémental', () => {
  it('un second passage ne rappelle pas le LLM ; un fait ajouté ensuite est seul trié', async () => {
    env = setupTriage()
    seedPending(env, 'Le studio a un compte chez Brumehost')
    await env.m.triage.run()
    const calls = env.llm.calls
    expect((await env.m.triage.run()).facts_done).toBe(0)
    expect(env.llm.calls).toBe(calls)
    const fresh = seedPending(env, 'Le studio a un second compte chez Nimbus')
    const s = await env.m.triage.run()
    expect(s.facts_done).toBe(1)
    expect(triageRow(env.db(), fresh)!.genre).toBe('fait')
  })

  it('une ligne corrigée à la main n’est jamais réécrite, même avec reclassify', async () => {
    env = setupTriage()
    const id = seedPending(env, 'Le studio a un compte chez Brumehost')
    await env.m.triage.run()
    expect(env.m.triage.correct({ fact_id: id, genre: 'savoir' }).updated).toBe(true)
    env.db().prepare("UPDATE fact_triage SET prompt_version = 'tri-v2' WHERE fact_id = ?").run(id)
    await env.m.triage.run({ reclassify: true })
    expect(triageRow(env.db(), id)).toMatchObject({ genre: 'savoir', corrected_fields: '["genre"]' })
  })
})

describe('renvois et pannes', () => {
  it('sortie coupée : le lot est coupé en deux jusqu’à passer', async () => {
    env = setupTriage({ llm: new RecordingLlm('ollama', 'tri-fictif', { truncateAbove: 2 }) })
    for (let i = 0; i < 5; i++) seedPending(env, `Le dossier ${100 + i} est rangé chez Brumehost`)
    const s = await env.m.triage.run()
    expect(s.classified).toBe(5)
    expect(s.failed).toBe(0)
  })

  it('genre hors grille : renvoyé une fois, puis compté en échec ; retenté au passage suivant, jusqu’à trois fois', async () => {
    env = setupTriage({ llm: new RecordingLlm('ollama', 'tri-fictif', { invalid: /Orion/ }) })
    const id = seedPending(env, 'Le projet Orion vise les jardineries')
    await env.m.triage.run()
    expect(env.llm.calls).toBe(2)
    expect(triageRow(env.db(), id)).toMatchObject({ genre: null, llm_failures: 1 })
    await env.m.triage.run()
    await env.m.triage.run()
    expect(triageRow(env.db(), id)!.llm_failures).toBe(3)
    const calls = env.llm.calls
    await env.m.triage.run()
    expect(env.llm.calls).toBe(calls)
  })

  it('coupe-circuit : 3 échecs d’appel d’affilée (chacun repris une fois) arrêtent le passage sans marquer les faits', async () => {
    env = setupTriage({ llm: new RecordingLlm('ollama', 'tri-fictif', { fail: () => new Error('HTTP 503 fictif') }) })
    for (let i = 0; i < 90; i++) seedPending(env, `Le dossier ${100 + i} est rangé chez Brumehost`)
    const s = await env.m.triage.run({ concurrency: 1 })
    expect(s.state).toBe('error')
    expect(env.llm.calls).toBe(6)
    expect(s.error).toContain('503')
    expect(env.db().prepare('SELECT COUNT(*) AS n FROM fact_triage').get()).toEqual({ n: 0 })
  })

  it('limite de débit passagère : l’appel est repris une fois, le lot est classé', async () => {
    env = setupTriage({
      llm: new RecordingLlm('ollama', 'tri-fictif', { fail: call => (call === 1 ? new Error('HTTP 429 rate limit fictif') : null) }),
    })
    for (let i = 0; i < 3; i++) seedPending(env, `Le dossier ${100 + i} est rangé chez Brumehost`)
    const s = await env.m.triage.run()
    expect(s.state).toBe('done')
    expect(env.llm.calls).toBe(2)
    expect(s.classified).toBe(3)
  })
})

describe('pause, annulation, place unique', () => {
  it('refuse de démarrer en pause ; une pause posée pendant le passage l’arrête au lot suivant', async () => {
    env = setupTriage()
    for (let i = 0; i < 60; i++) seedPending(env, `Le dossier ${100 + i} est rangé chez Nimbus`)
    env.m.setEnabled(false)
    await expect(env.m.triage.start()).rejects.toMatchObject({ code: 'paused' })
    env.m.setEnabled(true)
    env.llm.behaviour.onCall = call => {
      if (call === 1) env.m.setEnabled(false)
    }
    const s = await env.m.triage.run({ concurrency: 1 })
    expect(s.state).toBe('paused')
    expect(env.llm.calls).toBe(1)
    expect(s.classified).toBe(20)
  })

  it('annulation : arrêt au lot suivant ; deux lancements simultanés n’en font qu’un', async () => {
    env = setupTriage()
    for (let i = 0; i < 60; i++) seedPending(env, `Le dossier ${100 + i} est rangé chez Nimbus`)
    env.llm.behaviour.onCall = call => {
      if (call === 1) env.m.triage.cancel()
    }
    const first = env.m.triage.start({ concurrency: 1 })
    await expect(env.m.triage.start()).rejects.toBeInstanceOf(TriageRefusedError)
    await first
    let s = env.m.triage.status()
    for (let i = 0; i < 200 && s.state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 5))
      s = env.m.triage.status()
    }
    expect(s.state).toBe('cancelled')
    expect(env.llm.calls).toBe(1)
  })

  it('dry-run : aucun appel, aucune écriture, une estimation', async () => {
    env = setupTriage()
    seedPending(env, 'Le studio a un compte chez Brumehost')
    seedPending(env, 'Le salaire net de Zorba est de 1 800 euros')
    const s = await env.m.triage.run({ dryRun: true })
    expect(env.llm.calls).toBe(0)
    expect(env.embedder.calls).toBe(0)
    expect(env.db().prepare('SELECT COUNT(*) AS n FROM fact_triage').get()).toEqual({ n: 0 })
    expect(s.estimate).toMatchObject({ facts_pending: 2, facts_sensible: 1, llm_facts_max: 1, llm_calls_max: 1, cost_usd: 0 })
  })
})

describe('boucle d’événements (ticket #27)', () => {
  it('le passage rend la main entre les lots et mesure son plus long blocage', async () => {
    env = setupTriage()
    for (let i = 0; i < 120; i++) seedPending(env, `Le dossier ${100 + i} du projet Lumen`, { path: `/fictif/source-${i % 7}.jsonl` })
    let ticks = 0
    let running = true
    const tick = (): void => {
      if (!running) return
      ticks++
      setImmediate(tick)
    }
    // Retours à la boucle demandés par le moteur (setImmediate hors de ce compteur de ticks).
    const real = globalThis.setImmediate
    let engineYields = 0
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
      if (fn !== tick) engineYields++
      return real(fn, ...args)
    }) as unknown as typeof setImmediate)
    setImmediate(tick)
    // Le faux LLM répond sans attendre : entre deux lots, le moteur doit lui-même rendre la main.
    const yieldsAtCall: number[] = []
    env.llm.behaviour.onCall = () => void yieldsAtCall.push(engineYields)
    let s
    try {
      s = await env.m.triage.run({ concurrency: 1 })
    } finally {
      running = false
      spy.mockRestore()
    }
    expect(s.facts_done).toBe(120)
    expect(ticks).toBeGreaterThan(6)
    expect(yieldsAtCall).toHaveLength(6)
    for (let k = 1; k < yieldsAtCall.length; k++) expect(yieldsAtCall[k]!).toBeGreaterThan(yieldsAtCall[k - 1]!)
    expect(typeof s.max_block_ms).toBe('number')
  })
})
