/**
 * Import de transcriptions : trois garde-fous ajoutés après mesure sur de
 * vraies sessions (données ici 100 % fictives) :
 *  1. SECRETS : le texte envoyé au LLM passe par le même Redactor que la
 *     capture, quel que soit le format (Claude Code, Codex, export ChatGPT) ;
 *     le dry-run compte les fenêtres concernées ; la valeur va au coffre ;
 *  2. AUTEUR : seul ce que l'humain a tapé est présenté comme `[user]` ; les
 *     notifications, résumés de compaction, contenus injectés, messages
 *     d'autres sessions et consignes d'un agent parent sont étiquetés ou
 *     réduits à leur étiquette ; les messages tapés pendant que l'assistant
 *     travaille (file d'attente) ne sont plus perdus ;
 *  3. ANCRE : une fenêtre identique déjà extraite dans un AUTRE fichier ou une
 *     autre conversation ne fait plus sauter le début d'une unité.
 * Contrainte commune : le hash des fenêtres (transcript_window_state) reste
 * celui d'avant ces correctifs (valeurs d'or calculées avec l'ancien code).
 *
 * Fixtures construites par CONCATÉNATION : jamais de littéral qui ressemble à
 * un vrai secret dans le source (dépôt public, analyse des pushs).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/engine/memoria.js'
import { ContentStore } from '../src/storage/content.js'
import { parseClaudeCodeTranscript, type Turn } from '../src/migration/transcript-parsers.js'
import {
  importTranscripts,
  TRANSCRIPT_EXTRACTION_SYSTEM,
  type TranscriptUnit,
} from '../src/migration/import-transcripts.js'
import type { CompleteOptions, LlmProvider } from '../src/llm/provider.js'

// ───────────────────────────── Faux LLM qui enregistre ─────────────────────────────

class RecordingExtraction implements LlmProvider {
  readonly name = 'fake'
  readonly model = 'fake'
  calls = 0
  prompts: string[] = []
  systems: string[] = []
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    this.calls++
    this.prompts.push(opts.prompt)
    this.systems.push(opts.system ?? '')
    return Promise.resolve(JSON.stringify({ facts: [] }))
  }
}

// ───────────────────────────── Transcriptions fictives ─────────────────────────────

const FAKE = {
  openai: 'sk-' + 'FICTIF' + 'a1b2c3d4'.repeat(3),
  github: 'ghp_' + 'Fict0' + 'x9Y8z7W6'.repeat(3),
  bearer: 'opaqueFICTIF' + '0123456789abcdef',
  dbPass: 'MotDePasse' + 'Fictif42',
}

const base = { sessionId: 'sess-fictive', cwd: '/fictif/orion', version: '2.0.0', userType: 'external', isSidechain: false }
let clock = 0
const ts = (): string => new Date(Date.UTC(2026, 5, 1, 10, 0, clock++)).toISOString()
const human = (text: string): string =>
  JSON.stringify({ ...base, type: 'user', timestamp: ts(), origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', message: { role: 'user', content: text } })
const userWith = (text: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ ...base, type: 'user', timestamp: ts(), ...extra, message: { role: 'user', content: text } })
const bare = (text: string): string => JSON.stringify({ type: 'user', timestamp: ts(), message: { role: 'user', content: text } })
const assistant = (text: string): string =>
  JSON.stringify({ ...base, type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const queued = (prompt: unknown, extra: Record<string, unknown> = { origin: { kind: 'human' } }): string =>
  JSON.stringify({ ...base, type: 'attachment', timestamp: ts(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt, ...extra } })

/**
 * Session Claude Code reprenant les cas relevés sur de vraies sessions (champs
 * réels : origin.kind, turnOrigin, promptSource, isMeta, isCompactSummary,
 * pièces jointes queued_command), y compris des lignes anciennes sans champs.
 */
