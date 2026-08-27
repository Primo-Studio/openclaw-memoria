/**
 * Tri de tableau — règle partagée (Journal) : re-cliquer la colonne active
 * inverse le sens ; une nouvelle colonne repart en « récent d'abord » pour une
 * date, « A→Z » pour du texte. Fonction PURE, testée hors DOM.
 */
export type SortDir = 'asc' | 'desc'

export interface SortState<K extends string> {
  key: K
  dir: SortDir
}

export function nextSort<K extends string>(current: SortState<K>, key: K, dateKeys: readonly K[]): SortState<K> {
  if (key === current.key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: dateKeys.includes(key) ? 'desc' : 'asc' }
}

/** Valeur aria-sort d'un en-tête (none = colonne non active). */
export function ariaSort<K extends string>(current: SortState<K>, key: K): 'ascending' | 'descending' | 'none' {
  if (key !== current.key) return 'none'
  return current.dir === 'asc' ? 'ascending' : 'descending'
}
