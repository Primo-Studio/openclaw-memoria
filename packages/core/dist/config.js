/**
 * Configuration & résolution du stockage (spec §8, décision D1).
 *
 * - Fichier de découverte FIXE : `~/.memoria/config.toml` (pointe vers le storage_root).
 * - `resolveStorageRoot()` UNIQUE : param explicite > config.toml > $MEMORIA_HOME > ~/.memoria/data.
 *   (Corrige le legacy : 8 chemins divergents, `cfg.workspacePath` ignoré par la DB.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
export const DEFAULT_CONFIG_PATH = join(homedir(), '.memoria', 'config.toml');
export function defaultStorageRoot() {
    return join(homedir(), '.memoria', 'data');
}
export function loadConfigFile(configPath = DEFAULT_CONFIG_PATH) {
    if (!existsSync(configPath))
        return {};
    const raw = readFileSync(configPath, 'utf8');
    try {
        return parseToml(raw);
    }
    catch (err) {
        throw new Error(`config.toml illisible (${configPath}) : ${err.message}`);
    }
}
export function saveConfigFile(config, configPath = DEFAULT_CONFIG_PATH) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, stringifyToml(config), 'utf8');
}
/** LE résolveur unique d'emplacement. Toute ouverture de DB passe par ici. */
export function resolveStorageRoot(opts = {}) {
    const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
    const env = opts.env ?? process.env;
    const config = loadConfigFile(configPath);
    const root = opts.storageRoot ?? config.storage_path ?? env['MEMORIA_HOME'] ?? defaultStorageRoot();
    const storageRoot = resolve(root);
    return { configPath, storageRoot, config };
}
/** Arborescence canonique sous storage_root (spec §8). */
export function storagePaths(storageRoot) {
    return {
        root: storageRoot,
        registry: join(storageRoot, 'registry.sqlite'),
        assistantsDir: join(storageRoot, 'assistants'),
        assistantDb: (instanceId) => join(storageRoot, 'assistants', instanceId, 'memory.sqlite'),
        sharedDir: join(storageRoot, 'shared'),
        sharedDb: (scopeFile) => join(storageRoot, 'shared', `${scopeFile}.sqlite`),
        secretsDir: join(storageRoot, 'secrets'),
        backupsDir: join(storageRoot, 'backups'),
        cacheDir: join(storageRoot, 'cache'),
        daemonState: join(storageRoot, 'daemon.json'),
        daemonLock: join(storageRoot, 'daemon.lock'),
    };
}
export function ensureStorageTree(storageRoot) {
    const p = storagePaths(storageRoot);
    for (const dir of [p.root, p.assistantsDir, p.sharedDir, p.secretsDir, p.backupsDir, p.cacheDir]) {
        mkdirSync(dir, { recursive: true });
    }
}
//# sourceMappingURL=config.js.map