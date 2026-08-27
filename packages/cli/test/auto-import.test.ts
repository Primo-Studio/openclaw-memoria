/**
 * scripts/auto-import.sh (lancé toutes les 6 h par launchd) : découvre les
 * instances claude-code / codex via l'API admin puis lance `memoria import`
 * pour chacune. Tout est simulé : daemon = petit serveur node:http, CLI = script
 * qui journalise ses arguments, chemins via l'environnement — aucun ~/.memoria.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'auto-import.sh')
const PLIST = join(REPO, 'scripts', 'fr.primo-studio.memoria.autoimport.plist')

let home: string
let data: string
let calls: string
let log: string
let server: Server | null = null

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memoria-autoimport-'))
  data = join(home, 'data')
  calls = join(home, 'cli-calls.log')
  log = join(home, 'auto-import.log')
  mkdirSync(data, { recursive: true })
  // Fausse CLI : journalise ses arguments, réussit.
  writeFileSync(join(home, 'fake-cli.js'), `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n')\n`)
})

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(home, { recursive: true, force: true })
})

/**
 * Lancement ASYNCHRONE obligatoire : le faux daemon vit dans ce process ; un
 * spawnSync bloquerait la boucle d'événements et le script attendrait sa
 * réponse pour toujours.
 */
async function run(arg?: string): Promise<{ status: number | null; log: string; calls: string[] }> {
  const child = spawn('bash', arg ? [SCRIPT, arg] : [SCRIPT], {
    env: {
      ...process.env,
      HOME: home,
      MEMORIA_NODE: process.execPath,
      MEMORIA_CLI: join(home, 'fake-cli.js'),
      MEMORIA_HOME: data,
      MEMORIA_AUTO_IMPORT_LOG: log,
    },
    stdio: 'ignore',
  })
  const status = await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  return { status, log: existsSync(log) ? readFileSync(log, 'utf8') : '', calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [] }
}

/** Faux daemon : /v1/admin/agents protégé par le token de daemon.json. */
async function fakeDaemon(agents: unknown[]): Promise<void> {
  const seen: string[] = []
  server = createServer((req, res) => {
    seen.push(`${req.headers.authorization ?? ''} ${req.url ?? ''}`)
    if (req.url === '/v1/admin/agents' && req.headers.authorization === 'Bearer tok-admin') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ agents }))
      return
    }
    res.writeHead(401).end('{}')
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  writeFileSync(join(data, 'daemon.json'), JSON.stringify({ port, admin_token: 'tok-admin', pid: process.pid }))
}

const AGENTS = [
  { assistant_type: 'claude-code', instance: { id: 'inst-claude', revoked_at: null } },
  { assistant_type: 'codex', instance: { id: 'inst-codex-revoked', revoked_at: '2026-08-01T00:00:00Z' } },
  { assistant_type: 'openclaw', instance: { id: 'inst-koda', revoked_at: null } },
]

describe('auto-import.sh', () => {
  it('syntaxe valide (bash -n)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })

  it('daemon.json absent → « on saute », exit 0, CLI jamais appelée', async () => {
    const r = await run()
    expect(r.status).toBe(0)
    expect(r.log).toContain('on saute')
    expect(r.calls).toEqual([])
  })

  it('un import par instance claude-code/codex NON révoquée — ni l’instance révoquée, ni OpenClaw', async () => {
    await fakeDaemon(AGENTS)
    const r = await run()
    expect(r.status).toBe(0)
    expect(r.calls).toEqual(['import --instance inst-claude --transcripts'])
    expect(r.log).toContain('import inst-claude')
    expect(r.log).toContain('fin')
  })

  it('--max-windows N transmis à la CLI', async () => {
    await fakeDaemon(AGENTS)
    const r = await run('3')
    expect(r.calls).toEqual(['import --instance inst-claude --transcripts --max-windows 3'])
  })

  it('aucune instance éligible → le dit, exit 0', async () => {
    await fakeDaemon([AGENTS[2]!])
    const r = await run()
    expect(r.status).toBe(0)
    expect(r.log).toContain('aucune instance claude-code/codex')
    expect(r.calls).toEqual([])
  })
})

describe('fr.primo-studio.memoria.autoimport.plist', () => {
  it('XML valide (plutil sur macOS) et pointe sur scripts/auto-import.sh du dépôt', () => {
    const xml = readFileSync(PLIST, 'utf8')
    if (process.platform === 'darwin') {
      const lint = spawnSync('plutil', ['-lint', PLIST], { encoding: 'utf8' })
      expect(lint.status, lint.stdout + lint.stderr).toBe(0)
    }
    const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]!)
    const script = args.find(a => a.endsWith('auto-import.sh'))
    expect(script).toBeDefined()
    expect(script!.endsWith('/scripts/auto-import.sh')).toBe(true)
    expect(existsSync(join(REPO, 'scripts', 'auto-import.sh'))).toBe(true)
    expect(xml).toContain('<key>StartInterval</key>')
  })
})
