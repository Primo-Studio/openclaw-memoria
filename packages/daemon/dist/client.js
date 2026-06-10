/**
 * DaemonClient — utilisé par CLI / UI / MCP. Découvre le daemon via
 * `daemon.json`, peut le démarrer s'il n'existe pas (singleton).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStorageRoot } from '@memoria/core';
import { daemonLooksAlive, readDaemonState } from './state.js';
export class DaemonClient {
    baseUrl;
    token;
    constructor(state, token) {
        this.baseUrl = `http://127.0.0.1:${state.port}`;
        this.token = token;
    }
    /** Client admin local : lit port + admin_token dans daemon.json. */
    static admin(opts = {}) {
        const { storageRoot } = resolveStorageRoot(opts);
        const state = readDaemonState(storageRoot);
        if (!state)
            return null;
        return new DaemonClient(state, opts.token ?? state.admin_token);
    }
    async health() {
        try {
            const res = await fetch(`${this.baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
            if (!res.ok)
                return null;
            return (await res.json());
        }
        catch {
            return null;
        }
    }
    async completePairing(code) {
        return this.post('/v1/pairing/complete', { code });
    }
    // --- admin ---
    async pair(type, displayName) {
        return this.post('/v1/admin/pair', { type, display_name: displayName });
    }
    async revoke(instanceId) {
        await this.post('/v1/admin/revoke', { assistant_instance_id: instanceId });
    }
    async agents() {
        return this.get('/v1/admin/agents');
    }
    async stats() {
        return this.get('/v1/admin/stats');
    }
    async doctor() {
        return this.get('/v1/admin/doctor');
    }
    async audit() {
        return this.get('/v1/admin/audit');
    }
    // --- mémoire (token d'instance) ---
    async storeFact(input) {
        return this.post('/v1/memory/store_fact', input);
    }
    async recall(input) {
        return this.post('/v1/memory/recall', input);
    }
    headers() {
        const h = { 'content-type': 'application/json' };
        if (this.token)
            h['authorization'] = `Bearer ${this.token}`;
        return h;
    }
    async post(path, body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body ?? {}),
        });
        return handleResponse(res, path);
    }
    async get(path) {
        const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
        return handleResponse(res, path);
    }
}
async function handleResponse(res, path) {
    const payload = (await res.json().catch(() => ({})));
    if (!res.ok) {
        throw new Error(`daemon ${path} → ${res.status} : ${String(payload['error'] ?? 'erreur')}`);
    }
    return payload;
}
/**
 * Garantit qu'un daemon tourne pour ce storage_root : réutilise le vivant,
 * sinon en démarre un détaché (`memoria-daemon`) et attend son health.
 */
export async function ensureDaemon(opts = {}) {
    const { storageRoot } = resolveStorageRoot(opts);
    const alive = daemonLooksAlive(storageRoot);
    if (alive) {
        const client = new DaemonClient(alive);
        if (await client.health())
            return alive;
    }
    const binPath = fileURLToPath(new URL('./bin.js', import.meta.url));
    const args = [binPath];
    if (opts.storageRoot)
        args.push('--storage-root', opts.storageRoot);
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 150));
        const state = daemonLooksAlive(storageRoot);
        if (state) {
            const client = new DaemonClient(state);
            if (await client.health())
                return state;
        }
    }
    throw new Error('le daemon n’a pas démarré dans les 15 s (voir memoria doctor)');
}
//# sourceMappingURL=client.js.map