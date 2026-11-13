/**
 * Importeur de transcripts (spec §7.2) :
 *  - parsers des 4 formats réels (Claude Code / Codex rollout / Codex history /
 *    Markdown) sur des mini-fichiers reproduisant les structures EXACTES, bruit
 *    filtré ;
 *  - importTranscripts → faits en QUARANTAINE (dormant + pending) : invisibles
 *    au recall, visibles via listReview, approuvables par lot ;
 *  - idempotence (ré-import = 0 nouveau), dédup (même fait sur 2 fenêtres = 1),
 *    dryRun (0 écriture), sinceDate (filtre les vieux tours), sans LLM (0 fait).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/engine/memoria.js'
import { ContentStore } from '../src/storage/content.js'
import {
  detectTranscriptFormat,
  parseClaudeCodeTranscript,
  parseCodexHistory,
  parseCodexRollout,
  parseMarkdown,
} from '../src/migration/transcript-parsers.js'
import {
  importTranscripts,
  LLM_CIRCUIT_BREAKER_FAILURES,
  MAX_FILE_ATTEMPTS,
  MAX_OUTAGE_ATTEMPTS,
  type ImportTranscriptsMemoria,
} from '../src/migration/import-transcripts.js'
import type { CompleteOptions, LlmProvider } from '../src/llm/provider.js'

// ───────────────────────────── Faux LLM déterministe ─────────────────────────

/** Émet 1 fait durable par fenêtre, dérivé du contenu (faits distincts). */
class FakeExtraction implements LlmProvider {
  readonly name = 'fake'
  readonly model = 'fake'
  calls = 0
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    this.calls++
    // Fait dérivé d'un mot saillant du prompt → un fait par fenêtre, distinct.
    const m = opts.prompt.match(/\b(scaleway|convex|vitest|postgres|stripe|vercel|ollama|qwen)\b/i)
    const topic = m ? m[1]!.toLowerCase() : `sujet${this.calls}`
    return Promise.resolve(
      JSON.stringify({
        facts: [{ fact: `Le projet utilise ${topic} comme brique technique de référence`, category: 'config', confidence: 0.9 }],
      }),
    )
  }
}

/** Émet TOUJOURS le même fait → teste la dédup inter-fenêtres. */
class ConstantExtraction implements LlmProvider {
  readonly name = 'const'
  readonly model = 'const'
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(): Promise<string> {
    return Promise.resolve(
      JSON.stringify({ facts: [{ fact: 'Le déploiement se fait sur Vercel en production', category: 'process', confidence: 0.9 }] }),
    )
  }
}

// ─────────────────────────────── Parsers ───────────────────────────────

describe('parsers', () => {
  it('Claude Code : type user/assistant, content string OU blocs text, bruit tool_use/thinking ignoré', () => {
    const lines = [
      // contenu = string
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T10:00:00.000Z', message: { role: 'user', content: 'Configure le projet avec Convex.' } }),
      // contenu = tableau de blocs (text + thinking + tool_use à filtrer)
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-01T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'réflexion interne à ignorer' },
            { type: 'text', text: 'Convex est configuré.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      // événements à ignorer : summary + tool_result-only
      JSON.stringify({ type: 'summary', summary: 'résumé', leafUuid: 'x' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'sortie outil' }] } }),
      'ligne json invalide {{{', // ligne corrompue : ignorée, pas de throw
    ].join('\n')

    const turns = parseClaudeCodeTranscript(lines)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', text: 'Configure le projet avec Convex.' })
    expect(turns[0]!.ts).toBe('2026-06-01T10:00:00.000Z')
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'Convex est configuré.' })
  })

  it('Codex rollout : response_item/message, blocs input_text/output_text, environment_context ignoré', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-06-02T08:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ajoute des tests vitest.' }] },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:00:10.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests vitest ajoutés.' }] },
      }),
      // bruit système : <environment_context> → filtré
      JSON.stringify({
        timestamp: '2026-06-02T07:59:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/x</environment_context>' }] },
      }),
      // autres types à ignorer
      JSON.stringify({ timestamp: '2026-06-02T08:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      JSON.stringify({ timestamp: '2026-06-02T08:00:01.000Z', type: 'event_msg', payload: { type: 'token_count' } }),
    ].join('\n')

    const turns = parseCodexRollout(lines)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', text: 'Ajoute des tests vitest.' })
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'Tests vitest ajoutés.' })
  })

  it('Codex history : prompts user seuls, ts epoch s → ISO', () => {
    const lines = [
      JSON.stringify({ session_id: 's1', ts: 1_733_040_000, text: 'Migre vers Postgres.' }),
      JSON.stringify({ session_id: 's1', ts: 1_733_040_060, text: 'Utilise Stripe pour le paiement.' }),
      'corrompu', // ignorée
    ].join('\n')

    const turns = parseCodexHistory(lines)
    expect(turns).toHaveLength(2)
    expect(turns.every(t => t.role === 'user')).toBe(true)
    expect(turns[0]!.text).toBe('Migre vers Postgres.')
    expect(turns[0]!.ts).toBe(new Date(1_733_040_000_000).toISOString())
  })

  it('Markdown : découpe en sections de titre ##, role user', () => {
    const md = ['# Titre principal', 'intro', '', '## Section A', 'contenu A sur plusieurs', 'lignes', '', '## Section B', 'contenu B'].join('\n')
    const turns = parseMarkdown(md)
    expect(turns.length).toBeGreaterThanOrEqual(2)
    expect(turns.every(t => t.role === 'user')).toBe(true)
    expect(turns.some(t => t.text.includes('Section A') && t.text.includes('contenu A'))).toBe(true)
    expect(turns.some(t => t.text.includes('Section B'))).toBe(true)
  })

  it('detectTranscriptFormat : par chemin et par contenu', () => {
    expect(detectTranscriptFormat('/home/u/.codex/history.jsonl', '')).toBe('codex-history')
    expect(detectTranscriptFormat('/home/u/.codex/sessions/2026/06/01/rollout-abc.jsonl', '')).toBe('codex-rollout')
    expect(detectTranscriptFormat('/home/u/.claude/projects/slug/uuid.jsonl', '')).toBe('claude-code')
    expect(detectTranscriptFormat('/x/notes.md', '')).toBe('markdown')
    // par contenu (extension/chemin ambigus)
    expect(detectTranscriptFormat('/x/dump.jsonl', JSON.stringify({ session_id: 's', ts: 1, text: 'hi' }))).toBe('codex-history')
    expect(detectTranscriptFormat('/x/dump.jsonl', JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message' } }))).toBe('codex-rollout')
    expect(detectTranscriptFormat('/x/dump.jsonl', JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }))).toBe('claude-code')
    expect(detectTranscriptFormat('/x/whatever.txt', 'juste du texte libre')).toBe('unknown')
  })
})

