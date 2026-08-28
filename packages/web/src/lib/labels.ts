/**
 * Libellés lisibles pour les valeurs qui viennent de la base (catégorie d'un
 * souvenir, thèmes auto-générés).
 *
 * POURQUOI un fichier à part : ce sont des fonctions PURES, réutilisées par
 * tous les écrans qui affichent un souvenir (Mémoire, Revue, et plus tard
 * Thèmes et Maintenance). `components/ui.tsx` est le point d'entrée des
 * primitives visuelles, pas des règles de vocabulaire.
 */

type Translate = (key: string, vars?: Record<string, string | number>) => string

/**
 * Catégories connues : celles que demande le moteur d'extraction
 * (core/engine/capture.ts) + celles héritées de la v3.34
 * (core/cognition/markdown-sync.ts).
 *
 * POURQUOI une liste explicite : une catégorie inconnue doit s'afficher telle
 * quelle. Sans cette garde, `t()` renverrait la CLÉ (« fact.category.machin »),
 * ce qui est pire que le mot anglais qu'on cherche à traduire.
 */
const KNOWN_CATEGORIES = new Set([
  'general',
  'preference',
  'decision',
  'config',
  'process',
  'error',
  'erreur',
  'savoir',
  'outil',
  'client',
  'rh',
  'chronologie',
  'identity',
  'statement',
])

/** « preference » → « Préférence » ; une valeur inconnue est rendue telle quelle. */
export function categoryLabel(t: Translate, value: string | undefined | null): string {
  const raw = (value ?? '').trim()
  const key = raw.toLowerCase()
  return KNOWN_CATEGORIES.has(key) ? t(`fact.category.${key}`) : raw
}

/**
 * Thèmes affichés sur une carte de souvenir. Au-delà de {max}, la ligne de
 * métadonnées devient un mur de pastilles et le souvenir lui-même — le seul
 * texte qui compte — passe au second plan. Le reste est résumé en « +N ».
 */
export const MAX_VISIBLE_TOPICS = 3

export function splitTopics(topics: string[] | undefined | null, max = MAX_VISIBLE_TOPICS): { shown: string[]; hidden: string[] } {
  const all = topics ?? []
  if (all.length <= max) return { shown: all, hidden: [] }
  return { shown: all.slice(0, max), hidden: all.slice(max) }
}
