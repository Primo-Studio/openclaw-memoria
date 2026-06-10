/**
 * ContentStore — accès à UNE DB de contenu (privée d'instance ou partagée de scope).
 * Le pool (engine) décide quelles DB ouvrir ; ce module ne connaît qu'un fichier.
 */
import type { Database } from 'better-sqlite3';
import type { Fact, LifecycleState, Sensitivity, Visibility, WalEntry } from '../types.js';
export interface FactRow {
    id: string;
    fact: string;
    category: string;
    fact_type: string;
    confidence: number;
    source: string;
    assistant_instance_id: string | null;
    user_id: string | null;
    org_id: string | null;
    client_org_id: string | null;
    project_id: string | null;
    topic_id: string | null;
    scope_id: string;
    sensitivity: Sensitivity;
    visibility: Visibility;
    tags: string;
    entity_ids: string;
    lifecycle_state: LifecycleState;
    superseded: number;
    superseded_by: string | null;
    usefulness: number;
    recall_count: number;
    used_count: number;
    relevance_weight: number;
    created_at: string;
    updated_at: string;
    last_accessed_at: string | null;
}
export interface InsertFactInput {
    id?: string;
    fact: string;
    category?: string;
    fact_type?: string;
    confidence?: number;
    source?: string;
    assistant_instance_id?: string | null;
    user_id?: string | null;
    org_id?: string | null;
    client_org_id?: string | null;
    project_id?: string | null;
    topic_id?: string | null;
    scope_id: string;
    sensitivity?: Sensitivity;
    visibility?: Visibility;
    tags?: string[];
    entity_ids?: string[];
}
export interface FtsSearchOptions {
    limit?: number;
    includeDormant?: boolean;
    /** Sensibilité maximale autorisée pour le lecteur. */
    maxSensitivity?: Sensitivity;
    scopeIds?: string[];
}
export interface FtsHit {
    row: FactRow;
    /** Pertinence FTS positive (plus haut = meilleur). */
    relevance: number;
}
/** Échappe une requête utilisateur en expression FTS5 sûre (tokens cités, OR). */
export declare function toFtsQuery(query: string): string | null;
export declare class ContentStore {
    readonly db: Database;
    readonly path: string;
    readonly journalMode: string;
    readonly onNetworkVolume: boolean;
    constructor(path: string);
    insertFact(input: InsertFactInput): Fact;
    getFact(id: string): Fact | null;
    countFacts(): number;
    /**
     * Recherche FTS avec PRÉ-FILTRE permissions dans le SQL (filtre DUR, spec §6.1) :
     * lifecycle / superseded / sensibilité / scopes autorisés.
     */
    searchFacts(query: string, opts?: FtsSearchOptions): FtsHit[];
    /** Marque l'usage en recall (compteurs + dernier accès). */
    touchFacts(ids: string[]): void;
    /**
     * HARD-DELETE (spec §11) : efface le fait ET toutes ses traces locales —
     * FTS (par trigger), embeddings, fact_topics, projection, WAL non traité.
     * Retourne le nombre de faits effacés.
     */
    hardDeleteFacts(ids: string[]): number;
    walAppend(instanceId: string, role: WalEntry['role'], content: string): number;
    walPending(limit?: number): WalEntry[];
    walMarkProcessed(ids: number[]): void;
    walRecordAttempt(id: number): void;
    /** Cleanup BORNÉ (anti table illimitée du legacy) : purge le traité au-delà de maxRows/maxAgeDays. */
    walCleanup(maxRows?: number, maxAgeDays?: number): number;
    walPendingCount(): number;
    close(): void;
}
export declare function rowToFact(row: FactRow): Fact;
//# sourceMappingURL=content.d.ts.map