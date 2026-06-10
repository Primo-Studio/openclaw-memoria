/**
 * RegistryStore — `registry.sqlite`, gouvernance uniquement (spec §3.1).
 * Identités, instances, scopes, policies, pairing, audit neutre, secret_refs,
 * annuaire des DB. AUCUN fait ici.
 */
import type { Database } from 'better-sqlite3';
import type { Assistant, AssistantInstance, AssistantType, AuditEntry, DbRegistryEntry, HumanUser, MemoryScope, Organization, Pairing, ScopeKind, ScopePolicy } from '../types.js';
export declare class RegistryStore {
    readonly db: Database;
    readonly path: string;
    constructor(path: string);
    /**
     * Garantit l'état P1 : 1 human_user actif + 1 organisation own_company +
     * les scopes de base (`user`, `legacy_to_review`). Idempotent.
     */
    bootstrap(displayName?: string): {
        user: HumanUser;
        ownCompany: Organization;
    };
    ensureScope(type: ScopeKind, name: string, refs: Partial<Pick<MemoryScope, 'owner_user_id' | 'org_id' | 'client_org_id' | 'project_id'>>): MemoryScope;
    createOrganization(name: string, orgType: Organization['org_type'], parentOrgId?: string | null): Organization;
    getScope(id: string): MemoryScope | null;
    getScopeByName(name: string): MemoryScope | null;
    listScopes(): MemoryScope[];
    ensureAssistant(type: AssistantType, displayName: string, ownerUserId: string): Assistant;
    getAssistant(id: string): Assistant | null;
    listAssistants(): Assistant[];
    createInstance(assistantId: string, machineId: string, profileId?: string | null): AssistantInstance;
    getInstance(id: string): AssistantInstance | null;
    listInstances(): AssistantInstance[];
    touchInstance(id: string): void;
    revokeInstance(id: string): void;
    /** Authentifie un token d'instance → instance non révoquée, ou null. */
    verifyInstanceToken(token: string): AssistantInstance | null;
    /** Crée un pairing : code court TTL 10 min à coller dans le chat de l'agent. */
    createPairing(instanceId: string): {
        pairing: Pairing;
        code: string;
    };
    /** Échange code → token d'instance (one-shot, expire après TTL). */
    completePairing(code: string): {
        instance: AssistantInstance;
        token: string;
    } | null;
    setPolicy(policy: ScopePolicy): void;
    getPolicy(assistantId: string, scopeId: string): ScopePolicy | null;
    /** Scopes lisibles par un assistant (policy can_read). */
    readableScopes(assistantId: string): MemoryScope[];
    registerDb(entry: Omit<DbRegistryEntry, 'id'>): DbRegistryEntry;
    listDbs(): DbRegistryEntry[];
    dbForScope(scopeId: string): DbRegistryEntry | null;
    dbForInstance(instanceId: string): DbRegistryEntry | null;
    /** Audit NEUTRE : action + hash — jamais de contenu (spec §11). */
    audit(entry: Omit<AuditEntry, 'id' | 'ts'>): void;
    auditTail(limit?: number): AuditEntry[];
    close(): void;
}
//# sourceMappingURL=registry.d.ts.map