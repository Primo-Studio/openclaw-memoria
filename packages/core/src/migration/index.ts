/**
 * Migration legacy v3.34 → V3 (spec §7.1) :
 * schéma v3.34 reconstitué + importeur backup→quarantaine→vérif/rollback.
 */
export { createSyntheticLegacyDb } from './legacy-schema.js'
export type { SyntheticLegacyOptions, SyntheticLegacySummary } from './legacy-schema.js'
export { importLegacyDb } from './import-legacy.js'
export type { ImportLegacyInput, ImportLegacyReport } from './import-legacy.js'
