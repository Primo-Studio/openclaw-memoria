/**
 * Daemon local unique (spec §2.2) — UN processus détient les DB ;
 * MCP/CLI/UI sont des clients HTTP sur 127.0.0.1.
 *
 * Auth à trois niveaux :
 *  - aucun : /v1/health, /v1/pairing/complete (le code one-shot TTL EST le secret) ;
 *  - Bearer <admin_token> (daemon.json chmod 600) : /v1/admin/* — réservé à
 *    l'utilisateur local (CLI, UI web) ;
 *  - Bearer <instance_token> (issu du pairing) : /v1/memory/* — les agents.
 *
 * Écritures sérialisées de fait : better-sqlite3 est synchrone sur l'unique
 * thread Node → zéro contention inter-process par construction.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  Memoria,
  newToken,
  nowISO,
  type CaptureMode,
  type CaptureTurnInput,
  type ForgetFilter,
  type RecallInput,
  type StoreFactInput,
} from '@memoria/core'
import { findUiDist, serveUi } from './static.js'
import { acquireLock, clearDaemonState, writeDaemonState, type DaemonState } from './state.js'

export const DAEMON_VERSION = '0.1.0'

export interface DaemonOptions {
  storageRoot?: string
  configPath?: string
  /** Port d'écoute ; 0 = éphémère (persisté dans daemon.json). */
  port?: number
  /** Dossier dist de l'UI web (défaut : auto-détection @memoria/web/dist). */
  uiDist?: string
}

export interface RunningDaemon {
  state: DaemonState
  memoria: Memoria
  close: () => Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const memoria = Memoria.init({ storageRoot: opts.storageRoot, configPath: opts.configPath })
  const storageRoot = memoria.paths.root

  const release = acquireLock(storageRoot)
  if (!release) {
    memoria.close()
    throw new Error(`un daemon Memoria tourne déjà pour ${storageRoot} (daemon.lock)`)
  }

