/**
 * Route d'import de l'export ChatGPT (POST /v1/admin/import_start, kind=chatgpt),
 * données fictives :
 *  - dry-run : bilan (conversations, messages, fenêtres, jetons), aucune
 *    instance créée, aucun appel LLM, possible même sans LLM configuré ;
 *  - import réel : instance chatgpt créée une fois puis réutilisée, souvenirs
 *    en revue, ré-import = 0 nouveau ;
 *  - erreurs d'entrée : chemin relatif (400), introuvable (404), instance
 *    d'un autre type (400), import réel sans LLM (422).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompleteOptions, LlmProvider } from '@memoria/core'
import { startDaemon, type ChatGptImportSummary, type ImportJobStatus, type RunningDaemon } from '../src/index.js'

class FakeExtraction implements LlmProvider {
  readonly name = 'openai'
  readonly model = 'gpt-4o-mini'
  calls = 0
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    this.calls++
    const m = opts.prompt.match(/IDEE-(\w+)/)
    return Promise.resolve(
      JSON.stringify({ facts: m ? [{ fact: `L'utilisateur a eu une idée de projet fictif nommée ${m[1]}`, category: 'idea', confidence: 0.9 }] : [] }),
    )
  }
}

let root: string
let daemon: RunningDaemon | null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-chatgpt-route-'))
  mkdirSync(join(root, 'home'), { recursive: true })
  daemon = null
})

afterEach(async () => {
  await daemon?.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

async function boot(extraction: LlmProvider | null): Promise<RunningDaemon> {
  daemon = await startDaemon({
    storageRoot: join(root, 'storage'),
    configPath: join(root, 'config.toml'),
    agentsHome: join(root, 'home'),
    checkCli: () => false,
    registrar: (host, id) => ({ host: 'generic', registered: true, detail: `stub ${host}/${id}` }),
    credentialsDir: join(root, 'credentials'),
    llm: { extraction },
  })
  return daemon
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.state.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${daemon!.state.admin_token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function waitJob(): Promise<ImportJobStatus> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const { json } = await call('GET', '/v1/admin/import_status')
    const status = json as unknown as ImportJobStatus
    if (status.state === 'done' || status.state === 'error') return status
    if (Date.now() > deadline) throw new Error(`job jamais terminé : ${JSON.stringify(status)}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

/** Export fictif : deux conversations, dont une avec un nœud système et un message caché. */
function writeExport(): string {
  const conv = (id: string, idea: string) => ({
    id,
    title: `Conversation ${id}`,
    create_time: 1_735_725_600,
    update_time: 1_735_729_200,
    current_node: `${id}-a`,
    mapping: {
      root: { id: 'root', parent: null, children: [`${id}-s`], message: null },
      [`${id}-s`]: { id: `${id}-s`, parent: 'root', children: [`${id}-h`], message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['consigne'] } } },
      [`${id}-h`]: {
        id: `${id}-h`,
        parent: `${id}-s`,
        children: [`${id}-u`],
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['caché'] }, metadata: { is_visually_hidden_from_conversation: true } },
      },
      [`${id}-u`]: {
        id: `${id}-u`,
        parent: `${id}-h`,
        children: [`${id}-a`],
        message: { author: { role: 'user' }, create_time: 1_735_725_700, content: { content_type: 'text', parts: [`J'ai une idée : IDEE-${idea}`] }, recipient: 'all' },
      },
      [`${id}-a`]: {
        id: `${id}-a`,
        parent: `${id}-u`,
        children: [],
        message: { author: { role: 'assistant' }, create_time: 1_735_725_760, content: { content_type: 'text', parts: ['Bonne idée.'] }, recipient: 'all' },
      },
    },
  })
  const file = join(root, 'conversations.json')
  writeFileSync(file, JSON.stringify([conv('c-1', 'velo'), conv('c-2', 'jardin')]))
  return file
}

describe('import_start — chatgpt', () => {
  it('dry-run : bilan et coût estimé, aucune instance, aucun appel, même sans LLM joignable', async () => {
    await boot(null)
    const file = writeExport()
    const started = await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: file, dry_run: true })
    expect(started.status).toBe(200)
    const done = await waitJob()
    expect(done.state).toBe('done')
    expect(done.kind).toBe('chatgpt')
    const summary = done.summary as ChatGptImportSummary
    expect(summary).toMatchObject({ dry_run: true, instance_id: null, windows: 2, windows_known: 0 })
    expect(summary.stats).toMatchObject({ conversations_kept: 2, messages_kept: 4, dropped: { system: 2, hidden: 2 } })
    expect(summary.estimate!.input_tokens).toBeGreaterThan(0)
    expect(summary.cost).toBeNull() // aucun moteur d'extraction configuré
    const agents = await call('GET', '/v1/admin/agents')
    expect(JSON.stringify(agents.json)).not.toContain('chatgpt')
  })

  it('import réel : instance chatgpt créée puis réutilisée, souvenirs en revue, ré-import = 0 nouveau', async () => {
    const fake = new FakeExtraction()
    await boot(fake)
    const file = writeExport()

    const dry = await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: file, dry_run: true })
    expect(dry.status).toBe(200)
    const dryDone = await waitJob()
    expect((dryDone.summary as ChatGptImportSummary).cost).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' })
    expect((dryDone.summary as ChatGptImportSummary).cost!.usd).not.toBeNull()
    expect(fake.calls).toBe(0)

    expect((await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: file })).status).toBe(200)
    const first = await waitJob()
    expect(first.state).toBe('done')
    expect(first.progress.facts_imported).toBe(2)
    expect(fake.calls).toBe(2)
    const instance = first.instance_id
    expect(instance).toBeTruthy()

    expect((await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: file })).status).toBe(200)
    const second = await waitJob()
    expect(second.instance_id).toBe(instance)
    expect(second.progress.facts_imported).toBe(0)
    expect((second.summary as ChatGptImportSummary).conversations_unchanged).toBe(2)
    expect(fake.calls).toBe(2)
  })

  it('erreurs d’entrée : chemin relatif, introuvable, instance d’un autre type, import réel sans LLM', async () => {
    await boot(null)
    const file = writeExport()
    expect((await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: 'conversations.json' })).status).toBe(400)
    expect((await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: join(root, 'absent.zip') })).status).toBe(404)
    expect((await call('POST', '/v1/admin/import_start', { kind: 'chatgpt' })).status).toBe(400)

    const connected = await call('POST', '/v1/admin/agents_connect', { kind: 'claude-code' })
    const other = connected.json['instance_id'] as string
    const wrong = await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: file, instance_id: other })
    expect(wrong.status).toBe(400)
    expect(String(wrong.json['error'])).toContain('claude-code')

    expect((await call('POST', '/v1/admin/import_start', { kind: 'chatgpt', path: file })).status).toBe(422)
  })
})
