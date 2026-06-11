/**
 * @memoria/core — moteur Memoria, aucune dépendance d'hôte.
 */
export { Memoria } from './engine/memoria.js'
export type { MemoriaInitOptions, PairAssistantInput, PairAssistantResult } from './engine/memoria.js'
export { scoreFact, passesClientIsolation } from './engine/scoring.js'
export {
  resolveStorageRoot,
  storagePaths,
  ensureStorageTree,
  loadConfigFile,
  saveConfigFile,
  defaultStorageRoot,
  moveStorage,
  isEnabled,
  setEnabled,
  DEFAULT_CONFIG_PATH,
} from './config.js'
export type { MemoriaConfig, ResolvedConfig, ResolveOptions } from './config.js'
export {
  AUTOSTART_LABEL,
  autostartStatus,
  enableAutostart,
  disableAutostart,
} from './control/autostart.js'
export type { AutostartSpec, AutostartStatus } from './control/autostart.js'
export { RegistryStore } from './storage/registry.js'
export { ContentStore, toFtsQuery, queryTokens, normalizeText, isContentWord, rowToFact } from './storage/content.js'
export type { FactRow, InsertFactInput, FtsHit, FtsSearchOptions } from './storage/content.js'
export { runMigrations, schemaVersion } from './storage/migrations.js'
export type { Migration } from './storage/migrations.js'
export { isOnNetworkVolume } from './storage/network-guard.js'
export { openDatabase } from './storage/sqlite.js'
export * from './types.js'
export * from './secrets/types.js'
export * from './secrets/index.js'
export * from './llm/provider.js'
export * from './llm/index.js'
export * from './llm/openai.js'
export * from './engine/selective.js'
export * from './engine/wal.js'
export * from './engine/capture.js'
export * from './migration/index.js'
export * from './vector/index.js'
export * from './cognition/index.js'
export { importLegacyCognition } from './migration/import-cognition.js'
export {
  estimateTokens,
  newId,
  newPairingCode,
  newToken,
  nowISO,
  sha256Hex,
  vectorToBuffer,
  bufferToVector,
} from './util.js'
