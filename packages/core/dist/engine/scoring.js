const RECENCY_HALF_LIFE_DAYS = 90;
const RECENCY_FLOOR = 0.15;
export function scoreFact(row, relevance, context, now) {
    const ageDays = Math.max(0, (now - Date.parse(row.created_at)) / 86_400_000);
    const recency = Math.max(RECENCY_FLOOR, Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS));
    const confidence = clamp(row.confidence, 0.05, 1);
    const usage = 1 + Math.log1p(row.used_count + 0.5 * row.recall_count) * 0.15;
    const lifecycle = row.lifecycle_state === 'active' ? 1 : row.lifecycle_state === 'dormant' ? 0.3 : 0;
    let boost = 1;
    if (context) {
        if (context.project_id && row.project_id === context.project_id)
            boost *= 1.6;
        if (context.client_org_id && row.client_org_id === context.client_org_id)
            boost *= 1.4;
        if (context.org_id && row.org_id === context.org_id)
            boost *= 1.2;
    }
    boost *= row.relevance_weight;
    const total = relevance * recency * confidence * usage * lifecycle * boost;
    return { relevance, recency, confidence, usage, lifecycle, boost, total };
}
/**
 * FILTRE DUR anti-fuite inter-clients (décision v2.1 #3) :
 * un fait rattaché à un client n'est visible QUE si l'active_context déclare
 * CE client. Pas de contexte client déclaré → données client masquées.
 * (Les scopes globaux user/org/privé restent accessibles si policy OK.)
 */
export function passesClientIsolation(row, context) {
    if (!row.client_org_id)
        return true;
    return context?.client_org_id === row.client_org_id;
}
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
//# sourceMappingURL=scoring.js.map