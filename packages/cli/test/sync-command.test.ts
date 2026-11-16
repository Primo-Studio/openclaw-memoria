/**
 * `memoria sync invite | join | status` contre deux vrais daemons locaux
 * (boucle locale, ports libres, coffre de test) : la commande proposée par
 * `invite` est utilisable telle quelle (jamais 0.0.0.0), et `status` montre
 * les espaces de chaque pair (org seulement) et la synchro automatique armée.
 * Données FICTIVES uniquement.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startDaemon, type RunningDaemon } from '@memoria/daemon'
import { buildCli } from '../src/index.js'

let dir: string
let hub: RunningDaemon
let spoke: RunningDaemon
let lanPort: number

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

async function cli(side: 'hub' | 'spoke', ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: Buffer[] = []
  const err: Buffer[] = []
  const stdout = new PassThrough()
  stdout.on('data', (c: Buffer) => out.push(c))
  const stderr = new PassThrough()
  stderr.on('data', (c: Buffer) => err.push(c))
  const code = await buildCli().run([...argv, '--storage-root', join(dir, side), '--config', join(dir, `${side}.toml`)], { stdin: new PassThrough(), stdout, stderr })
  return { code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-synccli-'))
  lanPort = await freePort()
  writeFileSync(join(dir, 'hub.toml'), `[sync]\nenabled = true\nrole = "hub"\nlisten_lan = "127.0.0.1:${lanPort}"\nscopes = ["org"]\n`)
  hub = await startDaemon({ storageRoot: join(dir, 'hub'), configPath: join(dir, 'hub.toml'), llm: { extraction: null } })
  spoke = await startDaemon({ storageRoot: join(dir, 'spoke'), configPath: join(dir, 'spoke.toml'), llm: { extraction: null }, syncFirstTickMs: 60_000 })
  const a = hub.memoria.pairAssistant({ type: 'claude-code', display_name: 'Agent du hub' })
  const org = hub.memoria.registry.ownOrgScope()!
  hub.memoria.setScopeAccess(a.assistant_id, org.id, { can_read: true, can_write: true })
  hub.memoria.storeFact({ instance: a.assistant_instance_id, scope: org.id, content: 'Essai fictif : process de sauvegarde des rushes' })
  // laisser l'écoute LAN se lier
  await new Promise(r => setTimeout(r, 200))
})

afterEach(async () => {
  await hub.close()
  await spoke.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('memoria sync (commandes)', () => {
  it('invite donne une commande utilisable, join relie, status montre org et la synchro armée', async () => {
    const inv = await cli('hub', 'sync', 'invite', '--name', 'Mac de l’équipe')
    expect(inv.code).toBe(0)
    expect(inv.out).toContain('Espaces que ce Mac recevra : org')
    expect(inv.out).not.toContain('0.0.0.0')
    const m = /memoria sync join --hub (\S+) --code (\S+)/.exec(inv.out)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(`127.0.0.1:${lanPort}`)

    const joined = await cli('spoke', 'sync', 'join', '--hub', m![1]!, '--code', m![2]!)
    expect(joined.code).toBe(0)
    expect(joined.out).toContain('Synchro automatique en marche')

    const hs = await cli('hub', 'sync', 'status')
    expect(hs.out).toContain('espaces partagés avec les Mac reliés : org')
    expect(hs.out).toMatch(/\[spoke\].*espaces : org/)
    expect(hs.out).not.toMatch(/espaces : .*user/)

    const ss = await cli('spoke', 'sync', 'status')
    expect(ss.out).toContain('synchro automatique : armée')

    const bad = await cli('hub', 'sync', 'invite', '--scopes', 'user')
    expect(bad.code).toBe(1)
    expect(bad.err).toMatch(/ne se synchronise jamais/)
  })
})
