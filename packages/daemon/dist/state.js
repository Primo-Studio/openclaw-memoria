/**
 * État local du daemon : `daemon.json` (découverte clients) + lock-file singleton.
 *
 * - `daemon.json` (chmod 600) : { daemon_id, port, admin_token, pid, started_at }.
 *   C'est par CE fichier que CLI/UI/MCP découvrent le daemon et son token admin.
 * - `daemon.lock` : PID — un seul daemon par storage_root. Lock périmé (process
 *   mort) → reprise automatique.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { storagePaths } from '@memoria/core';
export function readDaemonState(storageRoot) {
    const p = storagePaths(storageRoot).daemonState;
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
export function writeDaemonState(storageRoot, state) {
    const p = storagePaths(storageRoot).daemonState;
    writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
    chmodSync(p, 0o600);
}
export function clearDaemonState(storageRoot) {
    const p = storagePaths(storageRoot).daemonState;
    rmSync(p, { force: true });
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Prend le lock singleton. Retourne `null` si un autre daemon VIVANT le tient,
 * sinon une fonction de libération.
 */
export function acquireLock(storageRoot) {
    const lockPath = storagePaths(storageRoot).daemonLock;
    if (existsSync(lockPath)) {
        const raw = readFileSync(lockPath, 'utf8').trim();
        const pid = Number.parseInt(raw, 10);
        // Un lock tenu par un process VIVANT (y compris le nôtre) refuse : un seul
        // daemon par storage_root, même intra-process.
        if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
            return null;
        }
        // lock périmé → reprise
        rmSync(lockPath, { force: true });
    }
    writeFileSync(lockPath, String(process.pid), 'utf8');
    return () => rmSync(lockPath, { force: true });
}
/** Le daemon décrit par daemon.json est-il vivant (PID) ? */
export function daemonLooksAlive(storageRoot) {
    const state = readDaemonState(storageRoot);
    if (!state)
        return null;
    return isPidAlive(state.pid) ? state : null;
}
//# sourceMappingURL=state.js.map