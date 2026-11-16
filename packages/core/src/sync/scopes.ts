/**
 * Quels espaces la synchro a le droit de faire voyager, et comment un espace
 * change d'identifiant sans rien perdre (reprise de l'identité du hub).
 *
 * Règle d'équipe : seuls les espaces d'ÉQUIPE partent vers les Mac reliés.
 * L'espace `user` (personnel au propriétaire), les mémoires privées des agents
 * et la quarantaine de revue ne sont JAMAIS servis ni acceptés d'un pair.
 */
import type { Database } from 'better-sqlite3'

/** Types qui ne voyagent jamais, quelle que soit la config (ni envoi, ni réception, ni reprise). */
export const SYNC_FORBIDDEN_TYPES: readonly string[] = ['user', 'private', 'legacy_to_review']

/**
 * Types qu'un hub peut proposer à ses pairs. `client` n'y est pas : un fait
 * marqué d'un client ne se synchronise pas (l'isolation client ne survivrait
 * pas au voyage, les identifiants d'organisation diffèrent d'un Mac à l'autre).
 */
export const SYNC_ALLOWED_TYPES: readonly string[] = ['org', 'project', 'shared_topic']

/** Espaces synchronisés par défaut : l'espace d'équipe seulement. */
export const SYNC_DEFAULT_TYPES: readonly string[] = ['org']

/** Erreur de configuration de synchro (type d'espace refusé, inconnu…). */
export class SyncScopeError extends Error {}

/**
 * Valide une liste de types d'espaces (option `--scopes`, config `[sync].scopes`).
 * Vide ou absente → défaut (`org`). Un type interdit ou inconnu → erreur claire,
 * jamais un repli silencieux qui ferait partir plus que prévu.
 */
export function normalizeSyncTypes(input?: readonly string[] | string | null): string[] {
  const raw = typeof input === 'string' ? input.split(',') : (input ?? [])
  const types = [...new Set(raw.map(t => String(t).trim()).filter(t => t.length > 0))]
  if (types.length === 0) return [...SYNC_DEFAULT_TYPES]
  for (const t of types) {
    if (SYNC_FORBIDDEN_TYPES.includes(t)) {
      throw new SyncScopeError(`l'espace « ${t} » ne se synchronise jamais (personnel ou privé) : seuls ${SYNC_ALLOWED_TYPES.join(', ')} sont possibles`)
    }
    if (!SYNC_ALLOWED_TYPES.includes(t)) {
      throw new SyncScopeError(`type d'espace inconnu pour la synchro : « ${t} » (possibles : ${SYNC_ALLOWED_TYPES.join(', ')})`)
    }
  }
  return types
}

/**
 * Liste blanche effective d'une config de synchro. Une config ancienne qui
 * contient encore `user` (défaut d'avant) est filtrée ici : les types interdits
 * ne passent jamais, même écrits à la main dans le fichier.
 */
export function effectiveSyncTypes(configured?: readonly string[] | null): string[] {
  const list = configured && configured.length > 0 ? configured : SYNC_DEFAULT_TYPES
  return list.filter(t => SYNC_ALLOWED_TYPES.includes(t))
}

/** Colonnes qui portent un identifiant d'espace : `scope_id` et `*_scope_id`. */
function isScopeColumn(name: string): boolean {
  return name === 'scope_id' || name.endsWith('_scope_id')
}

/**
 * Repointe, dans UNE base, toutes les colonnes qui renvoient à l'espace `fromId`
 * vers `toId`. Lecture du schéma réel (sqlite_master) : une table ajoutée plus
 * tard est prise en compte sans y penser. Les tables virtuelles (FTS, vecteurs)
 * sont sautées : elles n'ont pas de telle colonne, et lire le schéma d'une table
 * vec0 sans son extension échouerait. `UPDATE OR REPLACE` : une ligne laissée
 * par un essai précédent sous `toId` ne bloque pas le déplacement.
 * À appeler DANS une transaction de l'appelant. Renvoie le nombre de lignes déplacées.
 */
export function repointScopeColumns(db: Database, fromId: string, toId: string, exclude: readonly string[] = []): number {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; sql: string | null }>
  let moved = 0
  for (const t of tables) {
    if (exclude.includes(t.name)) continue
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? '')) continue
    const cols = (db.pragma(`table_info("${t.name.replaceAll('"', '""')}")`) as Array<{ name: string }>).map(c => c.name)
    for (const col of cols.filter(isScopeColumn)) {
      moved += db.prepare(`UPDATE OR REPLACE "${t.name.replaceAll('"', '""')}" SET "${col}" = ? WHERE "${col}" = ?`).run(toId, fromId).changes
    }
  }
  return moved
}

/** Remplace un identifiant dans un tableau JSON stocké en texte (`allowed_scopes`, `default_scopes`). */
export function replaceInJsonList(raw: string | null | undefined, fromId: string, toId: string): string | null {
  if (!raw) return null
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(list) || !list.includes(fromId)) return null
  return JSON.stringify([...new Set(list.map(x => (x === fromId ? toId : x)))])
}
