/**
 * Configuration & résolution du stockage (spec §8, décision D1).
 *
 * - Fichier de découverte FIXE : `~/.memoria/config.toml` (pointe vers le storage_root).
 * - `resolveStorageRoot()` UNIQUE : param explicite > config.toml > $MEMORIA_HOME > ~/.memoria/data.
 *   (Corrige le legacy : 8 chemins divergents, `cfg.workspacePath` ignoré par la DB.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

export interface MemoriaConfig {
  /** Racine du stockage (registry + DB + secrets + backups). */
  storage_path?: string
  daemon?: {
    /** 0 = port auto (choisi au premier démarrage puis persisté). */
    port?: number
  }
  llm?: {
    /** Profil raccourci : '100-local' | 'local-plus-cloud' | 'cloud' | 'custom'. */
    profile?: string
    /**
     * Choix EXPLICITE du provider/modèle d'extraction (prioritaire sur le
     * profil si présent). provider ∈ ollama|anthropic|openai|openrouter.
     */
    extraction?: { provider?: string; model?: string }
    /** Choix explicite des embeddings (provider ollama uniquement en V1). */
    embeddings?: { provider?: string; model?: string }
  }
}

export interface ResolvedConfig {
  configPath: string
  storageRoot: string
  config: MemoriaConfig
}

export const DEFAULT_CONFIG_PATH: string = join(homedir(), '.memoria', 'config.toml')

export function defaultStorageRoot(): string {
  return join(homedir(), '.memoria', 'data')
}

export function loadConfigFile(configPath: string = DEFAULT_CONFIG_PATH): MemoriaConfig {
  if (!existsSync(configPath)) return {}
  const raw = readFileSync(configPath, 'utf8')
  try {
    return parseToml(raw) as MemoriaConfig
  } catch (err) {
    throw new Error(`config.toml illisible (${configPath}) : ${(err as Error).message}`)
  }
}

export function saveConfigFile(config: MemoriaConfig, configPath: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, stringifyToml(config as Record<string, unknown>), 'utf8')
}

export interface ResolveOptions {
  /** Priorité 1 : chemin explicite (tests, daemon piloté). */
  storageRoot?: string
  /** Chemin du fichier de découverte (défaut ~/.memoria/config.toml). */
  configPath?: string
  /** Environnement injectable pour les tests. */
  env?: NodeJS.ProcessEnv
}

/** LE résolveur unique d'emplacement. Toute ouverture de DB passe par ici. */
export function resolveStorageRoot(opts: ResolveOptions = {}): ResolvedConfig {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH
  const env = opts.env ?? process.env
  const config = loadConfigFile(configPath)

  const root = opts.storageRoot ?? config.storage_path ?? env['MEMORIA_HOME'] ?? defaultStorageRoot()

  const storageRoot = resolve(root)
  return { configPath, storageRoot, config }
}

/** Arborescence canonique sous storage_root (spec §8). */
export function storagePaths(storageRoot: string) {
  return {
    root: storageRoot,
    registry: join(storageRoot, 'registry.sqlite'),
    assistantsDir: join(storageRoot, 'assistants'),
    assistantDb: (instanceId: string) => join(storageRoot, 'assistants', instanceId, 'memory.sqlite'),
    sharedDir: join(storageRoot, 'shared'),
    sharedDb: (scopeFile: string) => join(storageRoot, 'shared', `${scopeFile}.sqlite`),
    secretsDir: join(storageRoot, 'secrets'),
    backupsDir: join(storageRoot, 'backups'),
    cacheDir: join(storageRoot, 'cache'),
    daemonState: join(storageRoot, 'daemon.json'),
    daemonLock: join(storageRoot, 'daemon.lock'),
  } as const
}

export function ensureStorageTree(storageRoot: string): void {
  const p = storagePaths(storageRoot)
  for (const dir of [p.root, p.assistantsDir, p.sharedDir, p.secretsDir, p.backupsDir, p.cacheDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
