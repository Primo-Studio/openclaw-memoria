/**
 * Service launchd face à un verrou tenu : ATTENDRE, pas boucler.
 *
 * Avant : « autostart on » + « start » (ou l'inverse) = l'instance launchd
 * mourait en exit 1 sur daemon.lock et KeepAlive la relançait toutes les
 * ~10 s indéfiniment (runs = 6, 9… dans launchctl print, memoria.err.log
 * rempli). Ici le verrou est tenu par CE process (acquireLock), relâché
 * après un délai : le démarrage supervisé doit finir par réussir, avec une
 * seule ligne de journal. Hors launchd : erreur immédiate, typée.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonLockHeldError, acquireLock, lockHolderPid, startWithStandby, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-standby-'))
})

afterEach(async () => {
  await daemon?.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

const opts = () => ({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })

describe('startWithStandby', () => {
  it('supervisé : attend la libération du verrou puis démarre — une seule ligne de journal', async () => {
    const release = acquireLock(root)
    expect(release).not.toBeNull()
    expect(lockHolderPid(root)).toBe(process.pid)
    const logs: string[] = []
    let sleeps = 0
    setTimeout(() => release!(), 250)
    daemon = await startWithStandby(opts(), {
      supervised: true,
      intervalMs: 50,
      sleep: ms => {
        sleeps++
        return new Promise(r => setTimeout(r, ms))
      },
      log: m => logs.push(m),
    })
    expect(daemon.state.pid).toBe(process.pid)
    expect(sleeps).toBeGreaterThanOrEqual(2) // a bien attendu, pas réussi du 1er coup
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`pid ${process.pid}`)
    expect(logs[0]).toContain('attend')
  }, 15_000)

  it('non supervisé (memoria start / daemon) : échec immédiat, erreur typée avec le pid du détenteur', async () => {
    const release = acquireLock(root)!
    try {
      await expect(startWithStandby(opts(), { supervised: false, sleep: async () => {} })).rejects.toBeInstanceOf(DaemonLockHeldError)
      await expect(startWithStandby(opts(), { supervised: false, sleep: async () => {} })).rejects.toThrow(`pid ${process.pid}`)
    } finally {
      release()
    }
  })

  it('supervisé avec borne : relève l’erreur une fois le délai écoulé (le verrou ne bouge pas)', async () => {
    const release = acquireLock(root)!
    try {
      await expect(
        startWithStandby(opts(), { supervised: true, intervalMs: 20, maxWaitMs: 120, sleep: ms => new Promise(r => setTimeout(r, ms)), log: () => {} }),
      ).rejects.toBeInstanceOf(DaemonLockHeldError)
    } finally {
      release()
    }
  })
})