// ─────────────────────────── importTranscripts ───────────────────────────

let root: string
let m: Memoria | undefined
let instance: string

function newMemoria(extraction: LlmProvider | null): Memoria {
  m = Memoria.init({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction },
    secretsVault: 'aes-vault',
  })
  return m
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-transcripts-'))
  m = undefined
})

afterEach(() => {
  // Les tests de parsers n'instancient pas Memoria ; ne fermer que si créé.
  m?.close()
  m = undefined
  rmSync(root, { recursive: true, force: true })
})

/** Écrit un transcript Claude Code multi-tours (génère ≥2 fenêtres). */
function writeClaudeFile(path: string, topics: string[], baseTs = '2026-06-05T10:00:00.000Z'): void {
  const lines: string[] = []
  let t = Date.parse(baseTs)
  for (const topic of topics) {
    lines.push(JSON.stringify({ type: 'user', timestamp: new Date(t).toISOString(), message: { role: 'user', content: `On parle de ${topic} maintenant.` } }))
    t += 60_000
    lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(t).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `D'accord, ${topic} est en place et fonctionne bien.` }] } }))
    t += 60_000
  }
  writeFileSync(path, lines.join('\n'))
}

describe('importTranscripts — quarantaine de revue', () => {
  it('faits en quarantaine (dormant + pending) : invisibles au recall, visibles via listReview, approuvables', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id

    const file = join(root, 'conv.jsonl')
    // 4 sujets × 2 tours = 8 tours → ≥2 fenêtres (6 tours/fenêtre)
    writeClaudeFile(file, ['scaleway', 'convex', 'vitest', 'postgres'])

    const report = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })

    expect(report.errors).toEqual([])
    expect(report.files_read).toBe(1)
    expect(report.windows).toBeGreaterThanOrEqual(2)
    expect(fake.calls).toBe(report.windows) // 1 appel LLM / fenêtre
    expect(report.facts_quarantined).toBeGreaterThanOrEqual(2)

    // INVISIBLE au recall normal (faits dormants)
    expect(mem.recall({ instance, query: 'scaleway brique technique' }).items).toHaveLength(0)
    expect(mem.recall({ instance, query: 'convex référence' }).items).toHaveLength(0)

    // VISIBLE dans la file de revue, provenance 'transcript'
    const pending = mem.listReview()
    expect(pending.length).toBe(report.facts_quarantined)
    expect(pending.every(p => p.source_type === 'transcript')).toBe(true)

    // Approbation par lot → recallable
    const { updated } = mem.reviewDecision(pending.map(p => p.id), 'accepted')
    expect(updated).toBe(pending.length)
    expect(mem.recall({ instance, query: 'scaleway brique technique' }).items.length).toBeGreaterThanOrEqual(1)
    expect(mem.listReview()).toHaveLength(0)
  })

  it('idempotence : ré-importer le même fichier → 0 nouveau', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['scaleway', 'convex'])

    const first = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(first.facts_quarantined).toBeGreaterThanOrEqual(1)

    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.files_skipped_already_imported).toBe(1)
    expect(second.files_read).toBe(0)
    expect(second.facts_quarantined).toBe(0)
    expect(second.windows).toBe(0)

    // toujours le même nombre d'items en revue
    expect(mem.listReview().length).toBe(first.facts_quarantined)
  })

  it('dédup : 2 fenêtres produisant le même fait → 1 seul quarantiné', async () => {
    const constant = new ConstantExtraction()
    const mem = newMemoria(constant)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    // 6 sujets × 2 = 12 tours → ≥2 fenêtres, toutes renvoient LE MÊME fait
    writeClaudeFile(file, ['a', 'b', 'c', 'd', 'e', 'f'])

    const report = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: constant })
    expect(report.windows).toBeGreaterThanOrEqual(2)
    expect(report.facts_extracted).toBeGreaterThanOrEqual(2)
    expect(report.facts_quarantined).toBe(1)
    expect(report.facts_skipped_duplicates).toBeGreaterThanOrEqual(1)
    expect(mem.listReview()).toHaveLength(1)
  })

  it('dryRun : parse + compte, AUCUNE écriture', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['scaleway', 'convex', 'vitest', 'postgres'])

    const report = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, dryRun: true })
    expect(report.dry_run).toBe(true)
    expect(report.windows).toBeGreaterThanOrEqual(2)
    expect(report.facts_quarantined).toBe(0)
    expect(fake.calls).toBe(0) // aucune extraction en dry-run

    const store = new ContentStore(mem.paths.assistantDb(instance))
    expect(store.countFacts()).toBe(0)
    const sources = store.db.prepare("SELECT COUNT(*) AS c FROM memory_sources WHERE source_type = 'transcript'").get() as { c: number }
    expect(sources.c).toBe(0)
    store.close()
    expect(mem.listReview()).toHaveLength(0)
  })

  it('sinceDate : filtre les vieux tours', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')

    // 2 tours anciens (2026-01) + 2 récents (2026-06)
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'Vieux sujet ollama.' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Vieille réponse ollama.' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T10:00:00.000Z', message: { role: 'user', content: 'Sujet récent stripe.' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Réponse récente stripe.' }] } }),
    ].join('\n')
    writeFileSync(file, lines)

    const report = await importTranscripts({
      files: [file],
      memoria: mem,
      instanceId: instance,
      extraction: fake,
      sinceDate: '2026-05-01T00:00:00.000Z',
    })

    // Seuls les tours récents survivent → 1 seule fenêtre (2 tours), 1 appel LLM.
    expect(report.windows).toBe(1)
    expect(fake.calls).toBe(1)
    expect(report.facts_quarantined).toBe(1)
  })

  it('sans LLM : 0 fait extrait, note no-llm, aucune invention', async () => {
    const mem = newMemoria(null)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['scaleway', 'convex'])

    const report = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: null })
    expect(report.facts_quarantined).toBe(0)
    expect(report.facts_extracted).toBe(0)
    expect(report.notes.some(n => n.startsWith('no-llm'))).toBe(true)
    expect(mem.listReview()).toHaveLength(0)
  })

  it('maxWindowsPerFile : garde les fenêtres récentes et signale les ignorées', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'big.jsonl')
    // 18 sujets × 2 = 36 tours → 6 fenêtres ; cap à 2 → 4 ignorées.
    writeClaudeFile(file, Array.from({ length: 18 }, (_, i) => `t${i}`))

    const report = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    expect(report.windows).toBe(2)
    expect(report.notes.some(n => n.includes('fenêtre(s) ancienne(s) ignorée(s)'))).toBe(true)
  })

  it('onProgress : appelé après CHAQUE fichier avec compteurs exacts (et un callback qui jette ne casse rien)', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const fileA = join(root, 'a.jsonl')
    const fileB = join(root, 'b.jsonl')
    writeClaudeFile(fileA, ['scaleway'])
    writeClaudeFile(fileB, ['convex'])

    const ticks: Array<{ filesDone: number; filesTotal: number; factsImported: number }> = []
    const report = await mem.importTranscripts(instance, [fileA, fileB], {
      onProgress: p => ticks.push({ ...p }),
    })

    expect(ticks).toHaveLength(2) // 1 tick par fichier
    expect(ticks[0]).toMatchObject({ filesDone: 1, filesTotal: 2 })
    expect(ticks[1]).toMatchObject({ filesDone: 2, filesTotal: 2 })
    // compteur monotone, et le dernier tick reflète le total final
    expect(ticks[1]!.factsImported).toBeGreaterThanOrEqual(ticks[0]!.factsImported)
    expect(ticks[1]!.factsImported).toBe(report.facts_quarantined)

    // un callback qui jette est loggé mais n'interrompt pas l'import
    const fileC = join(root, 'c.jsonl')
    writeClaudeFile(fileC, ['stripe'])
    const report2 = await mem.importTranscripts(instance, [fileC], {
      onProgress: () => {
        throw new Error('boom UI')
      },
    })
    expect(report2.errors).toEqual([])
    expect(report2.files_read).toBe(1)
  })

  // Demandé par la revue adversariale : prouver que la quarantaine d'un agent
  // ne fuite JAMAIS vers un autre agent, avant ET après approbation.
  it('ANTI-FUITE : transcript importé pour A invisible au recall de B', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    const a = mem.pairAssistant({ type: 'claude-code', display_name: 'Agent A' }).assistant_instance_id
    const b = mem.pairAssistant({ type: 'codex', display_name: 'Agent B' }).assistant_instance_id
    const file = join(root, 'a.jsonl')
    writeClaudeFile(file, ['deploiement vercel', 'config firebase'])

    await mem.importTranscripts(a, [file])
    const query = 'deploiement vercel config firebase'

    // B ne voit rien, ni avant ni après l'approbation chez A
    expect(mem.recall({ instance: b, query }).items).toHaveLength(0)
    const items = mem.listReview().map(i => i.id)
    expect(items.length).toBeGreaterThan(0)
    mem.reviewDecision(items, 'accepted')
    expect(mem.recall({ instance: b, query }).items).toHaveLength(0)
    // …mais A, lui, retrouve sa mémoire approuvée
    expect(mem.recall({ instance: a, query }).items.length).toBeGreaterThan(0)
  })
})

