/**
 * GARDE SENSIBLE (`[llm] sensitive_gate = true`) : un texte de paie, de santé,
 * d'identité… n'atteint JAMAIS le modèle, LLM ou vecteurs, quel que soit le
 * chemin (capture, import des conversations, indexation, rappel, cognition).
 *
 * Les providers sont des ESPIONS qui enregistrent tout ce qu'ils reçoivent :
 * « n'atteint jamais » se vérifie sur ce qu'ils ont vu, pas sur un drapeau.
 * Réglage absent : rien ne change (le texte sensible passe, comme avant).
 *
 * Données 100 % fictives (dépôt public) : « Camille », « Studio Exemple ».
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applySensitiveGate,
  CognitionEngine,
  containsSensitive,
  ContentStore,
  EmbeddingIndexer,
  gateEmbeddings,
  gateExtraction,
  isSensitive,
  isSensitiveGated,
  loadConfigFile,
  Memoria,
  rawConfigHasSensitiveGate,
  SensitiveContentError,
  sensitiveGateEnabled,
  sensitiveGateState,
  type CompleteOptions,
  type EmbeddingProvider,
  type LlmProvider,
} from '../src/index.js'
import { renderTriageBatch } from '../src/triage/prompt.js'
import { renderMessagesBatch, runUserMessagesPass, type UserMessagesDetailReport } from '../src/triage/user-messages.js'
import { renderOwnerMonth, renderPersonNotes } from '../src/triage/styles-pass.js'
import type { UserMessagesPassOptions } from '../src/triage/types.js'
import { RecordingLlm, setupTriage, type TriageEnv } from './triage-fixtures.js'

// ───────────────────────────── Espions ─────────────────────────────

const BANAL_FACT = 'Le site Studio Exemple se déploie avec npm run build puis vercel'

class SpyExtraction implements LlmProvider {
  readonly name = 'spy'
  readonly model = 'spy-llm'
  prompts: string[] = []
  systems: string[] = []
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    this.prompts.push(opts.prompt)
    this.systems.push(opts.system ?? '')
    return Promise.resolve(JSON.stringify({ facts: [{ fact: BANAL_FACT, category: 'config', confidence: 0.9 }] }))
  }
}

class SpyEmbedding implements EmbeddingProvider {
  readonly name = 'spy'
  readonly model = 'spy-8d'
  readonly dimensions = 8
  texts: string[] = []
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    this.texts.push(...texts)
    return Promise.resolve(
      texts.map((_, i) => {
        const v = new Float32Array(8)
        v[i % 8] = 1
        return v
      }),
    )
  }
}

/** Ce qu'un espion a vu et qui n'aurait jamais dû partir. */
const PAYROLL = /bulletin|paie|salaire/i
const leaked = (seen: string[]): string[] => seen.filter(t => PAYROLL.test(t))

const PAYSLIP = 'Voici le bulletin de paie de Camille pour octobre : salaire net 1 850 €, à classer.'

// ───────────────────────────── Providers ─────────────────────────────