function claudeFixture(): string {
  clock = 0
  return [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'sess-fictive' }),
    human('Je veux que le projet fictif Orion utilise Vitest pour tous les tests.'),
    assistant('D’accord, je configure Vitest pour Orion.'),
    human(
      `Config de test : clé ${FAKE.openai}, jeton GitHub ${FAKE.github}, appel avec Authorization: Bearer ${FAKE.bearer}, ` +
        `base postgres://orion:${FAKE.dbPass}@db.example.test:5432/app`,
    ),
    assistant('Configuration notée, sans la recopier.'),
    userWith(
      '<task-notification>\n<task-id>t-1</task-id>\n<status>completed</status>\n<summary>Agent "audit fictif" completed</summary>\n<result>IDEE-SOUS-AGENT : migrer Orion vers Deno.</result>\n</task-notification>',
      { origin: { kind: 'task-notification' }, promptSource: 'system', turnOrigin: 'task_notification' },
    ),
    assistant('Le sous-agent propose une migration ; je te laisse décider.'),
    userWith(
      'This session is being continued from a previous conversation that ran out of context. Summary: IDEE-RESUME, l’assistant recommande Postgres 17.',
      { isCompactSummary: true, isVisibleInTranscriptOnly: true },
    ),
    userWith('Base directory for this skill: /fictif/skill\n\n# Compétence fictive\nIDEE-COMPETENCE : toujours lancer le linter.', { isMeta: true }),
    queued('Et n’oublie pas : IDEE-FILE-ATTENTE, garde les logs en JSON.'),
    queued('<task-notification><summary>autre tâche</summary></task-notification>', { origin: { kind: 'task-notification' } }),
    queued('message relayé IDEE-PAIR-FILE', { origin: { kind: 'peer' }, isMeta: true }),
    assistant('Je garde les logs en JSON.'),
    bare('Another Claude session sent a message: <message>IDEE-PAIR : utiliser Redis.</message>'),
    bare('<command-name>/compact</command-name>'),
    bare('<local-command-stdout>Compacted IDEE-COMMANDE</local-command-stdout>'),
    userWith('Relevé programmé fictif IDEE-PROGRAMME : vérifie la boîte de test.', { isMeta: true, promptSource: 'system', turnOrigin: 'scheduled', scheduledTaskId: 'cron-1' }),
    assistant('Rien de nouveau dans la boîte de test.'),
    bare('<system-reminder>Rappel fictif IDEE-RAPPEL</system-reminder>'),
    human('Parfait, je valide Vitest.'),
    queued('Parfait, je valide Vitest.'),
    queued([{ type: 'text', text: 'IDEE-FIN : pense à la documentation.' }]),
  ].join('\n')
}

/** Transcription d'un sous-agent (« sidechain ») : l'humain n'y écrit jamais. */
function sidechainFixture(): string {
  const side = { ...base, isSidechain: true, agentId: 'a-fictif' }
  return [
    JSON.stringify({ ...side, type: 'user', timestamp: '2026-06-01T11:00:00.000Z', message: { role: 'user', content: 'Tâche fictive IDEE-ORCHESTRATEUR : analyse le module Orion.' } }),
    JSON.stringify({ ...side, type: 'assistant', timestamp: '2026-06-01T11:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Analyse faite : le module Orion est propre.' }] } }),
    JSON.stringify({ ...side, type: 'user', isMeta: true, timestamp: '2026-06-01T11:00:02.000Z', message: { role: 'user', content: '<system-reminder>rappel fictif</system-reminder>' } }),
  ].join('\n')
}

/**
 * VALEURS D'OR : hash des fenêtres de ces fixtures calculés avec le code
 * d'AVANT les correctifs (parser et gabarit de hash d'origine). Si l'un d'eux
 * change, toutes les fenêtres déjà extraites des vraies bases repartiraient au
 * LLM (ticket #27).
 */
const GOLDEN_MAIN = [
  '08cccb5640f49404a6eb1d24345c2951f926b89090f59053102b6564fb0a54d6',
  '2c27e1d7915e62388e0d636ce1c33aa63255923d5c8679c58c81ded985c63706',
  '75e7eaf9b14d9e1adde12f7d0edbf7a18f724c754cc0455f26bc9221e5099348',
]
const GOLDEN_SIDECHAIN = ['29d7863b4a9174bd075f03ec0e99e60fcbecfc010f44124aa825cd874e3c246b']

// ───────────────────────────── Banc ─────────────────────────────

let root: string
let m: Memoria | null = null

function newMemoria(extraction: LlmProvider | null): Memoria {
  m = Memoria.init({ storageRoot: join(root, 'storage'), configPath: join(root, 'config.toml'), llm: { extraction }, secretsVault: 'aes-vault' })
  return m
}