// ─────────────── Ticket #27 : import non bloquant, fenêtres retentées ───────────────

/** Échoue (comme un `fetch failed`) sur les fenêtres qui parlent de `failOn`, tant que `failing`. */
class FlakyExtraction extends FakeExtraction {
  failing = true
  constructor(private readonly failOn: string) {
    super()
  }
  override complete(opts: CompleteOptions): Promise<string> {
    if (this.failing && opts.prompt.includes(this.failOn)) {
      this.calls++
      const cause = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' })
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause }))
    }
    return super.complete(opts)
  }
}

/** 6 sujets = 2 fenêtres : [scaleway, convex, vitest] puis [postgres, stripe, vercel]. */
const TWO_WINDOWS = ['scaleway', 'convex', 'vitest', 'postgres', 'stripe', 'vercel']

describe('importTranscripts — ne bloque pas le daemon (ticket #27)', () => {
  it('fichier inchangé (taille + date) : écarté SANS être relu', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['scaleway', 'convex'])
    // Date à la seconde ronde : restaurable à l'identique par utimes.
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000)
    utimesSync(file, stamp, stamp)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    const callsAfterFirst = fake.calls

    // Preuve qu'il n'est pas relu : on remplace le contenu par un AUTRE contenu
    // de même taille en restaurant la date. S'il était lu, le hash différerait
    // et le fichier serait réimporté.
    const before = statSync(file)
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replaceAll('scaleway', 'postgres'))
    utimesSync(file, stamp, stamp)
    expect(statSync(file).size).toBe(before.size)
    expect(Math.trunc(statSync(file).mtimeMs)).toBe(Math.trunc(before.mtimeMs))

    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.files_skipped_already_imported).toBe(1)
    expect(second.files_read).toBe(0)
    expect(fake.calls).toBe(callsAfterFirst)
  })

  it('fichier modifié : relu et réimporté', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['scaleway', 'convex'])
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })

    writeClaudeFile(file, ['scaleway', 'convex', 'stripe', 'postgres', 'vercel', 'ollama'])
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.files_read).toBe(1)
    expect(second.files_skipped_already_imported).toBe(0)
    expect(second.facts_quarantined).toBeGreaterThanOrEqual(1)
  })

  it('même contenu sous une autre date : écarté par le hash, puis par la date au passage suivant', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['scaleway', 'convex'])
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    const calls = fake.calls

    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.files_skipped_already_imported).toBe(1)
    expect(second.notes.some(n => n.includes('(hash)'))).toBe(true)
    const third = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(third.notes.some(n => n.includes('(inchangé)'))).toBe(true)
    expect(fake.calls).toBe(calls)
  })

  it('la boucle d’événements tourne pendant un import de fichiers déjà connus', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const files: string[] = []
    for (let i = 0; i < 40; i++) {
      const file = join(root, `conv-${i}.jsonl`)
      writeClaudeFile(file, [`sujet numero ${i}`])
      files.push(file)
    }
    await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: fake })

    // Un « serveur » concurrent : chaque tour de boucle d'événements compte.
    // Avant le correctif, un lot de fichiers connus ne rendait jamais la main
    // (aucun appel réseau → aucun vrai `await`) : 0 tour pendant tout le lot.
    let ticks = 0
    let done = false
    const server = (async () => {
      while (!done) {
        await new Promise(resolve => setImmediate(resolve))
        ticks++
      }
    })()
    const second = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: fake })
    done = true
    await server
    expect(second.files_skipped_already_imported).toBe(files.length)
    expect(ticks).toBeGreaterThanOrEqual(files.length - 1)
  })
})

