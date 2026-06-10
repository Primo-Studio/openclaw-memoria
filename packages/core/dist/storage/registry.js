import { openDatabase } from './sqlite.js';
import { runMigrations } from './migrations.js';
import { registryMigrations } from './registry-schema.js';
import { fromJsonArray, newId, newPairingCode, newToken, nowISO, sha256Hex, toJson } from '../util.js';
const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
export class RegistryStore {
    db;
    path;
    constructor(path) {
        const opened = openDatabase(path);
        this.db = opened.db;
        this.path = path;
        runMigrations(this.db, registryMigrations);
    }
    // -------------------------------------------------------------- bootstrap
    /**
     * Garantit l'état P1 : 1 human_user actif + 1 organisation own_company +
     * les scopes de base (`user`, `legacy_to_review`). Idempotent.
     */
    bootstrap(displayName = 'Utilisateur') {
        const tx = this.db.transaction(() => {
            let user = this.db.prepare('SELECT * FROM human_users LIMIT 1').get();
            if (!user) {
                user = {
                    id: newId(),
                    display_name: displayName,
                    local_profile_name: null,
                    created_at: nowISO(),
                };
                this.db
                    .prepare('INSERT INTO human_users (id, display_name, local_profile_name, created_at) VALUES (?, ?, ?, ?)')
                    .run(user.id, user.display_name, user.local_profile_name, user.created_at);
            }
            let org = this.db.prepare("SELECT * FROM organizations WHERE org_type = 'own_company' LIMIT 1").get();
            if (!org) {
                org = { id: newId(), name: 'Mon organisation', org_type: 'own_company', parent_org_id: null, created_at: nowISO() };
                this.db
                    .prepare('INSERT INTO organizations (id, name, org_type, parent_org_id, created_at) VALUES (?, ?, ?, ?, ?)')
                    .run(org.id, org.name, org.org_type, org.parent_org_id, org.created_at);
            }
            this.ensureScope('user', 'user', { owner_user_id: user.id });
            this.ensureScope('legacy_to_review', 'legacy_to_review', {});
            this.ensureScope('org', `org:${org.id}`, { org_id: org.id });
            return { user, ownCompany: org };
        });
        return tx();
    }
    ensureScope(type, name, refs) {
        const existing = this.db.prepare('SELECT * FROM memory_scopes WHERE type = ? AND name = ?').get(type, name);
        if (existing)
            return existing;
        const scope = {
            id: newId(),
            type,
            name,
            owner_user_id: refs.owner_user_id ?? null,
            org_id: refs.org_id ?? null,
            client_org_id: refs.client_org_id ?? null,
            project_id: refs.project_id ?? null,
            created_at: nowISO(),
        };
        this.db
            .prepare('INSERT INTO memory_scopes (id, type, name, owner_user_id, org_id, client_org_id, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(scope.id, scope.type, scope.name, scope.owner_user_id, scope.org_id, scope.client_org_id, scope.project_id, scope.created_at);
        return scope;
    }
    createOrganization(name, orgType, parentOrgId) {
        const org = {
            id: newId(),
            name,
            org_type: orgType,
            parent_org_id: parentOrgId ?? null,
            created_at: nowISO(),
        };
        this.db
            .prepare('INSERT INTO organizations (id, name, org_type, parent_org_id, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(org.id, org.name, org.org_type, org.parent_org_id, org.created_at);
        return org;
    }
    getScope(id) {
        return this.db.prepare('SELECT * FROM memory_scopes WHERE id = ?').get(id) ?? null;
    }
    getScopeByName(name) {
        return this.db.prepare('SELECT * FROM memory_scopes WHERE name = ?').get(name) ?? null;
    }
    listScopes() {
        return this.db.prepare('SELECT * FROM memory_scopes ORDER BY created_at').all();
    }
    // -------------------------------------------------------- assistants & instances
    ensureAssistant(type, displayName, ownerUserId) {
        const existing = this.db
            .prepare('SELECT * FROM assistants WHERE type = ? AND display_name = ?')
            .get(type, displayName);
        if (existing)
            return { ...existing, default_scopes: fromJsonArray(existing.default_scopes) };
        const a = {
            id: newId(),
            type,
            display_name: displayName,
            owner_user_id: ownerUserId,
            default_scopes: [],
            created_at: nowISO(),
        };
        this.db
            .prepare('INSERT INTO assistants (id, type, display_name, owner_user_id, default_scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(a.id, a.type, a.display_name, a.owner_user_id, toJson(a.default_scopes), a.created_at);
        return a;
    }
    getAssistant(id) {
        const row = this.db.prepare('SELECT * FROM assistants WHERE id = ?').get(id);
        return row ? { ...row, default_scopes: fromJsonArray(row.default_scopes) } : null;
    }
    listAssistants() {
        const rows = this.db.prepare('SELECT * FROM assistants ORDER BY created_at').all();
        return rows.map(r => ({ ...r, default_scopes: fromJsonArray(r.default_scopes) }));
    }
    createInstance(assistantId, machineId, profileId) {
        const inst = {
            id: newId(),
            assistant_id: assistantId,
            machine_id: machineId,
            profile_id: profileId ?? null,
            created_at: nowISO(),
            last_seen_at: null,
            token_hash: null,
            revoked_at: null,
        };
        this.db
            .prepare('INSERT INTO assistant_instances (id, assistant_id, machine_id, profile_id, created_at, last_seen_at, token_hash, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(inst.id, inst.assistant_id, inst.machine_id, inst.profile_id, inst.created_at, null, null, null);
        return inst;
    }
    getInstance(id) {
        return (this.db.prepare('SELECT * FROM assistant_instances WHERE id = ?').get(id) ??
            null);
    }
    listInstances() {
        return this.db.prepare('SELECT * FROM assistant_instances ORDER BY created_at').all();
    }
    touchInstance(id) {
        this.db.prepare('UPDATE assistant_instances SET last_seen_at = ? WHERE id = ?').run(nowISO(), id);
    }
    revokeInstance(id) {
        this.db.prepare('UPDATE assistant_instances SET revoked_at = ?, token_hash = NULL WHERE id = ?').run(nowISO(), id);
        this.db
            .prepare("UPDATE pairings SET status = 'revoked' WHERE assistant_instance_id = ? AND status = 'pending'")
            .run(id);
    }
    /** Authentifie un token d'instance → instance non révoquée, ou null. */
    verifyInstanceToken(token) {
        const hash = sha256Hex(token);
        const inst = this.db
            .prepare('SELECT * FROM assistant_instances WHERE token_hash = ? AND revoked_at IS NULL')
            .get(hash);
        return inst ?? null;
    }
    // ------------------------------------------------------------------ pairing
    /** Crée un pairing : code court TTL 10 min à coller dans le chat de l'agent. */
    createPairing(instanceId) {
        const code = newPairingCode();
        const pairing = {
            id: newId(),
            assistant_instance_id: instanceId,
            code_hash: sha256Hex(code),
            status: 'pending',
            created_at: nowISO(),
            expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
        };
        this.db
            .prepare('INSERT INTO pairings (id, assistant_instance_id, code_hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(pairing.id, pairing.assistant_instance_id, pairing.code_hash, pairing.status, pairing.created_at, pairing.expires_at);
        return { pairing, code };
    }
    /** Échange code → token d'instance (one-shot, expire après TTL). */
    completePairing(code) {
        const hash = sha256Hex(code.trim().toUpperCase());
        const pairing = this.db
            .prepare("SELECT * FROM pairings WHERE code_hash = ? AND status = 'pending'")
            .get(hash);
        if (!pairing)
            return null;
        if (new Date(pairing.expires_at).getTime() < Date.now()) {
            this.db.prepare("UPDATE pairings SET status = 'expired' WHERE id = ?").run(pairing.id);
            return null;
        }
        const token = newToken();
        const tx = this.db.transaction(() => {
            this.db.prepare("UPDATE pairings SET status = 'completed' WHERE id = ?").run(pairing.id);
            this.db
                .prepare('UPDATE assistant_instances SET token_hash = ?, last_seen_at = ? WHERE id = ?')
                .run(sha256Hex(token), nowISO(), pairing.assistant_instance_id);
        });
        tx();
        const instance = this.getInstance(pairing.assistant_instance_id);
        if (!instance)
            return null;
        return { instance, token };
    }
    // ------------------------------------------------------------------ policies
    setPolicy(policy) {
        this.db
            .prepare(`INSERT INTO assistant_scope_policy (assistant_id, scope_id, can_read, can_write, can_share, secret_access)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(assistant_id, scope_id) DO UPDATE SET
           can_read = excluded.can_read, can_write = excluded.can_write,
           can_share = excluded.can_share, secret_access = excluded.secret_access`)
            .run(policy.assistant_id, policy.scope_id, policy.can_read ? 1 : 0, policy.can_write ? 1 : 0, policy.can_share ? 1 : 0, policy.secret_access);
    }
    getPolicy(assistantId, scopeId) {
        const row = this.db
            .prepare('SELECT * FROM assistant_scope_policy WHERE assistant_id = ? AND scope_id = ?')
            .get(assistantId, scopeId);
        if (!row)
            return null;
        return {
            assistant_id: row.assistant_id,
            scope_id: row.scope_id,
            can_read: row.can_read === 1,
            can_write: row.can_write === 1,
            can_share: row.can_share === 1,
            secret_access: row.secret_access,
        };
    }
    /** Scopes lisibles par un assistant (policy can_read). */
    readableScopes(assistantId) {
        return this.db
            .prepare(`SELECT s.* FROM memory_scopes s
         JOIN assistant_scope_policy p ON p.scope_id = s.id
         WHERE p.assistant_id = ? AND p.can_read = 1`)
            .all(assistantId);
    }
    // ------------------------------------------------------------------ db registry
    registerDb(entry) {
        const existing = this.db.prepare('SELECT * FROM db_registry WHERE path = ?').get(entry.path);
        if (existing)
            return existing;
        const e = { id: newId(), ...entry };
        this.db
            .prepare('INSERT INTO db_registry (id, kind, path, assistant_instance_id, scope_id) VALUES (?, ?, ?, ?, ?)')
            .run(e.id, e.kind, e.path, e.assistant_instance_id, e.scope_id);
        return e;
    }
    listDbs() {
        return this.db.prepare('SELECT * FROM db_registry').all();
    }
    dbForScope(scopeId) {
        return (this.db.prepare("SELECT * FROM db_registry WHERE scope_id = ? AND kind = 'shared'").get(scopeId) ?? null);
    }
    dbForInstance(instanceId) {
        return (this.db
            .prepare("SELECT * FROM db_registry WHERE assistant_instance_id = ? AND kind = 'assistant'")
            .get(instanceId) ?? null);
    }
    // ------------------------------------------------------------------ audit
    /** Audit NEUTRE : action + hash — jamais de contenu (spec §11). */
    audit(entry) {
        this.db
            .prepare('INSERT INTO audit_log (ts, actor_type, actor_id, action, target_id_hash, scope_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(nowISO(), entry.actor_type, entry.actor_id, entry.action, entry.target_id_hash, entry.scope_id, entry.reason);
    }
    auditTail(limit = 100) {
        return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=registry.js.map