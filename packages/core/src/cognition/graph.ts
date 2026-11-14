/**
 * Graphe entité→relations (couche 5 legacy, portée propre, bucket B async).
 *
 * Modèle (décision GE-5) : UNE seule implémentation, arête NON-dirigée, 1 ligne
 * par paire (invariant `from_entity < to_entity`), poids ∈ [0,1] cap 1.0,
 * renforcement +0.1 par co-occurrence. La double implémentation Hebbian
 * (dirigée, cap 2.0, doublons) est JETÉE.
 *
 * Anti-fuite (le risque #1 du portage) : l'expansion au recall ne suit pas les
 * arêtes `relations`. Une arête naît de la co-occurrence dans N'IMPORTE QUEL
 * fait, y compris un fait que l'appelant ne peut pas lire (critical, autre
 * client, expiré, supersédé, oublié, dormant) : la suivre trahissait
 * l'association que ce fait porte. L'expansion va de fait LISIBLE en fait
 * LISIBLE par une entité qu'ils citent tous deux (`fact_entities`), avec les
 * mêmes filtres durs que la recherche (§6.1, benchmark §16 : fuite = 0).
 *
 * Liens fait↔entité via la table de jointure `fact_entities` (remplace le
 * `entity_ids LIKE` fragile, GE-3). Pas de colonne `status` : l'état actif d'un
 * fait = `superseded = 0` ; une arête vit par son poids (decay/prune).
 */
import type { Database, Statement } from 'better-sqlite3'
import { newId, nowISO } from '../util.js'
import type { RelationType } from './entities.js'

export interface RelationRow {
  id: string
  from_entity: string
  to_entity: string
  kind: string
  weight: number
  context: string
  created_at: string
  last_accessed_at: string
}

export interface DecayConfig {
  /** Facteur de decay par jour (défaut 0.995 ≈ -0.5 %/jour). */
  decayPerDay: number
  /** Poids minimal sous lequel l'arête est élaguée (défaut 0.05). */
  pruneThreshold: number
}

export const DEFAULT_DECAY: DecayConfig = { decayPerDay: 0.995, pruneThreshold: 0.05 }

const WEIGHT_INCREMENT = 0.1
const WEIGHT_CAP = 1.0
const INITIAL_WEIGHT = 0.5
const CONTEXT_CAP = 20

/** Ordonne la paire (invariant non-dirigé) : la plus petite id en premier. */
function orderedPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a]
}

/**
 * Upsert d'une relation entre deux entités (par fait justificatif). Non-dirigée :
 * la paire est ordonnée → 1 SEULE ligne quel que soit l'ordre d'extraction.
 * Renforce le poids (cap 1.0) et accumule le fait dans le context (cappé 20).
 * Self-loop (a === b) ignoré.
 */