describe('garde sensible : enveloppe des providers', () => {
  it('un prompt sensible est refusé, le provider interne n’est jamais appelé, le message ne cite rien', async () => {
    const spy = new SpyExtraction()
    const gated = gateExtraction(spy)
    const err = await gated.complete({ prompt: PAYSLIP }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SensitiveContentError)
    expect((err as Error).message).not.toMatch(/Camille|1 850|octobre/)
    await expect(gated.completeDetailed!({ prompt: PAYSLIP })).rejects.toBeInstanceOf(SensitiveContentError)
    expect(spy.prompts).toEqual([])
  })

  it('les consignes fixes (`system`) ne sont pas testées, un texte banal passe', async () => {
    const spy = new SpyExtraction()
    const gated = gateExtraction(spy)
    // Une consigne de tri peut citer « salaire » comme catégorie à reconnaître.
    await gated.complete({ system: 'Classe en salaire, santé, impôts ou autre.', prompt: BANAL_FACT })
    expect(spy.prompts).toEqual([BANAL_FACT])
    expect(gated.name).toBe('spy')
    expect(gated.model).toBe('spy-llm')
    expect(isSensitiveGated(gated)).toBe(true)
    expect(gateExtraction(gated)).toBe(gated) // idempotent
  })

  it('vecteurs : un seul texte sensible refuse le lot, sans appel ; un lot banal passe', async () => {
    const spy = new SpyEmbedding()
    const gated = gateEmbeddings(spy)
    await expect(gated.embed([BANAL_FACT, PAYSLIP])).rejects.toBeInstanceOf(SensitiveContentError)
    await expect(gated.embedDetailed!([PAYSLIP])).rejects.toBeInstanceOf(SensitiveContentError)
    expect(spy.texts).toEqual([])
    const vectors = await gated.embed([BANAL_FACT])
    expect(vectors).toHaveLength(1)
    expect(spy.texts).toEqual([BANAL_FACT])
    expect(gated.dimensions).toBe(8)
  })

  it('réglage absent ou mal écrit : rien n’est enveloppé, mêmes objets qu’avant', () => {
    expect(sensitiveGateEnabled({})).toBe(false)
    expect(sensitiveGateEnabled({ llm: {} })).toBe(false)
    expect(sensitiveGateEnabled({ llm: { sensitive_gate: false } })).toBe(false)
    expect(sensitiveGateEnabled({ llm: { sensitive_gate: 'true' as unknown as boolean } })).toBe(false)
    expect(sensitiveGateEnabled({ llm: { sensitive_gate: true } })).toBe(true)
    const profile = { extraction: new SpyExtraction(), embeddings: new SpyEmbedding() }
    const same = applySensitiveGate(profile, false)
    expect(same).toBe(profile)
    expect(same.extraction).toBe(profile.extraction)
  })

  it('très long texte : testé par morceaux, un motif à cheval sur une coupe est trouvé', async () => {
    const filler = 'Le build tourne sur la machine de test, rien à signaler. '
    let long = ''
    while (long.length < 450_000) long += filler
    expect(await containsSensitive(long)).toBe(false)
    // « bulletin de paie » posé en travers de la première coupe (50 000 caractères).
    const cut = 50_000 - 6
    const straddling = `${long.slice(0, cut)} bulletin de paie ${long.slice(cut)}`
    expect(await containsSensitive(straddling)).toBe(true)
  })

  it('les gabarits fixes des prompts du tri et des passes ne sont pas eux-mêmes sensibles', async () => {
    // Sinon, garde active, chaque appel du tri serait refusé et le coupe-circuit l'arrêterait.
    const prompts = [
      renderTriageBatch([
        { origine: 'session', cat: 'general', texte: BANAL_FACT },
        { origine: null, cat: 'decision', texte: BANAL_FACT },
      ]),
      renderMessagesBatch('claude-code', [{ date: '2026-11-01T10:00:00Z', context: 'Contexte banal', message: BANAL_FACT }]),
      renderOwnerMonth(
        '2026-10',
        { messages: 3, longueur_mediane: 40, part_tres_courts: 10, part_sans_ponctuation_finale: 20, part_avec_question: 30 },
        [{ ts: '2026-10-01T00:00:00Z', text: BANAL_FACT }],
      ),
      renderPersonNotes('Camille', [{ at: '2026-10-01T00:00:00Z', text: BANAL_FACT }]),
    ]
    for (const p of prompts) expect(await containsSensitive(p)).toBe(false)
  })
})

// ───────────────────────────── Moteur ─────────────────────────────

let root: string
let m: Memoria | undefined
let spyLlm: SpyExtraction
let spyEmb: SpyEmbedding

function newMemoria(gate: boolean): Memoria {
  const configPath = join(root, 'config.toml')
  if (gate) writeFileSync(configPath, '[llm]\nsensitive_gate = true\n')
  m = Memoria.init({
    storageRoot: join(root, 'data'),
    configPath,
    llm: { extraction: spyLlm, embeddings: spyEmb },
    secretsVault: 'aes-vault',
  })
  // Pas de passage de cognition différé au milieu d'un test (machine chargée) :
  // chaque test lance les siens, comme cognition-declared.test.ts.
  m.cognitionDebounceMs = 60_000
  return m
}

function auditCount(mem: Memoria, action: string): number {
  return (mem.registry.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n
}

function hasVector(mem: Memoria, instance: string, factId: string): boolean {
  const store = mem['openContent'](mem.paths.assistantDb(instance)) as ContentStore
  return store.db.prepare("SELECT 1 FROM embeddings WHERE owner_type = 'fact' AND owner_id = ?").get(factId) !== undefined
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-sensitive-gate-'))
  spyLlm = new SpyExtraction()
  spyEmb = new SpyEmbedding()
})

