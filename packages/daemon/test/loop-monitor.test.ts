/**
 * Mesure des blocages du daemon (ticket #27) : un daemon qui « tourne » mais ne
 * répond plus doit se voir dans /v1/health et dans le doctor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOOP_BLOCK_WARN_MS, responsivenessWarning, startLoopMonitor, type LoopMonitor } from '../src/loop-monitor.js'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Le vrai moniteur, avec un compteur de ceux qui tournent encore : c'est le
// seul moyen de voir une fuite (la minuterie est `unref`, rien d'autre ne la trahit).
const running = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/loop-monitor.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/loop-monitor.js')>()
  return {
    ...real,
    startLoopMonitor: (slotMs?: number) => {
      const m = real.startLoopMonitor(slotMs)
      let stopped = false
      running.count++
      return {
        snapshot: m.snapshot,
        stop: () => {
          if (!stopped) running.count--
          stopped = true
          m.stop()
        },
      }
    },
  }
})

let monitor: LoopMonitor | undefined
let daemon: RunningDaemon | undefined
let root: string | undefined

afterEach(async () => {
  monitor?.stop()
  monitor = undefined
  await daemon?.close()
  daemon = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('loop-monitor', () => {
  it('un travail synchrone long est mesuré', async () => {
    monitor = startLoopMonitor()
    await sleep(60)
    const end = Date.now() + 300
    while (Date.now() < end) {
      /* blocage volontaire de la boucle d'événements */
    }
    await sleep(60)
    const snap = monitor.snapshot()
    expect(snap.max_block_ms_1m).toBeGreaterThanOrEqual(200)
    expect(snap.max_block_ms_15m).toBeGreaterThanOrEqual(snap.max_block_ms_1m)
  })

  it('le blocage d’une minute écoulée reste visible sur 15 min', async () => {
    monitor = startLoopMonitor(150) // tranches de 150 ms au lieu d'une minute
    await sleep(40)
    const end = Date.now() + 250
    while (Date.now() < end) {
      /* blocage */
    }
    await sleep(500) // plusieurs tranches calmes passent
    const snap = monitor.snapshot()
    expect(snap.max_block_ms_15m).toBeGreaterThanOrEqual(150)
    expect(snap.max_block_ms_1m).toBeLessThan(150)
  })

  it('avertissement seulement au-delà du seuil', () => {
    expect(responsivenessWarning({ max_block_ms_1m: 40, max_block_ms_15m: LOOP_BLOCK_WARN_MS - 1 })).toBeNull()
    expect(responsivenessWarning({ max_block_ms_1m: 40, max_block_ms_15m: 23_400 })).toContain('23,4 s')
  })

  it('/v1/health et le doctor exposent la réactivité', async () => {
    root = mkdtempSync(join(tmpdir(), 'memoria-loop-'))
    daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
    const client = new DaemonClient(daemon.state)
    const health = await client.health()
    expect(health?.responsiveness?.max_block_ms_15m).toBeGreaterThanOrEqual(0)
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const report = (await admin.doctor()) as { responsiveness?: { max_block_ms_1m: number } }
    expect(report.responsiveness?.max_block_ms_1m).toBeGreaterThanOrEqual(0)
  })

  it('port déjà pris : le démarrage échoue sans laisser de moniteur ni de verrou', async () => {
    root = mkdtempSync(join(tmpdir(), 'memoria-loop-'))
    const blocker: Server = createServer()
    const port = await new Promise<number>(r => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as { port: number }).port)))
    const before = running.count
    try {
      await expect(
        startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, port }),
      ).rejects.toThrow(/EADDRINUSE/)
    } finally {
      await new Promise<void>(r => blocker.close(() => r()))
    }
    expect(running.count).toBe(before)
    expect(existsSync(join(root, 'daemon.lock'))).toBe(false)
  })

  it('daemon.json impossible à écrire : tout est défait (moniteur, verrou, écoute)', async () => {
    root = mkdtempSync(join(tmpdir(), 'memoria-loop-'))
    // Un dossier non vide à la place de daemon.json : le renommage final échoue.
    mkdirSync(join(root, 'daemon.json'))
    writeFileSync(join(root, 'daemon.json', 'occupe'), '', 'utf8')
    const before = running.count
    await expect(
      startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } }),
    ).rejects.toThrow()
    expect(running.count).toBe(before)
    expect(existsSync(join(root, 'daemon.lock'))).toBe(false)
    // Le verrou rendu, un démarrage normal repart une fois l'obstacle levé.
    rmSync(join(root, 'daemon.json'), { recursive: true })
    daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
    expect(daemon.state.port).toBeGreaterThan(0)
  })
})
