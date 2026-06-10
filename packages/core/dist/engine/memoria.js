/**
 * Memoria — le moteur (spec §4). Aucune dépendance d'hôte.
 * P1 : identité/pairing, storeFact, recall fan-out gouverné, forget hard-delete,
 * doctor/stats. Capture pipeline (WAL→redaction→extraction) arrive en P2,
 * MCP/UI en P3 — voir docs/v3/STATUS.md.
 */
import { existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { relative } from 'node:path';
import { ensureStorageTree, resolveStorageRoot, storagePaths, } from '../config.js';
import { RegistryStore } from '../storage/registry.js';
import { ContentStore } from '../storage/content.js';
import { estimateTokens, sha256Hex } from '../util.js';
import { passesClientIsolation, scoreFact } from './scoring.js';
const DEFAULT_TOKEN_BUDGET = 1500;
const DEFAULT_RECALL_LIMIT = 12;
export class Memoria {
    resolved;
    paths;
    registry;
    pool = new Map();
    closed = false;
    constructor(resolved, userDisplayName) {
        this.resolved = resolved;
        this.paths = storagePaths(resolved.storageRoot);
        ensureStorageTree(resolved.storageRoot);
        this.registry = new RegistryStore(this.paths.registry);
        this.registry.bootstrap(userDisplayName);
        this.registry.registerDb({ kind: 'registry', path: this.paths.registry, assistant_instance_id: null, scope_id: null });
    }
    /** Point d'entrée unique. `Memoria.init({ storageRoot })` pour les tests/daemon. */
    static init(opts = {}) {
        const resolved = resolveStorageRoot(opts);
        return new Memoria(resolved, opts.userDisplayName);
    }
    // ------------------------------------------------------------ identité & connexion
    pairAssistant(input) {
        this.assertOpen();
        const { user } = this.registry.bootstrap();
        const assistant = this.registry.ensureAssistant(input.type, input.display_name ?? input.type, user.id);
        const instance = this.registry.createInstance(assistant.id, input.machine ?? hostname(), input.profile);
        // Scope privé de l'instance + provision de sa DB
        const privateScope = this.registry.ensureScope('private', `private:${instance.id}`, {});
        const dbPath = this.paths.assistantDb(instance.id);
        this.openContent(dbPath);
        this.registry.registerDb({ kind: 'assistant', path: dbPath, assistant_instance_id: instance.id, scope_id: privateScope.id });
        // Policies par défaut : privé = lecture/écriture ; `user` = lecture (partage volontaire en P5)
        this.registry.setPolicy({
            assistant_id: assistant.id,
            scope_id: privateScope.id,
            can_read: true,
            can_write: true,
            can_share: false,
            secret_access: 'none',
        });
        const userScope = this.registry.getScopeByName('user');
        if (userScope) {
            this.registry.setPolicy({
                assistant_id: assistant.id,
                scope_id: userScope.id,
                can_read: true,
                can_write: false,
                can_share: false,
                secret_access: 'none',
            });
        }
        const { code } = this.registry.createPairing(instance.id);
        this.registry.audit({
            actor_type: 'user',
            actor_id: 'local',
            action: 'pair_assistant',
            target_id_hash: sha256Hex(instance.id),
            scope_id: privateScope.id,
            reason: `type=${input.type}`,
        });
        return {
            assistant_id: assistant.id,
            assistant_instance_id: instance.id,
            pairing_code: code,
            command: `npx -y @memoria/mcp connect --code ${code}`,
        };
    }
    completePairing(code) {
        this.assertOpen();
        const result = this.registry.completePairing(code);
        if (!result)
            return null;
        this.registry.audit({
            actor_type: 'assistant',
            actor_id: result.instance.id,
            action: 'complete_pairing',
            target_id_hash: sha256Hex(result.instance.id),
            scope_id: null,
            reason: null,
        });
        return { assistant_instance_id: result.instance.id, instance_token: result.token };
    }
    revokeInstance(instanceId) {
        this.assertOpen();
        this.registry.revokeInstance(instanceId);
        this.registry.audit({
            actor_type: 'user',
            actor_id: 'local',
            action: 'revoke_instance',
            target_id_hash: sha256Hex(instanceId),
            scope_id: null,
            reason: null,
        });
    }
    /** Authentifie un token d'instance (utilisé par le daemon). */
    authenticate(token) {
        this.assertOpen();
        const inst = this.registry.verifyInstanceToken(token);
        if (inst)
            this.registry.touchInstance(inst.id);
        return inst;
    }
    // ------------------------------------------------------------------- mémoire
    storeFact(input) {
        this.assertOpen();
        const instance = this.mustInstance(input.instance);
        const scope = this.resolveTargetScope(instance, input.scope);
        if (scope.type !== 'private') {
            const policy = this.registry.getPolicy(instance.assistant_id, scope.id);
            if (!policy?.can_write) {
                throw new Error(`écriture refusée : l'assistant n'a pas can_write sur le scope « ${scope.name} »`);
            }
        }
        const store = this.storeForScope(scope, instance);
        const fact = store.insertFact({
            fact: input.content,
            category: input.category,
            fact_type: input.fact_type,
            confidence: input.confidence,
            source: input.source ?? 'manual',
            assistant_instance_id: instance.id,
            org_id: input.org_id ?? scope.org_id,
            client_org_id: input.client_org_id ?? scope.client_org_id,
            project_id: input.project_id ?? scope.project_id,
            scope_id: scope.id,
            sensitivity: input.sensitivity,
            tags: input.tags,
            visibility: scope.type === 'private' ? 'private' : 'shared',
        });
        this.registry.audit({
            actor_type: 'assistant',
            actor_id: instance.id,
            action: 'store_fact',
            target_id_hash: sha256Hex(fact.id),
            scope_id: scope.id,
            reason: null,
        });
        return fact;
    }
    /**
     * Recall fan-out gouverné (spec §6.1) :
     * scopes autorisés → pré-filtre SQL par DB → fusion → scoring global →
     * filtre dur client → budget tokens GLOBAL → compteurs d'usage.
     */
    recall(input) {
        this.assertOpen();
        const instance = this.mustInstance(input.instance);
        const budget = input.token_budget ?? DEFAULT_TOKEN_BUDGET;
        const limit = input.limit ?? DEFAULT_RECALL_LIMIT;
        const searchTargets = this.resolveReadTargets(instance);
        const now = Date.now();
        const candidates = [];
        let totalFound = 0;
        for (const target of searchTargets) {
            const store = this.openContent(target.dbPath);
            const hits = store.searchFacts(input.query, {
                limit: 50,
                includeDormant: input.include_dormant ?? false,
                maxSensitivity: 'sensitive',
                scopeIds: target.scopeIds,
            });
            totalFound += hits.length;
            for (const hit of hits) {
                // FILTRE DUR anti-fuite inter-clients — jamais un boost, une exclusion.
                if (!passesClientIsolation(hit.row, input.active_context))
                    continue;
                const parts = scoreFact(hit.row, hit.relevance, input.active_context, now);
                if (parts.total <= 0)
                    continue;
                candidates.push({
                    store,
                    item: {
                        kind: 'fact',
                        id: hit.row.id,
                        content: hit.row.fact,
                        category: hit.row.category,
                        scope_id: hit.row.scope_id,
                        source_db: relative(this.paths.root, target.dbPath),
                        score: parts.total,
                        created_at: hit.row.created_at,
                    },
                });
            }
        }
        candidates.sort((a, b) => b.item.score - a.item.score);
        // CAP DUR de tokens (corrige format.ts legacy : aucun cap global)
        const selected = [];
        let tokens = 0;
        for (const c of candidates) {
            if (selected.length >= limit)
                break;
            const cost = estimateTokens(c.item.content);
            if (tokens + cost > budget && selected.length > 0)
                continue;
            tokens += cost;
            selected.push(c);
        }
        // Compteurs d'usage par DB d'origine
        const byStore = new Map();
        for (const s of selected) {
            const arr = byStore.get(s.store) ?? [];
            arr.push(s.item.id);
            byStore.set(s.store, arr);
        }
        for (const [store, ids] of byStore)
            store.touchFacts(ids);
        this.registry.audit({
            actor_type: 'assistant',
            actor_id: instance.id,
            action: 'recall',
            target_id_hash: null,
            scope_id: null,
            reason: `returned=${selected.length}`,
        });
        return {
            items: selected.map(s => s.item),
            totalFound,
            tokens,
            scopes_searched: searchTargets.flatMap(t => t.scopeNames),
        };
    }
    /** Hard-delete gouverné (spec §11). */
    forget(filter) {
        this.assertOpen();
        const hasIds = (filter.ids?.length ?? 0) > 0;
        if (!hasIds && !filter.query && !filter.category && !filter.scope_id) {
            throw new Error('forget : filtre vide refusé');
        }
        if (!hasIds && !filter.query && filter.confirm_bulk !== true) {
            throw new Error('forget : suppression en masse — confirm_bulk requis');
        }
        let deleted = 0;
        for (const entry of this.registry.listDbs()) {
            if (entry.kind === 'registry')
                continue;
            const store = this.openContent(entry.path);
            let ids = filter.ids ?? [];
            if (!hasIds) {
                const conditions = [];
                const params = [];
                if (filter.scope_id) {
                    conditions.push('scope_id = ?');
                    params.push(filter.scope_id);
                }
                if (filter.category) {
                    conditions.push('category = ?');
                    params.push(filter.category);
                }
                let rows;
                if (filter.query) {
                    rows = store
                        .searchFacts(filter.query, { limit: 500, includeDormant: true, maxSensitivity: 'critical', scopeIds: filter.scope_id ? [filter.scope_id] : undefined })
                        .map(h => ({ id: h.row.id }));
                    if (filter.category)
                        rows = rows.filter(r => store.getFact(r.id)?.category === filter.category);
                }
                else {
                    rows = store.db
                        .prepare(`SELECT id FROM facts${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`)
                        .all(...params);
                }
                ids = rows.map(r => r.id);
            }
            if (ids.length === 0)
                continue;
            const n = store.hardDeleteFacts(ids);
            deleted += n;
            if (n > 0) {
                this.registry.audit({
                    actor_type: 'user',
                    actor_id: 'local',
                    action: 'forget',
                    target_id_hash: sha256Hex(ids.slice().sort().join(',')),
                    scope_id: filter.scope_id ?? null,
                    reason: `deleted=${n}`,
                });
            }
        }
        return { deleted };
    }
    // -------------------------------------------------------------------- admin
    listAgents() {
        this.assertOpen();
        return this.registry.listInstances().map(instance => {
            const assistant = this.registry.getAssistant(instance.assistant_id);
            const db = this.registry.dbForInstance(instance.id);
            return { instance, assistant_type: assistant?.type ?? 'generic', db_path: db?.path ?? null };
        });
    }
    stats() {
        this.assertOpen();
        let facts = 0;
        let databases = 0;
        for (const entry of this.registry.listDbs()) {
            if (entry.kind === 'registry')
                continue;
            databases++;
            if (existsSync(entry.path))
                facts += this.openContent(entry.path).countFacts();
        }
        return { facts, databases, instances: this.registry.listInstances().length };
    }
    doctor() {
        this.assertOpen();
        const warnings = [];
        const databases = [];
        let onNetwork = false;
        let journalMode = 'wal';
        for (const entry of this.registry.listDbs()) {
            const exists = existsSync(entry.path);
            let size = 0;
            let walPending;
            if (exists) {
                size = statSync(entry.path).size;
                if (entry.kind !== 'registry') {
                    const store = this.openContent(entry.path);
                    walPending = store.walPendingCount();
                    onNetwork ||= store.onNetworkVolume;
                    journalMode = store.journalMode;
                    if (store.onNetworkVolume) {
                        warnings.push(`DB sur volume réseau/synchronisé : ${entry.path} (journal_mode=${store.journalMode})`);
                    }
                }
            }
            else if (entry.kind !== 'registry') {
                warnings.push(`DB enregistrée mais absente du disque : ${entry.path}`);
            }
            databases.push({ kind: entry.kind, path: entry.path, exists, size_bytes: size, wal_pending: walPending });
        }
        return {
            ok: warnings.length === 0,
            storage_root: this.paths.root,
            config_path: this.resolved.configPath,
            registry_path: this.paths.registry,
            databases,
            network_guard: { on_network_volume: onNetwork, journal_mode: journalMode },
            warnings,
        };
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const store of this.pool.values())
            store.close();
        this.pool.clear();
        this.registry.close();
    }
    // ------------------------------------------------------------------ interne
    assertOpen() {
        if (this.closed)
            throw new Error('Memoria est fermé (close() déjà appelé)');
    }
    mustInstance(instanceId) {
        const instance = this.registry.getInstance(instanceId);
        if (!instance)
            throw new Error(`instance inconnue : ${instanceId}`);
        if (instance.revoked_at)
            throw new Error(`instance révoquée : ${instanceId}`);
        return instance;
    }
    openContent(path) {
        let store = this.pool.get(path);
        if (!store) {
            store = new ContentStore(path);
            this.pool.set(path, store);
        }
        return store;
    }
    /** Scope cible d'une écriture : id, nom, ou défaut = privé de l'instance. */
    resolveTargetScope(instance, scopeRef) {
        if (!scopeRef) {
            const scope = this.registry.getScopeByName(`private:${instance.id}`);
            if (!scope)
                throw new Error(`scope privé introuvable pour l'instance ${instance.id}`);
            return scope;
        }
        const scope = this.registry.getScope(scopeRef) ?? this.registry.getScopeByName(scopeRef);
        if (!scope)
            throw new Error(`scope inconnu : ${scopeRef}`);
        return scope;
    }
    /** DB qui héberge un scope (privé → DB d'instance ; partagé → shared/…). */
    storeForScope(scope, instance) {
        if (scope.type === 'private') {
            return this.openContent(this.paths.assistantDb(instance.id));
        }
        const dbPath = this.sharedDbPath(scope);
        const store = this.openContent(dbPath);
        this.registry.registerDb({ kind: 'shared', path: dbPath, assistant_instance_id: null, scope_id: scope.id });
        return store;
    }
    sharedDbPath(scope) {
        switch (scope.type) {
            case 'user':
                return this.paths.sharedDb('user');
            case 'org':
                return this.paths.sharedDb(`companies/${scope.org_id ?? scope.id}`);
            case 'client':
                return this.paths.sharedDb(`clients/${scope.client_org_id ?? scope.id}`);
            case 'project':
                return this.paths.sharedDb(`projects/${scope.project_id ?? scope.id}`);
            case 'shared_topic':
                return this.paths.sharedDb(`topics/${scope.id}`);
            case 'legacy_to_review':
                return this.paths.sharedDb('legacy_to_review');
            default:
                throw new Error(`type de scope sans DB partagée : ${scope.type}`);
        }
    }
    /**
     * Cibles de lecture du fan-out : la DB privée de CETTE instance + chaque DB
     * partagée dont le scope est lisible (policy can_read). Les scopes privés
     * des AUTRES instances sont exclus structurellement.
     */
    resolveReadTargets(instance) {
        const targets = new Map();
        const push = (dbPath, scope) => {
            const entry = targets.get(dbPath) ?? { scopeIds: [], scopeNames: [] };
            entry.scopeIds.push(scope.id);
            entry.scopeNames.push(scope.name);
            targets.set(dbPath, entry);
        };
        for (const scope of this.registry.readableScopes(instance.assistant_id)) {
            if (scope.type === 'private') {
                if (scope.name !== `private:${instance.id}`)
                    continue;
                push(this.paths.assistantDb(instance.id), scope);
            }
            else if (scope.type === 'legacy_to_review') {
                // La quarantaine n'entre JAMAIS dans le recall (revue via UI uniquement)
                continue;
            }
            else {
                const dbPath = this.sharedDbPath(scope);
                if (existsSync(dbPath))
                    push(dbPath, scope);
            }
        }
        return [...targets.entries()].map(([dbPath, v]) => ({ dbPath, ...v }));
    }
}
//# sourceMappingURL=memoria.js.map