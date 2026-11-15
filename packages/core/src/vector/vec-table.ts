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
  upsertVectors(db, key, [{ factId, vector }])
}

/**
 * Insère/remplace les vecteurs d'un lot de faits. vec0 n'indexe pas `fact_id` :
 * chaque `DELETE … WHERE fact_id = ?` relisait tout l'index (~15 ms par fait
 * sur 5 500 vecteurs, mesuré le 15/11, soit ~240 ms pour un lot de 16). Une
 * seule relecture pour tout le lot.
 */
export function upsertVectors(db: Database, key: VecIndexKey, items: Array<{ factId: string; vector: Float32Array }>): void {
  for (const { vector } of items) {
    if (vector.length !== key.dimensions) {
      throw new Error(`dimension du vecteur (${vector.length}) ≠ table ${vecTableName(key)} — interdit`)
    }
  }
  if (items.length === 0 || !ensureVecTable(db, key)) return
  const table = vecTableName(key)
  db.prepare(`DELETE FROM ${table} WHERE fact_id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(items.map(i => i.factId)))
  const insert = db.prepare(`INSERT INTO ${table} (embedding, fact_id) VALUES (?, ?)`)
  for (const { factId, vector } of items) insert.run(vectorToBuffer(vector), factId)
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

// ---------------------------------------------------------------- réparation

/**
 * Repère d'une vérification : la dernière ligne d'`embeddings` (rowid ET id)
 * au moment où elle a commencé. Tant que cette ligne existe avec le même id,
 * toute ligne écrite depuis a un rowid plus grand (SQLite donne max + 1) : il
 * suffit de vérifier celles-là. Ligne effacée ou réécrite (rowid réutilisé,
 * VACUUM) : le repère ne tient plus, on revérifie tout.
 */
export interface VecRepairMark {
  rowid: number
  id: string | null
}

export interface VecRepairResult {
  /** Vecteurs réinsérés dans l'index. */
  repaired: number
  /** Repère pour la vérification suivante (`repairVecIndexSince`). */
  mark: VecRepairMark
}

/** Lignes lues par tranche (vecteurs du modèle, ou lignes de l'index) : quelques ms chacune. */
const REPAIR_PAGE = 2000
/**
 * Manquants confirmés puis réinsérés par transaction. La confirmation relit les
 * `fact_id` de tout l'index (~15 ms sur 5 500 vecteurs) ; l'insertion d'un
 * vecteur de 1 536 composantes coûte ~0,1 ms : ~25 ms par lot. Il n'y a de lot
 * que s'il manque quelque chose (en pratique : un index à reconstruire).
 */
const REPAIR_BATCH = 64

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Dernière ligne d'`embeddings` ({ 0, null } si la table est vide). */
export function embeddingsMark(db: Database): VecRepairMark {
  const r = db.prepare('SELECT rowid AS rowid, id FROM embeddings ORDER BY rowid DESC LIMIT 1').get() as { rowid: number; id: string } | undefined
  return r ? { rowid: r.rowid, id: r.id } : { rowid: 0, id: null }
}

export function sameMark(a: VecRepairMark, b: VecRepairMark): boolean {
  return a.rowid === b.rowid && a.id === b.id
}

/** La ligne repère existe-t-elle toujours, avec le même id ? */
function markHolds(db: Database, mark: VecRepairMark): boolean {
  if (mark.rowid === 0) return true // table vide à ce moment : toute ligne écrite depuis est après
  const r = db.prepare('SELECT id FROM embeddings WHERE rowid = ?').get(mark.rowid) as { id: string } | undefined
  return r?.id === mark.id
}

/**
 * Vecteurs de ce modèle (owner_type 'fact') de rowid dans ]after, upTo], par
 * tranches sur idx_embeddings_model : ni le vecteur ni `facts` ne sont lus
 * (l'existence du fait n'est vérifiée que pour les manquants). null : base fermée.
 */
async function modelRows(db: Database, key: VecIndexKey, after: number, upTo: number): Promise<Array<{ rid: number; owner: string }> | null> {
  const page = db.prepare(
    `SELECT rowid AS rid, owner_id AS owner, owner_type AS type FROM embeddings
     WHERE model = ? AND dimensions = ? AND rowid > ? AND rowid <= ?
     ORDER BY rowid LIMIT ${REPAIR_PAGE}`,
  )
  const out: Array<{ rid: number; owner: string }> = []
  for (let last = after; last < upTo; ) {
    // Toute ligne de la plage passe le filtre : la tranche ne lit jamais plus de REPAIR_PAGE lignes.
    const rows = page.all(key.model, key.dimensions, last, upTo) as Array<{ rid: number; owner: string; type: string }>
    for (const r of rows) if (r.type === 'fact') out.push({ rid: r.rid, owner: r.owner })
    if (rows.length < REPAIR_PAGE) break
    last = rows[rows.length - 1]!.rid
    await yieldToEventLoop()
    if (!db.open) return null
  }
  return out
}

/** `fact_id` présents dans l'index, lus par fenêtres de rowid (sans lire les vecteurs). null : base fermée. */
async function indexedFactIds(db: Database, table: string): Promise<Set<string> | null> {
  const rowids = (db.prepare(`SELECT rowid FROM ${table}`).pluck().all() as number[]).sort((a, b) => a - b)
  const window = db.prepare(`SELECT fact_id FROM ${table} WHERE rowid >= ? AND rowid <= ?`).pluck()
  const out = new Set<string>()
  for (let i = 0; i < rowids.length; i += REPAIR_PAGE) {
    if (i > 0) {
      await yieldToEventLoop()
      if (!db.open) return null
    }
    const hi = rowids[Math.min(i + REPAIR_PAGE, rowids.length) - 1]!
    for (const id of window.all(rowids[i]!, hi) as string[]) out.add(id)
  }
  return out
}

/**
 * Réinsère, parmi ces lignes d'`embeddings`, celles qui manquent VRAIMENT à
 * l'index. Chaque lot est confirmé dans SA transaction, au moment d'écrire :
 * ligne toujours là et toujours de ce modèle, fait toujours existant (un fait
 * effacé entre deux tranches ne revient jamais dans l'index), vecteur absent
 * de l'index (une réparation ou une indexation concurrente ne crée pas de
 * doublon). Le vecteur n'est lu que pour un manquant confirmé. null : base fermée.
 */
async function reinsertMissing(db: Database, key: VecIndexKey, rowids: number[]): Promise<number | null> {
  if (rowids.length === 0) return 0
  const table = vecTableName(key)
  const eligible = db.prepare(
    `SELECT e.rowid AS rid, e.owner_id AS owner FROM embeddings e
     WHERE e.rowid IN (SELECT value FROM json_each(?)) AND e.owner_type = 'fact' AND e.model = ? AND e.dimensions = ?
       AND EXISTS (SELECT 1 FROM facts f WHERE f.id = e.owner_id)`,
  )
  const inIndex = db.prepare(`SELECT fact_id FROM ${table} WHERE fact_id IN (SELECT value FROM json_each(?))`).pluck()
  const vector = db.prepare('SELECT vector FROM embeddings WHERE rowid = ?').pluck()
  const insert = db.prepare(`INSERT INTO ${table} (embedding, fact_id) VALUES (?, ?)`)
  const confirmAndInsert = db.transaction((batch: number[]): number => {
    const rows = eligible.all(JSON.stringify(batch), key.model, key.dimensions) as Array<{ rid: number; owner: string }>
    if (rows.length === 0) return 0
    const indexed = new Set(inIndex.all(JSON.stringify(rows.map(r => r.owner))) as string[])
    let n = 0
    for (const r of rows) {
      if (indexed.has(r.owner)) continue
      insert.run(vector.get(r.rid) as Buffer, r.owner)
      indexed.add(r.owner)
      n++
    }
    return n
  })
  let repaired = 0
  for (let i = 0; i < rowids.length; i += REPAIR_BATCH) {
    if (i > 0) {
      await yieldToEventLoop()
      if (!db.open) return null
    }
    repaired += confirmAndInsert(rowids.slice(i, i + REPAIR_BATCH))
  }
  return repaired
}

/**
 * Répare l'index depuis la vérité : tout embedding de ce modèle (fait existant)
 * absent de l'index y est réinséré. Couvre l'index créé APRÈS les embeddings
 * (migration du nommage par dimension vers (dimensions, modèle), table
 * supprimée, crash entre les deux écritures). 0 appel provider.
 *
 * Même ensemble que l'anti-jointure d'avant (`embeddings JOIN facts … NOT IN
 * (index)`), jamais un compte : une ligne périmée de l'index (fait effacé,
 * vecteur d'un autre état) compenserait un manquant. Mais découpée : cette
 * anti-jointure synchrone figeait la boucle 1 250 ms sur la vraie base (15/11),
 * sur les 8 bases d'un bloc au démarrage. Ici : vecteurs du modèle par tranches
 * de rowid, puis `fact_id` de l'index par fenêtres, différence en mémoire,
 * main rendue entre les tranches ; les manquants sont confirmés au moment
 * d'écrire (voir reinsertMissing).
 *
 * Rend le repère à passer à `repairVecIndexSince`, ou null (extension absente,
 * base fermée en route : rien n'est vérifié).
 */
export async function repairVecIndex(db: Database, key: VecIndexKey): Promise<VecRepairResult | null> {
  if (!db.open || !ensureVecTable(db, key)) return null
  const mark = embeddingsMark(db)
  // Les lignes écrites après le repère sont pour la vérification suivante.
  const rows = await modelRows(db, key, 0, mark.rowid)
  if (!rows) return null
  if (rows.length === 0) return { repaired: 0, mark }
  await yieldToEventLoop()
  if (!db.open) return null
  const present = await indexedFactIds(db, vecTableName(key))
  if (!present) return null
  const repaired = await reinsertMissing(
    db,
    key,
    rows.filter(r => !present.has(r.owner)).map(r => r.rid),
  )
  return repaired === null ? null : { repaired, mark }
}

/**
 * Vérification des seules lignes d'`embeddings` écrites après le repère
 * (après chaque store_fact, entre deux vérifications complètes). null : le
 * repère ne tient plus (sa ligne a été effacée ou réécrite), ou la base est
 * fermée ; l'appelant refait alors une vérification complète.
 */
export async function repairVecIndexSince(db: Database, key: VecIndexKey, mark: VecRepairMark): Promise<VecRepairResult | null> {
  if (!db.open || !markHolds(db, mark) || !ensureVecTable(db, key)) return null
  const top = embeddingsMark(db)
  if (top.rowid <= mark.rowid) return { repaired: 0, mark }
  const rows = await modelRows(db, key, mark.rowid, top.rowid)
  if (!rows) return null
  const repaired = await reinsertMissing(
    db,
    key,
    rows.map(r => r.rid),
  )
  return repaired === null ? null : { repaired, mark: top }
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
