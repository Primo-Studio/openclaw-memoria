/**
 * `ensureDaemon` face à launchd (service `memoria autostart on`), launchd
 * SIMULÉ via les hooks — aucun launchctl réel, aucun effet sur la machine.
 *
 * Le bug d'origine (27/08) : `memoria autostart on` puis `memoria start`
 * lançaient DEUX daemons ; le second prenait daemon.lock et launchd bouclait
 * en échec. Et après `memoria stop` (sortie propre), launchd ne relançait
 * pas seul → Memoria restait éteinte jusqu'au prochain login.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDaemon, readDaemonState, startDaemon, type RunningDaemon } from '../src/index.js'

/** Le process existe-t-il ? (signal 0 = test d'existence, sans effet) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let root: string
let configPath: string
let inProcess: RunningDaemon | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-ensure-launchd-'))
  configPath = join(root, 'config.toml')
})

/** Arrête un daemon spawné (détaché) par ensureDaemon, puis efface le tmp. */
async function stopSpawned(): Promise<void> {
  const state = readDaemonState(root)
  if (state && pidAlive(state.pid)) {
    process.kill(state.pid, 'SIGTERM')
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && pidAlive(state.pid)) await new Promise(r => setTimeout(r, 100))
  }
}

afterEach(async () => {
  if (inProcess) {
    await inProcess.close()
    inProcess = null
  }
  await stopSpawned()
  rmSync(root, { recursive: true, force: true })
})

describe('ensureDaemon + launchd', () => {
  it('service launchd pour un AUTRE stockage → jamais kickstarté, démarrage direct', async () => {
    const kickstart = vi.fn(() => true)
    const state = await ensureDaemon({ storageRoot: root, configPath }, { launchd: { targets: () => false, kickstart } })
    expect(kickstart).not.toHaveBeenCalled()
    expect(pidAlive(state.pid)).toBe(true)
  }, 30_000)

  it('kickstart accepté mais rien ne démarre → repli sur le démarrage direct après waitMs', async () => {
    const kickstart = vi.fn(() => true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t0 = Date.now()
    const state = await ensureDaemon({ storageRoot: root, configPath }, { launchd: { targets: () => true, kickstart, waitMs: 400 } })
    expect(kickstart).toHaveBeenCalledOnce()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(pidAlive(state.pid)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('launchd'))
    warn.mockRestore()
  }, 30_000)

  it('kickstart qui lance VRAIMENT le daemon → réutilisé, aucun second daemon', async () => {
    const kickstart = vi.fn(() => {
      // launchd simulé : démarre le daemon dans ce process, de façon asynchrone.
      void startDaemon({ storageRoot: root, configPath }).then(d => {
        inProcess = d
      })
      return true
    })
    const state = await ensureDaemon({ storageRoot: root, configPath }, { launchd: { targets: () => true, kickstart, waitMs: 15_000 } })
    expect(kickstart).toHaveBeenCalledOnce()
    // Même daemon que celui « de launchd » : pas de spawn parallèle.
    expect(inProcess).not.toBeNull()
    expect(state.daemon_id).toBe(inProcess!.state.daemon_id)
    expect(state.pid).toBe(process.pid)
  }, 30_000)

  it('démarrage direct : le daemon spawné reçoit --storage-root ET --config (sinon il lisait ~/.memoria/config.toml)', async () => {
    const spawned: string[][] = []
    const spawnDaemon = vi.fn((args: string[]) => {
      spawned.push(args)
      // launchd absent : on simule le process détaché par un daemon en process.
      void startDaemon({ storageRoot: root, configPath }).then(d => {
        inProcess = d
      })
    })
    const state = await ensureDaemon({ storageRoot: root, configPath }, { launchd: { targets: () => false, kickstart: () => false }, spawnDaemon })
    expect(spawnDaemon).toHaveBeenCalledOnce()
    expect(spawned[0]).toContain('--storage-root')
    expect(spawned[0]![spawned[0]!.indexOf('--storage-root') + 1]).toBe(root)
    expect(spawned[0]).toContain('--config')
    expect(spawned[0]![spawned[0]!.indexOf('--config') + 1]).toBe(configPath)
    expect(state.pid).toBe(process.pid)
  }, 30_000)

  it('daemon déjà vivant → ni kickstart ni spawn', async () => {
    inProcess = await startDaemon({ storageRoot: root, configPath })
    const kickstart = vi.fn(() => true)
    const state = await ensureDaemon({ storageRoot: root, configPath }, { launchd: { targets: () => true, kickstart } })
    expect(kickstart).not.toHaveBeenCalled()
    expect(state.daemon_id).toBe(inProcess.state.daemon_id)
  }, 30_000)
})
