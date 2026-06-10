/**
 * Daemon local unique (spec §2.2) — UN processus détient les DB ;
 * MCP/CLI/UI sont des clients HTTP sur 127.0.0.1.
 *
 * Auth à trois niveaux :
 *  - aucun : /v1/health, /v1/pairing/complete (le code one-shot TTL EST le secret) ;
 *  - Bearer <admin_token> (daemon.json chmod 600) : /v1/admin/* — réservé à
 *    l'utilisateur local (CLI, UI web) ;
 *  - Bearer <instance_token> (issu du pairing) : /v1/memory/* — les agents.
 *
 * Écritures sérialisées de fait : better-sqlite3 est synchrone sur l'unique
 * thread Node → zéro contention inter-process par construction.
 */
import { createServer } from 'node:http';
import { Memoria, newToken, nowISO } from '@memoria/core';
import { findUiDist, serveUi } from './static.js';
import { acquireLock, clearDaemonState, writeDaemonState } from './state.js';
export const DAEMON_VERSION = '0.1.0';
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
export async function startDaemon(opts = {}) {
    const memoria = Memoria.init({ storageRoot: opts.storageRoot, configPath: opts.configPath });
    const storageRoot = memoria.paths.root;
    const release = acquireLock(storageRoot);
    if (!release) {
        memoria.close();
        throw new Error(`un daemon Memoria tourne déjà pour ${storageRoot} (daemon.lock)`);
    }
    const adminToken = newToken();
    const daemonId = newToken().slice(0, 16);
    const server = createServer((req, res) => {
        void handle(req, res).catch((err) => {
            const status = err instanceof HttpError ? err.status : 500;
            sendJson(res, status, { error: err.message ?? 'erreur interne' });
        });
    });
    const uiDist = findUiDist(opts.uiDist);
    async function handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const route = `${req.method} ${url.pathname}`;
        if (route === 'GET /v1/health') {
            sendJson(res, 200, { ok: true, version: DAEMON_VERSION, daemon_id: daemonId, ui: Boolean(uiDist) });
            return;
        }
        if (req.method === 'GET' && uiDist && serveUi(url.pathname, uiDist, res))
            return;
        if (route === 'POST /v1/pairing/complete') {
            const body = await readJson(req);
            const code = String(body['code'] ?? '');
            const done = memoria.completePairing(code);
            if (!done)
                throw new HttpError(401, 'code de pairing invalide ou expiré');
            sendJson(res, 200, done);
            return;
        }
        const token = bearerToken(req);
        if (url.pathname.startsWith('/v1/admin/')) {
            if (token !== adminToken)
                throw new HttpError(401, 'token admin requis');
            await handleAdmin(route, url, req, res);
            return;
        }
        if (url.pathname.startsWith('/v1/memory/')) {
            if (!token)
                throw new HttpError(401, 'token d’instance requis');
            const instance = memoria.authenticate(token);
            if (!instance)
                throw new HttpError(401, 'token d’instance invalide ou révoqué');
            await handleMemory(route, req, res, instance.id);
            return;
        }
        throw new HttpError(404, `route inconnue : ${route}`);
    }
    async function handleAdmin(route, url, req, res) {
        switch (route) {
            case 'GET /v1/admin/facts': {
                const facts = memoria.browseFacts({
                    instance: url.searchParams.get('instance') ?? undefined,
                    q: url.searchParams.get('q') ?? undefined,
                    limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
                });
                sendJson(res, 200, { facts });
                return;
            }
            case 'GET /v1/admin/capture_mode': {
                sendJson(res, 200, { mode: memoria.getCaptureMode() });
                return;
            }
            case 'POST /v1/admin/capture_mode': {
                const body = await readJson(req);
                const mode = String(body['mode'] ?? '');
                if (!['auto-private', 'review-first', 'incognito'].includes(mode)) {
                    throw new HttpError(400, `mode de capture inconnu : ${mode}`);
                }
                memoria.setCaptureMode(mode);
                sendJson(res, 200, { mode });
                return;
            }
            case 'POST /v1/admin/pair': {
                const body = await readJson(req);
                const result = memoria.pairAssistant({
                    type: body['type'] ?? 'generic',
                    display_name: body['display_name'],
                    machine: body['machine'],
                    profile: body['profile'] ?? null,
                });
                sendJson(res, 200, result);
                return;
            }
            case 'POST /v1/admin/revoke': {
                const body = await readJson(req);
                memoria.revokeInstance(String(body['assistant_instance_id'] ?? ''));
                sendJson(res, 200, { ok: true });
                return;
            }
            case 'GET /v1/admin/agents': {
                sendJson(res, 200, { agents: memoria.listAgents() });
                return;
            }
            case 'GET /v1/admin/stats': {
                sendJson(res, 200, memoria.stats());
                return;
            }
            case 'GET /v1/admin/doctor': {
                sendJson(res, 200, memoria.doctor());
                return;
            }
            case 'POST /v1/admin/forget': {
                const body = await readJson(req);
                sendJson(res, 200, memoria.forget(body));
                return;
            }
            case 'GET /v1/admin/audit': {
                sendJson(res, 200, { entries: memoria.registry.auditTail(200) });
                return;
            }
            default:
                throw new HttpError(404, `route admin inconnue : ${route}`);
        }
    }
    async function handleMemory(route, req, res, instanceId) {
        switch (route) {
            case 'POST /v1/memory/store_fact': {
                const body = await readJson(req);
                const fact = memoria.storeFact({ ...body, instance: instanceId });
                sendJson(res, 200, { fact });
                return;
            }
            case 'POST /v1/memory/recall': {
                const body = await readJson(req);
                const result = memoria.recall({ ...body, instance: instanceId });
                sendJson(res, 200, result);
                return;
            }
            default:
                throw new HttpError(404, `route mémoire inconnue : ${route}`);
        }
    }
    let port;
    try {
        port = await new Promise((resolvePort, reject) => {
            server.once('error', reject);
            server.listen(opts.port ?? 0, '127.0.0.1', () => {
                const addr = server.address();
                if (addr && typeof addr === 'object')
                    resolvePort(addr.port);
                else
                    reject(new Error('adresse d’écoute illisible'));
            });
        });
    }
    catch (err) {
        release();
        memoria.close();
        throw err;
    }
    const state = {
        daemon_id: daemonId,
        port,
        admin_token: adminToken,
        pid: process.pid,
        started_at: nowISO(),
    };
    writeDaemonState(storageRoot, state);
    const close = async () => {
        await new Promise((resolveClose) => server.close(() => resolveClose()));
        clearDaemonState(storageRoot);
        release();
        memoria.close();
    };
    return { state, memoria, close };
}
// ----------------------------------------------------------------- helpers
function bearerToken(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        return null;
    return header.slice('Bearer '.length).trim();
}
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000)
            throw new HttpError(413, 'corps de requête trop grand');
        chunks.push(chunk);
    }
    if (chunks.length === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError(400, 'JSON invalide');
    }
}
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}
//# sourceMappingURL=server.js.map