/** Fichier sous une arborescence Claude Code fictive (format détecté par le chemin). */
function writeTranscript(rel: string, content: string): string {
  const file = join(root, '.claude', 'projects', '-fictif', rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

function windowHashes(mem: Memoria, instance: string): string[] {
  const store = new ContentStore(mem.paths.assistantDb(instance))
  try {
    return (store.db.prepare('SELECT window_hash FROM transcript_window_state').all() as Array<{ window_hash: string }>).map(r => r.window_hash).sort()
  } finally {
    store.close()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-import-gates-'))
})

afterEach(() => {
  m?.close()
  m = null
  rmSync(root, { recursive: true, force: true })
})

// ───────────────────────────── 1. Secrets ─────────────────────────────

describe('secrets : rien ne part au LLM en clair', () => {
  const values = Object.values(FAKE)

  it('Claude Code : clé sk-, jeton ghp_, Bearer, mot de passe dans une URL → masqués, valeurs au coffre', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = writeTranscript('sess.jsonl', claudeFixture())

    const report = await mem.importTranscripts(instance, [file])

    expect(fake.calls).toBe(3)
    const all = fake.prompts.join('\n')
    for (const v of values) expect(all, 'une valeur de secret a atteint le LLM').not.toContain(v)
    expect(all).toContain('[secret:')
    expect(report.windows_with_secrets).toBe(1)
    expect(report.notes[0]).toMatch(/^secrets : 1 fenêtre\(s\) contenaient un secret/)
    // Même configuration que la capture : la valeur est au coffre, sous le nom du placeholder.
    const names = [...all.matchAll(/\[secret:([^\]]+)\]/g)].map(x => x[1]!)
    expect(names).toHaveLength(4)
    const vault = (mem as unknown as { secretProvider: { get(n: string): string | null } }).secretProvider
    expect(names.map(n => vault.get(n)).sort()).toEqual([...values].sort())
  })

  it('tour coupé par le parseur au milieu d’une clé : le début de la clé ne part pas', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    // 20 000 caractères au plus par tour : la clé fictive commence 14 caractères avant la coupe.
    const key = 'sk-' + 'FICTIFcoupe' + 'q1w2e3r4'.repeat(4)
    const long = 'x'.repeat(20_000 - 15) + ' ' + key + ' suite'
    const file = writeTranscript('coupe.jsonl', [human(long), assistant('Bien reçu.'), human('Merci.'), assistant('De rien.')].join('\n') + '\n')

    await mem.importTranscripts(instance, [file])

    const all = fake.prompts.join('\n')
    expect(all).toContain('…[tronqué]')
    expect(all, 'le début de la clé coupée a atteint le LLM').not.toContain(key.slice(0, 10))
  })

  it('dry-run : compte les fenêtres à secret, aucun appel LLM, rien au coffre', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = writeTranscript('sess.jsonl', claudeFixture())

    const report = await mem.importTranscripts(instance, [file], { dryRun: true })

    expect(fake.calls).toBe(0)
    expect(report.windows).toBe(3)
    expect(report.windows_with_secrets).toBe(1)
    expect(report.notes[0]).toMatch(/^secrets : 1 fenêtre\(s\) à envoyer contiennent un secret/)
    const vault = (mem as unknown as { secretProvider: { get(n: string): string | null } }).secretProvider
    const { RegexRedactor } = await import('../src/secrets/redaction.js')
    for (const s of new RegexRedactor().redact(FAKE.openai).found) expect(vault.get(s.name)).toBeNull()
  })

  it('tout format : conversation d’export (tour + contexte) et rollout Codex masqués aussi, même sans redactor passé', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const unit: TranscriptUnit = {
      key: 'chatgpt:conv-secret',
      label: 'Conversation fictive',
      format: 'chatgpt',
      turns: [
        { role: 'user', text: `Ma base : postgres://moi:${FAKE.dbPass}@db.example.test/app` },
        { role: 'assistant', text: 'Noté.' },
      ],
      sourceHash: 'chatgpt:hash-fictif-1',
      size: 100,
      mtimeMs: 1,
      context: `Conversation « test ${FAKE.openai} »`,
    }
    const codex = join(root, '.codex', 'sessions', '2026', '06', '01', 'rollout-fictif.jsonl')
    mkdirSync(dirname(codex), { recursive: true })
    writeFileSync(
      codex,
      [
        JSON.stringify({ timestamp: '2026-06-01T08:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Utilise le jeton ${FAKE.github} pour la CI.` }] } }),
        JSON.stringify({ timestamp: '2026-06-01T08:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CI configurée.' }] } }),
      ].join('\n'),
    )

    // Appel direct sans `redactor` : le masquage par défaut s'applique.
    const report = await importTranscripts({ files: [codex], units: [unit], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: Number.POSITIVE_INFINITY, tailQuietMs: 0 })

    expect(fake.calls).toBe(2)
    const all = fake.prompts.join('\n')
    for (const v of [FAKE.dbPass, FAKE.openai, FAKE.github]) expect(all).not.toContain(v)
    expect(report.windows_with_secrets).toBe(2)
  })

  it('tour abrégé (consigne d’un agent parent) : masqué AVANT la coupe, un secret coupé ne part pas en clair', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    // La coupe (2 500 caractères) tombe juste après le mot de passe, avant « @hôte » :
    // masqué après la coupe, le motif ne reconnaissait plus rien.
    const head = 'Tâche fictive : '
    const tail = ` postgres://orion:${FAKE.dbPass}`
    const prompt = head + 'a'.repeat(2500 - head.length - tail.length) + tail + '@db.example.test/app puis la suite de la consigne.'
    const side = { ...base, isSidechain: true, agentId: 'a-coupe' }
    const file = writeTranscript(
      'sess/subagents/agent-a-coupe.jsonl',
      [
        JSON.stringify({ ...side, type: 'user', timestamp: '2026-06-01T11:00:00.000Z', message: { role: 'user', content: prompt } }),
        JSON.stringify({ ...side, type: 'assistant', timestamp: '2026-06-01T11:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fait.' }] } }),
      ].join('\n'),
    )

    const report = await mem.importTranscripts(instance, [file])

    expect(fake.calls).toBe(2) // la consigne ferme sa fenêtre à elle seule (≥ 2 000 caractères)
    expect(fake.prompts.join('\n')).not.toContain(FAKE.dbPass)
    expect(fake.prompts[0]).toContain('…[abrégé]')
    expect(fake.prompts[0]).not.toMatch(/\[secret:[^\]]*…\[abrégé\]/) // jamais un placeholder coupé en deux
    // Coupé avec son placeholder : rien de ce secret n'est envoyé, donc rien n'est compté ni mis au coffre.
    expect(report.windows_with_secrets).toBe(0)
  })

  it('import ChatGPT par le moteur : secret masqué et mis au coffre (même câblage que la capture)', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.ensureChatGptInstance()
    const unit: TranscriptUnit = {
      key: 'chatgpt:conv-coffre',
      label: 'Coffre',
      format: 'chatgpt',
      turns: [
        { role: 'user', text: `Mon jeton : ${FAKE.github}` },
        { role: 'assistant', text: 'Noté.' },
      ],
      sourceHash: 'chatgpt:hash-fictif-3',
      size: 10,
      mtimeMs: 1,
    }

    const report = await mem.importChatGpt(instance, [unit])

    expect(fake.prompts.join('\n')).not.toContain(FAKE.github)
    expect(report.windows_with_secrets).toBe(1)
    const name = /\[secret:([^\]]+)\]/.exec(fake.prompts[0]!)?.[1]
    const vault = (mem as unknown as { secretProvider: { get(n: string): string | null } }).secretProvider
    expect(vault.get(name!)).toBe(FAKE.github)
  })
})

