/**
 * NIVEAU DE VÉRITÉ d'un souvenir (retours bêta).
 *
 * « Marquer explicitement dit par l'utilisateur / observé / déduit par l'agent /
 * vérifié — c'est important pour éviter qu'une hypothèse ou une ancienne erreur
 * devienne une instruction durable. »
 *
 * On DÉRIVE le niveau des colonnes existantes plutôt que d'ajouter un champ à
 * remplir : la matière est déjà là (`source`, `fact_type`, poids d'usage), et un
 * champ de plus serait un champ de plus à tenir à jour — donc à laisser pourrir.
 *
 * ⚠ Limite assumée : on ne distingue PAS « dit par l'utilisateur » de « dit par
 * l'assistant ». Le rôle du message d'origine n'est pas conservé sur le fait
 * (seul le WAL l'a, et il est purgé). Prétendre le contraire serait afficher une
 * garantie qu'on ne peut pas tenir. `extracted` couvre donc les deux.
 */

export type FactOrigin =
  /** Posé explicitement (storeFact, import manuel) — la source la plus sûre. */
  | 'declared'
  /** Extrait d'une conversation par le LLM — fidèle au dit, mais reformulé. */
  | 'extracted'
  /** DÉDUIT par l'agent (motif récurrent, regroupement) — personne ne l'a dit. */
  | 'inferred'
  /** Extrait ou déduit, puis CONFIRMÉ par l'usage réel (a servi à répondre). */
  | 'confirmed'

export interface OriginInput {
  source: string
  fact_type: string
  used_count: number
  relevance_weight: number
}

/** Préfixes de `source` posés par les couches cognitives (jamais un énoncé reçu). */
const INFERRED_PREFIXES = ['cluster:', 'pattern:', 'observation:', 'dialectic:']

/**
 * Niveau de vérité d'un fait.
 *
 * L'ordre compte : la confirmation par l'usage PRIME sur l'origine, car un fait
 * déduit qui a réellement servi à répondre vaut mieux qu'un fait extrait jamais
 * utilisé. Mais elle ne s'applique pas à `declared`, déjà au plus haut.
 */
export function factOrigin(row: OriginInput): FactOrigin {
  const source = (row.source ?? '').toLowerCase()
  const inferred = INFERRED_PREFIXES.some(p => source.startsWith(p)) || row.fact_type === 'cluster' || row.fact_type === 'pattern'
  const declared = source === 'manual' || source === 'capture' || source === 'import'

  if (declared) return 'declared'
  // « Confirmé » = le feedback l'a fait remonter (relevance_weight > 1 n'est
  // atteint QUE par reinforce(used:true)) ET il a réellement servi.
  if (row.used_count > 0 && row.relevance_weight > 1) return 'confirmed'
  return inferred ? 'inferred' : 'extracted'
}

/** Étiquette courte destinée au prompt de l'agent (anglais, cf. issue #1). */
export function originLabel(origin: FactOrigin): string {
  switch (origin) {
    case 'declared':
      return 'stated'
    case 'confirmed':
      return 'confirmed by use'
    case 'inferred':
      return 'inferred by the agent'
    default:
      return 'extracted from a conversation'
  }
}

/**
 * Vrai si le souvenir mérite d'être lu avec prudence : personne ne l'a jamais
 * énoncé, l'agent l'a déduit. C'est exactement le cas où une hypothèse risque
 * d'être appliquée comme une règle.
 */
export function needsCaution(origin: FactOrigin): boolean {
  return origin === 'inferred'
}
