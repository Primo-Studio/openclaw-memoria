import { openDatabase } from './sqlite.js';
import { runMigrations } from './migrations.js';
import { contentMigrations } from './content-schema.js';
import { fromJsonArray, newId, nowISO, toJson } from '../util.js';
const SENSITIVITY_ORDER = { normal: 0, sensitive: 1, critical: 2 };
/** Échappe une requête utilisateur en expression FTS5 sûre (tokens cités, OR). */
export function toFtsQuery(query) {
    const tokens = query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map(t => t.trim())
        .filter(t => t.length > 1);
    if (tokens.length === 0)
        return null;
    return tokens.map(t => `"${t.replaceAll('"', '')}"`).join(' OR ');
}
export class ContentStore {
    db;
    path;
    journalMode;
    onNetworkVolume;
    constructor(path) {
        const opened = openDatabase(path);
        this.db = opened.db;
        this.path = path;
        this.journalMode = opened.journalMode;
        this.onNetworkVolume = opened.onNetworkVolume;
        runMigrations(this.db, contentMigrations);
    }
    insertFact(input) {
        const ts = nowISO();
        const row = {
            id: input.id ?? newId(),
            fact: input.fact,
            category: input.category ?? 'general',
            fact_type: input.fact_type ?? 'statement',
            confidence: input.confidence ?? 0.8,
            source: input.source ?? 'manual',
            assistant_instance_id: input.assistant_instance_id ?? null,
            user_id: input.user_id ?? null,
            org_id: input.org_id ?? null,
            client_org_id: input.client_org_id ?? null,
            project_id: input.project_id ?? null,
            topic_id: input.topic_id ?? null,
            scope_id: input.scope_id,
            sensitivity: input.sensitivity ?? 'normal',
            visibility: input.visibility ?? 'private',
            tags: toJson(input.tags ?? []),
            entity_ids: toJson(input.entity_ids ?? []),
            lifecycle_state: 'active',
            superseded: 0,
            superseded_by: null,
            usefulness: 0,
            recall_count: 0,
            used_count: 0,
            relevance_weight: 1.0,
            created_at: ts,
            updated_at: ts,
            last_accessed_at: null,
        };
        this.db
            .prepare(`INSERT INTO facts (
          id, fact, category, fact_type, confidence, source,
          assistant_instance_id, user_id, org_id, client_org_id, project_id, topic_id, scope_id,
          sensitivity, visibility, tags, entity_ids,
          lifecycle_state, superseded, superseded_by,
          usefulness, recall_count, used_count, relevance_weight,
          created_at, updated_at, last_accessed_at
        ) VALUES (
          @id, @fact, @category, @fact_type, @confidence, @source,
          @assistant_instance_id, @user_id, @org_id, @client_org_id, @project_id, @topic_id, @scope_id,
          @sensitivity, @visibility, @tags, @entity_ids,
          @lifecycle_state, @superseded, @superseded_by,
          @usefulness, @recall_count, @used_count, @relevance_weight,
          @created_at, @updated_at, @last_accessed_at
        )`)
            .run(row);
        return rowToFact(row);
    }
    getFact(id) {
        const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
        return row ? rowToFact(row) : null;
    }
    countFacts() {
        const r = this.db.prepare('SELECT COUNT(*) AS c FROM facts').get();
        return r.c;
    }
    /**
     * Recherche FTS avec PRÉ-FILTRE permissions dans le SQL (filtre DUR, spec §6.1) :
     * lifecycle / superseded / sensibilité / scopes autorisés.
     */
    searchFacts(query, opts = {}) {
        const match = toFtsQuery(query);
        if (!match)
            return [];
        const limit = opts.limit ?? 50;
        const maxSens = SENSITIVITY_ORDER[opts.maxSensitivity ?? 'normal'];
        const lifecycleStates = opts.includeDormant ? ['active', 'dormant'] : ['active'];
        const conditions = [
            `f.superseded = 0`,
            `f.lifecycle_state IN (${lifecycleStates.map(() => '?').join(',')})`,
            `(CASE f.sensitivity WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 ELSE 2 END) <= ?`,
        ];
        const params = [...lifecycleStates, maxSens];
        if (opts.scopeIds && opts.scopeIds.length > 0) {
            conditions.push(`f.scope_id IN (${opts.scopeIds.map(() => '?').join(',')})`);
            params.push(...opts.scopeIds);
        }
        const sql = `
      SELECT f.*, -bm25(facts_fts) AS fts_relevance
      FROM facts_fts
      JOIN facts f ON f.rowid = facts_fts.rowid
      WHERE facts_fts MATCH ?
        AND ${conditions.join(' AND ')}
      ORDER BY fts_relevance DESC
      LIMIT ?
    `;
        const rows = this.db.prepare(sql).all(match, ...params, limit);
        return rows.map(r => ({ row: r, relevance: Math.max(0, r.fts_relevance) }));
    }
    /** Marque l'usage en recall (compteurs + dernier accès). */
    touchFacts(ids) {
        if (ids.length === 0)
            return;
        const ts = nowISO();
        const stmt = this.db.prepare('UPDATE facts SET recall_count = recall_count + 1, last_accessed_at = ? WHERE id = ?');
        const tx = this.db.transaction((all) => {
            for (const id of all)
                stmt.run(ts, id);
        });
        tx(ids);
    }
    /**
     * HARD-DELETE (spec §11) : efface le fait ET toutes ses traces locales —
     * FTS (par trigger), embeddings, fact_topics, projection, WAL non traité.
     * Retourne le nombre de faits effacés.
     */
    hardDeleteFacts(ids) {
        if (ids.length === 0)
            return 0;
        const del = this.db.transaction((all) => {
            let n = 0;
            const placeholders = all.map(() => '?').join(',');
            this.db.prepare(`DELETE FROM embeddings WHERE owner_type = 'fact' AND owner_id IN (${placeholders})`).run(...all);
            this.db.prepare(`DELETE FROM fact_topics WHERE fact_id IN (${placeholders})`).run(...all);
            this.db.prepare(`DELETE FROM memory_projection WHERE fact_id IN (${placeholders})`).run(...all);
            const r = this.db.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...all);
            n = r.changes;
            return n;
        });
        return del(ids);
    }
    // --- WAL (spec §6.2) — la logique replay/retry vit dans engine/wal.ts ---
    walAppend(instanceId, role, content) {
        const r = this.db
            .prepare('INSERT INTO wal_buffer (ts, assistant_instance_id, role, content) VALUES (?, ?, ?, ?)')
            .run(nowISO(), instanceId, role, content);
        return Number(r.lastInsertRowid);
    }
    walPending(limit = 100) {
        const rows = this.db
            .prepare('SELECT * FROM wal_buffer WHERE processed = 0 ORDER BY id LIMIT ?')
            .all(limit);
        return rows.map(r => ({ ...r, processed: r.processed === 1 }));
    }
    walMarkProcessed(ids) {
        if (ids.length === 0)
            return;
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`UPDATE wal_buffer SET processed = 1 WHERE id IN (${placeholders})`).run(...ids);
    }
    walRecordAttempt(id) {
        this.db.prepare('UPDATE wal_buffer SET attempts = attempts + 1 WHERE id = ?').run(id);
    }
    /** Cleanup BORNÉ (anti table illimitée du legacy) : purge le traité au-delà de maxRows/maxAgeDays. */
    walCleanup(maxRows = 5000, maxAgeDays = 14) {
        const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
        const r1 = this.db.prepare('DELETE FROM wal_buffer WHERE processed = 1 AND ts < ?').run(cutoff);
        const r2 = this.db
            .prepare(`DELETE FROM wal_buffer WHERE processed = 1 AND id NOT IN (
           SELECT id FROM wal_buffer WHERE processed = 1 ORDER BY id DESC LIMIT ?
         )`)
            .run(maxRows);
        return r1.changes + r2.changes;
    }
    walPendingCount() {
        const r = this.db.prepare('SELECT COUNT(*) AS c FROM wal_buffer WHERE processed = 0').get();
        return r.c;
    }
    close() {
        this.db.close();
    }
}
export function rowToFact(row) {
    return {
        ...row,
        tags: fromJsonArray(row.tags),
        entity_ids: fromJsonArray(row.entity_ids),
        superseded: row.superseded === 1,
    };
}
//# sourceMappingURL=content.js.map