export function upsertRelation(
  db: Database,
  entityA: string,
  entityB: string,
  kind: RelationType,
  factId: string,
): void {
  if (entityA === entityB) return
  const [from, to] = orderedPair(entityA, entityB)
  const ts = nowISO()
  const existing = db
    .prepare('SELECT id, context FROM relations WHERE from_entity = ? AND to_entity = ?')
    .get(from, to) as { id: string; context: string } | undefined

  if (existing) {
    const context = appendContext(existing.context, factId)
    db.prepare(
      'UPDATE relations SET weight = MIN(weight + ?, ?), last_accessed_at = ?, context = ? WHERE id = ?',
    ).run(WEIGHT_INCREMENT, WEIGHT_CAP, ts, context, existing.id)
  } else {
    db.prepare(
      `INSERT INTO relations (id, from_entity, to_entity, kind, weight, context, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), from, to, kind, INITIAL_WEIGHT, JSON.stringify([factId]), ts, ts)
  }
}

/** Lie un fait à une entité (idempotent via PK composite). */
export function linkFactEntity(db: Database, factId: string, entityId: string): void {
  db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, ?)').run(factId, entityId)
}

/**
 * Renforce TOUTES les paires d'un ensemble d'entités co-occurrentes dans un
 * même fait (Hebbian « fire together, wire together »). Corrige GE-1 : on
 * utilise les ids FRAÎCHEMENT extraits, le chemin s'exécute réellement.
 */
export function reinforceCooccurrence(db: Database, entityIds: string[], factId: string): void {
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      upsertRelation(db, entityIds[i]!, entityIds[j]!, 'related_to', factId)
    }
  }
}

/**
 * Une entité citée par plus de faits que cela relie tout à tout (le nom de
 * l'utilisateur, de sa société) : l'expansion ne la suit pas. Même seuil que
 * les voisins `links` du rappel (LINK_MAX_MENTIONS).
 *
 * Le compte porte sur TOUTES les citations, faits cachés compris, et il est
 * lu dans l'index seul. Un fait caché peut donc faire d'une entité un hub et
 * retirer les liens qui passent par elle. Il ne peut jamais justifier un lien :
 * chaque lien rendu relie deux faits lisibles. En échange, la lecture reste
 * bornée à 31 lignes d'index par entité, même quand des milliers de faits
 * dormants la citent (un compte sur les seuls faits lisibles devait, lui,
 * relire chacun de ces faits).
 */
export const GRAPH_HUB_MAX_FACTS = 30
/**
 * Entités examinées au plus par expansion (hubs compris), germes compris.
 * L'expansion est synchrone, sur le chemin de la réponse : avec le seuil des
 * hubs, cela borne la lecture à 64 × 30 lignes, quelle que soit la base.
 */
const GRAPH_MAX_ENTITIES = 64
/** Faits atteints au plus : borne le front du saut suivant. */
const GRAPH_MAX_CANDIDATES = 200

/** Ce que l'appelant pourrait lui-même rappeler : l'expansion ne voit rien d'autre. */
export interface GraphFactFilter {
  /** Scopes lisibles dans cette base. */
  scopeIds: readonly string[]
  /**
   * Client du contexte actif. Un fait rattaché à un AUTRE client n'existe pas
   * pour l'expansion. Absent : seuls les faits sans client passent (même règle
   * que passesClientIsolation).
   */
  clientOrgId?: string | null
  /** Instant de référence pour l'expiration (ms, défaut maintenant). */
  now?: number
}

/**
 * Filtres durs de la recherche directe (searchFacts + isolation client), sauf
 * l'expiration. Celle-ci est jugée en JS avec Date.parse, comme partout dans le
 * rappel : en SQL, la date serait comparée comme du texte, et « Jan 1 2020 »
 * ou un décalage +05:00 paraîtraient vivants. Un tel fait servirait de pont.
 */
const READABLE_SQL = `f.superseded = 0 AND f.lifecycle_state = 'active' AND f.sensitivity IN ('normal','sensitive')
  AND f.scope_id IN (SELECT value FROM json_each(@scopes))
  AND (f.client_org_id IS NULL OR f.client_org_id = '' OR f.client_org_id = @client)`

interface GraphStatements {
  readable: Statement
  entitiesOf: Statement
  mentions: Statement
  factsOf: Statement
  names: Statement
}

/**
 * Instructions préparées UNE fois par connexion : les listes passent en JSON
 * (`json_each`), donc le texte SQL ne dépend ni du nombre de germes ni du
 * nombre de scopes.
 *
 * CROSS JOIN fixe l'ordre de lecture : liste d'ids, puis jointure, puis le
 * fait par sa clé. Sans lui, SQLite préférait l'index idx_facts_lifecycle et
 * parcourait TOUS les faits actifs à chaque rappel (47 à 64 ms sur 20 000 faits).
 */
const statementsByDb = new WeakMap<Database, GraphStatements>()

function graphStatements(db: Database): GraphStatements {
  let st = statementsByDb.get(db)
  if (!st) {
    st = {
      readable: db.prepare(
        `SELECT f.id, f.expires_at FROM json_each(@ids) j CROSS JOIN facts f ON f.id = j.value WHERE ${READABLE_SQL}`,
      ),
      entitiesOf: db.prepare('SELECT fact_id, entity_id FROM fact_entities WHERE fact_id IN (SELECT value FROM json_each(@ids))'),
      // LIMIT dans la sous-requête : on s'arrête au premier fait au-delà du seuil.
      mentions: db.prepare(
        `SELECT j.value AS entity_id,
                (SELECT COUNT(*) FROM (SELECT 1 FROM fact_entities fe WHERE fe.entity_id = j.value LIMIT @cap)) AS n
         FROM json_each(@ids) j`,
      ),
      factsOf: db.prepare(
        `SELECT fe.entity_id, f.id, f.expires_at, f.created_at
         FROM json_each(@ids) j CROSS JOIN fact_entities fe ON fe.entity_id = j.value CROSS JOIN facts f ON f.id = fe.fact_id
         WHERE ${READABLE_SQL}`,
      ),
      names: db.prepare('SELECT id, name FROM entities WHERE id IN (SELECT value FROM json_each(@ids))'),
    }
    statementsByDb.set(db, st)
  }
  return st
}

interface Reach {
  hops: number
  /** Entité partagée avec le front qui explique le lien (la plus rare). */
  via: string
  /** Faits lisibles qui citent `via` : moins il y en a, plus le lien est parlant. */
  viaFacts: number
  /** Entités partagées avec le front au même saut. */
  shared: number
  created_at: string
}

/** Ordre d'un voisin : saut, puis entités partagées, rareté du lien, récence, id (stable d'un rappel à l'autre). */
function compareReach(a: [string, Reach], b: [string, Reach]): number {
  const [ida, ra] = a
  const [idb, rb] = b
  return (
    ra.hops - rb.hops ||
    rb.shared - ra.shared ||
    ra.viaFacts - rb.viaFacts ||
    (rb.created_at < ra.created_at ? -1 : rb.created_at > ra.created_at ? 1 : 0) ||
    (ida < idb ? -1 : ida > idb ? 1 : 0)
  )
}

/**
 * EXPANSION au recall (étape 4 du pipeline §6.1). Germes → leurs entités →
 * faits LISIBLES qui citent aussi ces entités → leurs entités → saut suivant
 * (`maxHops`, 2 par défaut). Chaque fait traversé, pont compris, passe le
 * filtre de l'appelant : aucun lien ne peut venir d'un fait qu'il ne pourrait
 * pas rappeler. Les arêtes `relations` ne sont pas lues.
 *
 * Retourne des fact_ids (PAS le contenu) : l'appelant les relit lui-même.
 *
 * `via_entity` : nom de l'entité que le voisin partage avec le fait qui l'a
 * amené (un germe au premier saut, le pont au second). Sans elle, le rappel ne
 * peut pas expliquer pourquoi un fait sans aucun mot de la requête est remonté.
 *
 * Score : 0,5 au premier saut, 0,25 au second. Il ne dépend que du saut, donc
 * quand le premier saut remplit déjà `maxFacts`, le second n'est pas calculé.
 */
export function expandByEntities(
  db: Database,
  seedFactIds: string[],
  filter: GraphFactFilter,
  opts: { maxHops?: number; maxFacts?: number } = {},
): Array<{ fact_id: string; score: number; hops: number; via_entity?: string }> {
  const maxHops = opts.maxHops ?? 2
  const maxFacts = opts.maxFacts ?? 5
  if (seedFactIds.length === 0 || filter.scopeIds.length === 0 || maxHops < 1 || maxFacts < 1) return []
  const st = graphStatements(db)
  const now = filter.now ?? Date.now()
  const scope = { scopes: JSON.stringify(filter.scopeIds), client: filter.clientOrgId ?? null }
  // Même règle que passesRecallHardFilters : une date illisible n'expire pas.
  const alive = (r: { expires_at: string | null }): boolean => !(r.expires_at && Date.parse(r.expires_at) <= now)

  // Germes : seulement ceux que l'appelant pourrait lui-même rappeler.
  const unique = [...new Set(seedFactIds)]
  const readable = st.readable.all({ ...scope, ids: JSON.stringify(unique) }) as Array<{ id: string; expires_at: string | null }>
  const seeds = new Set(readable.filter(alive).map(r => r.id))
  let frontier = unique.filter(id => seeds.has(id))

  const visited = new Set<string>()
  const reached = new Map<string, Reach>()
  let budget = GRAPH_MAX_ENTITIES

  for (let hop = 1; hop <= maxHops && frontier.length > 0 && budget > 0; hop++) {
    // Entités du front, les meilleurs faits d'abord : si le budget coupe, il
    // coupe les liens les moins pertinents.
    const rank = new Map(frontier.map((id, i) => [id, i]))
    const links = (st.entitiesOf.all({ ids: JSON.stringify(frontier) }) as Array<{ fact_id: string; entity_id: string }>).sort(
      (a, b) => rank.get(a.fact_id)! - rank.get(b.fact_id)! || (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0),
    )
    const fresh: string[] = []
    for (const { entity_id } of links) {
      if (fresh.length >= budget) break
      if (visited.has(entity_id)) continue
      visited.add(entity_id)
      fresh.push(entity_id)
    }
    budget -= fresh.length
    if (fresh.length === 0) break

    const counts = st.mentions.all({ ids: JSON.stringify(fresh), cap: GRAPH_HUB_MAX_FACTS + 1 }) as Array<{ entity_id: string; n: number }>
    const followed = counts.filter(c => c.n <= GRAPH_HUB_MAX_FACTS).map(c => c.entity_id)
    // Que des hubs : aucun fait atteint, donc aucun front pour le saut suivant.
    if (followed.length === 0) break

    const rows = (
      st.factsOf.all({ ...scope, ids: JSON.stringify(followed) }) as Array<{
        entity_id: string
        id: string
        expires_at: string | null
        created_at: string
      }>
    ).filter(alive)
    const perEntity = new Map<string, number>()
    for (const r of rows) perEntity.set(r.entity_id, (perEntity.get(r.entity_id) ?? 0) + 1)

    const next: string[] = []
    for (const r of rows) {
      if (seeds.has(r.id)) continue
      const n = perEntity.get(r.entity_id)!
      const prev = reached.get(r.id)
      if (!prev) {
        if (reached.size >= GRAPH_MAX_CANDIDATES) continue
        reached.set(r.id, { hops: hop, via: r.entity_id, viaFacts: n, shared: 1, created_at: r.created_at })
        next.push(r.id)
      } else if (prev.hops === hop) {
        prev.shared++
        if (n < prev.viaFacts || (n === prev.viaFacts && r.entity_id < prev.via)) {
          prev.via = r.entity_id
          prev.viaFacts = n
        }
      }
      // Atteint à un saut plus court : ce chemin-là est déjà le meilleur.
    }
    frontier = next
      .map(id => [id, reached.get(id)!] as [string, Reach])
      .sort(compareReach)
      .map(([id]) => id)
    // Le saut suivant ne donnerait que des scores plus bas que ceux déjà en main.
    if (reached.size >= maxFacts) break
  }

  const top = [...reached.entries()].sort(compareReach).slice(0, maxFacts)
  // Noms des entités de passage : une seule requête, sur les seuls voisins gardés.
  const names = new Map<string, string>()
  if (top.length > 0) {
    const viaIds = [...new Set(top.map(([, r]) => r.via))]
    for (const r of st.names.all({ ids: JSON.stringify(viaIds) }) as Array<{ id: string; name: string }>) names.set(r.id, r.name)
  }
  return top.map(([fact_id, r]) => {
    const base = { fact_id, score: 0.5 ** r.hops, hops: r.hops }
    const name = names.get(r.via)
    return name ? { ...base, via_entity: name } : base
  })
}

/**
 * DECAY (corrige GE-2 : jamais branché dans le legacy). À déclencher en job
 * quotidien daemon. Affaiblit les arêtes selon le temps depuis le dernier
 * accès ; élague celles sous le seuil. Retourne {decayed, pruned}.
 */
export function applyDecay(db: Database, config: DecayConfig = DEFAULT_DECAY, now = Date.now()): {
  decayed: number
  pruned: number
} {
  const rows = db.prepare('SELECT id, weight, last_accessed_at, created_at FROM relations').all() as Array<{
    id: string
    weight: number
    last_accessed_at: string
    created_at: string
  }>
  const update = db.prepare('UPDATE relations SET weight = ? WHERE id = ?')
  const remove = db.prepare('DELETE FROM relations WHERE id = ?')
  let decayed = 0
  let pruned = 0
  const tx = db.transaction(() => {
    for (const rel of rows) {
      const ref = Date.parse(rel.last_accessed_at || rel.created_at)
      const days = Number.isNaN(ref) ? 0 : Math.max(0, (now - ref) / 86_400_000)
      const decayedWeight = rel.weight * Math.pow(config.decayPerDay, days)
      if (decayedWeight < config.pruneThreshold) {
        remove.run(rel.id)
        pruned++
      } else if (decayedWeight < rel.weight) {
        update.run(decayedWeight, rel.id)
        decayed++
      }
    }
  })
  tx()
  return { decayed, pruned }
}

/**
 * Sur supersession d'un fait : le retire du context des relations qu'il
 * justifiait ; relation au context vidé → supprimée, sinon affaiblie
 * (-0.15, plancher 0.1). Retire aussi ses liens fact_entities. Idempotent.
 */
export function onFactSuperseded(db: Database, factId: string): number {
  let affected = 0
  const tx = db.transaction(() => {
    const rels = db
      .prepare('SELECT id, context FROM relations WHERE context LIKE ?')
      .all(`%${factId}%`) as Array<{ id: string; context: string }>
    for (const rel of rels) {
      let ctx: string[]
      try {
        const parsed: unknown = JSON.parse(rel.context || '[]')
        ctx = Array.isArray(parsed) ? parsed.map(String) : []
      } catch {
        ctx = []
      }
      if (!ctx.includes(factId)) continue
      const updated = ctx.filter(id => id !== factId)
      if (updated.length === 0) {
        db.prepare('DELETE FROM relations WHERE id = ?').run(rel.id)
      } else {
        db.prepare('UPDATE relations SET context = ?, weight = MAX(weight - 0.15, 0.1) WHERE id = ?').run(
          JSON.stringify(updated),
          rel.id,
        )
      }
      affected++
    }
    // Une apparition par lien : le fait remplacé ne compte plus.
    db.prepare(
      'UPDATE entities SET mention_count = MAX(mention_count - 1, 0) WHERE id IN (SELECT entity_id FROM fact_entities WHERE fact_id = ?)',
    ).run(factId)
    db.prepare('DELETE FROM fact_entities WHERE fact_id = ?').run(factId)
  })
  tx()
  return affected
}

export interface GraphStats {
  entities: number
  relations: number
  avg_weight: number
}

export function graphStats(db: Database): GraphStats {
  const e = (db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c
  const r = db.prepare('SELECT COUNT(*) AS c, AVG(weight) AS avg FROM relations').get() as {
    c: number
    avg: number | null
  }
  return { entities: e, relations: r.c, avg_weight: r.avg ?? 0 }
}

function appendContext(existing: string, factId: string): string {
  let arr: string[]
  try {
    const parsed: unknown = JSON.parse(existing || '[]')
    arr = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    arr = []
  }
  if (!arr.includes(factId)) arr.push(factId)
  return JSON.stringify(arr.slice(-CONTEXT_CAP))
}
