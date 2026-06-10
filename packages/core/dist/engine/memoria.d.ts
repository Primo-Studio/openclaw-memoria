import { storagePaths, type ResolveOptions, type ResolvedConfig } from '../config.js';
import { RegistryStore } from '../storage/registry.js';
import type { AssistantInstance, AssistantType, CaptureMode, DoctorReport, Fact, ForgetFilter, RecallInput, RecallResult, StoreFactInput } from '../types.js';
export interface PairAssistantInput {
    type: AssistantType;
    display_name?: string;
    machine?: string;
    profile?: string | null;
}
export interface PairAssistantResult {
    assistant_id: string;
    assistant_instance_id: string;
    pairing_code: string;
    /** Commande à copier-coller dans le chat de l'agent (D4). */
    command: string;
}
export interface MemoriaInitOptions extends ResolveOptions {
    userDisplayName?: string;
}
export declare class Memoria {
    readonly resolved: ResolvedConfig;
    readonly paths: ReturnType<typeof storagePaths>;
    readonly registry: RegistryStore;
    private readonly pool;
    private closed;
    private constructor();
    /** Point d'entrée unique. `Memoria.init({ storageRoot })` pour les tests/daemon. */
    static init(opts?: MemoriaInitOptions): Memoria;
    pairAssistant(input: PairAssistantInput): PairAssistantResult;
    completePairing(code: string): {
        assistant_instance_id: string;
        instance_token: string;
    } | null;
    revokeInstance(instanceId: string): void;
    /** Authentifie un token d'instance (utilisé par le daemon). */
    authenticate(token: string): AssistantInstance | null;
    storeFact(input: StoreFactInput): Fact;
    /**
     * Recall fan-out gouverné (spec §6.1) :
     * scopes autorisés → pré-filtre SQL par DB → fusion → scoring global →
     * filtre dur client → budget tokens GLOBAL → compteurs d'usage.
     */
    recall(input: RecallInput): RecallResult;
    /** Hard-delete gouverné (spec §11). */
    forget(filter: ForgetFilter): {
        deleted: number;
    };
    /**
     * Navigation admin dans la mémoire (UI web) : faits d'une instance (sa DB
     * privée) ou de toutes les DB, récents d'abord ou filtrés FTS.
     */
    browseFacts(opts?: {
        instance?: string;
        q?: string;
        limit?: number;
    }): Array<Fact & {
        source_db: string;
    }>;
    /** Mode de capture global : auto-private (défaut) | review-first | incognito (pause). */
    getCaptureMode(): CaptureMode;
    setCaptureMode(mode: CaptureMode): void;
    listAgents(): Array<{
        instance: AssistantInstance;
        assistant_type: string;
        db_path: string | null;
    }>;
    stats(): {
        facts: number;
        databases: number;
        instances: number;
    };
    doctor(): DoctorReport;
    close(): void;
    private assertOpen;
    private mustInstance;
    private openContent;
    /** Scope cible d'une écriture : id, nom, ou défaut = privé de l'instance. */
    private resolveTargetScope;
    /** DB qui héberge un scope (privé → DB d'instance ; partagé → shared/…). */
    private storeForScope;
    private sharedDbPath;
    /**
     * Cibles de lecture du fan-out : la DB privée de CETTE instance + chaque DB
     * partagée dont le scope est lisible (policy can_read). Les scopes privés
     * des AUTRES instances sont exclus structurellement.
     */
    private resolveReadTargets;
}
//# sourceMappingURL=memoria.d.ts.map