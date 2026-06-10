import { type RecallResult } from '@memoria/core';
import { type DaemonState } from './state.js';
export interface ClientOptions {
    storageRoot?: string;
    configPath?: string;
    /** Token : admin (depuis daemon.json) ou token d'instance (agents). */
    token?: string;
}
export declare class DaemonClient {
    readonly baseUrl: string;
    private readonly token;
    constructor(state: Pick<DaemonState, 'port'>, token?: string);
    /** Client admin local : lit port + admin_token dans daemon.json. */
    static admin(opts?: ClientOptions): DaemonClient | null;
    health(): Promise<{
        ok: boolean;
        version: string;
        daemon_id: string;
    } | null>;
    completePairing(code: string): Promise<{
        assistant_instance_id: string;
        instance_token: string;
    }>;
    pair(type: string, displayName?: string): Promise<{
        assistant_instance_id: string;
        pairing_code: string;
        command: string;
    }>;
    revoke(instanceId: string): Promise<void>;
    agents(): Promise<unknown>;
    stats(): Promise<unknown>;
    doctor(): Promise<unknown>;
    audit(): Promise<unknown>;
    storeFact(input: Record<string, unknown>): Promise<unknown>;
    recall(input: Record<string, unknown>): Promise<RecallResult>;
    private headers;
    private post;
    private get;
}
/**
 * Garantit qu'un daemon tourne pour ce storage_root : réutilise le vivant,
 * sinon en démarre un détaché (`memoria-daemon`) et attend son health.
 */
export declare function ensureDaemon(opts?: ClientOptions): Promise<DaemonState>;
//# sourceMappingURL=client.d.ts.map