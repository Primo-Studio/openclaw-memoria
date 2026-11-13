/**
 * Carte des souvenirs (T28) : lecture/écriture des positions 2D en cache et
 * calcul des fils d'un souvenir. Le calcul lui-même est dans projection.ts.
 *
 * Les positions vivent dans chaque base de contenu (table `fact_projection`),
 * mais elles sortent d'UN SEUL calcul sur toutes les bases : tous les agents
 * partagent le même espace, on peut donc les superposer sur une carte.
 */
import type { ContentStore } from '../storage/content.js'
import { bufferToVector, nowISO } from '../util.js'
import { knn, type VecIndexKey } from '../vector/vec-table.js'

/** Longueur maximale du texte renvoyé avec chaque point (le détail vient au clic). */
const LABEL_MAX = 160

export interface MemoryMapSource {
  store: ContentStore
  /** assistant_instance_id, ou `shared:<id du scope>` pour une base partagée (unique par base). */
  agent: string
}

export interface MemoryMapPoint {
  id: string
  x: number
  y: number
  label: string
  category: string
  agent: string
  created_at: string
  recall_count: number
  pinned: boolean
}

export interface MemoryMapAgent {
  id: string
  /** Type d'assistant (`claude-code`, `codex`…) ou `shared`. */
  type: string
  /** Nom d'affichage : nom de l'agent, ou nom du scope partagé. */
  name: string
  /** Souvenirs placés. Peut valoir 0 : la liste contient TOUTES les sources, pour des couleurs stables. */
  points: number
  /** Souvenirs actifs absents de la carte (pas encore calculés, ou sans vecteur). */
  unplaced: number
}

export interface MemoryMap {
  /**
   * `no-embeddings` : aucun moteur de vecteurs configuré, la carte est impossible.
   * `error` : le dernier calcul a échoué (message dans `error`). Les points du
   * calcul précédent, s'il y en a, sont quand même renvoyés. L'écran ne doit
   * pas redemander en boucle : un nouveau calcul part d'un clic, ou tout seul
   * quand les données ont changé ET qu'un délai minimal est passé depuis l'échec.
   */
  status: 'ready' | 'computing' | 'empty' | 'no-embeddings' | 'error'
  /** Message du dernier calcul en échec (seulement avec `status: 'error'`). */
  error?: string
  model: string | null
  computed_at: string | null
  points: MemoryMapPoint[]
  agents: MemoryMapAgent[]
  unplaced: number
}

export interface MemoryMapLinks {
  id: string
  content: string
  category: string
  agent: string
  created_at: string
  recall_count: number
  entities: string[]
  /** Voisins par le SENS (vecteurs), du plus proche au plus lointain. */
  neighbours: Array<{ id: string; similarity: number }>
  /** Souvenirs qui partagent une entité (personne, outil, projet…) avec celui-ci. */
  related: Array<{ id: string; via: string }>
}

const ACTIVE = "f.superseded = 0 AND f.lifecycle_state = 'active'"

/** Voisins par le sens renvoyés pour un souvenir. */
const NEIGHBOURS = 6
/** Voisins demandés à l'index de chaque base AVANT le filtre des faits actifs (premier essai). */
const NEIGHBOUR_CANDIDATES = 40
/** Plafond de la demande élargie (40, 160, 640, 2 560) : sous la limite de l'index (4 096). */
const NEIGHBOUR_CANDIDATES_MAX = 2560

export function readMapPoints(source: MemoryMapSource, model: string): MemoryMapPoint[] {
  const rows = source.store.db
    .prepare(
      `SELECT f.id, p.x, p.y, f.fact, f.category, f.created_at, f.recall_count, f.pinned
       FROM fact_projection p JOIN facts f ON f.id = p.fact_id
       WHERE p.model = ? AND ${ACTIVE}`,
    )
    .all(model) as Array<{
    id: string
    x: number
    y: number
    fact: string
    category: string
    created_at: string
    recall_count: number
    pinned: number
  }>
  return rows.map(r => ({
    id: r.id,
    x: r.x,
    y: r.y,
    label: r.fact.length > LABEL_MAX ? `${r.fact.slice(0, LABEL_MAX - 1)}…` : r.fact,
    category: r.category,
    agent: source.agent,
    created_at: r.created_at,
    recall_count: r.recall_count,
    pinned: r.pinned === 1,
  }))
}

