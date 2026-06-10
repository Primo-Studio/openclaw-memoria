export interface MemoriaConfig {
    /** Racine du stockage (registry + DB + secrets + backups). */
    storage_path?: string;
    daemon?: {
        /** 0 = port auto (choisi au premier démarrage puis persisté). */
        port?: number;
    };
    llm?: {
        /** Profil : '100-local' | 'local-plus-cloud' | 'cloud'. */
        profile?: string;
    };
}
export interface ResolvedConfig {
    configPath: string;
    storageRoot: string;
    config: MemoriaConfig;
}
export declare const DEFAULT_CONFIG_PATH: string;
export declare function defaultStorageRoot(): string;
export declare function loadConfigFile(configPath?: string): MemoriaConfig;
export declare function saveConfigFile(config: MemoriaConfig, configPath?: string): void;
export interface ResolveOptions {
    /** Priorité 1 : chemin explicite (tests, daemon piloté). */
    storageRoot?: string;
    /** Chemin du fichier de découverte (défaut ~/.memoria/config.toml). */
    configPath?: string;
    /** Environnement injectable pour les tests. */
    env?: NodeJS.ProcessEnv;
}
/** LE résolveur unique d'emplacement. Toute ouverture de DB passe par ici. */
export declare function resolveStorageRoot(opts?: ResolveOptions): ResolvedConfig;
/** Arborescence canonique sous storage_root (spec §8). */
export declare function storagePaths(storageRoot: string): {
    readonly root: string;
    readonly registry: string;
    readonly assistantsDir: string;
    readonly assistantDb: (instanceId: string) => string;
    readonly sharedDir: string;
    readonly sharedDb: (scopeFile: string) => string;
    readonly secretsDir: string;
    readonly backupsDir: string;
    readonly cacheDir: string;
    readonly daemonState: string;
    readonly daemonLock: string;
};
export declare function ensureStorageTree(storageRoot: string): void;
//# sourceMappingURL=config.d.ts.map