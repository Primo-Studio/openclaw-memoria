/**
 * Table vectorielle sqlite-vec (spec §10) — index ANN dans le MÊME fichier
 * SQLite que la vérité (la table embeddings reste la source).
 *
 * Une table virtuelle PAR (dimensions, modèle) : `vec_index_768_nomic_embed_text`,
 * `vec_index_1536_text_embedding_3_small`… Le mélange de dimensions est
 * structurellement impossible (anti-bug 768/1536) — et le mélange de MODÈLES
 * aussi : deux modèles de même dimension (nomic-embed-text vs sa v2-moe, ou
 * deux modèles OpenAI à 1536) produisent des espaces incomparables. Nommer
 * l'index par la dimension seule laissait A → B → A réutiliser un index rempli
 * de vecteurs B (rien à ré-embedder côté `embeddings`, qui connaît déjà A) :
 * le KNN comparait des espaces différents, sans un mot.
 *
 * Machine sans binaire sqlite-vec → dégradation PROPRE vers FTS seul,
 * annoncée une fois (console.warn), jamais silencieuse.
 */
import { createRequire } from 'node:module'
import type { Database } from 'better-sqlite3'
import { vectorToBuffer } from '../util.js'

/** Identité d'un index vectoriel : le modèle ET ses dimensions. */
export interface VecIndexKey {
  model: string
  dimensions: number
}

let warnedUnavailable = false
const loadedDbs = new WeakSet<Database>()
const knownTables = new WeakMap<Database, Set<string>>()

/** Charge l'extension sqlite-vec dans cette connexion. False si indisponible. */
export function loadVecExtension(db: Database): boolean {
  if (loadedDbs.has(db)) return true
  try {
    requireSqliteVec().load(db)
    loadedDbs.add(db)
    return true
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true
      console.warn(
        `[memoria] extension sqlite-vec indisponible (${(err as Error).message}) — recall en FTS seul`,
      )
    }
    return false
  }
}

interface SqliteVecModule {
  load: (db: Database) => void
}

// sqlite-vec est CJS, le core est en ESM strict → createRequire
const requireCjs = createRequire(import.meta.url)
let cachedModule: SqliteVecModule | null | undefined
function requireSqliteVec(): SqliteVecModule {
  if (cachedModule === undefined) {
    try {
      cachedModule = requireCjs('sqlite-vec') as SqliteVecModule
    } catch {
      cachedModule = null
    }
  }
  if (!cachedModule) throw new Error('module sqlite-vec introuvable')
  return cachedModule
}

export function isVecAvailable(db: Database): boolean {
  return loadVecExtension(db)
}

/**
 * Nom de table : `vec_index_<dims>_<modèle slugifié>`. Le slug ne garde que
 * [a-z0-9_] (« nomic-embed-text:latest » → `nomic_embed_text_latest`) — un nom
 * de modèle ne doit jamais pouvoir injecter du SQL ni casser un identifiant.
 */
export function vecTableName(key: VecIndexKey): string {
  const slug = key.model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return `vec_index_${key.dimensions}_${slug || 'model'}`
}

