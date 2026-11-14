/**
 * `memoria import chatgpt <export>` : routage (sans casser `memoria import
 * --instance … --transcripts`), chemin rendu absolu avant l'envoi au daemon,
 * dry-run affiché avec fenêtres, jetons et coût, import réel avec rappel
 * Revue. fetch stubé, aucun réseau, données fictives.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeDaemonState, type ChatGptImportSummary, type ImportJobStatus } from '@memoria/daemon'
import { buildCli } from '../src/index.js'
import { ImportChatGptCommand, ImportCommand } from '../src/commands/import.js'

let root: string
let cfg: string

function makeIo() {
  const out: Buffer[] = []
  const err: Buffer[] = []
  const stdout = new PassThrough()
  stdout.on('data', (c: Buffer) => out.push(c))
  const stderr = new PassThrough()
  stderr.on('data', (c: Buffer) => err.push(c))
  return {
    context: { stdin: new PassThrough(), stdout, stderr },
    out: () => Buffer.concat(out).toString('utf8'),
    err: () => Buffer.concat(err).toString('utf8'),
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function summary(dryRun: boolean): ChatGptImportSummary {
  return {
    dry_run: dryRun,
    instance_id: dryRun ? null : 'inst-chatgpt',
    stats: {
      files: 2,
      conversations_seen: 12,
      conversations_kept: 10,
      conversations_empty: 1,
      conversations_malformed: 1,
      conversations_duplicate: 0,
      messages_on_branch: 60,
      messages_kept: 40,
      nodes_off_branch: 5,
      dropped: { system: 10, hidden: 6, 'type:thoughts': 4 },
    },
    windows: 25,
    windows_known: 0,
    conversations_unchanged: 0,
    estimate: dryRun ? { windows: 25, prompt_chars: 150_000, input_tokens: 40_741, output_tokens: 9_000, output_tokens_max: 25_600 } : null,
    cost: dryRun ? { provider: 'openai', model: 'gpt-4o-mini', usd: 0.01, usd_max: 0.02, pricing_as_of: '2026-08' } : null,
    facts_extracted: dryRun ? 0 : 30,
    facts_quarantined: dryRun ? 0 : 28,
    facts_skipped_duplicates: dryRun ? 0 : 2,
    notes: [],
  }
}

function status(state: ImportJobStatus['state'], extra: Partial<ImportJobStatus> = {}): ImportJobStatus {
  return {
    state,
    kind: 'chatgpt',
    instance_id: null,
    progress: { files_done: 0, files_total: 0, facts_imported: 0 },
    error: null,
    errors: [],
    started_at: new Date().toISOString(),
    finished_at: null,
    ...extra,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cli-chatgpt-'))
  cfg = join(root, 'config.toml')
  writeDaemonState(root, { daemon_id: 'd-test', port: 4242, admin_token: 'token-admin-test', pid: process.pid, started_at: new Date().toISOString() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

const args = (...rest: string[]): string[] => [...rest, '--storage-root', root, '--config', cfg]

describe('memoria import chatgpt', () => {
  it('routage : « import chatgpt <export> » ≠ « import --instance … --transcripts »', () => {
    const cli = buildCli()
    expect(cli.process(['import', 'chatgpt', '/x/export.zip'])).toBeInstanceOf(ImportChatGptCommand)
    expect(cli.process(['import', '--instance', 'inst-1', '--transcripts'])).toBeInstanceOf(ImportCommand)
  })

  it('export introuvable → message clair, aucun appel au daemon', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const io = makeIo()
    expect(await buildCli().run(args('import', 'chatgpt', join(root, 'absent.zip')), io.context)).toBe(1)
    expect(io.err()).toContain('export introuvable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dry-run : chemin ABSOLU envoyé, bilan avec fenêtres, jetons et coût', async () => {
    writeFileSync(join(root, 'export.zip'), 'contenu fictif')
    // Dossier courant simulé : le CLI doit rendre le chemin absolu lui-même.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    let sent: Record<string, unknown> = {}
    let polls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
        if (u.endsWith('/v1/admin/import_start')) {
          sent = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse(status('running'))
        }
        if (u.endsWith('/v1/admin/import_status')) {
          polls++
          if (polls === 1) return jsonResponse(status('running', { progress: { files_done: 3, files_total: 10, facts_imported: 0 } }))
          return jsonResponse(status('done', { summary: summary(true), finished_at: new Date().toISOString() }))
        }
        throw new Error(`URL inattendue : ${u}`)
      }),
    )
    try {
      const io = makeIo()
      const code = await buildCli().run(args('import', 'chatgpt', 'export.zip', '--dry-run', '--poll-ms', '10'), io.context)
      expect(io.err()).toBe('')
      expect(code).toBe(0)
      expect(sent).toMatchObject({ kind: 'chatgpt', dry_run: true })
      expect(sent['path']).toBe(join(root, 'export.zip'))
      expect(sent).not.toHaveProperty('instance_id')
      const out = io.out()
      expect(out).toContain('3/10 conversation(s) comptée(s)')
      expect(out).toContain('10 conversation(s) gardée(s) sur 12')
      expect(out).toContain('Fenêtres à extraire : 25')
      expect(out).toContain('Jetons estimés')
      expect(out).toContain('openai/gpt-4o-mini')
      expect(out).toContain('memoria import chatgpt')
    } finally {
      cwd.mockRestore()
    }
  })

  it('import réel : souvenirs en revue, rappel de l’écran Revue', async () => {
    const file = join(root, 'conversations.json')
    writeFileSync(file, '[]')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url)
        if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
        if (u.endsWith('/v1/admin/import_start')) return jsonResponse(status('running'))
        if (u.endsWith('/v1/admin/import_status')) return jsonResponse(status('done', { summary: summary(false), instance_id: 'inst-chatgpt' }))
        throw new Error(`URL inattendue : ${u}`)
      }),
    )
    const io = makeIo()
    expect(await buildCli().run(args('import', 'chatgpt', file, '--poll-ms', '10'), io.context)).toBe(0)
    expect(io.out()).toContain('28 souvenir(s) mis en attente de revue')
    expect(io.out()).toContain('Revue')
  })
})
