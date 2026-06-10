/**
 * DaemonClient — utilisé par CLI / UI / MCP. Découvre le daemon via
 * `daemon.json`, peut le démarrer s'il n'existe pas (singleton).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveStorageRoot, type RecallResult } from '@memoria/core'
import { daemonLooksAlive, readDaemonState, type DaemonState } from './state.js'

export interface ClientOptions {
  storageRoot?: string
  configPath?: string
  /** Token : admin (depuis daemon.json) ou token d'instance (agents). */
  token?: string
}

export class DaemonClient {
  readonly baseUrl: string
  private readonly token: string | undefined

  constructor(state: Pick<DaemonState, 'port'>, token?: string) {
    this.baseUrl = `http://127.0.0.1:${state.port}`
    this.token = token
  }

  /** Client admin local : lit port + admin_token dans daemon.json. */
  static admin(opts: ClientOptions = {}): DaemonClient | null {
    const { storageRoot } = resolveStorageRoot(opts)
    const state = readDaemonState(storageRoot)
    if (!state) return null
    return new DaemonClient(state, opts.token ?? state.admin_token)
  }

  async health(): Promise<{ ok: boolean; version: string; daemon_id: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return null
      return (await res.json()) as { ok: boolean; version: string; daemon_id: string }
    } catch {
      return null
    }
  }

  async completePairing(code: string): Promise<{ assistant_instance_id: string; instance_token: string }> {
    return this.post('/v1/pairing/complete', { code })
  }

  // --- admin ---
  async pair(type: string, displayName?: string): Promise<{ assistant_instance_id: string; pairing_code: string; command: string }> {
    return this.post('/v1/admin/pair', { type, display_name: displayName })
  }
  async revoke(instanceId: string): Promise<void> {
    await this.post('/v1/admin/revoke', { assistant_instance_id: instanceId })
  }
  async agents(): Promise<unknown> {
    return this.get('/v1/admin/agents')
  }
  async stats(): Promise<unknown> {
    return this.get('/v1/admin/stats')
  }
  async doctor(): Promise<unknown> {
    return this.get('/v1/admin/doctor')
  }
  async audit(): Promise<unknown> {
    return this.get('/v1/admin/audit')
  }

  // --- mémoire (token d'instance) ---
  async storeFact(input: Record<string, unknown>): Promise<unknown> {
    return this.post('/v1/memory/store_fact', input)
  }
  async recall(input: Record<string, unknown>): Promise<RecallResult> {
    return this.post('/v1/memory/recall', input)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token) h['authorization'] = `Bearer ${this.token}`
    return h
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body ?? {}),
    })
    return handleResponse<T>(res, path)
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() })
    return handleResponse<T>(res, path)
  }
}

async function handleResponse<T>(res: Response, path: string): Promise<T> {
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(`daemon ${path} → ${res.status} : ${String(payload['error'] ?? 'erreur')}`)
  }
  return payload as T
}

/**
 * Garantit qu'un daemon tourne pour ce storage_root : réutilise le vivant,
 * sinon en démarre un détaché (`memoria-daemon`) et attend son health.
 */
export async function ensureDaemon(opts: ClientOptions = {}): Promise<DaemonState> {
  const { storageRoot } = resolveStorageRoot(opts)
  const alive = daemonLooksAlive(storageRoot)
  if (alive) {
    const client = new DaemonClient(alive)
    if (await client.health()) return alive
  }

  const binPath = fileURLToPath(new URL('./bin.js', import.meta.url))
  const args = [binPath]
  if (opts.storageRoot) args.push('--storage-root', opts.storageRoot)
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' })
  child.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150))
    const state = daemonLooksAlive(storageRoot)
    if (state) {
      const client = new DaemonClient(state)
      if (await client.health()) return state
    }
  }
  throw new Error('le daemon n’a pas démarré dans les 15 s (voir memoria doctor)')
}