// ───────────────────────────── 2. Hash des fenêtres inchangé ─────────────────────────────

describe('hash des fenêtres : identique au code d’avant', () => {
  it('fenêtres extraites = valeurs d’or (étiquettes, file d’attente et masquage hors hash)', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const main = writeTranscript('sess.jsonl', claudeFixture())
    const side = writeTranscript('sess/subagents/agent-a-fictif.jsonl', sidechainFixture())

    await mem.importTranscripts(instance, [main, side])

    expect(windowHashes(mem, instance)).toEqual([...GOLDEN_MAIN, ...GOLDEN_SIDECHAIN].sort())
    // Et le texte envoyé n'est PLUS celui qui fait le hash (sinon le test d'or ne prouverait rien).
    expect(fake.prompts.some(p => p.includes('[secret:'))).toBe(true)
  })
})

// ───────────────────────────── 3. Auteur des tours ─────────────────────────────

describe('auteur des tours Claude Code', () => {
  it('parser : mêmes tours qu’avant (rôle, texte), auteur réel noté à part, file d’attente rattachée', () => {
    const turns = parseClaudeCodeTranscript(claudeFixture())
    // Rôles et nombre de tours inchangés : 16 tours, comme l'ancien parser.
    expect(turns.map(t => t.role).join(',')).toBe('user,assistant,user,assistant,user,assistant,user,user,assistant,user,user,user,user,assistant,user,user')
    expect(turns.map(t => t.source ?? '-')).toEqual([
      '-', '-', '-', '-', 'notification', '-', 'summary', 'system', '-', 'peer', 'command', 'command', 'scheduled', '-', 'system', '-',
    ])
    // Le message en file (humain) précède la réponse qui le traite ; notification et message relayé en file écartés.
    expect(turns[8]!.queuedBefore).toEqual(['Et n’oublie pas : IDEE-FILE-ATTENTE, garde les logs en JSON.'])
    // En fin de fichier : rattaché au dernier tour ; le doublon d'un tour tapé n'est pas repris.
    expect(turns[15]!.queuedAfter).toEqual(['IDEE-FIN : pense à la documentation.'])
    expect(turns.filter((t: Turn) => t.queuedBefore || t.queuedAfter)).toHaveLength(2)

    const side = parseClaudeCodeTranscript(sidechainFixture())
    expect(side.map(t => t.source ?? '-')).toEqual(['orchestrator', '-', 'system'])
  })

  it('prompt LLM : seul l’humain est [user] ; résultat de sous-agent, résumé, compétence et rappel non envoyés', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const main = writeTranscript('sess.jsonl', claudeFixture())
    const side = writeTranscript('sess/subagents/agent-a-fictif.jsonl', sidechainFixture())

    await mem.importTranscripts(instance, [main, side])

    const all = fake.prompts.join('\n')
    const userLines = all.split('\n').filter(l => l.startsWith('- [user'))
    expect(userLines).toEqual([
      '- [user] Je veux que le projet fictif Orion utilise Vitest pour tous les tests.',
      expect.stringMatching(/^- \[user\] Config de test : clé \[secret:/),
      '- [user, sent while the assistant was working] Et n’oublie pas : IDEE-FILE-ATTENTE, garde les logs en JSON.',
      '- [user] Parfait, je valide Vitest.',
      '- [user, sent while the assistant was working] IDEE-FIN : pense à la documentation.',
    ])
    // Notification : son résumé, pas le résultat du sous-agent (déjà extrait de sa propre transcription).
    expect(all).toContain('- [task notification, not written by the user] Agent "audit fictif" completed')
    for (const absent of ['IDEE-SOUS-AGENT', 'IDEE-RESUME', 'IDEE-COMPETENCE', 'IDEE-RAPPEL', 'IDEE-PAIR-FILE']) expect(all).not.toContain(absent)
    expect(all).toContain('- [summary of the earlier conversation, written by the assistant (omitted)]')
    expect(all).toContain('- [message from another agent session, not the user] Another Claude session sent a message: <message>IDEE-PAIR')
    expect(all).toContain('- [scheduled task prompt, sent automatically] Relevé programmé fictif IDEE-PROGRAMME')
    expect(all).toContain('- [local command or its output] <local-command-stdout>Compacted IDEE-COMMANDE')
    expect(all).toContain('- [instructions from the agent that launched this sub-agent, not the user] Tâche fictive IDEE-ORCHESTRATEUR')
    // Le prompt système demande de nommer l'auteur réel d'une idée ou d'une décision.
    expect(fake.systems.every(s => s === TRANSCRIPT_EXTRACTION_SYSTEM)).toBe(true)
    expect(TRANSCRIPT_EXTRACTION_SYSTEM).toMatch(/Only \[user\] and \[user, …\] lines were written by the human user/)
    expect(TRANSCRIPT_EXTRACTION_SYSTEM).toMatch(/"The assistant proposed…"/)
  })

  it('une fenêtre sans tour étiqueté part au LLM telle qu’avant (conversations d’export inchangées)', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const unit: TranscriptUnit = {
      key: 'chatgpt:conv-simple',
      label: 'Simple',
      format: 'chatgpt',
      turns: [
        { role: 'user', text: 'Idée fictive : une appli de vélo.' },
        { role: 'assistant', text: 'Bonne idée.' },
      ],
      sourceHash: 'chatgpt:hash-fictif-2',
      size: 10,
      mtimeMs: 1,
    }
    await importTranscripts({ files: [], units: [unit], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: Number.POSITIVE_INFINITY, tailQuietMs: 0 })
    expect(fake.prompts).toEqual([
      'Extrait de conversation :\n- [user] Idée fictive : une appli de vélo.\n- [assistant] Bonne idée.\n\nObjet JSON {"facts": [...]} des faits durables :',
    ])
  })
})

