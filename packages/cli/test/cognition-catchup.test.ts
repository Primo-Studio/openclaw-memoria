/**
 * `memoria cognition catchup` : rattrapage de cognition depuis le terminal.
 * Daemon arrêté = passage local annoncé ; daemon vivant = route admin, suivi
 * jusqu'à la fin. Stockage en tmpdir, aucun LLM, données fictives.
 *
 * Les tests passent par buildCli() : c'est le CLI que reçoit l'utilisateur.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Memoria } from '@memoria/core'
import { startDaemon, type RunningDaemon } from '@memoria/daemon'
import { buildCli, CognitionCatchupCommand } from '../src/index.js'

let root: string
let cfg: string
let daemon: RunningDaemon | null = null

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

function run(args: string[], io: ReturnType<typeof makeIo>): Promise<number> {
  return buildCli().run(['cognition', 'catchup', ...args, '--storage-root', root, '--config', cfg], io.context)
}

type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } }
const dbOf = (m: Memoria, instance: string): Db => m['openContent'](m.paths.assistantDb(instance)).db as unknown as Db

/** Trois souvenirs dans l'état « d'avant la migration » : marqués backfill, sans graphe. */
function seed(m: Memoria): { instance: string; ids: string[] } {
  const instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
  const ids = ['Orion', 'Kestrel', 'Nimbus'].map(
    name => m.storeFact({ instance, content: `Le projet ${name} est suivi par l’agence Brumehost` }).id,
  )
  const db = dbOf(m, instance)
  for (const id of ids) {
    db.prepare("INSERT INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, '2020-01-01T00:00:00.000Z', 'backfill', 0)").run(id)
  }
  return { instance, ids }
}

const linked = (m: Memoria, instance: string, id: string): number =>
  (dbOf(m, instance).prepare('SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?').get(id) as { n: number }).n

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cli-cog-'))
  cfg = join(root, 'config.toml')
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (daemon) await daemon.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

describe('memoria cognition catchup', () => {
  it('daemon arrêté : passage local annoncé, heuristique par défaut', async () => {
    const m = Memoria.init({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    const { instance, ids } = seed(m)
    m.close()

    const io = makeIo()
    expect(await run([], io)).toBe(0)
    expect(io.out()).toContain('daemon arrêté')
    expect(io.out()).toContain('Souvenirs reliés : 3')
    expect(io.out()).toContain('Passés par le LLM : 0')

    const check = Memoria.init({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    for (const id of ids) expect(linked(check, instance, id)).toBeGreaterThan(0)
    check.close()
  })

  it('daemon vivant : lance par la route admin et attend la fin', async () => {
    daemon = await startDaemon({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    const { instance, ids } = seed(daemon.memoria)

    const io = makeIo()
    expect(await run([], io)).toBe(0)
    expect(io.out()).toContain('Rattrapage lancé (heuristique, sans LLM)')
    expect(io.out()).toContain('Souvenirs reliés : 3')
    for (const id of ids) expect(linked(daemon.memoria, instance, id)).toBeGreaterThan(0)

    const status = makeIo()
    expect(await run(['--status'], status)).toBe(0)
    expect(status.out()).toContain('Rattrapage de cognition : done (heuristic)')
  })

  it('--llm sans moteur d’extraction : refus clair du daemon, rien n’est lancé', async () => {
    daemon = await startDaemon({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    const io = makeIo()
    expect(await run(['--llm'], io)).toBe(1)
    expect(io.err()).toContain('aucun moteur d’extraction')
  })

  it('--max-facts invalide et --status sans daemon : erreurs propres', async () => {
    const bad = makeIo()
    expect(await run(['--max-facts', 'beaucoup'], bad)).toBe(1)
    expect(bad.err()).toContain('--max-facts')
    const status = makeIo()
    expect(await run(['--status'], status)).toBe(1)
    expect(status.err()).toContain('daemon arrêté')
  })

  it('la commande fait partie du CLI livré (buildCli)', () => {
    expect(buildCli().process(['cognition', 'catchup', '--status'])).toBeInstanceOf(CognitionCatchupCommand)
  })

  it('daemon arrêté, --llm sans LLM joignable : refus clair, aucun souvenir traité en heuristique', async () => {
    const m = Memoria.init({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    const { instance, ids } = seed(m)
    m.close()

    const io = makeIo()
    expect(await run(['--llm'], io)).toBe(1)
    expect(io.err()).toContain('LLM')
    expect(io.out()).not.toContain('Rattrapage terminé')

    const check = Memoria.init({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    for (const id of ids) expect(linked(check, instance, id)).toBe(0)
    check.close()
  })

  it('suivi : un délai dépassé sur la lecture d’état n’arrête pas la commande', async () => {
    daemon = await startDaemon({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    seed(daemon.memoria)
    // Le daemon est occupé : la première lecture d'état expire, les suivantes passent.
    const realFetch = globalThis.fetch
    let timedOut = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/v1/admin/cognition_catchup') && (init?.method ?? 'GET') === 'GET' && timedOut === 0) {
        timedOut++
        return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      }
      return realFetch(input, init)
    })

    const io = makeIo()
    expect(await run([], io)).toBe(0)
    expect(timedOut).toBe(1)
    expect(io.out()).toContain('le suivi continue')
    expect(io.out()).toContain('Souvenirs reliés : 3')
  })

  it('--cancel : arrête le rattrapage du daemon ; rien en cours = erreur propre', async () => {
    daemon = await startDaemon({ storageRoot: root, configPath: cfg, llm: { extraction: null } })
    const idle = makeIo()
    expect(await run(['--cancel'], idle)).toBe(1)
    expect(idle.err()).toContain('aucun rattrapage')

    // Un rattrapage qui dure, jusqu'à ce qu'on l'annule.
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    vi.spyOn(daemon.memoria, 'processCognition').mockImplementation(async () => {
      await gate
      return { processed: 1, llm_facts: 0, errors: 0, clusters_rebuilt: 0, cancelled: true }
    })
    const cancel = vi.spyOn(daemon.memoria, 'cancelCognitionCatchup').mockImplementation(() => {
      release()
      return true
    })
    const started = makeIo()
    expect(await run(['--no-wait'], started)).toBe(0)

    const io = makeIo()
    expect(await run(['--cancel'], io)).toBe(0)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(io.out()).toContain('Annulation demandée')
    await vi.waitFor(async () => {
      const status = makeIo()
      await run(['--status'], status)
      expect(status.out()).toContain('Rattrapage de cognition : cancelled')
    })
  })
})