  const adminToken = newToken()
  const daemonId = newToken().slice(0, 16)

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      sendJson(res, status, { error: (err as Error).message ?? 'erreur interne' })
    })
  })

  const uiDist = findUiDist(opts.uiDist)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /v1/health') {
      sendJson(res, 200, { ok: true, version: DAEMON_VERSION, daemon_id: daemonId, ui: Boolean(uiDist) })
      return
    }

    if (req.method === 'GET' && uiDist && serveUi(url.pathname, uiDist, res)) return

    if (route === 'POST /v1/pairing/complete') {
      const body = await readJson(req)
      const code = String(body['code'] ?? '')
      const done = memoria.completePairing(code)
      if (!done) throw new HttpError(401, 'code de pairing invalide ou expiré')
      sendJson(res, 200, done)
      return
    }

    const token = bearerToken(req)

    if (url.pathname.startsWith('/v1/admin/')) {
      if (token !== adminToken) throw new HttpError(401, 'token admin requis')
      await handleAdmin(route, url, req, res)
      return
    }

    if (url.pathname.startsWith('/v1/memory/')) {
      if (!token) throw new HttpError(401, 'token d’instance requis')
      const instance = memoria.authenticate(token)
      if (!instance) throw new HttpError(401, 'token d’instance invalide ou révoqué')
      await handleMemory(route, req, res, instance.id)
      return
    }

    throw new HttpError(404, `route inconnue : ${route}`)
  }

  async function handleAdmin(route: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    switch (route) {
      case 'GET /v1/admin/facts': {
        const facts = memoria.browseFacts({
          instance: url.searchParams.get('instance') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        })
        sendJson(res, 200, { facts })
        return
      }
      case 'GET /v1/admin/review': {
        sendJson(res, 200, { items: memoria.listReview() })
        return
      }
      case 'POST /v1/admin/adopt_legacy': {
        const body = await readJson(req)
        const instanceId = String(body['instance'] ?? '')
        if (!instanceId) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, memoria.adoptLegacyInto(instanceId, { reindex: body['reindex'] !== false }))
        return
      }
      case 'GET /v1/admin/scopes': {
        sendJson(res, 200, { scopes: memoria.listScopesWithAccess(), assistants: memoria.registry.listAssistants() })
        return
      }
      case 'POST /v1/admin/share': {
        const body = await readJson(req)
        const factIds = (body['fact_ids'] as string[]) ?? []
        const targetScope = String(body['target_scope'] ?? '')
        if (!targetScope) throw new HttpError(400, 'target_scope requis')
        sendJson(res, 200, memoria.shareFacts(factIds, targetScope))
        return
      }
      case 'POST /v1/admin/policy': {
        const body = await readJson(req)
        const assistantId = String(body['assistant_id'] ?? '')
        const scopeId = String(body['scope_id'] ?? '')
        if (!assistantId || !scopeId) throw new HttpError(400, 'assistant_id et scope_id requis')
        memoria.setScopeAccess(assistantId, scopeId, body as Record<string, never>)
        sendJson(res, 200, { ok: true })
        return
      }
      case 'GET /v1/admin/identity_candidates': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { candidates: memoria.suggestIdentityFacts(instance) })
        return
      }
      case 'POST /v1/admin/review/approve': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.reviewDecision((body['ids'] as string[]) ?? [], 'accepted'))
        return
      }
      case 'POST /v1/admin/review/reject': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.reviewDecision((body['ids'] as string[]) ?? [], 'rejected'))
        return
      }
      case 'GET /v1/admin/capture_mode': {
        sendJson(res, 200, { mode: memoria.getCaptureMode() })
        return
      }
      case 'POST /v1/admin/capture_mode': {
        const body = await readJson(req)
        const mode = String(body['mode'] ?? '') as CaptureMode
        if (!['auto-private', 'review-first', 'incognito'].includes(mode)) {
          throw new HttpError(400, `mode de capture inconnu : ${mode}`)
        }
        memoria.setCaptureMode(mode)
        sendJson(res, 200, { mode })
        return
      }
      case 'POST /v1/admin/pair': {
        const body = await readJson(req)
        const result = memoria.pairAssistant({
          type: (body['type'] as never) ?? 'generic',
          display_name: body['display_name'] as string | undefined,
          machine: body['machine'] as string | undefined,
          profile: (body['profile'] as string | undefined) ?? null,
        })
        sendJson(res, 200, result)
        return
      }
      case 'POST /v1/admin/revoke': {
        const body = await readJson(req)
        memoria.revokeInstance(String(body['assistant_instance_id'] ?? ''))
        sendJson(res, 200, { ok: true })
        return
      }
      case 'GET /v1/admin/agents': {
        sendJson(res, 200, { agents: memoria.listAgents() })
        return
      }
      case 'GET /v1/admin/stats': {
        sendJson(res, 200, memoria.stats())
        return
      }
      case 'GET /v1/admin/doctor': {
        sendJson(res, 200, memoria.doctor())
        return
      }
      case 'POST /v1/admin/forget': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.forget(body as ForgetFilter))
        return
      }
      case 'GET /v1/admin/audit': {
        sendJson(res, 200, { entries: memoria.registry.auditTail(200) })
        return
      }
      default:
        throw new HttpError(404, `route admin inconnue : ${route}`)
    }
  }

  async function handleMemory(route: string, req: IncomingMessage, res: ServerResponse, instanceId: string): Promise<void> {
    switch (route) {
      case 'POST /v1/memory/store_fact': {
        const body = await readJson(req)
        const fact = memoria.storeFact({ ...(body as Omit<StoreFactInput, 'instance'>), instance: instanceId })
        sendJson(res, 200, { fact })
        return
      }
      case 'POST /v1/memory/recall': {
        const body = await readJson(req)
        // Hybride FTS+vectoriel quand un provider d'embeddings est disponible —
        // sinon strictement équivalent au recall FTS.
        const result = await memoria.recallSemantic({ ...(body as Omit<RecallInput, 'instance'>), instance: instanceId })
        sendJson(res, 200, result)
        return
      }
      case 'POST /v1/memory/capture_turn': {
        const body = await readJson(req)
        const messages = body['messages']
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new HttpError(400, 'messages requis (tableau {role, content})')
        }
        const result = await memoria.captureTurn({
          instance: instanceId,
          messages: messages as CaptureTurnInput['messages'],
          active_context: body['active_context'] as CaptureTurnInput['active_context'],
        })
        sendJson(res, 200, result)
        return
      }
      default:
        throw new HttpError(404, `route mémoire inconnue : ${route}`)
    }
  }

  let port: number
  try {
    port = await new Promise<number>((resolvePort, reject) => {
      server.once('error', reject)
      server.listen(opts.port ?? 0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolvePort(addr.port)
        else reject(new Error('adresse d’écoute illisible'))
      })
    })
  } catch (err) {
    release()
    memoria.close()
    throw err
  }

  const state: DaemonState = {
    daemon_id: daemonId,
    port,
    admin_token: adminToken,
    pid: process.pid,
    started_at: nowISO(),
  }
  writeDaemonState(storageRoot, state)

  // Rejeu du WAL au boot (spec §6.2) : best-effort, jamais bloquant pour le
  // démarrage — sans LLM dispo les entrées restent pending (visibles au doctor).
  void memoria
    .replayWal()
    .then(replayed => {
      const totals = replayed.reduce(
        (acc, r) => ({ processed: acc.processed + r.summary.processed, facts: acc.facts + r.summary.facts_created }),
        { processed: 0, facts: 0 },
      )
      if (totals.processed > 0) {
        console.log(`[memoria-daemon] WAL rejoué : ${totals.processed} entrées → ${totals.facts} faits`)
      }
      // rattrapage d'indexation vectorielle (faits jamais embedés)
      return memoria.indexEmbeddings()
    })
    .then(r => {
      if (r.indexed > 0) console.log(`[memoria-daemon] embeddings indexés : ${r.indexed}`)
    })
    .catch((err: unknown) => console.warn('[memoria-daemon] rejeu/indexation au boot en échec :', (err as Error).message))

  const close = async (): Promise<void> => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    clearDaemonState(storageRoot)
    release()
    memoria.close()
  }

  return { state, memoria, close }
}

// ----------------------------------------------------------------- helpers

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim()
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 2_000_000) throw new HttpError(413, 'corps de requête trop grand')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'JSON invalide')
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export type { Server }
