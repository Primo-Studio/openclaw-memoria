/**
 * Numéro d'ordre de la synchro (sync/seq.ts) : il ne redescend jamais, et une
 * base de la première version (numéro réutilisable) est reprise sans perdre
 * ses numéros. Données fictives, base en mémoire.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureSyncSeq, maxSyncSeq } from '../src/sync/seq.js'

function factsDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE facts (id TEXT PRIMARY KEY, fact TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL)')
  return db
}

const seqOf = (db: Database.Database, id: string): number | undefined =>
  (db.prepare('SELECT seq FROM sync_seq WHERE fact_id = ?').get(id) as { seq: number } | undefined)?.seq

describe('numéro d’ordre de la synchro', () => {
  it('modifier puis oublier le fait le plus récent : le numéro suivant est toujours plus grand', () => {
    const db = factsDb()
    const add = db.prepare("INSERT INTO facts (id, fact, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')")
    add.run('a', 'Essai fictif : premier fait')
    ensureSyncSeq(db)
    add.run('b', 'Essai fictif : dernier fait')
    expect(seqOf(db, 'b')).toBe(2)
    db.prepare("UPDATE facts SET expires_at = '2031-01-01T00:00:00.000Z' WHERE id = 'b'").run()
    expect(seqOf(db, 'b')).toBe(3)
    db.prepare("DELETE FROM facts WHERE id = 'b'").run()
    expect(maxSyncSeq(db)).toBe(3)
    add.run('c', 'Essai fictif : fait neuf')
    expect(seqOf(db, 'c')).toBe(4)
  })

  it('base de la première version : numéros gardés, déclencheurs remplacés', () => {
    const db = factsDb()
    db.exec(`
      CREATE TABLE sync_seq (fact_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE UNIQUE INDEX idx_sync_seq_seq ON sync_seq(seq);
      CREATE TRIGGER facts_sync_seq_ai AFTER INSERT ON facts BEGIN
        DELETE FROM sync_seq WHERE fact_id = new.id;
        INSERT INTO sync_seq (fact_id, seq) VALUES (new.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_seq));
      END;
      CREATE TRIGGER facts_sync_seq_au AFTER UPDATE OF fact, expires_at, updated_at ON facts BEGIN
        DELETE FROM sync_seq WHERE fact_id = new.id;
        INSERT INTO sync_seq (fact_id, seq) VALUES (new.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_seq));
      END;
      CREATE TRIGGER facts_sync_seq_ad AFTER DELETE ON facts BEGIN
        DELETE FROM sync_seq WHERE fact_id = old.id;
      END;
    `)
    const add = db.prepare("INSERT INTO facts (id, fact, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')")
    add.run('a', 'Essai fictif : fait a')
    add.run('b', 'Essai fictif : fait b')
    db.prepare("UPDATE facts SET fact = 'Essai fictif : fait a, revu' WHERE id = 'a'").run()
    expect([seqOf(db, 'a'), seqOf(db, 'b')]).toEqual([3, 2])

    ensureSyncSeq(db)
    expect([seqOf(db, 'a'), seqOf(db, 'b')]).toEqual([3, 2])
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name)
    expect(triggers).toEqual(['facts_sync_seq2_ad', 'facts_sync_seq2_ai', 'facts_sync_seq2_au'])
    // le plus récent modifié puis oublié : jamais son numéro repris
    db.prepare("UPDATE facts SET expires_at = '2031-01-01T00:00:00.000Z' WHERE id = 'a'").run()
    expect(seqOf(db, 'a')).toBe(4)
    db.prepare("DELETE FROM facts WHERE id = 'a'").run()
    add.run('c', 'Essai fictif : fait neuf')
    expect(seqOf(db, 'c')).toBe(5)
  })
})
