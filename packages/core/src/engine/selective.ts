/**
 * Selective — dédup AVANT stockage, PAR SCOPE (spec §6.2 étape 4).
 * Corrige le legacy SEL-2 : les faits dormants participent au dedup
 * (l'ancien searchFacts filtrait `lifecycle_state != 'dormant'`, donc un
 * doublon d'un fait dormant était re-stocké en double).
 */
import { rowToFact, type ContentStore, type FactRow } from '../storage/content.js'
import type { Fact } from '../types.js'
import { factNormHash, normalizeFact } from '../util.js'

export interface DuplicateMatch {
  kind: 'exact' | 'near'
  existing: Fact
}

/** Seuil Jaccard au-delà duquel deux faits sont considérés near-dup. */
const NEAR_DUP_JACCARD = 0.85
/** Candidats FTS examinés pour le near-dup (0 appel LLM — heuristique pure). */
const NEAR_DUP_CANDIDATES = 3

export { normalizeFact }

export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Complète `norm_hash` sur des lignes qui ne l'ont pas. UNE transaction et UNE
 * instruction préparée pour tout le lot : avec un commit par ligne, le
 * rattrapage d'un scope hérité (des dizaines de milliers de lignes) bloquait
 * le thread du daemon plusieurs secondes. Tout ou rien : si la base refuse
 * l'écriture (lecture seule), on abandonne au premier échec au lieu de tenter
 * N écritures ; la recherche reste correcte, juste plus lente.
 */
function backfillNormHash(store: ContentStore, rows: readonly FactRow[]): void {
  if (rows.length === 0) return
  try {
    // `AND norm_hash IS NULL` : ne jamais écraser un hash posé entre-temps.
    const setHash = store.db.prepare('UPDATE facts SET norm_hash = ? WHERE id = ? AND norm_hash IS NULL')
    store.db.transaction(() => {
      for (const row of rows) setHash.run(factNormHash(row.fact), row.id)
    })()
  } catch {
    /* écriture impossible : les lignes restent sans hash, le balayage les couvre */
  }
}

/**
 * Cherche un doublon de `factText` dans le scope `scopeId` de la DB `store` :
 *  (a) égalité exacte sur texte normalisé — TOUS les états lifecycle (dormants inclus) ;
 *  (b) near-dup : top-3 FTS du scope puis similarité Jaccard sur tokens > 0.85.
 * Retourne null si aucun doublon. Aucun appel LLM.
 */
export function findDuplicate(
  store: ContentStore,
  scopeId: string,
  factText: string,
  opts: { nearDup?: boolean } = {},
): DuplicateMatch | null {
  const normalized = normalizeFact(factText)
  if (!normalized) return null

  // (a) exact — non superseded, dormants/archivés INCLUS. Lecture d'INDEX sur
  // le hash du texte normalisé (facts.norm_hash) : l'ancien balayage complet du
  // scope, refait pour chaque fait candidat, figeait le daemon dès qu'un scope
  // devenait massif (67 000 lignes en file de revue, ticket #27).
  const hashed = store.db
    .prepare('SELECT * FROM facts WHERE scope_id = ? AND norm_hash = ? AND superseded = 0 ORDER BY rowid')
    .all(scopeId, factNormHash(factText)) as FactRow[]
  for (const row of hashed) {
    if (normalizeFact(row.fact) === normalized) return { kind: 'exact', existing: rowToFact(row) }
  }
  // Lignes SANS hash (chemin d'écriture qui ne le pose pas, ou texte modifié
  // hors des chemins connus) : balayées comme avant, et complétées au passage
  // pour ne l'être qu'une fois.
  const unhashed = store.db
    .prepare('SELECT * FROM facts WHERE scope_id = ? AND norm_hash IS NULL ORDER BY rowid')
    .all(scopeId) as FactRow[]
  let found: FactRow | null = null
  for (const row of unhashed) {
    if (row.superseded === 0 && normalizeFact(row.fact) === normalized) {
      found = row
      break
    }
  }
  backfillNormHash(store, unhashed)
  if (found) return { kind: 'exact', existing: rowToFact(found) }

  // (b) near-dup — FTS borné au scope, dormants inclus, sensibilité non filtrée
  // (le dedup est interne : il n'expose pas de contenu au lecteur).
  // Désactivable : une CORRECTION est par nature proche de l'original — la
  // prendre pour un doublon la ferait disparaître (correctFact). Idem pour une
  // DÉCLARATION explicite (storeFact) : « 13 octobre » → « 14 octobre » n'est
  // pas une redite, c'est une autre information. Seule la capture le garde.
  if (opts.nearDup === false) return null
  const tokens = new Set(normalized.split(' '))
  const hits = store.searchFacts(factText, {
    limit: NEAR_DUP_CANDIDATES,
    includeDormant: true,
    maxSensitivity: 'critical',
    scopeIds: [scopeId],
  })
  for (const hit of hits) {
    const candidate = new Set(normalizeFact(hit.row.fact).split(' '))
    if (jaccardSimilarity(tokens, candidate) > NEAR_DUP_JACCARD) {
      return { kind: 'near', existing: rowToFact(hit.row) }
    }
  }
  return null
}
