/**
 * `memoria import` (mission B5) — mince client des routes daemon :
 * enregistrement de la commande, validation des arguments, flux complet avec
 * fetch stubé (import_start → polling import_status → résumé), erreurs daemon
 * arrêté et job en échec, coupures réseau transitoires pendant le polling et
 * attente d'un import concurrent (409). Aucun réseau réel, aucun vrai HOME.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeDaemonState, type ImportJobStatus } from '@memoria/daemon'
import { buildCli } from '../src/index.js'
import { ImportCommand } from '../src/commands/import.js'

let root: string
let cfg: string

function makeIo() {
  const outChunks: Buffer[] = []
  const errChunks: Buffer[] = []
  const stdout = new PassThrough()
  stdout.on('data', (c: Buffer) => outChunks.push(c))
  const stderr = new PassThrough()
  stderr.on('data', (c: Buffer) => errChunks.push(c))
  return {
    context: { stdin: new PassThrough(), stdout, stderr },
    out: () => Buffer.concat(outChunks).toString('utf8'),
    err: () => Buffer.concat(errChunks).toString('utf8'),
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function aliveDaemon(): void {
  writeDaemonState(root, {
    daemon_id: 'd-test',
    port: 4242,
    admin_token: 'token-admin-test',
    pid: process.pid,
    started_at: new Date().toISOString(),
  })
}

function status(state: ImportJobStatus['state'], progress: Partial<ImportJobStatus['progress']> = {}, extra: Partial<ImportJobStatus> = {}): ImportJobStatus {
  return {
    state,
    kind: 'transcripts',
    instance_id: 'inst-1',
    progress: { files_done: 0, files_total: 0, facts_imported: 0, ...progress },
    error: null,
    errors: [],
    started_at: new Date().toISOString(),
    finished_at: null,
    ...extra,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cli-import-'))
  cfg = join(root, 'config.toml')
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('réseau interdit dans les tests')
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

const args = (...rest: string[]): string[] => [...rest, '--storage-root', root, '--config', cfg]

describe('memoria import', () => {
  it('est enregistrée dans le CLI', () => {
    const cli = buildCli()
    expect(cli.process(['import', '--instance', 'inst-1', '--transcripts'])).toBeInstanceOf(ImportCommand)
  })

  it('valide les arguments : source obligatoire, exclusive', async () => {
    const cli = buildCli()
    const io1 = makeIo()
    expect(await cli.run(args('import', '--instance', 'inst-1'), io1.context)).toBe(1)
    expect(io1.err()).toContain('indique la source')

    const io2 = makeIo()
    expect(await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--legacy', '/tmp/x.db'), io2.context)).toBe(1)
    expect(io2.err()).toContain('pas les deux')
  })

  it('daemon arrêté → message clair, pas de stack', async () => {
    const cli = buildCli()
    const io = makeIo()
    expect(await cli.run(args('import', '--instance', 'inst-1', '--transcripts'), io.context)).toBe(1)
    expect(io.err()).toContain('memoria start')
  })

  it('flux complet : import_start puis polling jusqu’à done, résumé + rappel Revue', async () => {
    aliveDaemon()
    let polls = 0
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers['authorization']).toBe('Bearer token-admin-test')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toMatchObject({ instance_id: 'inst-1', kind: 'transcripts', max_windows_per_file: 5 })
        return jsonResponse(status('running', { files_total: 2 }))
      }
      if (u.endsWith('/v1/admin/import_status')) {
        polls++
        if (polls === 1) return jsonResponse(status('running', { files_done: 1, files_total: 2, facts_imported: 3 }))
        return jsonResponse(status('done', { files_done: 2, files_total: 2, facts_imported: 7 }, { finished_at: new Date().toISOString() }))
      }
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    const code = await cli.run(
      args('import', '--instance', 'inst-1', '--transcripts', '--max-windows', '5', '--poll-ms', '10'),
      io.context,
    )
    expect(code).toBe(0)
    expect(polls).toBe(2)
    expect(io.out()).toContain('1/2 fichier(s) — 3 souvenir(s)')
    expect(io.out()).toContain('✓ 7 souvenir(s) importé(s)')
    expect(io.out()).toContain('Revue')
  })

  it('job en échec → code 1 + message d’erreur du daemon', async () => {
    aliveDaemon()
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toMatchObject({ kind: 'legacy', legacy_path: '/tmp/legacy.db' })
        return jsonResponse(status('running', {}, { kind: 'legacy' }))
      }
      if (u.endsWith('/v1/admin/import_status')) {
        return jsonResponse(status('error', {}, { kind: 'legacy', error: 'import legacy interrompu : integrity_check non-ok' }))
      }
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    const code = await cli.run(args('import', '--instance', 'inst-1', '--legacy', '/tmp/legacy.db', '--poll-ms', '10'), io.context)
    expect(code).toBe(1)
    expect(io.err()).toContain('integrity_check non-ok')
  })

  it('polling : « fetch failed » transitoires tolérés (compteur remis à zéro), l’import va au bout', async () => {
    aliveDaemon()
    let polls = 0
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) return jsonResponse(status('running', { files_total: 3 }))
      if (u.endsWith('/v1/admin/import_status')) {
        polls++
        // 2 coupures, une réponse, 3 coupures encore (le compteur est bien remis à zéro), puis la fin.
        if (polls <= 2 || (polls >= 4 && polls <= 6)) throw new TypeError('fetch failed')
        if (polls === 3) return jsonResponse(status('running', { files_done: 1, files_total: 3, facts_imported: 2 }))
        return jsonResponse(status('done', { files_done: 3, files_total: 3, facts_imported: 9 }, { finished_at: new Date().toISOString() }))
      }
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    const code = await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--poll-ms', '10'), io.context)
    expect(code).toBe(0)
    expect(polls).toBe(7)
    expect(io.out()).toContain('daemon momentanément injoignable (fetch failed), on réessaie… (1/10)')
    expect(io.out()).toContain('(3/10)')
    expect(io.out()).not.toContain('(4/10)')
    expect(io.out()).toContain('✓ 9 souvenir(s) importé(s)')
    expect(io.err()).toBe('')
  })

  it('polling : au-delà de 10 coupures d’affilée → abandon avec un message clair (l’import continue peut-être)', async () => {
    aliveDaemon()
    let polls = 0
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) return jsonResponse(status('running', { files_total: 3 }))
      if (u.endsWith('/v1/admin/import_status')) {
        polls++
        throw new TypeError('fetch failed')
      }
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    const code = await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--poll-ms', '10'), io.context)
    expect(code).toBe(1)
    expect(polls).toBe(11)
    expect(io.out()).toContain('(10/10)')
    expect(io.err()).toContain('injoignable 11 fois')
    expect(io.err()).toContain('continue peut-être côté daemon')
    expect(io.err()).not.toContain('    at ') // pas de stack
  })

  it('polling : une erreur HTTP du daemon (401 : clé changée) reste fatale, pas « transitoire »', async () => {
    aliveDaemon()
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) return jsonResponse(status('running', { files_total: 3 }))
      if (u.endsWith('/v1/admin/import_status')) return jsonResponse({ error: 'token admin requis' }, 401)
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    expect(await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--poll-ms', '10'), io.context)).toBe(1)
    expect(io.err()).toContain('401')
    expect(io.out()).not.toContain('injoignable')
  })

  it('import_start → 409 : attend la fin de l’import en cours, puis relance le sien', async () => {
    aliveDaemon()
    let starts = 0
    let polls = 0
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) {
        starts++
        if (starts === 1) return jsonResponse({ error: 'un import est déjà en cours — attends sa fin (GET /v1/admin/import_status)' }, 409)
        return jsonResponse(status('running', { files_total: 2 }))
      }
      if (u.endsWith('/v1/admin/import_status')) {
        polls++
        // L'import de l'autre instance : 2 sondes en cours, puis terminé.
        if (polls <= 2) return jsonResponse(status('running', { files_done: polls, files_total: 5 }, { instance_id: 'inst-autre' }))
        if (polls === 3) return jsonResponse(status('done', { files_done: 5, files_total: 5, facts_imported: 4 }, { instance_id: 'inst-autre' }))
        // Puis le nôtre.
        return jsonResponse(status('done', { files_done: 2, files_total: 2, facts_imported: 7 }, { finished_at: new Date().toISOString() }))
      }
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    const code = await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--poll-ms', '10'), io.context)
    expect(code).toBe(0)
    expect(starts).toBe(2)
    expect(polls).toBe(4)
    expect(io.out()).toContain('Un autre import est déjà en cours')
    expect(io.out()).toContain('(import en cours : 2/5 fichier(s)')
    expect(io.out()).toContain('Import précédent terminé (done)')
    expect(io.out()).toContain('Import des conversations lancé…')
    expect(io.out()).toContain('✓ 7 souvenir(s) importé(s)')
  })

  it('import_start → 409 obstiné (5 attentes) → on renonce avec un message, pas de boucle infinie', async () => {
    aliveDaemon()
    let starts = 0
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) {
        starts++
        return jsonResponse({ error: 'un import est déjà en cours' }, 409)
      }
      if (u.endsWith('/v1/admin/import_status')) return jsonResponse(status('idle', {}, { kind: null, instance_id: null }))
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    expect(await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--poll-ms', '10'), io.context)).toBe(1)
    expect(starts).toBe(6)
    expect(io.err()).toContain('occupe toujours le daemon')
  })

  it('la ligne de progression n’est réécrite que quand elle change (journal lisible)', async () => {
    aliveDaemon()
    let polls = 0
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) return jsonResponse(status('running', { files_total: 2 }))
      if (u.endsWith('/v1/admin/import_status')) {
        polls++
        if (polls <= 4) return jsonResponse(status('running', { files_done: 1, files_total: 2, facts_imported: 3 }))
        return jsonResponse(status('done', { files_done: 2, files_total: 2, facts_imported: 3 }))
      }
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    expect(await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--poll-ms', '10'), io.context)).toBe(0)
    expect(io.out().split('1/2 fichier(s) — 3 souvenir(s)').length - 1).toBe(1)
  })

  it('422 du daemon (pas de LLM) → message « moteur d’intelligence » remonté tel quel', async () => {
    aliveDaemon()
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/health')) return jsonResponse({ ok: true, version: 'test', daemon_id: 'd-test' })
      if (u.endsWith('/v1/admin/import_start')) {
        return jsonResponse({ error: 'Configure d’abord un moteur d’intelligence (Réglages) — l’import de conversations a besoin d’un LLM d’extraction.' }, 422)
      }
      throw new Error(`URL inattendue : ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cli = buildCli()
    const io = makeIo()
    const code = await cli.run(args('import', '--instance', 'inst-1', '--transcripts', '--poll-ms', '10'), io.context)
    expect(code).toBe(1)
    expect(io.err()).toContain('moteur d’intelligence')
  })
})