/** Crée (si besoin) la table vectorielle de ce (modèle, dimensions). */
export function ensureVecTable(db: Database, key: VecIndexKey): boolean {
  if (!loadVecExtension(db)) return false
  let tables = knownTables.get(db)
  if (!tables) {
    tables = new Set()
    knownTables.set(db, tables)
  }
  const table = vecTableName(key)
  if (tables.has(table)) return true
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
       embedding float[${key.dimensions}],
       fact_id TEXT
     )`,
  )
  tables.add(table)
  return true
}

/**
 * Toutes les tables d'index vectoriel de cette base — les tables VIRTUELLES
 * seulement (pas leurs shadow tables `_chunks`/`_rowids`/…), quel que soit le
 * schéma de nommage (legacy `vec_index_768` ou `vec_index_768_<modèle>`).
 * Sert au hard-delete (content.ts) : un oubli doit purger TOUS les index.
 */
export function listVecTables(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'vec\\_index\\_%' ESCAPE '\\'
           AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
      )
      .all() as Array<{ name: string }>
  ).map(t => t.name)
}

/** Insère/remplace le vecteur d'un fait dans l'index. */
export function upsertVector(db: Database, key: VecIndexKey, factId: string, vector: Float32Array): void {
  if (vector.length !== key.dimensions) {
    throw new Error(`dimension du vecteur (${vector.length}) ≠ table ${vecTableName(key)} — interdit`)
  }
  if (!ensureVecTable(db, key)) return
  const table = vecTableName(key)
  db.prepare(`DELETE FROM ${table} WHERE fact_id = ?`).run(factId)
  db.prepare(`INSERT INTO ${table} (embedding, fact_id) VALUES (?, ?)`).run(vectorToBuffer(vector), factId)
}

/** Retire des faits de l'index (hard-delete / réindexation). */
export function removeVectors(db: Database, key: VecIndexKey, factIds: string[]): void {
  if (factIds.length === 0 || !ensureVecTable(db, key)) return
  const table = vecTableName(key)
  const stmt = db.prepare(`DELETE FROM ${table} WHERE fact_id = ?`)
  for (const id of factIds) stmt.run(id)
}

/**
 * Purge des faits de TOUS les index vectoriels de la base, quel que soit leur
 * nommage (legacy `vec_index_768` ou `vec_index_768_<modèle>`) — sans en créer
 * aucun. C'est la brique du hard-delete (spec §11 « aucune trace ») : un fait
 * rejeté en revue ou oublié ne doit plus être mesurable par similarité, dans
 * AUCUN index, y compris ceux d'un modèle qui n'est plus le modèle courant.
 * `removeVectors` ne couvre qu'un index connu (celui de l'indexer actif) et le
 * crée au besoin — ici on ne touche qu'à l'existant.
 *
 * Sans extension chargeable, les tables vec0 sont inaccessibles dans cette
 * connexion : on n'y touche pas (elles ne servent alors à aucun recall).
 */
export function purgeFactVectors(db: Database, factIds: string[]): void {
  if (factIds.length === 0) return
  const tables = listVecTables(db)
  if (tables.length === 0 || !loadVecExtension(db)) return
  for (const table of tables) {
    const stmt = db.prepare(`DELETE FROM "${table}" WHERE fact_id = ?`)
    for (const id of factIds) stmt.run(id)
  }
}

/**
 * Répare l'index depuis la vérité : tout embedding de ce modèle (fait existant)
 * absent de l'index y est réinséré. Couvre l'index créé APRÈS les embeddings
 * (migration du nommage par dimension vers (dimensions, modèle), table
 * supprimée, crash entre les deux écritures). 0 appel provider. Retourne le
 * nombre de vecteurs réinsérés.
 */
export function repairVecIndex(db: Database, key: VecIndexKey): number {
  if (!ensureVecTable(db, key)) return 0
  const table = vecTableName(key)
  const missing = db
    .prepare(
      `SELECT e.owner_id AS fact_id, e.vector AS vector
       FROM embeddings e JOIN facts f ON f.id = e.owner_id
       WHERE e.owner_type = 'fact' AND e.model = ? AND e.dimensions = ?
         AND e.owner_id NOT IN (SELECT fact_id FROM ${table})`,
    )
    .all(key.model, key.dimensions) as Array<{ fact_id: string; vector: Buffer }>
  if (missing.length === 0) return 0
  const insert = db.prepare(`INSERT INTO ${table} (embedding, fact_id) VALUES (?, ?)`)
  const tx = db.transaction((rows: typeof missing) => {
    for (const r of rows) insert.run(r.vector, r.fact_id)
  })
  tx(missing)
  return missing.length
}

export interface KnnHit {
  fact_id: string
  distance: number
}

/** KNN brut sur l'index — le filtrage permissions se fait PAR-DESSUS (jointure facts). */
export function knn(db: Database, key: VecIndexKey, query: Float32Array, k: number): KnnHit[] {
  if (query.length !== key.dimensions) {
    throw new Error(`dimension de la requête (${query.length}) ≠ table ${vecTableName(key)} — interdit`)
  }
  if (!ensureVecTable(db, key)) return []
  const table = vecTableName(key)
  return db
    .prepare(`SELECT fact_id, distance FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
    .all(vectorToBuffer(query), k) as KnnHit[]
}