describe('importTranscripts — une fenêtre n’est extraite qu’une fois (ticket #27)', () => {
  it('conversation qui grandit : seules les NOUVELLES fenêtres partent au LLM', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    const first = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(first.windows).toBe(2)
    expect(fake.calls).toBe(2)

    // La conversation continue : 3 sujets de plus = 1 fenêtre de plus.
    writeClaudeFile(file, [...TWO_WINDOWS, 'ollama', 'qwen', 'sujet final'])
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.files_read).toBe(1)
    expect(second.windows_skipped_known).toBe(2)
    expect(second.windows).toBe(1)
    expect(fake.calls).toBe(3)
    expect(second.facts_quarantined).toBe(1)
    expect(second.files_incomplete).toBe(0)
  })

  it('même conversation sous un autre chemin : aucune nouvelle extraction', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const a = join(root, 'a.jsonl')
    const b = join(root, 'b.jsonl')
    writeClaudeFile(a, TWO_WINDOWS)
    writeClaudeFile(b, [...TWO_WINDOWS, 'ollama'])
    await importTranscripts({ files: [a], memoria: mem, instanceId: instance, extraction: fake })
    const calls = fake.calls
    const second = await importTranscripts({ files: [b], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.windows_skipped_known).toBe(2)
    expect(fake.calls).toBe(calls + 1)
  })
})

describe('importTranscripts — fenêtres en échec retentées (ticket #27)', () => {
  it('une fenêtre en échec : fichier incomplet, SEULE cette fenêtre repart au prochain import', async () => {
    const flaky = new FlakyExtraction('postgres')
    const mem = newMemoria(flaky)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)

    const first = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(first.windows).toBe(2)
    expect(first.files_incomplete).toBe(1)
    expect(first.facts_quarantined).toBe(1)
    // la cause réseau est journalisée, pas seulement « fetch failed »
    expect(first.errors[0]).toContain('ETIMEDOUT')

    // Le LLM répond de nouveau : seule la fenêtre en échec est rejouée.
    flaky.failing = false
    const callsBefore = flaky.calls
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(flaky.calls - callsBefore).toBe(1)
    expect(second.windows).toBe(1)
    expect(second.files_incomplete).toBe(0)
    expect(second.facts_quarantined).toBe(1)
    expect(mem.listReview().length).toBe(2)

    // Désormais complet : plus aucun appel.
    const third = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(flaky.calls - callsBefore).toBe(1)
    expect(third.files_skipped_already_imported).toBe(1)
  })

  it('fichier entièrement réussi : jamais retenté', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    const first = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(first.files_incomplete).toBe(0)
    const calls = fake.calls
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(fake.calls).toBe(calls)
  })

  it(`échec persistant d'une fenêtre, seule à extraire : ${MAX_FILE_ATTEMPTS} essais au plus, puis abandon signalé`, async () => {
    const flaky = new FlakyExtraction('postgres')
    const mem = newMemoria(flaky)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)

    // Régime courant du daemon : ce fichier est le seul à extraire. L'appel
    // témoin passe (le LLM marche), donc l'essai est compté à chaque import.
    const reports = []
    for (let i = 0; i < MAX_FILE_ATTEMPTS; i++) {
      reports.push(await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky }))
    }
    // 1er passage : 2 fenêtres + 1 témoin. Ensuite : la fenêtre en échec + 1 témoin.
    const expectedCalls = 3 + 2 * (MAX_FILE_ATTEMPTS - 1)
    expect(flaky.calls).toBe(expectedCalls)
    expect(reports[0]!.notes.some(n => n.includes('abandon'))).toBe(false)
    expect(reports.at(-1)!.notes.some(n => n.includes('abandon'))).toBe(true)

    const after = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(flaky.calls).toBe(expectedCalls)
    expect(after.files_skipped_already_imported).toBe(1)
    expect(after.files_incomplete).toBe(0)
  })

  it('sans LLM, un fichier incomplet ne consomme pas d’essai', async () => {
    const flaky = new FlakyExtraction('postgres')
    const mem = newMemoria(flaky)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })

    const noLlm = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: null })
    expect(noLlm.files_skipped_already_imported).toBe(1)

    flaky.failing = false
    const retry = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(retry.windows).toBe(1)
    expect(retry.facts_quarantined).toBe(1)
  })
})

// ─────────────── Relecture du ticket #27 : six défauts de l'import ───────────────

/** Le LLM se dit disponible mais chaque appel échoue (quota épuisé, réseau coupé). */
class DownExtraction extends FakeExtraction {
  /** Nombre d'appels qui réussissent avant la panne. */
  constructor(
    private healthyCalls = 0,
    private readonly message = 'fetch failed',
  ) {
    super()
  }
  override complete(opts: CompleteOptions): Promise<string> {
    if (this.calls >= this.healthyCalls) {
      this.calls++
      return Promise.reject(new Error(this.message))
    }
    return super.complete(opts)
  }
}

interface StateRow {
  complete: number
  attempts: number
  failed_windows: string
}

function fileState(mem: Memoria, path: string): StateRow | undefined {
  const store = new ContentStore(mem.paths.assistantDb(instance))
  try {
    return store.db
      .prepare('SELECT complete, attempts, failed_windows FROM transcript_file_state WHERE path = ?')
      .get(path) as StateRow | undefined
  } finally {
    store.close()
  }
}

/** Vieillit un fichier : la conversation est « au repos ». */
function atRest(path: string): void {
  const old = new Date(Date.now() - 3 * 3_600_000)
  utimesSync(path, old, old)
}

