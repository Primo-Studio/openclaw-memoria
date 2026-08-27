export {
  loadVecExtension,
  isVecAvailable,
  ensureVecTable,
  vecTableName,
  upsertVector,
  removeVectors,
  repairVecIndex,
  listVecTables,
  purgeFactVectors,
  knn,
} from './vec-table.js'
export type { KnnHit, VecIndexKey } from './vec-table.js'
export { EmbeddingIndexer } from './indexer.js'
export type { IndexerRunResult } from './indexer.js'
export { hybridSearchFacts } from './hybrid.js'
export type { HybridSearchOptions } from './hybrid.js'
