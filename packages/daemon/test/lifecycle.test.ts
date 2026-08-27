/**
 * Cycle de vie RÉEL du daemon détaché : ensureDaemon spawne le vrai
 * packages/daemon/dist/bin.js sur un stockage jetable (launchd simulé absent),
 * on vérifie health, l'arrêt par SIGTERM efface daemon.json + daemon.lock, et
 * un second ensureDaemon relance un daemon NEUF au lieu de croire l'ancien
 * vivant. Aucun test ne couvrait ce chemin — celui qui a laissé Memoria
 * éteinte ~24 h le 26/08.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storagePaths } from '@memoria/core'
import { DaemonClient, ensureDaemon, readDaemonState, waitForExit } from '../src/index.js'

let root: string
const noLaunchd = { launchd: { targets: () => false, kickstart: () => false } }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-lifecycle-'))
})

afterEach(async () => {
  const state = readDaemonState(root)
  if (state && pidAlive(state.pid)) {
    process.kill(state.pid, 'SIGTERM')
    await waitForExit(state.pid, 5_000)
  }
  rmSync(root, { recursive: true, force: true })
})

describe('daemon détaché (spawn réel)', () => {
  it('start → health → SIGTERM → daemon.json et daemon.lock effacés → un second start relance un daemon neuf', async () => {
    const paths = storagePaths(root)
    const first = await ensureDaemon({ storageRoot: root, configPath: join(root, 'config.toml') }, noLaunchd)
    expect(first.pid).not.toBe(process.pid)
    expect(pidAlive(first.pid)).toBe(true)
    expect(existsSync(paths.daemonState)).toBe(true)
    expect(existsSync(paths.daemonLock)).toBe(true)
    const health = await new DaemonClient(first).health()
    expect(health?.pid).toBe(first.pid)
    expect(health?.supervisor).toBeNull()
    expect(health?.config_path).toBe(join(root, 'config.toml')) // --config bien transmis

    // ensureDaemon réutilise le vivant (pas de second process)
    const again = await ensureDaemon({ storageRoot: root, configPath: join(root, 'config.toml') }, noLaunchd)
    expect(again.pid).toBe(first.pid)

    process.kill(first.pid, 'SIGTERM')
    expect(await waitForExit(first.pid, 5_000)).toBe(true)
    expect(existsSync(paths.daemonState)).toBe(false)
    expect(existsSync(paths.daemonLock)).toBe(false)

    const second = await ensureDaemon({ storageRoot: root, configPath: join(root, 'config.toml') }, noLaunchd)
    expect(second.pid).not.toBe(first.pid)
    expect(await new DaemonClient(second).health()).not.toBeNull()
  }, 40_000)
})
