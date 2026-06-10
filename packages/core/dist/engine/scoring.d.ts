/**
 * Scoring GLOBAL du recall (spec §6.1, étape 3) :
 *   score = pertinence(FTS/cosine) × récence × confiance × usage × lifecycle
 *           × BOOST(active_context)
 * Le boost de contexte est une PERTINENCE, jamais une permission — le filtre
 * dur d'exclusion s'applique AVANT (pré-filtre SQL + filtre client).
 */
import type { ActiveContext } from '../types.js';
import type { FactRow } from '../storage/content.js';
export interface ScoreParts {
    relevance: number;
    recency: number;
    confidence: number;
    usage: number;
    lifecycle: number;
    boost: number;
    total: number;
}
export declare function scoreFact(row: FactRow, relevance: number, context: ActiveContext | undefined, now: number): ScoreParts;
/**
 * FILTRE DUR anti-fuite inter-clients (décision v2.1 #3) :
 * un fait rattaché à un client n'est visible QUE si l'active_context déclare
 * CE client. Pas de contexte client déclaré → données client masquées.
 * (Les scopes globaux user/org/privé restent accessibles si policy OK.)
 */
export declare function passesClientIsolation(row: Pick<FactRow, 'client_org_id'>, context: ActiveContext | undefined): boolean;
//# sourceMappingURL=scoring.d.ts.map