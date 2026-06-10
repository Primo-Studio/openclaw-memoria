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
import { type Server } from 'node:http';
import { Memoria } from '@memoria/core';
import { type DaemonState } from './state.js';
export declare const DAEMON_VERSION = "0.1.0";
export interface DaemonOptions {
    storageRoot?: string;
    configPath?: string;
    /** Port d'écoute ; 0 = éphémère (persisté dans daemon.json). */
    port?: number;
}
export interface RunningDaemon {
    state: DaemonState;
    memoria: Memoria;
    close: () => Promise<void>;
}
export declare function startDaemon(opts?: DaemonOptions): Promise<RunningDaemon>;
export type { Server };
//# sourceMappingURL=server.d.ts.map