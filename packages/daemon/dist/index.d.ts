/**
 * @memoria/daemon — daemon local unique, gardien des DB (spec §2.2).
 * HTTP 127.0.0.1 + tokens (admin / instance), singleton lock-file.
 */
export { startDaemon, DAEMON_VERSION } from './server.js';
export type { DaemonOptions, RunningDaemon } from './server.js';
export { DaemonClient, ensureDaemon } from './client.js';
export type { ClientOptions } from './client.js';
export { readDaemonState, writeDaemonState, clearDaemonState, acquireLock, daemonLooksAlive, } from './state.js';
export type { DaemonState } from './state.js';
//# sourceMappingURL=index.d.ts.map