/** 9 sujets = 3 fenêtres pleines, un fait distinct par fenêtre (scaleway, postgres, ollama). */
const THREE_WINDOWS = [...TWO_WINDOWS, 'ollama', 'qwen', 'dernier sujet']

describe('importTranscripts — écriture des faits en échec', () => {
  it('une écriture qui jette sur la 2e fenêtre : les autres fenêtres continuent, celle-ci repart au passage suivant', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, THREE_WINDOWS)

    // Moteur dont le 2e storeFact jette (base occupée un instant).
    let stores = 0
    const interrupted: ImportTranscriptsMemoria = {
      findKnownDuplicate: (i, f, o) => mem.findKnownDuplicate(i, f, o),
      storeFact: input => {
        if (++stores === 2) throw new Error('Memoria est fermé')
        return mem.storeFact(input)
      },
      paths: mem.paths,
      registry: mem.registry,
    }
    const first = await importTranscripts({ files: [file], memoria: interrupted, instanceId: instance, extraction: fake })
    expect(first.errors.some(e => e.includes('Memoria est fermé'))).toBe(true)
    expect(first.facts_quarantined).toBe(2) // fenêtres 1 et 3
    expect(first.files_incomplete).toBe(1)
    expect(fileState(mem, file)).toMatchObject({ complete: 0, attempts: 0 })

    // Relance : le fichier n'est PAS « déjà importé », seule la fenêtre 2 repart.
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.files_skipped_already_imported).toBe(0)
    expect(second.windows_skipped_known).toBe(2)
    expect(second.windows).toBe(1)
    expect(second.facts_quarantined).toBe(1)
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })

    const third = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(third.files_skipped_already_imported).toBe(1)
    expect(fake.calls).toBe(4) // 3 au 1er passage, 1 au 2e, 0 ensuite
  })

  it(`écriture qui échoue toujours pour une fenêtre : rejouée ${MAX_OUTAGE_ATTEMPTS} imports au plus, pas sans fin`, async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, THREE_WINDOWS)
    const refusing: ImportTranscriptsMemoria = {
      findKnownDuplicate: (i, f, o) => mem.findKnownDuplicate(i, f, o),
      storeFact: input => {
        if (input.content.includes('postgres')) throw new Error('écriture refusée')
        return mem.storeFact(input)
      },
      paths: mem.paths,
      registry: mem.registry,
    }
    const run = () => importTranscripts({ files: [file], memoria: refusing, instanceId: instance, extraction: fake })
    const first = await run()
    expect(first.facts_quarantined).toBe(2)
    let last = first
    for (let i = 1; i < MAX_OUTAGE_ATTEMPTS; i++) last = await run()
    expect(last.notes.some(n => n.includes('abandon'))).toBe(true)
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
    const calls = fake.calls
    expect(calls).toBe(3 + (MAX_OUTAGE_ATTEMPTS - 1))
    const after = await run()
    expect(after.files_skipped_already_imported).toBe(1)
    expect(fake.calls).toBe(calls)
  })
})

describe('importTranscripts — panne du LLM', () => {
  it('panne pendant plus de passages que MAX_FILE_ATTEMPTS : aucun essai compté, tout repart au retour du LLM', async () => {
    const down = new DownExtraction()
    const mem = newMemoria(down)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)

    for (let i = 0; i <= MAX_FILE_ATTEMPTS; i++) {
      const r = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: down })
      expect(r.files_incomplete).toBe(1)
      expect(r.notes.some(n => n.includes('abandon'))).toBe(false)
    }
    expect(fileState(mem, file)).toMatchObject({ complete: 0, attempts: 0 })

    const fake = new FakeExtraction()
    const back = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(back.windows).toBe(2)
    expect(back.facts_quarantined).toBe(2)
    expect(back.files_incomplete).toBe(0)
  })

  it('coupe-circuit : après N échecs d’affilée, plus aucun appel et les fichiers restants sont laissés intacts', async () => {
    const down = new DownExtraction()
    const mem = newMemoria(down)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const files: string[] = []
    for (let i = 0; i < 5; i++) {
      const file = join(root, `conv-${i}.jsonl`)
      // 6 sujets propres à chaque fichier = 2 fenêtres pleines.
      writeClaudeFile(file, Array.from({ length: 6 }, (_, k) => `fichier ${i} point ${k}`))
      files.push(file)
    }

    const report = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: down })
    // 10 fenêtres, 5 appels seulement : 4 fenêtres et 1 appel témoin.
    expect(down.calls).toBe(LLM_CIRCUIT_BREAKER_FAILURES)
    expect(report.notes.some(n => n.startsWith('coupe-circuit'))).toBe(true)
    // Fichiers 0 et 1 : touchés par la panne, incomplets, aucun essai. Les autres : jamais ouverts.
    for (const f of files.slice(0, 2)) expect(fileState(mem, f)).toMatchObject({ complete: 0, attempts: 0 })
    for (const f of files.slice(2)) expect(fileState(mem, f)).toBeUndefined()

    const fake = new FakeExtraction()
    const back = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: fake })
    expect(back.windows).toBe(10)
    expect(back.files_incomplete).toBe(0)
  })

  it('limite de débit (HTTP 429) : panne générale sans appel témoin, aucune fenêtre usée, coupe-circuit ouvert', async () => {
    const limited = new DownExtraction(0, 'openai /chat/completions : HTTP 429 rate limit exceeded')
    const mem = newMemoria(limited)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const files: string[] = []
    for (let i = 0; i < 5; i++) {
      const file = join(root, `conv-${i}.jsonl`)
      writeClaudeFile(file, Array.from({ length: 6 }, (_, k) => `fichier ${i} point ${k}`))
      files.push(file)
    }
    // Chaque import : exactement N appels (aucun témoin), puis le coupe-circuit.
    for (let pass = 1; pass <= 12; pass++) {
      const report = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: limited })
      expect(limited.calls).toBe(pass * LLM_CIRCUIT_BREAKER_FAILURES)
      expect(report.notes.some(n => n.startsWith('coupe-circuit'))).toBe(true)
    }
    // Douze imports sous limite de débit : rien n'a été abandonné, tout repart ensuite.
    const fake = new FakeExtraction()
    const back = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: fake })
    expect(back.windows).toBe(10)
    expect(back.files_incomplete).toBe(0)
  })

  it('panne qui commence en cours de run : aucun essai compté, même si le LLM avait répondu avant', async () => {
    const down = new DownExtraction(2) // le 1er fichier réussit, puis plus rien
    const mem = newMemoria(down)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const files: string[] = []
    for (let i = 0; i < 4; i++) {
      const file = join(root, `conv-${i}.jsonl`)
      writeClaudeFile(file, Array.from({ length: 6 }, (_, k) => `fichier ${i} point ${k}`))
      files.push(file)
    }
    const report = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: down })
    expect(report.notes.some(n => n.startsWith('coupe-circuit'))).toBe(true)
    expect(fileState(mem, files[0]!)).toMatchObject({ complete: 1 })
    // Fichiers 1 et 2 : l'appel témoin a échoué lui aussi, c'est une panne.
    expect(fileState(mem, files[1]!)).toMatchObject({ complete: 0, attempts: 0 })
    expect(fileState(mem, files[2]!)).toMatchObject({ complete: 0, attempts: 0 })
    expect(fileState(mem, files[3]!)).toBeUndefined() // coupe-circuit ouvert avant lui
  })

  it(`fenêtre seule à extraire pendant une panne sans fin : abandonnée après ${MAX_OUTAGE_ATTEMPTS} imports`, async () => {
    const down = new DownExtraction()
    const mem = newMemoria(down)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['un', 'deux', 'trois']) // 1 fenêtre pleine
    let last
    for (let i = 0; i < MAX_OUTAGE_ATTEMPTS; i++) {
      last = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: down })
    }
    expect(last!.notes.some(n => n.includes('abandon'))).toBe(true)
    expect(down.calls).toBe(2 * MAX_OUTAGE_ATTEMPTS) // la fenêtre + l'appel témoin
    const after = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: down })
    expect(after.files_skipped_already_imported).toBe(1)
    expect(down.calls).toBe(2 * MAX_OUTAGE_ATTEMPTS)
  })
})

