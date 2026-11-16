/**
 * Curseur fiable de la synchro : un NUMÉRO D'ORDRE local, croissant, posé sur
 * chaque fait créé, modifié ou appliqué dans un espace synchronisé.
 *
 * Avant, les pairs reprenaient d'après `updated_at`, qui est la date d'ORIGINE
 * du fait (horloge de la machine qui l'a écrit). Un fait poussé en retard par
 * un 3e Mac arrivait sur le hub avec une date antérieure au curseur des autres :
 * ils ne le recevaient jamais. Le numéro, lui, est attribué par la base qui
 * sert (le hub pour la réception, le Mac lui-même pour son envoi) au moment de
 * l'écriture : un fait appliqué plus tard a toujours un numéro plus grand.
 *
 * Le numéro ne REDESCEND jamais (AUTOINCREMENT : SQLite garde le plus haut
 * attribué dans `sqlite_sequence`, même quand sa ligne disparaît). La première
 * version reprenait `MAX(seq) + 1` après avoir retiré la ligne du fait : une
 * modification du fait le plus récent retrouvait SON numéro, et le fait écrit
 * après l'oubli du plus récent reprenait celui de l'oublié. Les pairs, déjà à
 * ce numéro, ne les recevaient jamais (expiration, correction, fait neuf perdus).
 *
 * Coût : la table et ses déclencheurs ne sont créés qu'à la demande, par le
 * moteur de synchro, et seulement dans les bases PARTAGÉES qu'il touche
 * (jamais les bases privées des agents, jamais au démarrage). Une seule
 * transaction : amorçage des faits déjà présents + déclencheurs, pour ne rien
 * laisser passer entre les deux.
 */
import type { Database } from 'better-sqlite3'

/**
 * Colonnes dont la modification doit repartir chez les pairs. La télémétrie
 * locale (recall_count, used_count, usefulness, relevance_weight,
 * last_accessed_at) et les index locaux (norm_hash, pinned) n'y sont PAS :
 * sinon chaque rappel renumérote le fait et les pairs le retirent sans fin.
 */
const SEQ_COLUMNS = [
  'fact', 'category', 'fact_type', 'confidence', 'source', 'scope_id',
  'sensitivity', 'visibility', 'tags', 'entity_ids', 'lifecycle_state',
  'superseded', 'superseded_by', 'expires_at', 'deleted_at', 'client_org_id',
  'origin_machine_id', 'origin_rev', 'content_hash', 'updated_at',
] as const

/** Déclencheurs de cette version (le nom change avec le schéma : une base d'avant est reprise). */
const TRIGGER_AI = 'facts_sync_seq2_ai'
const TRIGGER_AU = 'facts_sync_seq2_au'
const TRIGGER_AD = 'facts_sync_seq2_ad'
/** Déclencheurs de la première version (numéro réutilisable), retirés à la reprise. */
const OLD_TRIGGERS = ['facts_sync_seq_ai', 'facts_sync_seq_au', 'facts_sync_seq_ad']

/** Bases déjà prêtes dans ce processus (une vérification de schéma par connexion). */
const ready = new WeakSet<Database>()

/** Crée (si besoin) la table de numéros et ses déclencheurs dans une base partagée. */
export function ensureSyncSeq(db: Database): void {
  if (ready.has(db)) return
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(TRIGGER_AU)
  if (!exists) {
    const present = new Set((db.pragma('table_info(facts)') as Array<{ name: string }>).map(c => c.name))
    const cols = SEQ_COLUMNS.filter(c => present.has(c)).join(', ')
    // DELETE puis INSERT, sans clause de conflit : dans un déclencheur, la
    // politique de conflit de l'instruction extérieure (INSERT OR IGNORE du
    // partage, par exemple) remplacerait celle d'un « INSERT OR REPLACE ».
    // Le numéro vient d'AUTOINCREMENT : jamais celui d'une ligne retirée.
    const bump = `
        DELETE FROM sync_seq WHERE fact_id = new.id;
        INSERT INTO sync_seq (fact_id) VALUES (new.id);`
    db.transaction(() => {
      // Base d'une version d'avant : ses numéros sont gardés (les curseurs des
      // pairs y renvoient), seuls la table et les déclencheurs changent.
      for (const t of OLD_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`)
      const old = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_seq'").get() as { sql: string } | undefined
      if (old && !/AUTOINCREMENT/i.test(old.sql)) {
        db.exec(`
          DROP INDEX IF EXISTS idx_sync_seq_seq;
          ALTER TABLE sync_seq RENAME TO sync_seq_v1;
        `)
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_seq (
          seq     INTEGER PRIMARY KEY AUTOINCREMENT,
          fact_id TEXT NOT NULL UNIQUE
        );
      `)
      if (old && !/AUTOINCREMENT/i.test(old.sql)) {
        db.exec(`
          INSERT INTO sync_seq (seq, fact_id) SELECT seq, fact_id FROM sync_seq_v1 ORDER BY seq;
          DROP TABLE sync_seq_v1;
        `)
      }
      // Amorçage : les faits sans numéro en reçoivent un, dans l'ordre de leur date.
      db.exec(`
        INSERT OR IGNORE INTO sync_seq (fact_id)
        SELECT id FROM facts WHERE id NOT IN (SELECT fact_id FROM sync_seq) ORDER BY updated_at, rowid
      `)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${TRIGGER_AI} AFTER INSERT ON facts BEGIN${bump}
        END;
        CREATE TRIGGER IF NOT EXISTS ${TRIGGER_AU} AFTER UPDATE OF ${cols} ON facts BEGIN${bump}
        END;
        CREATE TRIGGER IF NOT EXISTS ${TRIGGER_AD} AFTER DELETE ON facts BEGIN
          DELETE FROM sync_seq WHERE fact_id = old.id;
        END;
      `)
    })()
  }
  ready.add(db)
}

/**
 * Numéro le plus haut JAMAIS attribué dans cette base (0 si aucun) : celui
 * d'une ligne retirée compte, comme pour le prochain numéro.
 */
export function maxSyncSeq(db: Database): number {
  const r = db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'sync_seq'), (SELECT MAX(seq) FROM sync_seq), 0) AS m").get() as { m: number }
  return Number(r.m)
}

/**
 * Lit un curseur stocké. Les anciens curseurs étaient des dates ISO : ils
 * valent 0, donc une reprise complète, sans danger (l'application d'un fait
 * déjà présent est un « déjà vu » par la règle de la dernière écriture).
 */
export function parseSeq(cursor: string | null | undefined): number {
  if (!cursor || !/^\d+$/.test(cursor)) return 0
  const n = Number(cursor)
  return Number.isSafeInteger(n) ? n : 0
}
