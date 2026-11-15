/**
 * `memoria triage run|status|cancel` : client mince du daemon (routes admin
 * /v1/admin/triage/run), repli local annoncé quand le daemon est arrêté.
 * Le daemon est simulé par un serveur HTTP local (ses routes de tri sont
 * écrites ailleurs). Stockage en tmpdir, aucun LLM, données fictives.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria, storagePaths } from '@memoria/core'
import { buildCli, TriageRunCommand } from '../src/index.js'

let root: string
let cfg: string
let server: Server | null = null

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

const run = (args: string[], io: ReturnType<typeof makeIo>): Promise<number> =>
  buildCli().run(['triage', ...args, '--storage-root', root, '--config', cfg], io.context)

const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  run_id: 'r1',
  state: 'running',
  dry_run: false,
  instance: null,
  started_at: '2026-01-01T00:00:00.000Z',
  updated_at: null,
  finished_at: null,
  budget_usd: 5,
  spent_usd: 0,
  total_spent_usd: 0,
  dbs_total: 1,
  dbs_done: 0,
  facts_done: 0,
  classified: 0,
  inherited: 0,
  sensible: 0,
  failed: 0,
  llm_calls: 0,
  embed_calls: 0,
  tokens_in: 0,
  tokens_out: 0,
  embed_tokens: 0,
  max_block_ms: null,
  error: null,
  estimate: null,
  ...over,
})

/** Faux daemon : /v1/health + routes de tri ; enregistre les requêtes. */
async function fakeDaemon(handler: (method: string, body: unknown) => { code: number; json: unknown }): Promise<Array<{ method: string; body: unknown; auth: string | undefined }>> {
  const seen: Array<{ method: string; body: unknown; auth: string | undefined }> = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      if (req.url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
        return
      }
      if (req.url !== '/v1/admin/triage/run') {
        res.writeHead(404).end('{}')
        return
      }
      const body = raw ? JSON.parse(raw) : null
      seen.push({ method: req.method ?? '', body, auth: req.headers.authorization })
      const r = handler(req.method ?? '', body)
      res.writeHead(r.code, { 'content-type': 'application/json' }).end(JSON.stringify(r.json))
    })
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  writeFileSync(
    storagePaths(root).daemonState,
    JSON.stringify({ daemon_id: 'fictif', port, admin_token: 'jeton-fictif', pid: process.pid, started_at: new Date().toISOString() }),
  )
  return seen
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cli-tri-'))
  cfg = join(root, 'config.toml')
  // Moteurs injoignables (port fermé) : jamais un LLM réel de la machine, même en local.
  writeFileSync(
    cfg,
    '[llm.extraction]\nprovider = "ollama"\nbase_url = "http://127.0.0.1:9"\n[llm.embeddings]\nprovider = "ollama"\nbase_url = "http://127.0.0.1:9"\n',
  )
  Memoria.init({ storageRoot: root, configPath: cfg, llm: { extraction: null } }).close()
})

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(root, { recursive: true, force: true })
})

describe('memoria triage', () => {
  it('daemon vivant : lance par la route admin avec le plafond, suit jusqu’à la fin', async () => {
    let polls = 0
    const seen = await fakeDaemon(method => {
      if (method === 'POST') return { code: 202, json: status() }
      polls++
      return { code: 200, json: polls < 2 ? status({ facts_done: 10 }) : status({ state: 'done', facts_done: 42, classified: 30, inherited: 12, spent_usd: 0.0123 }) }
    })
    const io = makeIo()
    const cli = buildCli()
    const cmd = cli.process(['triage', 'run', '--max-cost', '1.5', '--max-facts', '100', '--storage-root', root, '--config', cfg])
    ;(cmd as TriageRunCommand).pollIntervalMs = 5
    cmd.context = { ...cli.defaultContext, ...io.context } as typeof cmd.context
    expect(await cmd.validateAndExecute()).toBe(0)
    expect(seen[0]).toEqual({ method: 'POST', body: { dry_run: false, budget_usd: 1.5, max_facts: 100 }, auth: 'Bearer jeton-fictif' })
    expect(io.out()).toContain('Tri lancé (plafond 5 $)')
    expect(io.out()).toContain('Souvenirs triés : 42')
    expect(io.out()).toContain('0.0123 $')
  })

  it('daemon vivant : un refus (pause) est affiché tel quel, code 1', async () => {
    await fakeDaemon(() => ({ code: 423, json: { error: 'Memoria est en pause : aucun tri ne part au LLM.' } }))
    const io = makeIo()
    expect(await run(['run'], io)).toBe(1)
    expect(io.err()).toContain('Memoria est en pause')
  })

  it('status et cancel passent par le daemon', async () => {
    const seen = await fakeDaemon(method =>
      method === 'DELETE' ? { code: 200, json: { cancelled: true } } : { code: 200, json: status({ state: 'budget', facts_done: 7, spent_usd: 5 }) },
    )
    const s = makeIo()
    expect(await run(['status'], s)).toBe(0)
    expect(s.out()).toContain('arrêté au plafond de dépense')
    expect(s.out()).toContain('reprend où il s’est arrêté')
    const c = makeIo()
    expect(await run(['cancel'], c)).toBe(0)
    expect(c.out()).toContain('Annulation demandée')
    expect(seen.map(r => r.method)).toEqual(['GET', 'DELETE'])
  })

  it('daemon arrêté : dry-run local annoncé, sans appel ; tri réel sans LLM refusé', async () => {
    const dry = makeIo()
    expect(await run(['run', '--dry-run'], dry)).toBe(0)
    expect(dry.out()).toContain('daemon arrêté')
    expect(dry.out()).toContain('Souvenirs à trier : 0')
    const real = makeIo()
    expect(await run(['run'], real)).toBe(1)
    expect(real.err()).toContain('aucun LLM')
  })

  it('options invalides : erreurs propres', async () => {
    const a = makeIo()
    expect(await run(['run', '--max-cost', 'beaucoup'], a)).toBe(1)
    expect(a.err()).toContain('--max-cost')
    const b = makeIo()
    expect(await run(['run', '--max-facts', '0'], b)).toBe(1)
    expect(b.err()).toContain('--max-facts')
  })
})
