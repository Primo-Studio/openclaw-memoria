/**
 * `memoria stop` : daemon.json périmé nettoyé, et avertissement quand le
 * daemon arrêté était celui du service launchd (KeepAlive ne le relance pas
 * après une sortie propre — Memoria resterait éteinte jusqu'au login).
 * Le « daemon » est un process `sleep` enfant ; le health est stubé.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storagePaths } from '@memoria/core'
import { writeDaemonState } from '@memoria/daemon'
import { buildCli } from '../src/index.js'

let root: string
let cfg: string
let child: ChildProcess | null = null

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-stop-'))
  cfg = join(root, 'config.toml')
  mkdirSync(root, { recursive: true })
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('réseau interdit dans les tests')
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (child && child.exitCode === null) child.kill('SIGKILL')
  child = null
  rmSync(root, { recursive: true, force: true })
})

const args = (...rest: string[]): string[] => [...rest, '--storage-root', root, '--config', cfg]

describe('memoria stop', () => {
  it('daemon.json périmé (pid mort) : message clair, fichier NETTOYÉ, code 0', async () => {
    writeDaemonState(root, { daemon_id: 'd', port: 1, admin_token: 't', pid: 999_999, started_at: new Date().toISOString() })
    const io = makeIo()
    const code = await buildCli().run(args('stop'), io.context)
    expect(code).toBe(0)
    expect(io.out()).toContain('périmé')
    expect(existsSync(storagePaths(root).daemonState)).toBe(false)
  })

  it('daemon launchd vivant : arrêté, puis prévient qu’il ne redémarrera pas seul', async () => {
    child = spawn('sleep', ['30'], { stdio: 'ignore' })
    writeDaemonState(root, { daemon_id: 'd', port: 1, admin_token: 't', pid: child.pid!, started_at: new Date().toISOString() })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/v1/health')) return new Response(JSON.stringify({ ok: true, version: 't', daemon_id: 'd', supervisor: 'launchd' }), { status: 200 })
      throw new Error(`URL inattendue : ${String(url)}`)
    }))
    const io = makeIo()
    const code = await buildCli().run(args('stop'), io.context)
    expect(code).toBe(0)
    expect(io.out()).toContain(`✓ Daemon arrêté (pid ${child.pid})`)
    expect(io.out()).toContain('launchd')
    expect(io.out()).toContain('memoria start')
  })

  it('daemon direct vivant : arrêté sans avertissement launchd', async () => {
    child = spawn('sleep', ['30'], { stdio: 'ignore' })
    writeDaemonState(root, { daemon_id: 'd', port: 1, admin_token: 't', pid: child.pid!, started_at: new Date().toISOString() })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, version: 't', daemon_id: 'd', supervisor: null }), { status: 200 })))
    const io = makeIo()
    expect(await buildCli().run(args('stop'), io.context)).toBe(0)
    expect(io.out()).toContain('✓ Daemon arrêté')
    expect(io.out()).not.toContain('launchd')
  })
})
