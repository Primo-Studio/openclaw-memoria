/**
 * DaemonClient — utilisé par CLI / UI / MCP. Découvre le daemon via
 * `daemon.json`, peut le démarrer s'il n'existe pas (singleton).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { DEFAULT_CONFIG_PATH, autostartStorageRoot, kickstartService, resolveStorageRoot, type RecallResult } from '@memoria/core'
import type { ImportJobStatus } from './import-job.js'
import { daemonLooksAlive, readDaemonState, type DaemonState } from './state.js'

export interface ClientOptions {
  storageRoot?: string
  configPath?: string
  /** Token : admin (depuis daemon.json) ou token d'instance (agents). */
  token?: string
}

/** Réponse de GET /v1/health. Les champs pid/supervisor/built_sha sont absents d'un daemon antérieur. */
export interface DaemonHealth {
  ok: boolean
  version: string
  daemon_id: string
  ui?: boolean
  pid?: number
  started_at?: string
  /** 'launchd' quand le process EST celui du service `memoria autostart on`. */
  supervisor?: 'launchd' | null
  built_sha?: string | null
  storage_root?: string
  config_path?: string
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

  async health(): Promise<DaemonHealth | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return null
      return (await res.json()) as DaemonHealth
    } catch {
      return null
    }
  }

  async completePairing(code: string): Promise<{ assistant_instance_id: string; instance_token: string; assistant_type?: string }> {
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

  // --- contrôle (kill-switch, lancement auto, suppression d'agent) ---
  async control(): Promise<unknown> {
    return this.get('/v1/admin/control')
  }
  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.post('/v1/admin/enabled', { enabled })
  }
  async setAutostart(enabled: boolean): Promise<unknown> {
    return this.post('/v1/admin/autostart', { enabled })
  }
  async deleteAgent(instanceId: string): Promise<{ deleted: boolean }> {
    return this.post('/v1/admin/delete_agent', { assistant_instance_id: instanceId })
  }

  // --- agents sur cette machine : détection, connexion 1 clic, import (B1/B2/B3) ---
  async detectAgents(): Promise<{ agents: unknown[] }> {
    return this.get('/v1/admin/agents_detect')
  }
  async connectAgent(kind: string, name?: string): Promise<unknown> {
    return this.post('/v1/admin/agents_connect', { kind, ...(name ? { name } : {}) })
  }
  async importStart(input: {
    instance_id: string
    kind: 'transcripts' | 'legacy'
    legacy_path?: string
    max_windows_per_file?: number
  }): Promise<ImportJobStatus> {
    return this.post('/v1/admin/import_start', input)
  }
  async importStatus(): Promise<ImportJobStatus> {
    return this.get('/v1/admin/import_status')
  }

  // --- synchro inter-machines ---
  async syncStatus(): Promise<unknown> {
    return this.get('/v1/admin/sync/status')
  }
  async syncInitHub(listenLan: string): Promise<unknown> {
    return this.post('/v1/admin/sync/init_hub', { listen_lan: listenLan })
  }
  async syncInvite(displayName?: string): Promise<{ code: string; expires_at: string; hub_lan: string | null }> {
    return this.post('/v1/admin/sync/invite', { display_name: displayName })
  }
  async syncJoin(hub: string, code: string): Promise<{ scopes: number; facts: number; secrets: number }> {
    return this.post('/v1/admin/sync/join', { hub, code })
  }
  async syncNow(): Promise<{ pulled: number; pushed: number }> {
    return this.post('/v1/admin/sync/now', {})
  }
  async syncRevoke(machineId: string): Promise<{ revoked: boolean }> {
    return this.post('/v1/admin/sync/revoke', { machine_id: machineId })
  }
  async syncLeave(): Promise<{ ok: boolean }> {
    return this.post('/v1/admin/sync/leave', {})
  }

  // --- mise à jour ---
  async version(): Promise<{ version: string; sha: string | null; is_git: boolean; daemon: string }> {
    return this.get('/v1/admin/version')
  }
  async update(): Promise<{ ok: boolean; changed: boolean; before: string | null; after: string | null; message: string; log: string }> {
    return this.post('/v1/admin/update', {})
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

/** Chemin absolu du bin daemon (`memoria-daemon`), pour le LaunchAgent. */
export function daemonBinPath(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url))
}

/**
 * Arguments du daemon pour le LaunchAgent : node + bin + stockage, et le
 * `--config` quand il n'est pas celui par défaut. Sans lui, un daemon lancé
 * pour `memoria … --config /autre.toml` retombait en silence sur
 * ~/.memoria/config.toml (kill-switch, LLM, synchro d'une AUTRE config).
 */
export function daemonProgramArguments(storageRoot: string, configPath?: string): string[] {
  const args = [process.execPath, daemonBinPath(), '--storage-root', storageRoot]
  if (configPath && resolve(configPath) !== resolve(DEFAULT_CONFIG_PATH)) args.push('--config', configPath)
  return args
}

