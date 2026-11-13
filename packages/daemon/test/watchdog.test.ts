/**
 * scripts/watchdog.sh (lancé chaque minute par launchd, ticket #27) : sonde
 * /v1/health et alerte après 3 contrôles ratés de suite. Tout est simulé :
 * daemon = petit serveur node:http, alerte = script qui journalise son message.
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'watchdog.sh')

let home: string
let data: string
let alerts: string
let server: Server | null = null

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memoria-watchdog-'))
  data = join(home, 'data')
  alerts = join(home, 'alerts.log')
  mkdirSync(data, { recursive: true })
  const notify = join(home, 'notify.sh')
  writeFileSync(notify, `#!/bin/bash\necho "$1" >> ${JSON.stringify(alerts)}\n`)
  chmodSync(notify, 0o755)
})

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(home, { recursive: true, force: true })
})

/** Faux daemon : répond 200 au health, ou ne répond jamais (`hang`). */
async function fakeDaemon(mode: 'ok' | 'hang'): Promise<void> {
  server = createServer((_req, res) => {
    if (mode === 'ok') res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    // hang : on garde la connexion ouverte sans répondre (daemon bloqué)
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  writeFileSync(join(data, 'daemon.json'), JSON.stringify({ daemon_id: 'x', port, admin_token: 't', pid: 1, started_at: '' }, null, 2))
}

/** Asynchrone : un spawnSync figerait ce process, donc le faux daemon qu'il héberge. */
function runWatchdog(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [SCRIPT], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: home,
        MEMORIA_HOME: data,
        MEMORIA_WATCHDOG_STATE: join(home, 'watchdog.state'),
        MEMORIA_WATCHDOG_LOG: join(home, 'watchdog.log'),
        MEMORIA_WATCHDOG_TIMEOUT_S: '1',
        MEMORIA_WATCHDOG_NOTIFY: join(home, 'notify.sh'),
      },
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`watchdog.sh code ${code}`))))
  })
}

const alertLines = (): string[] => (existsSync(alerts) ? readFileSync(alerts, 'utf8').trim().split('\n') : [])

describe('watchdog.sh', () => {
  it('daemon qui répond : aucune alerte, compteur à zéro', async () => {
    await fakeDaemon('ok')
    await runWatchdog()
    await runWatchdog()
    expect(alertLines()).toHaveLength(0)
    expect(readFileSync(join(home, 'watchdog.state'), 'utf8').trim()).toBe('0')
  })

  it('daemon arrêté (daemon.json absent) : UNE alerte au 3e contrôle raté, pas avant, pas à chaque minute', async () => {
    await runWatchdog()
    await runWatchdog()
    expect(alertLines()).toHaveLength(0)
    await runWatchdog()
    expect(alertLines()).toHaveLength(1)
    expect(alertLines()[0]).toContain('ne répond plus')
    await runWatchdog()
    await runWatchdog()
    expect(alertLines()).toHaveLength(1)
  })

  it('daemon vivant mais bloqué (aucune réponse) : alerte au 3e contrôle', async () => {
    await fakeDaemon('hang')
    await runWatchdog()
    await runWatchdog()
    await runWatchdog()
    expect(alertLines()).toHaveLength(1)
    expect(alertLines()[0]).toContain('aucune réponse')
  }, 20_000)

  it('retour à la normale : une notification de rétablissement, compteur remis à zéro', async () => {
    await runWatchdog()
    await runWatchdog()
    await runWatchdog()
    await fakeDaemon('ok')
    await runWatchdog()
    expect(alertLines()).toHaveLength(2)
    expect(alertLines()[1]).toContain('répond de nouveau')
    expect(readFileSync(join(home, 'watchdog.state'), 'utf8').trim()).toBe('0')
  })
})