// ───────────────────────────── 4. Ancre ─────────────────────────────

describe('ancre : une fenêtre identique ailleurs ne fait plus sauter le début', () => {
  const paste = 'Contexte fictif réutilisé. '.repeat(80) // ~2 160 caractères : ferme une fenêtre à lui seul
  const longReply = 'Réponse détaillée fictive. '.repeat(80)

  it('conversations d’export : l’idée placée avant un texte commun à une autre conversation est envoyée', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const unit = (id: string, turns: Turn[]): TranscriptUnit => ({ key: `chatgpt:${id}`, label: id, format: 'chatgpt', turns, sourceHash: `chatgpt:${id}`, size: 1, mtimeMs: 1 })
    const A = unit('conv-A', [
      { role: 'user', text: paste },
      { role: 'assistant', text: 'Bien reçu A.' },
    ])
    const B = unit('conv-B', [
      { role: 'user', text: 'Mon idée IDEE-appli-velo : une appli fictive.' },
      { role: 'assistant', text: longReply },
      { role: 'user', text: paste },
      { role: 'assistant', text: 'Bien reçu B.' },
    ])
    const opts = { files: [], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: Number.POSITIVE_INFINITY, tailQuietMs: 0 }

    await importTranscripts({ ...opts, units: [A, B] })
    expect(fake.prompts.some(p => p.includes('IDEE-appli-velo'))).toBe(true)
  })

  it('fichier Claude Code jamais vu : une fenêtre déjà extraite d’un autre fichier ne fait pas sauter les précédentes', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    clock = 0
    const a = writeTranscript('a.jsonl', [human(paste), assistant('Bien reçu A.')].join('\n'))
    await mem.importTranscripts(instance, [a])
    expect(fake.calls).toBe(2) // [paste] seul, puis [Bien reçu A.]

    const b = writeTranscript('b.jsonl', [human('Mon idée IDEE-fichier-B : un outil fictif.'), assistant(longReply), human(paste), assistant('Bien reçu B.')].join('\n'))
    const report = await mem.importTranscripts(instance, [b])
    expect(fake.prompts.some(p => p.includes('IDEE-fichier-B'))).toBe(true)
    expect(report.windows_skipped_known).toBe(1) // seule la fenêtre commune est sautée
  })

  it('fichier vu vide (0 fenêtre), puis rempli avec une fenêtre connue ailleurs : son début est envoyé', async () => {
    const fake = new RecordingExtraction()
    const mem = newMemoria(fake)
    const instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    clock = 0
    const a = writeTranscript('a.jsonl', [human(paste), assistant('Bien reçu A.')].join('\n'))
    await mem.importTranscripts(instance, [a])
    const b = writeTranscript('b.jsonl', JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 's-b' }))
    await mem.importTranscripts(instance, [b]) // aucun tour : état « complet », 0 fenêtre
    writeFileSync(b, [human('Mon idée IDEE-fichier-vide : un outil fictif.'), assistant(longReply), human(paste), assistant('Bien reçu B.')].join('\n'))

    await mem.importTranscripts(instance, [b])
    expect(fake.prompts.some(p => p.includes('IDEE-fichier-vide'))).toBe(true)
  })
})