afterEach(() => {
  m?.close()
  m = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('garde sensible : capture', () => {
  it('un bulletin de paie n’atteint jamais le modèle ; l’entrée est traitée, sans nouvel essai ni abandon', async () => {
    const mem = newMemoria(true)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id

    const r = await mem.captureTurn({ instance, messages: [{ role: 'user', content: PAYSLIP }] })
    expect(r).toMatchObject({ appended: 1, processed: 1, facts_created: 0, deferred: 0, failed: 0, abandoned: 0 })
    expect(spyLlm.prompts).toEqual([])

    const store = mem['openContent'](mem.paths.assistantDb(instance)) as ContentStore
    expect(store.walPendingCount()).toBe(0)
    expect(auditCount(mem, 'sensitive_skipped')).toBe(1)
    expect(auditCount(mem, 'wal_entry_abandoned')).toBe(0)
    const reasons = mem.registry.db.prepare("SELECT reason, target_id_hash FROM audit_log WHERE action = 'sensitive_skipped'").all()
    expect(JSON.stringify(reasons)).not.toMatch(PAYROLL)

    // Rejeu (redémarrage) : rien ne repart.
    await mem.replayWal()
    expect(spyLlm.prompts).toEqual([])

    // Texte banal : passe normalement.
    const ok = await mem.captureTurn({ instance, messages: [{ role: 'assistant', content: 'On déploie Studio Exemple avec npm run build.' }] })
    expect(ok.facts_created).toBe(1)
    expect(spyLlm.prompts.some(p => p.includes('npm run build'))).toBe(true)
    expect(leaked(spyLlm.prompts)).toEqual([])
  })

  it('réglage absent : le texte sensible part comme aujourd’hui', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const r = await mem.captureTurn({ instance, messages: [{ role: 'user', content: PAYSLIP }] })
    expect(r.facts_created).toBe(1)
    expect(leaked(spyLlm.prompts).length).toBeGreaterThan(0)
    expect(auditCount(mem, 'sensitive_skipped')).toBe(0)
  })
})

/** Transcript Claude Code : une fenêtre de paie (6 tours) puis une fenêtre banale (6 tours). */
function writeTranscript(path: string): void {
  const lines: string[] = []
  let t = Date.parse('2026-06-05T10:00:00.000Z')
  const push = (role: 'user' | 'assistant', text: string): void => {
    const ts = new Date(t).toISOString()
    t += 60_000
    lines.push(
      role === 'user'
        ? JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
        : JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    )
  }
  push('user', PAYSLIP)
  push('assistant', 'C’est noté, je le range.')
  push('user', 'Range-le avec les autres documents de Camille.')
  push('assistant', 'Fait.')
  push('user', 'Merci.')
  push('assistant', 'Avec plaisir.')
  push('user', 'Pour Studio Exemple, on déploie avec npm run build puis vercel.')
  push('assistant', 'D’accord, le déploiement passe par vercel après le build.')
  push('user', 'Les tests restent à côté des sources.')
  push('assistant', 'Compris, les tests vitest restent à côté.')
  push('user', 'On garde Node 22.')
  push('assistant', 'Node 22 est noté pour Studio Exemple.')
  writeFileSync(path, lines.join('\n'))
}

describe('garde sensible : import des conversations', () => {
  it('la fenêtre de paie est sautée et comptée, l’import continue sur la suivante (dry-run compris)', async () => {
    const mem = newMemoria(true)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeTranscript(file)

    const dry = await mem.importTranscripts(instance, [file], { dryRun: true })
    expect(dry.windows_sensitive_skipped).toBe(1)
    expect(dry.windows).toBe(1)
    expect(spyLlm.prompts).toEqual([])

    const report = await mem.importTranscripts(instance, [file])
    expect(report.errors).toEqual([])
    expect(report.windows_sensitive_skipped).toBe(1)
    expect(report.windows).toBe(1)
    expect(report.files_incomplete).toBe(0)
    expect(spyLlm.prompts).toHaveLength(1)
    expect(spyLlm.prompts[0]).toContain('npm run build')
    expect(leaked(spyLlm.prompts)).toEqual([])
    expect(report.notes.some(n => /données sensibles : 1 fenêtre/.test(n))).toBe(true)

    // Nouvel import : la fenêtre sautée est notée traitée, rien ne repart.
    await mem.importTranscripts(instance, [file])
    expect(spyLlm.prompts).toHaveLength(1)
  })

  it('réglage absent : les deux fenêtres partent, le rapport garde sa forme d’avant', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeTranscript(file)
    const report = await mem.importTranscripts(instance, [file])
    expect(report.windows).toBe(2)
    expect('windows_sensitive_skipped' in report).toBe(false)
    expect(leaked(spyLlm.prompts).length).toBeGreaterThan(0)
  })
})