/**
 * Garantit qu'un daemon tourne pour ce storage_root : réutilise le vivant,
 * sinon en démarre un détaché (`memoria-daemon`) et attend son health.
 */
export interface EnsureDaemonHooks {
  /** Injectable pour les tests : launchd simulé. */
  launchd?: {
    /** Le service installé vise-t-il CE storage_root ? (sinon on ne le touche pas) */
    targets(storageRoot: string): boolean
    /** Demande le lancement ; false = pas de service / refus. */
    kickstart(): boolean
    /** Délai d'attente du health après kickstart (défaut 15 s). */
    waitMs?: number
  }
  /** Lancement détaché du daemon (tests : capture des arguments, daemon en process). */
  spawnDaemon?: (args: string[], storageRoot: string) => void
}

/** launchd réel : le service `memoria autostart on` s'il cible ce storage_root. */
const REAL_LAUNCHD: NonNullable<EnsureDaemonHooks['launchd']> = {
  targets: root => {
    const target = autostartStorageRoot()
    return target !== null && resolve(target) === resolve(root)
  },
  kickstart: () => kickstartService(),
}

/** Attend qu'un daemon réponde au health pour ce storage_root (null = délai dépassé). */
export async function waitForDaemon(storageRoot: string, ms: number): Promise<DaemonState | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150))
    const state = daemonLooksAlive(storageRoot)
    if (state) {
      const client = new DaemonClient(state)
      if (await client.health()) return state
    }
  }
  return null
}

/** Attend la mort d'un process (kill 0) ; false si toujours vivant au bout de `ms`. */
export async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, 100))
  }
}

export async function ensureDaemon(opts: ClientOptions = {}, hooks: EnsureDaemonHooks = {}): Promise<DaemonState> {
  const { storageRoot } = resolveStorageRoot(opts)
  const alive = daemonLooksAlive(storageRoot)
  if (alive) {
    const client = new DaemonClient(alive)
    if (await client.health()) return alive
  }

  // Service launchd installé pour CE stockage : c'est LUI qui doit posséder le
  // daemon. Spawner ici prendrait le lock et ferait boucler launchd en échec ;
  // et après un `memoria stop` (sortie propre) launchd ne relance pas seul.
  const launchd = hooks.launchd ?? REAL_LAUNCHD
  if (launchd.targets(storageRoot) && launchd.kickstart()) {
    const viaLaunchd = await waitForDaemon(storageRoot, launchd.waitMs ?? 15_000)
    if (viaLaunchd) return viaLaunchd
    console.warn('[memoria] launchd n’a pas relancé le daemon à temps — démarrage direct en repli (voir ~/Library/Logs/memoria.err.log)')
  }

  const args = [daemonBinPathForSpawn()]
  if (opts.storageRoot) args.push('--storage-root', opts.storageRoot)
  // Le daemon détaché recevait le storage_root mais PAS la config : il
  // résolvait ~/.memoria/config.toml et tournait avec le mauvais kill-switch /
  // LLM / synchro quand `--config` était fourni — sans le dire.
  if (opts.configPath) args.push('--config', opts.configPath)
  ;(hooks.spawnDaemon ?? spawnDetachedDaemon)(args, storageRoot)

  const started = await waitForDaemon(storageRoot, 15_000)
  if (started) return started
  throw new Error('le daemon n’a pas démarré dans les 15 s (voir memoria doctor)')
}

/** Daemon détaché, journal en append dans le stockage. */
function spawnDetachedDaemon(args: string[], storageRoot: string): void {
  // `stdio: 'ignore'` jetait TOUT : warnings, échecs d'extraction, stacktraces.
  // Une panne du daemon lancé par `memoria start` était donc indiagnosticable —
  // c'est exactement ce qui a laissé une extraction morte pendant dix jours sans
  // que rien ne le signale. On journalise dans le stockage, en append.
  const logPath = join(storageRoot, 'daemon.log')
  let stdio: 'ignore' | ['ignore', number, number] = 'ignore'
  try {
    mkdirSync(storageRoot, { recursive: true })
    const fd = openSync(logPath, 'a')
    stdio = ['ignore', fd, fd]
  } catch {
    /* stockage non inscriptible : on démarre quand même, sans journal */
  }
  const child = spawn(process.execPath, args, { detached: true, stdio })
  child.unref()
}

/**
 * `bin.js` du daemon à spawner. Depuis `dist/` c'est le voisin ; exécuté depuis
 * les SOURCES (vitest, tsx), `./bin.js` n'existe pas → on vise `../dist/bin.js`.
 * Sans ce repli, le spawn lançait node sur un fichier absent et « le daemon n'a
 * pas démarré dans les 15 s » — sans dire pourquoi.
 */
function daemonBinPathForSpawn(): string {
  const beside = fileURLToPath(new URL('./bin.js', import.meta.url))
  if (existsSync(beside)) return beside
  const dist = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
  return existsSync(dist) ? dist : beside
}