/** Souvenirs actifs sans position pour ce modèle. */
export function countUnplaced(source: MemoryMapSource, model: string): number {
  const r = source.store.db
    .prepare(
      `SELECT COUNT(*) AS c FROM facts f
       WHERE ${ACTIVE} AND NOT EXISTS (SELECT 1 FROM fact_projection p WHERE p.fact_id = f.id AND p.model = ?)`,
    )
    .get(model) as { c: number }
  return r.c
}

/** Parmi les non placés, ceux qui ONT un vecteur : un recalcul les placerait. */
export function countPlaceable(source: MemoryMapSource, key: VecIndexKey): number {
  const r = source.store.db
    .prepare(
      `SELECT COUNT(*) AS c FROM facts f
       JOIN embeddings e ON e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ? AND e.dimensions = ?
       WHERE ${ACTIVE} AND NOT EXISTS (SELECT 1 FROM fact_projection p WHERE p.fact_id = f.id AND p.model = ?)`,
    )
    .get(key.model, key.dimensions, key.model) as { c: number }
  return r.c
}

export function lastComputedAt(source: MemoryMapSource, model: string): string | null {
  const r = source.store.db.prepare('SELECT MAX(computed_at) AS t FROM fact_projection WHERE model = ?').get(model) as {
    t: string | null
  }
  return r.t
}

/** Souvenirs actifs qui ont un vecteur pour ce modèle, placés ou non. */
export function countVectors(source: MemoryMapSource, key: VecIndexKey): number {
  const r = source.store.db
    .prepare(
      `SELECT COUNT(*) AS c FROM facts f
       JOIN embeddings e ON e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ? AND e.dimensions = ?
       WHERE ${ACTIVE}`,
    )
    .get(key.model, key.dimensions) as { c: number }
  return r.c
}

export interface CollectedVectors {
  /** Pour chaque ligne de `flat` : la source (index) et l'id du fait. */
  owners: Array<{ source: number; id: string }>
  flat: Float32Array
  n: number
  /**
   * Vecteurs lus, y compris ceux écartés (valeur non finie, mauvaise taille).
   * Même grandeur que la somme des `countVectors` : sert à savoir si les
   * données ont changé depuis ce calcul.
   */
  candidates: number
}

function isFiniteVector(vec: Float32Array): boolean {
  for (let i = 0; i < vec.length; i++) if (!Number.isFinite(vec[i]!)) return false
  return true
}

/**
 * Vecteurs de tous les souvenirs actifs de toutes les sources, à plat.
 * La lecture d'une base est synchrone : on rend la main entre deux bases pour
 * que le daemon continue de répondre pendant la collecte (ticket #27).
 */
export async function collectVectors(sources: MemoryMapSource[], key: VecIndexKey): Promise<CollectedVectors> {
  const owners: CollectedVectors['owners'] = []
  const chunks: Float32Array[] = []
  let candidates = 0
  for (const [index, source] of sources.entries()) {
    if (index > 0) await new Promise<void>(resolve => setImmediate(resolve))
    const rows = source.store.db
      .prepare(
        `SELECT e.owner_id AS id, e.vector AS vector FROM embeddings e JOIN facts f ON f.id = e.owner_id
         WHERE e.owner_type = 'fact' AND e.model = ? AND e.dimensions = ? AND ${ACTIVE}
         ORDER BY f.created_at, f.id`,
      )
      .all(key.model, key.dimensions) as Array<{ id: string; vector: Buffer }>
    candidates += rows.length
    for (const row of rows) {
      const vec = bufferToVector(row.vector)
      // Une seule valeur NaN ou infinie fait échouer tout le calcul (débordement
      // de pile dans la projection) : ce souvenir reste « pas encore placé ».
      if (vec.length !== key.dimensions || !isFiniteVector(vec)) continue
      owners.push({ source: index, id: row.id })
      chunks.push(vec)
    }
  }
  const flat = new Float32Array(owners.length * key.dimensions)
  chunks.forEach((vec, i) => flat.set(vec, i * key.dimensions))
  return { owners, flat, n: owners.length, candidates }
}

/**
 * Remplace TOUTES les positions d'une base par celles de ce calcul (une
 * transaction). Les positions d'un ancien modèle partent aussi : elles ne
 * servent plus à rien et rien d'autre ne les supprimerait.
 */
export function writeProjection(
  source: MemoryMapSource,
  model: string,
  rows: Array<{ id: string; x: number; y: number }>,
  computedAt: string = nowISO(),
): void {
  const db = source.store.db
  const insert = db.prepare('INSERT OR REPLACE INTO fact_projection (fact_id, model, x, y, computed_at) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    db.prepare('DELETE FROM fact_projection').run()
    for (const r of rows) insert.run(r.id, model, r.x, r.y, computedAt)
  })()
}