describe('garde sensible : vecteurs', () => {
  it('le fait de paie reste sans vecteur, le fait banal est indexé', async () => {
    const mem = newMemoria(true)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const secret = mem.storeFact({ instance, content: 'Le bulletin de paie de Camille est rangé dans le dossier partagé', category: 'general' })
    const banal = mem.storeFact({ instance, content: BANAL_FACT, category: 'config' })
    await mem.indexEmbeddings(instance)
    expect(leaked(spyEmb.texts)).toEqual([])
    expect(spyEmb.texts).toContain(BANAL_FACT)
    expect(hasVector(mem, instance, banal.id)).toBe(true)
    expect(hasVector(mem, instance, secret.id)).toBe(false)
  })

  it('20 faits sensibles en tête de file ne bloquent pas le fait banal qui suit', async () => {
    const dir = join(root, 'indexer')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const store = new ContentStore(join(dir, 'content.sqlite'))
    try {
      const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre']
      for (let i = 0; i < 20; i++) {
        const f = store.insertFact({ fact: `Bulletin de paie ${months[i % 10]} ${2025 + Math.floor(i / 10)} de Camille`, scope_id: 'scope-test' })
        store.db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(`2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, f.id)
      }
      const banal = store.insertFact({ fact: BANAL_FACT, scope_id: 'scope-test' })
      store.db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run('2026-02-01T00:00:00.000Z', banal.id)

      const spy = new SpyEmbedding()
      // Sans le tri avant envoi, le lot de tête (16 faits de paie) était refusé à chaque passage.
      await expect(new EmbeddingIndexer({ store, provider: gateEmbeddings(spy) }).runAll()).rejects.toBeInstanceOf(SensitiveContentError)
      expect(spy.texts).toEqual([])

      const run = await new EmbeddingIndexer({ store, provider: gateEmbeddings(spy), skipSensitive: true }).runAll()
      expect(run.indexed).toBe(1)
      expect(spy.texts).toEqual([BANAL_FACT])
      const vectors = store.db.prepare("SELECT owner_id FROM embeddings WHERE owner_type = 'fact'").all() as Array<{ owner_id: string }>
      expect(vectors.map(v => v.owner_id)).toEqual([banal.id])
    } finally {
      store.close()
    }
  })

  it('réglage absent : le fait de paie est envoyé au moteur de vecteurs, comme aujourd’hui', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const secret = mem.storeFact({ instance, content: 'Le bulletin de paie de Camille est rangé dans le dossier partagé', category: 'general' })
    await mem.indexEmbeddings(instance)
    expect(leaked(spyEmb.texts).length).toBeGreaterThan(0)
    expect(hasVector(mem, instance, secret.id)).toBe(true)
  })
})

describe('garde sensible : rappel', () => {
  it('une requête de paie n’est pas envoyée au moteur de vecteurs, le rappel répond en plein texte', async () => {
    const mem = newMemoria(true)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    mem.storeFact({ instance, content: 'Le bulletin de paie de Camille est rangé dans le dossier partagé', category: 'general' })
    mem.storeFact({ instance, content: BANAL_FACT, category: 'config' })
    await mem.indexEmbeddings(instance)
    const before = spyEmb.texts.length

    const r = await mem.recallSemantic({ instance, query: 'bulletin de paie Camille' })
    expect(spyEmb.texts.length).toBe(before) // rien envoyé
    expect(r.items.some(i => i.content.includes('Camille'))).toBe(true)
    expect(leaked(spyEmb.texts)).toEqual([])

    // Requête banale : le chemin sémantique sert normalement.
    await mem.recallSemantic({ instance, query: 'déploiement vercel' })
    expect(spyEmb.texts).toContain('déploiement vercel')
  })
})

describe('garde sensible : tri (filtre par élément, garde sur le lot rendu)', () => {
  let env: TriageEnv | undefined
  afterEach(() => {
    env?.close()
    env = undefined
  })

  it('le lot rendu en JSON est jugé comme ses éléments : retours à la ligne échappés, marques de secret', async () => {
    const twoLines = 'Il a payé la facture\n200 € de frais de port'
    expect(await containsSensitive(twoLines)).toBe(false)
    expect(await containsSensitive(renderMessagesBatch('claude-code', [{ date: null, context: '', message: twoLines }]))).toBe(false)
    expect(await containsSensitive(renderTriageBatch([{ origine: 'session', cat: 'general', texte: twoLines }]))).toBe(false)
    // Valeur déjà masquée par le Redactor : le nom du type ne fait pas refuser le texte.
    expect(await containsSensitive('Virement prévu sur [secret:iban-0a1b2c3d] demain')).toBe(false)
    expect(await containsSensitive('Accès base : [secret:mot-de-passe-0a1b2c3d]')).toBe(false)
  })

  it('passe des messages : un message refusé avec son contexte est isolé et noté sensible, sans coupe-circuit', async () => {
    const llm = new RecordingLlm()
    // Réponse vide pour tout lot : seule compte ici la façon dont le refus est traité.
    llm.completeDetailed = async (opts: CompleteOptions) => {
      llm.calls++
      llm.prompts.push(opts.prompt)
      return { text: JSON.stringify({ items: [] }) }
    }
    env = setupTriage({ llm, config: '[llm]\nsensitive_gate = true\n' })
    const ts = (min: number): string => new Date(Date.UTC(2026, 2, 1, 10, min)).toISOString()
    const lines = [
      { type: 'assistant', timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Le client a payé' }] } },
      // Ni ce message ni son contexte ne sont sensibles seuls ; ensemble, rendus, ils le sont.
      { type: 'user', timestamp: ts(2), entrypoint: 'cli', message: { role: 'user', content: '200 € pour le site, on valide' } },
      { type: 'assistant', timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Noté.' }] } },
      { type: 'user', timestamp: ts(4), entrypoint: 'cli', message: { role: 'user', content: 'IDEE une app de troc de vélos' } },
    ]
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(env.claudeDir, '-p'), { recursive: true })
    writeFileSync(join(env.claudeDir, '-p', 's.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    env.m.registerUserMessagesPass(runUserMessagesPass)
    const r = (await env.m.triage.runUserMessages({ retryDelayMs: 0 } as UserMessagesPassOptions)) as UserMessagesDetailReport
    expect(r.stopped).toBeNull()
    expect(leaked(llm.prompts)).toEqual([])
    expect(llm.prompts.some(p => p.includes('troc de vélos'))).toBe(true)
    expect(llm.prompts.some(p => p.includes('200 €'))).toBe(false)
    const statuses = env
      .db()
      .prepare('SELECT status FROM user_message_state ORDER BY ts')
      .all()
      .map(s => (s as { status: string }).status)
    expect(statuses).toContain('sensitive')
  })

  it('tri des souvenirs : un lot refusé est coupé jusqu’au fait en cause, les autres sont classés, sans coupe-circuit', async () => {
    env = setupTriage({ config: '[llm]\nsensitive_gate = true\n' })
    // Texte banal, mais une catégorie qui, rendue dans le lot, fait refuser l'envoi.
    const odd = env.m.storeFact({ instance: env.instance, content: 'Le portail Lumen est hébergé chez Brumehost', category: 'paie' }).id
    const ok1 = env.m.storeFact({ instance: env.instance, content: 'Le projet Orion utilise Vitest pour ses tests' }).id
    const ok2 = env.m.storeFact({ instance: env.instance, content: 'Le site Studio Exemple se déploie avec Vercel' }).id
    const status = await env.m.triage.run()
    expect(status.state).toBe('done')
    // L'espion enregistre consignes + lot : seul le lot (après « Souvenirs à trier ») compte ici.
    const batches = env.llm.prompts.map(p => p.slice(p.indexOf('Souvenirs à trier')))
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.some(b => /"cat":"paie"/.test(b))).toBe(false)
    const genre = (id: string): unknown => (env!.db().prepare('SELECT genre FROM fact_triage WHERE fact_id = ?').get(id) as { genre: unknown } | undefined)?.genre ?? null
    expect(genre(ok1)).not.toBeNull()
    expect(genre(ok2)).not.toBeNull()
    expect(genre(odd)).toBeNull()
  })
})

describe('garde sensible : config.toml', () => {
  it('posée à la main pendant que le moteur tourne : gardée par Réglages, et appliquée tout de suite', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const configPath = join(root, 'config.toml')
    const { existsSync, readFileSync } = await import('node:fs')
    const before = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    writeFileSync(configPath, `${before}\n[llm]\nsensitive_gate = true\n`)
    // Un choix de modèle dans Réglages réécrit config.toml depuis la config en mémoire.
    mem.setEmbeddingsProvider('ollama')
    expect(readFileSync(configPath, 'utf8')).toMatch(/sensitive_gate\s*=\s*true/)
    await mem.captureTurn({ instance, messages: [{ role: 'user', content: PAYSLIP }] })
    expect(leaked(spyLlm.prompts)).toEqual([])
  })
})

describe('garde sensible : cognition', () => {
  it('processFact : heuristique locale hors llmOnly, rien d’écrit en llmOnly, jamais d’appel', async () => {
    const dir = join(root, 'cognition')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const store = new ContentStore(join(dir, 'content.sqlite'))
    try {
      const spy = new SpyExtraction()
      const engine = new CognitionEngine({ store, llm: gateExtraction(spy) })
      const a = store.insertFact({ fact: 'Le bulletin de paie de Camille est chez Studio Exemple', scope_id: 'scope-test' })
      const b = store.insertFact({ fact: 'Le salaire de Camille est versé par Studio Exemple', scope_id: 'scope-test' })
      const ra = await engine.processFact(a.id)
      expect(ra).toMatchObject({ processed: true, via: 'heuristic', sensitive: true })
      const rb = await engine.processFact(b.id, { llmOnly: true })
      expect(rb).toMatchObject({ processed: false, sensitive: true })
      expect(rb.llm_failed).toBeUndefined()
      expect(spy.prompts).toEqual([])
    } finally {
      store.close()
    }
  })

  it('le rattrapage en mode LLM ne s’arrête pas sur une suite de faits de paie', async () => {
    const mem = newMemoria(true)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const people = ['Camille', 'Maël', 'Sacha', 'Noa', 'Lou']
    for (const p of people) mem.storeFact({ instance, content: `Le bulletin de paie de ${p} arrive chez Studio Exemple`, category: 'general' })
    mem.storeFact({ instance, content: BANAL_FACT, category: 'config' })
    const before = spyLlm.prompts.length
    const result = await mem.processCognition(instance, { includeBackfill: true, llm: true })
    expect(result.errors).toBe(0)
    expect(leaked(spyLlm.prompts.slice(before))).toEqual([])
    expect(leaked(spyLlm.prompts)).toEqual([])
  })
})

// ───────────────────────────── Relecture du 19/11 ─────────────────────────────
// Un test par constat de la relecture de la garde (données fictives).

const GATE = '\n[llm]\nsensitive_gate = true\n'

/** Ajoute la garde à config.toml comme le fait une personne à la main, moteur en marche. */
function addGateByHand(): void {
  appendFileSync(join(root, 'config.toml'), GATE)
}

describe('garde sensible : relecture du 19/11', () => {
  it('constat 1 : garde posée puis un choix dans Réglages, la cognition en cache (entités, thèmes) passe par la garde', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    // Moteurs de cognition et de thèmes mis en cache avec le provider sans garde.
    mem.storeFact({ instance, content: BANAL_FACT, category: 'config' })
    await mem.processCognition(instance)
    expect(spyLlm.prompts.some(p => p.includes('npm run build'))).toBe(true)

    addGateByHand()
    mem.setEmbeddingsProvider('ollama')
    const before = spyLlm.prompts.length
    mem.storeFact({ instance, content: 'Le bulletin de paie de Camille arrive chez Studio Exemple', category: 'general' })
    await mem.processCognition(instance)
    expect(leaked(spyLlm.prompts.slice(before))).toEqual([])
  })

  it('constat 2 : garde posée puis pause et reprise, capture, vecteurs et cognition passent par la garde', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    // Profil, pipeline et indexeurs mémoïsés sans garde.
    await mem.captureTurn({ instance, messages: [{ role: 'assistant', content: 'On déploie Studio Exemple avec npm run build.' }] })
    await mem.indexEmbeddings(instance)
    expect(spyEmb.texts.length).toBeGreaterThan(0)

    addGateByHand()
    mem.setEnabled(false)
    mem.setEnabled(true)
    const llmBefore = spyLlm.prompts.length
    const embBefore = spyEmb.texts.length
    const r = await mem.captureTurn({ instance, messages: [{ role: 'user', content: PAYSLIP }] })
    expect(r.facts_created).toBe(0)
    mem.storeFact({ instance, content: PAYSLIP, category: 'general' })
    await mem.indexEmbeddings(instance)
    await mem.processCognition(instance)
    expect(leaked(spyLlm.prompts.slice(llmBefore))).toEqual([])
    expect(leaked(spyEmb.texts.slice(embBefore))).toEqual([])
    // Et le fichier la garde pour le redémarrage.
    expect(loadConfigFile(join(root, 'config.toml')).llm?.sensitive_gate).toBe(true)
  })

  it('constat 3 : second en-tête [llm] (fichier illisible) puis un enregistrement, la garde n’est pas perdue', async () => {
    const configPath = join(root, 'config.toml')
    // Ce que Réglages a déjà écrit sur un poste d'équipe.
    writeFileSync(configPath, '[llm]\nprofile = "custom"\n\n[llm.extraction]\nprovider = "openai"\nmodel = "gpt-4o-mini"\n')
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    addGateByHand()
    expect(() => loadConfigFile(configPath)).toThrow(/illisible/)

    mem.setEnabled(false)
    mem.setEnabled(true)
    const after = loadConfigFile(configPath)
    expect(after.llm?.sensitive_gate).toBe(true)
    await mem.captureTurn({ instance, messages: [{ role: 'user', content: PAYSLIP }] })
    expect(leaked(spyLlm.prompts)).toEqual([])
    expect(mem.doctor().engine?.sensitive_gate).toBe(true)
  })

  it('constat 3 : clé seule en fin de fichier, tombée dans une sous-table, signalée par doctor et llm_health ; absente, rien à signaler', async () => {
    const configPath = join(root, 'config.toml')
    writeFileSync(configPath, '[llm]\nprofile = "custom"\n\n[llm.embeddings]\nprovider = "openai"\n\nsensitive_gate = true\n')
    expect(sensitiveGateState(loadConfigFile(configPath))).toEqual({ enabled: false, misplaced: ['llm.embeddings'] })
    expect(rawConfigHasSensitiveGate('# sensitive_gate = true\n')).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Aucun appel réseau : les sondes Ollama et LM Studio de llm_health échouent sur place.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    try {
      const mem = newMemoria(false)
      expect(warn.mock.calls.some(c => /sensitive_gate mal placée/.test(String(c[0])))).toBe(true)
      const report = mem.doctor()
      expect(report.engine).toMatchObject({ sensitive_gate: false, sensitive_gate_misplaced: ['llm.embeddings'] })
      expect(report.warnings.some(w => /Garde sensible mal placée/.test(w))).toBe(true)
      const health = await mem.llmHealth()
      expect(health.sensitive_gate).toEqual({ enabled: false, misplaced: ['llm.embeddings'] })
      mem.close()
      m = undefined

      // Bien placée : active, aucun avertissement.
      writeFileSync(configPath, '[llm]\nprofile = "custom"\nsensitive_gate = true\n\n[llm.embeddings]\nprovider = "openai"\n')
      const ok = newMemoria(false).doctor()
      expect(ok.engine).toMatchObject({ sensitive_gate: true, sensitive_gate_misplaced: [] })
      expect(ok.warnings.some(w => /Garde sensible/.test(w))).toBe(false)
      m?.close()
      m = undefined

      // Absente (poste du propriétaire) : inactive, et rien n'est signalé.
      rmSync(configPath)
      const owner = newMemoria(false).doctor()
      expect(owner.engine).toMatchObject({ sensitive_gate: false, sensitive_gate_misplaced: [] })
      expect(owner.warnings.some(w => /Garde sensible/.test(w))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      warn.mockRestore()
    }
  })

  it('constat 4 : formulations courantes de paie, santé et identité, en français, anglais et portugais', async () => {
    const gated = gateExtraction(spyLlm)
    const phrases = [
      'Camille gagne 2 000 € par mois chez Studio Exemple',
      'Le net de Camille est de 1 850 €',
      'Le virement de 1 850 € à Camille est parti',
      'Camille est chez le dentiste demain, elle a la grippe',
      'Camille passe chez le kiné pour son dos',
      'Camille est née en 1990 à Exempleville',
      "Camille's salary is 3000 euros a month",
      'Send me the payslip for Camille',
      'Camille has a doctor appointment, sick leave until Monday',
      'O salário da Camille é 3000 reais',
      "Send me a copy of Camille's passport",
    ]
    for (const p of phrases) {
      expect(isSensitive(p), p).toBe(true)
      await expect(gated.complete({ prompt: p })).rejects.toBeInstanceOf(SensitiveContentError)
    }
    expect(spyLlm.prompts).toEqual([])
    // Mots de développeur et de gestion courante qui doivent continuer de passer.
    for (const p of [
      'Lance memoria doctor pour vérifier le poste',
      'brew doctor ne signale rien',
      'Erreur de syntax dans le fichier de config',
      'Virement de 300 € pour la facture de Studio Exemple',
      'Virement de 300 € à la banque pour la facture',
      'Le tax rate du panier est calculé côté serveur',
      'Le health check du serveur est vert',
      "L'idée est née en 2024 pendant un atelier",
      'On gagne du temps avec le cache',
      "L'API passe par Passport avec la stratégie Google",
      'passport.js garde la session dans un cookie',
    ]) {
      expect(isSensitive(p), p).toBe(false)
    }
  })

  it('constat 5 : une longue suite de chiffres (CSV collé) se teste en temps linéaire, sans figer la boucle', async () => {
    let csv = ''
    for (let i = 0; csv.length < 200_000; i++) csv += `${(i * 1.37).toFixed(2)},${i % 10 === 9 ? '\n' : ''}`
    let digits = ''
    for (let i = 0; digits.length < 200_000; i++) digits += `${i % 10} `
    // Avant la borne du montant : 0,5 s pour 20 000 caractères, 44 s pour 200 000.
    // Un morceau de la garde (50 000 caractères) reste sous 200 ms ; 200 000 d'un bloc, sous 1 s.
    for (const [text, limit] of [
      [csv.slice(0, 50_000), 200],
      [digits.slice(0, 50_000), 200],
      [csv.slice(0, 200_000), 1_000],
      [digits.slice(0, 200_000), 1_000],
    ] as const) {
      const start = performance.now()
      expect(isSensitive(text)).toBe(false)
      expect(performance.now() - start).toBeLessThan(limit)
    }
    // Le prompt de capture d'un tour avec 20 000 caractères de CSV : un morceau, bien sous 200 ms.
    const start = performance.now()
    expect(await containsSensitive(`[user] Voici les mesures :\n${csv.slice(0, 20_000)}`)).toBe(false)
    expect(performance.now() - start).toBeLessThan(200)
    // Les montants que ces motifs reconnaissent sont toujours vus.
    expect(isSensitive('Il a payé 1 850,00 € à Camille')).toBe(true)
    expect(isSensitive('1 850,00 € versés à Camille le 3 mars')).toBe(true)
    expect(isSensitive('12 345,67 euros versés à Camille')).toBe(true)
  })

  it('constat 6, sans garde : un réglage changé pendant un rattrapage LLM ne l’arrête pas (poste du propriétaire)', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    for (let i = 0; i < 3; i++) mem.storeFact({ instance, content: `${BANAL_FACT} (étape ${i + 1})`, category: 'config' })
    let changed = false
    spyLlm.complete = async (opts: CompleteOptions) => {
      spyLlm.prompts.push(opts.prompt)
      if (!changed) {
        changed = true
        mem.setEmbeddingsProvider('ollama')
      }
      return JSON.stringify({ entities: [{ name: 'Studio Exemple', type: 'organization' }], relations: [] })
    }
    const result = await mem.processCognition(instance, { includeBackfill: true, llm: true })
    expect(changed).toBe(true)
    expect(result.errors).toBe(0)
    expect(result.llm_facts).toBe(3)
  })

  it('constat 6 : garde posée PENDANT un passage de cognition, le passage s’arrête et la suite passe par la garde', async () => {
    const mem = newMemoria(false)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    for (let i = 0; i < 4; i++) mem.storeFact({ instance, content: `${BANAL_FACT} (étape ${i + 1})`, category: 'config' })
    for (const p of ['Camille', 'Noé', 'Sacha']) {
      mem.storeFact({ instance, content: `Le bulletin de paie de ${p} est rangé chez Studio Exemple`, category: 'general' })
    }
    // Au premier appel, la personne pose la garde et met Memoria en pause puis la relance.
    let flippedAt: number | null = null
    let embAt = 0
    const complete = spyLlm.complete.bind(spyLlm)
    spyLlm.complete = async (opts: CompleteOptions) => {
      const out = await complete(opts)
      if (flippedAt === null) {
        flippedAt = spyLlm.prompts.length
        embAt = spyEmb.texts.length
        addGateByHand()
        mem.setEnabled(false)
        mem.setEnabled(true)
      }
      return out
    }
    await mem.processCognition(instance)
    await mem.processCognition(instance)
    expect(flippedAt).not.toBeNull()
    expect(leaked(spyLlm.prompts.slice(flippedAt!))).toEqual([])
    // Vecteurs : gardés eux aussi, dès la garde posée.
    await mem.indexEmbeddings(instance)
    expect(leaked(spyEmb.texts.slice(embAt))).toEqual([])
  })
})