/** Échoue toujours, comme un fournisseur, sur les fenêtres qui contiennent `failOn` (le reste marche). */
class IndigestibleExtraction extends FakeExtraction {
  constructor(
    private readonly failOn: string,
    private readonly error: () => Error,
  ) {
    super()
  }
  override complete(opts: CompleteOptions): Promise<string> {
    if (opts.prompt.includes(this.failOn)) {
      this.calls++
      return Promise.reject(this.error())
    }
    return super.complete(opts)
  }
}

/** Répond toujours, mais jamais par du JSON (mauvais modèle chargé). */
class ProseExtraction extends FakeExtraction {
  override complete(): Promise<string> {
    this.calls++
    return Promise.resolve('Bien sûr, voici un résumé de la conversation.')
  }
}

describe('importTranscripts — erreur propre à une fenêtre', () => {
  const errors: Array<[string, () => Error]> = [
    ['HTTP 400 contexte trop long', () => new Error('lmstudio /chat/completions HTTP 400 (modèle x) : context length exceeded')],
    ['HTTP 500 du serveur local', () => new Error('ollama /api/chat HTTP 500 (modèle x) : model runner has unexpectedly stopped')],
    ['délai dépassé', () => Object.assign(new Error('délai dépassé (60000 ms)'), { name: 'LlmTimeoutError' })],
  ]
  for (const [label, error] of errors) {
    it(`${label} sur 5 fenêtres d'affilée, avant un fichier sain : pas de coupe-circuit, ${MAX_FILE_ATTEMPTS} essais puis abandon`, async () => {
      const llm = new IndigestibleExtraction('indigeste', error)
      const mem = newMemoria(llm)
      instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
      const bad = join(root, 'a-indigeste.jsonl')
      const healthy = join(root, 'b-sain.jsonl')
      writeClaudeFile(bad, Array.from({ length: 15 }, (_, i) => `indigeste ${i}`)) // 5 fenêtres pleines
      writeClaudeFile(healthy, ['scaleway', 'convex', 'vitest'])
      const run = () => importTranscripts({ files: [bad, healthy], memoria: mem, instanceId: instance, extraction: llm })

      const first = await run()
      expect(first.notes.some(n => n.startsWith('coupe-circuit'))).toBe(false)
      expect(first.facts_quarantined).toBe(1) // le fichier sain n'est pas bloqué
      expect(fileState(mem, healthy)).toMatchObject({ complete: 1 })
      expect(fileState(mem, bad)).toMatchObject({ complete: 0, attempts: 1 })

      for (let i = 1; i < MAX_FILE_ATTEMPTS; i++) {
        const r = await run()
        expect(r.notes.some(n => n.startsWith('coupe-circuit'))).toBe(false)
      }
      expect(fileState(mem, bad)).toMatchObject({ complete: 1 })
      const calls = llm.calls
      const fourth = await run()
      expect(fourth.files_skipped_already_imported).toBe(2)
      expect(llm.calls).toBe(calls) // plus aucun appel : rien n'est rejoué sans fin
    })
  }

  it('réponses sans JSON pour toutes les fenêtres : coupe-circuit, rien d’abandonné, tout repart avec un bon modèle', async () => {
    const prose = new ProseExtraction()
    const mem = newMemoria(prose)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const files: string[] = []
    for (let i = 0; i < 3; i++) {
      const file = join(root, `conv-${i}.jsonl`)
      writeClaudeFile(file, Array.from({ length: 6 }, (_, k) => `fichier ${i} point ${k}`))
      files.push(file)
    }
    for (let i = 0; i <= MAX_FILE_ATTEMPTS; i++) {
      const r = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: prose })
      expect(r.notes.some(n => n.startsWith('coupe-circuit'))).toBe(true)
      expect(r.notes.some(n => n.includes('abandon'))).toBe(false)
    }
    expect(prose.calls).toBe(LLM_CIRCUIT_BREAKER_FAILURES * (MAX_FILE_ATTEMPTS + 1))
    for (const f of files.slice(0, 2)) expect(fileState(mem, f)).toMatchObject({ complete: 0, attempts: 0 })

    const fake = new FakeExtraction()
    const back = await importTranscripts({ files, memoria: mem, instanceId: instance, extraction: fake })
    expect(back.windows).toBe(6)
    expect(back.files_incomplete).toBe(0)
  })

  it('une fenêtre toujours en échec n’emporte pas les fenêtres reportées par le plafond', async () => {
    const llm = new IndigestibleExtraction('indigeste', () => new Error('openai /chat/completions HTTP 400 (modèle x) : too long'))
    const mem = newMemoria(llm)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    const start = ['alpha a', 'alpha b', 'alpha c']
    const run = () => importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: llm, maxWindowsPerFile: 1 })
    writeClaudeFile(file, start)
    await run()
    expect(llm.calls).toBe(1)

    // + 4 fenêtres d'un coup, plafond à 1 : la plus récente (indigeste) passe
    // devant, les 3 autres sont reportées.
    writeClaudeFile(file, [
      ...start,
      ...Array.from({ length: 9 }, (_, i) => `suite ${i}`),
      'indigeste a', 'indigeste b', 'indigeste c',
    ])
    for (let i = 0; i < MAX_FILE_ATTEMPTS; i++) await run()
    // Fenêtre indigeste abandonnée ; les 3 reportées attendent toujours.
    const state = fileState(mem, file)!
    expect(state).toMatchObject({ complete: 0, attempts: 0 })
    expect((JSON.parse(state.failed_windows) as { pending: string[] }).pending).toHaveLength(3)

    let quarantined = 0
    for (let i = 0; i < 3; i++) quarantined += (await run()).facts_quarantined
    expect(quarantined).toBe(3)
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
  })
})

