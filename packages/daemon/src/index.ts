/**
 * @memoria/daemon — daemon local unique, gardien des DB (spec §2.2).
 * HTTP 127.0.0.1 + tokens (admin / instance), singleton lock-file.
 */
export { startDaemon, DAEMON_VERSION, DaemonLockHeldError } from './server.js'
export { startWithStandby } from './standby.js'
export type { StandbyOptions } from './standby.js'
export type { DaemonControlHooks, DaemonOptions, DaemonUpdaterHooks, RunningDaemon } from './server.js'
export { ImportJobRunner } from './import-job.js'
export type { ImportJobKind, ImportJobProgress, ImportJobState, ImportJobStatus } from './import-job.js'
export { DaemonClient, ensureDaemon, daemonBinPath, daemonProgramArguments, waitForDaemon, waitForExit } from './client.js'
export type { DaemonHealth, EnsureDaemonHooks } from './client.js'
export { currentVersion, pullAndBuild, scheduleRestart, scheduleAutostartHandover, repoRoot, NPM_MISSING_MESSAGE } from './update.js'
export type { UpdateResult } from './update.js'
export type { ClientOptions } from './client.js'
export {
  readDaemonState,
  writeDaemonState,
  clearDaemonState,
  acquireLock,
  daemonLooksAlive,
  lockHolderPid,
} from './state.js'
export type { DaemonState } from './state.js'
