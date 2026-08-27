/**
 * `memoria autostart on|off` : passation entre daemon direct et service
 * launchd, launchd et daemon SIMULÉS (fonctions injectées, fetch stubé) —
 * jamais de launchctl réel, jamais le service de la machine.
 *
 * Bug d'origine (27/08) : « autostart on » faisait bootstrap pendant qu'un
 * daemon direct tenait daemon.lock → l'instance launchd mourait sur le
 * verrou et KeepAlive la relançait toutes les ~10 s ; la CLI affichait ✓.
 * « autostart off » tuait le daemon launchd (bootout) et annonçait
 * « retiré » sans dire que plus rien ne tournait.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutostartStatus } from '@memoria/core'
import { writeDaemonState, type DaemonState } from '@memoria/daemon'
import { AutostartCommand, buildCli } from '../src/index.js'

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

const LOADED: AutostartStatus = {
  supported: true,
  installed: true,
  loaded: true,
  running: true,
  pid: 777,
  runs: 1,
  last_exit_code: 0,
  plistPath: '/fake/fr.primo-studio.memoria.plist',
}

/** daemon.json + health stubé (supervisor = launchd ou null). */
function fakeAliveDaemon(supervisor: 'launchd' | null): DaemonState {
  mkdirSync(root, { recursive: true })
  const state: DaemonState = { daemon_id: 'd-alive', port: 4242, admin_token: 'tok', pid: process.pid, started_at: new Date().toISOString() }
  writeDaemonState(root, state)
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/v1/health')) {
      return new Response(JSON.stringify({ ok: true, version: 't', daemon_id: 'd-alive', pid: process.pid, supervisor }), { status: 200 })
    }
    throw new Error(`URL inattendue : ${String(url)}`)
  }))
  return state
}

const STARTED: DaemonState = { daemon_id: 'd-launchd', port: 5555, admin_token: 'tok2', pid: 777, started_at: new Date().toISOString() }

function command(...argv: string[]): { cmd: AutostartCommand; calls: string[] } {
  const cli = buildCli()
  const cmd = cli.process([...argv, '--storage-root', root, '--config', cfg]) as AutostartCommand
  const calls: string[] = []
  cmd.autostartStatusFn = () => LOADED
  cmd.enableAutostartFn = spec => {
    calls.push(`enable:${spec.programArguments.slice(2).join(' ')}`)
    return LOADED
  }
  cmd.disableAutostartFn = () => {
    calls.push('disable')
    return { ...LOADED, installed: false, loaded: false, running: false, pid: null }
  }
  cmd.ensureDaemonFn = async () => {
    calls.push('ensureDaemon')
    return { ...STARTED, daemon_id: 'd-direct', port: 6666, pid: 8888 }
  }
  cmd.stopDaemonFn = async pid => {
    calls.push(`stop:${pid}`)
    return true
  }
  cmd.waitForDaemonFn = async () => {
    calls.push('waitForDaemon')
    return STARTED
  }
  cmd.waitForExitFn = async pid => {
    calls.push(`waitExit:${pid}`)
    return true
  }
  cmd.startTimeoutMs = 200
  return { cmd, calls }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-autostart-'))
  cfg = join(root, 'config.toml')
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('réseau interdit dans les tests')
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe('memoria autostart on', () => {
  it('aucun daemon : installe, puis n’affiche ✓ qu’après le health du daemon launchd', async () => {
    const { cmd, calls } = command('autostart', 'on')
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(0)
    expect(calls).toEqual([`enable:--storage-root ${root} --config ${cfg}`, 'waitForDaemon'])
    expect(io.out()).toContain('✓ Lancement auto installé et chargé')
    expect(io.out()).toContain('pid 777')
    expect(io.err()).toBe('')
  })

  it('daemon DIRECT vivant : arrêté et attendu AVANT le bootstrap (sinon launchd boucle sur le verrou)', async () => {
    fakeAliveDaemon(null)
    const { cmd, calls } = command('autostart', 'on')
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(0)
    expect(calls).toEqual([`stop:${process.pid}`, `enable:--storage-root ${root} --config ${cfg}`, 'waitForDaemon'])
    expect(io.out()).toContain('Arrêt du daemon direct')
    expect(io.out()).toContain('✓ Lancement auto installé et chargé')
  })

  it('daemon direct qui refuse de mourir : échec net, aucun bootstrap', async () => {
    fakeAliveDaemon(null)
    const { cmd, calls } = command('autostart', 'on')
    cmd.stopDaemonFn = async () => false
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(1)
    expect(io.err()).toContain('ne s’est pas arrêté')
    expect(calls).toEqual([])
  })

  it('daemon déjà sous launchd : idempotent, aucun rechargement (ça le tuerait pour rien)', async () => {
    fakeAliveDaemon('launchd')
    const { cmd, calls } = command('autostart', 'on')
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(0)
    expect(calls).toEqual([])
    expect(io.out()).toContain('déjà actif')
  })

  it('service chargé mais daemon muet : code 1 et renvoi vers memoria.err.log — jamais un ✓', async () => {
    const { cmd } = command('autostart', 'on')
    cmd.waitForDaemonFn = async () => null
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(1)
    expect(io.err()).toContain('ne répond pas')
    expect(io.err()).toContain('memoria.err.log')
    expect(io.out()).not.toContain('✓')
  })

  it('plist écrit mais service non chargé : code 1, texte « n’est pas chargé »', async () => {
    const { cmd } = command('autostart', 'on')
    cmd.enableAutostartFn = () => ({ ...LOADED, loaded: false, running: false, pid: null })
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(1)
    expect(io.err()).toContain('n’est pas chargé')
  })
})

describe('memoria autostart off', () => {
  it('daemon launchd vivant : bootout, attente de sa mort, puis relance en direct — annoncé', async () => {
    const alive = fakeAliveDaemon('launchd')
    const { cmd, calls } = command('autostart', 'off')
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(0)
    expect(calls).toEqual(['disable', `waitExit:${alive.pid}`, 'ensureDaemon'])
    expect(io.out()).toContain('relancé en direct (pid 8888')
  })

  it('daemon direct (ou aucun) : retiré, rien à relancer', async () => {
    fakeAliveDaemon(null)
    const { cmd, calls } = command('autostart', 'off')
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(0)
    expect(calls).toEqual(['disable'])
    expect(io.out()).toBe('✓ Lancement auto retiré.\n')
  })
})

describe('memoria autostart (état)', () => {
  it('chargé mais process mort : le dit, au lieu de rassurer avec « (chargé) »', async () => {
    const { cmd } = command('autostart')
    cmd.autostartStatusFn = () => ({ ...LOADED, running: false, pid: null, runs: 6, last_exit_code: 1 })
    const io = makeIo()
    const code = await buildCli().run(cmd, io.context)
    expect(code).toBe(0)
    expect(io.out()).toContain('ARRÊTÉ')
    expect(io.out()).toContain('6 relances')
    expect(io.out()).toContain('memoria.err.log')
  })

  it('en marche : pid affiché', async () => {
    const { cmd } = command('autostart')
    const io = makeIo()
    await buildCli().run(cmd, io.context)
    expect(io.out()).toContain('en marche, pid 777')
  })
})