describe('importTranscripts — plafond appliqué aux fenêtres pas encore extraites', () => {
  it('conversation qui grandit de plus que le plafond : l’excédent est reporté, jamais perdu', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    const topics = Array.from({ length: 21 }, (_, i) => `point ${i}`) // 7 fenêtres pleines
    writeClaudeFile(file, topics.slice(0, 6))
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    expect(fake.calls).toBe(2)

    // + 5 fenêtres d'un coup, plafond à 2 par import.
    writeClaudeFile(file, topics)
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    expect(second.windows_skipped_known).toBe(2)
    expect(second.windows).toBe(2)
    expect(second.files_incomplete).toBe(1)
    expect(second.notes.some(n => n.includes('reportée(s)'))).toBe(true)
    expect(fileState(mem, file)).toMatchObject({ complete: 0, attempts: 0 })

    const third = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    expect(third.windows).toBe(2)
    const fourth = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    expect(fourth.windows).toBe(1)
    expect(fourth.files_incomplete).toBe(0)
    expect(fake.calls).toBe(7) // les 7 fenêtres, une fois chacune
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
  })

  it('conversation importée toute jeune, puis croissance au-delà du plafond : reportée, pas ignorée', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    const topics = Array.from({ length: 21 }, (_, i) => `point ${i}`) // 7 fenêtres pleines
    const run = () => importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    // Un seul échange : une fenêtre encore ouverte, dont le hash changera.
    writeClaudeFile(file, topics.slice(0, 1))
    await run()
    expect(fake.calls).toBe(1)

    writeClaudeFile(file, topics)
    const second = await run()
    expect(second.windows).toBe(2)
    expect(second.notes.some(n => n.includes('reportée(s)'))).toBe(true)
    expect(second.notes.some(n => n.includes('ignorée(s)'))).toBe(false)
    expect(second.files_incomplete).toBe(1)

    // Dry-run d'un fichier incomplet et inchangé : il annonce ce qu'un vrai
    // import enverrait, sans rien écrire.
    const before = fileState(mem, file)
    const dry = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2, dryRun: true })
    expect(dry.files_skipped_already_imported).toBe(0)
    expect(dry.windows).toBe(2)
    expect(fileState(mem, file)).toEqual(before)
    expect(fake.calls).toBe(3)

    await run()
    await run()
    const last = await run()
    expect(last.windows).toBe(1)
    expect(fake.calls).toBe(1 + 7) // la jeune fenêtre, puis les 7 pleines, une fois chacune
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
  })

  it('premier import d’un gros fichier puis croissance : le vieil historique ignoré ne ressort pas', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    const topics = Array.from({ length: 21 }, (_, i) => `point ${i}`)
    writeClaudeFile(file, topics.slice(0, 18)) // 6 fenêtres, plafond 2 : 4 ignorées
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    writeClaudeFile(file, topics) // + 1 fenêtre
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, maxWindowsPerFile: 2 })
    expect(second.windows).toBe(1)
    expect(second.files_incomplete).toBe(0)
    expect(fake.calls).toBe(3)
  })
})

describe('importTranscripts — fenêtre de queue d’une conversation en cours', () => {
  it('fichier déjà suivi et modifié depuis peu : la queue incomplète attend le repos, puis part une seule fois', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(fake.calls).toBe(2)

    // La conversation continue, un échange à la fois : la queue reste incomplète.
    writeClaudeFile(file, [...TWO_WINDOWS, 'ollama'])
    const growing = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(growing.windows).toBe(0)
    expect(growing.notes.some(n => n.includes('différée'))).toBe(true)
    expect(growing.files_incomplete).toBe(0)
    writeClaudeFile(file, [...TWO_WINDOWS, 'ollama', 'qwen'])
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(fake.calls).toBe(2) // aucune ré-extraction de la queue pendant qu'elle grandit

    // Fichier au repos : la queue part, une fois, et le fichier est scellé.
    atRest(file)
    const quiet = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(quiet.windows).toBe(1)
    expect(fake.calls).toBe(3)
    expect(fileState(mem, file)).toMatchObject({ complete: 1, attempts: 0 })
    const after = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(after.files_skipped_already_imported).toBe(1)
  })

  it('tailQuietMs = 0 : la queue n’est jamais différée', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    writeClaudeFile(file, [...TWO_WINDOWS, 'ollama'])
    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, tailQuietMs: 0 })
    expect(second.windows).toBe(1)
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
  })
})

