export interface DaemonState {
    daemon_id: string;
    port: number;
    admin_token: string;
    pid: number;
    started_at: string;
}
export declare function readDaemonState(storageRoot: string): DaemonState | null;
export declare function writeDaemonState(storageRoot: string, state: DaemonState): void;
export declare function clearDaemonState(storageRoot: string): void;
/**
 * Prend le lock singleton. Retourne `null` si un autre daemon VIVANT le tient,
 * sinon une fonction de libération.
 */
export declare function acquireLock(storageRoot: string): (() => void) | null;
/** Le daemon décrit par daemon.json est-il vivant (PID) ? */
export declare function daemonLooksAlive(storageRoot: string): DaemonState | null;
//# sourceMappingURL=state.d.ts.map