/** Les fils d'un souvenir : voisins par le sens (toutes sources) + entités partagées (sa base). */
export function mapLinks(sources: MemoryMapSource[], key: VecIndexKey, factId: string): MemoryMapLinks | null {
  for (const source of sources) {
    const db = source.store.db
    const fact = db
      // Un fait remplacé ou dormant n'est pas sur la carte : son texte ne sort pas non plus ici.
      .prepare(`SELECT f.id, f.fact, f.category, f.created_at, f.recall_count FROM facts f WHERE f.id = ? AND ${ACTIVE}`)
      .get(factId) as { id: string; fact: string; category: string; created_at: string; recall_count: number } | undefined
    if (!fact) continue

    const entities = (
      db
        .prepare(
          `SELECT e.name FROM fact_entities fe JOIN entities e ON e.id = fe.entity_id
           WHERE fe.fact_id = ? ORDER BY e.mention_count ASC LIMIT 8`,
        )
        .all(factId) as Array<{ name: string }>
    ).map(r => r.name)

    // Entités RARES d'abord : une entité citée partout (« README », une date)
    // relie tout à tout et n'apprend rien.
    const related = db
      .prepare(
        `SELECT fe2.fact_id AS id, e.name AS via FROM fact_entities fe1
         JOIN fact_entities fe2 ON fe2.entity_id = fe1.entity_id AND fe2.fact_id != fe1.fact_id
         JOIN entities e ON e.id = fe1.entity_id
         JOIN facts f ON f.id = fe2.fact_id
         WHERE fe1.fact_id = ? AND ${ACTIVE}
         ORDER BY e.mention_count ASC LIMIT 8`,
      )
      .all(factId) as Array<{ id: string; via: string }>

    const neighbours: MemoryMapLinks['neighbours'] = []
    const own = db
      .prepare("SELECT vector FROM embeddings WHERE owner_type = 'fact' AND owner_id = ? AND model = ? AND dimensions = ?")
      .get(factId, key.model, key.dimensions) as { vector: Buffer } | undefined
    if (own) {
      const query = new Float32Array(bufferToVector(own.vector))
      const hits: Array<{ id: string; distance: number }> = []
      for (const other of sources) {
        // L'index de vecteurs garde les faits remplacés ou dormants (ils n'en
        // sortent qu'à l'effacement définitif) : on demande large, puis on ne
        // garde que les faits actifs, les seuls présents sur la carte. Un
        // souvenir entouré d'un gros lot de dormants (import de quasi-doublons)
        // n'aurait sinon aucun voisin : on redemande plus large, avec un plafond.
        let kept: Array<{ id: string; distance: number }> = []
        for (let k = NEIGHBOUR_CANDIDATES; ; k *= 4) {
          const raw = knn(other.store.db, key, query, k)
          const found = raw.filter(hit => hit.fact_id !== factId)
          const active = new Set(
            found.length === 0
              ? []
              : (
                  other.store.db
                    .prepare(`SELECT f.id FROM facts f WHERE f.id IN (${found.map(() => '?').join(',')}) AND ${ACTIVE}`)
                    .all(...found.map(hit => hit.fact_id)) as Array<{ id: string }>
                ).map(r => r.id),
          )
          kept = found.filter(hit => active.has(hit.fact_id)).map(hit => ({ id: hit.fact_id, distance: hit.distance }))
          // Assez de voisins, index épuisé (moins de k lignes), ou plafond atteint.
          if (kept.length >= NEIGHBOURS || raw.length < k || k >= NEIGHBOUR_CANDIDATES_MAX) break
        }
        hits.push(...kept)
      }
      hits.sort((a, b) => a.distance - b.distance)
      for (const hit of hits.slice(0, NEIGHBOURS)) {
        // Vecteurs unitaires, distance L2 : similarité cosinus = 1 - d²/2.
        const similarity = Math.max(0, Math.min(1, 1 - (hit.distance * hit.distance) / 2))
        neighbours.push({ id: hit.id, similarity: Math.round(similarity * 1000) / 1000 })
      }
    }

    return {
      id: fact.id,
      content: fact.fact,
      category: fact.category,
      agent: source.agent,
      created_at: fact.created_at,
      recall_count: fact.recall_count,
      entities,
      neighbours,
      related,
    }
  }
  return null
}