describe('importTranscripts — sinceDate et état de fichier', () => {
  const BASE = '2026-06-05T10:00:00.000Z'

  /** Fenêtre 0 (scaleway) en échec, fenêtre 1 extraite, puis état réécrit comme la première version : index [0]. */
  async function legacyState(file: string): Promise<{ mem: Memoria; flaky: FlakyExtraction }> {
    const flaky = new FlakyExtraction('scaleway')
    const mem = newMemoria(flaky)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    writeClaudeFile(file, TWO_WINDOWS)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    // Format actuel : la fenêtre en échec est notée par son hash, avec ses compteurs.
    const work = JSON.parse(fileState(mem, file)!.failed_windows) as { failed: Record<string, number[]>; pending: string[] }
    expect(Object.keys(work.failed)).toHaveLength(1)
    expect(Object.keys(work.failed)[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.values(work.failed)[0]).toEqual([1, 0])
    expect(work.pending).toEqual([])

    const store = new ContentStore(mem.paths.assistantDb(instance))
    store.db.prepare("UPDATE transcript_file_state SET failed_windows = '[0]' WHERE path = ?").run(file)
    store.close()
    flaky.failing = false
    return { mem, flaky }
  }

  it('ancien index numérique, fichier inchangé : la fenêtre en échec (placée avant une fenêtre réussie) est rejouée', async () => {
    const file = join(root, 'conv.jsonl')
    const { mem, flaky } = await legacyState(file)
    const calls = flaky.calls
    const retry = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(flaky.calls - calls).toBe(1)
    expect(retry.facts_quarantined).toBe(1)
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
  })

  it('ancien index numérique, fichier qui a grandi depuis : la fenêtre en échec est rejouée quand même', async () => {
    const file = join(root, 'conv.jsonl')
    const { mem, flaky } = await legacyState(file)
    writeClaudeFile(file, THREE_WINDOWS)
    const calls = flaky.calls
    const retry = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(flaky.calls - calls).toBe(2) // la fenêtre 0 en échec et la nouvelle fenêtre 2
    expect(retry.windows_skipped_known).toBe(1)
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
  })

  it('ancien format (tableau de hash, compteur par fichier) : repris, chaque fenêtre hérite du compteur', async () => {
    const flaky = new FlakyExtraction('postgres')
    const mem = newMemoria(flaky)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    const hash = Object.keys((JSON.parse(fileState(mem, file)!.failed_windows) as { failed: object }).failed)[0]!
    const store = new ContentStore(mem.paths.assistantDb(instance))
    store.db
      .prepare('UPDATE transcript_file_state SET failed_windows = ?, attempts = ? WHERE path = ?')
      .run(JSON.stringify([hash]), MAX_FILE_ATTEMPTS - 1, file)
    store.close()
    // Encore un échec : c'était le dernier essai permis.
    const last = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(last.windows).toBe(1)
    expect(last.notes.some(n => n.includes('abandon'))).toBe(true)
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
  })

  it('retry avec un autre sinceDate : le contenu en échec repart, même redécoupé', async () => {
    const flaky = new FlakyExtraction('stripe')
    const mem = newMemoria(flaky)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    // 12 tours, un par minute. Sans filtre : [0-5] réussit, [6-11] (stripe) échoue.
    writeClaudeFile(file, TWO_WINDOWS, BASE)
    const first = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: flaky })
    expect(first.files_incomplete).toBe(1)

    // Filtre à partir du tour 3 : toujours 2 fenêtres, mais [3-8] et [9-11].
    // L'ancien index « 1 » ne désignait plus que [9-11] : [3-8] n'était jamais
    // extraite et le fichier passait complet.
    flaky.failing = false
    const since = new Date(Date.parse(BASE) + 3 * 60_000).toISOString()
    const second = await importTranscripts({
      files: [file], memoria: mem, instanceId: instance, extraction: flaky, sinceDate: since, tailQuietMs: 0,
    })
    expect(second.windows).toBe(2)
  })

  it('passage filtré par sinceDate : le fichier n’est pas scellé, un import sans date reprend les vieux tours', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, THREE_WINDOWS, BASE)
    atRest(file)
    // À partir du tour 12 : seule la 3e fenêtre (ollama) passe.
    const since = new Date(Date.parse(BASE) + 12 * 60_000).toISOString()
    const first = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, sinceDate: since })
    expect(first.windows).toBe(1)
    expect(first.files_incomplete).toBe(0)

    const second = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(second.files_skipped_already_imported).toBe(0)
    expect(second.windows_skipped_known).toBe(1)
    expect(second.windows).toBe(2) // scaleway et postgres, jamais lues au 1er passage
    expect(fileState(mem, file)).toMatchObject({ complete: 1 })
    const third = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    expect(third.files_skipped_already_imported).toBe(1)
    expect(fake.calls).toBe(3)
  })
})

describe('importTranscripts — dry-run', () => {
  it('n’écrit rien, pas même le rattrapage des norm_hash', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    mem.storeFact({ instance, content: 'Le studio archive ses rushes sur un disque réseau' })
    const nullHashes = (): number => {
      const store = new ContentStore(mem.paths.assistantDb(instance))
      try {
        return (store.db.prepare('SELECT COUNT(*) AS c FROM facts WHERE norm_hash IS NULL').get() as { c: number }).c
      } finally {
        store.close()
      }
    }
    const store = new ContentStore(mem.paths.assistantDb(instance))
    store.db.prepare('UPDATE facts SET norm_hash = NULL').run()
    store.close()
    const before = nullHashes()
    expect(before).toBeGreaterThan(0)

    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, dryRun: true })
    expect(nullHashes()).toBe(before)
    expect(fileState(mem, file)).toBeUndefined()
  })

  it('vrai import : les faits sans norm_hash sont complétés', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    mem.storeFact({ instance, content: 'Le studio archive ses rushes sur un disque réseau' })
    const store = new ContentStore(mem.paths.assistantDb(instance))
    store.db.prepare('UPDATE facts SET norm_hash = NULL').run()
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, ['scaleway'])
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })
    const missing = store.db.prepare('SELECT COUNT(*) AS c FROM facts WHERE norm_hash IS NULL').get() as { c: number }
    store.close()
    expect(missing.c).toBe(0)
  })

  it('compte ce qu’un vrai import enverrait : les fenêtres déjà extraites sont à part', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    instance = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const file = join(root, 'conv.jsonl')
    writeClaudeFile(file, TWO_WINDOWS)
    await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake })

    writeClaudeFile(file, THREE_WINDOWS)
    const dry = await importTranscripts({ files: [file], memoria: mem, instanceId: instance, extraction: fake, dryRun: true })
    expect(dry.windows).toBe(1)
    expect(dry.windows_skipped_known).toBe(2)
    expect(fake.calls).toBe(2)
  })
})
