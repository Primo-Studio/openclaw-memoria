/**
 * Ouverture SQLite unifiée : pragmas de défense + garde réseau (spec §8).
 * WAL sur un volume réseau (NAS/iCloud/Dropbox) = risque de corruption →
 * on bascule en journal_mode=DELETE et on remonte un avertissement.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isOnNetworkVolume } from './network-guard.js';
export function openDatabase(path) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const onNetworkVolume = isOnNetworkVolume(path);
    let journalMode;
    if (onNetworkVolume) {
        journalMode = String(db.pragma('journal_mode = DELETE', { simple: true }));
    }
    else {
        journalMode = String(db.pragma('journal_mode = WAL', { simple: true }));
        db.pragma('synchronous = NORMAL');
    }
    return { db, journalMode, onNetworkVolume };
}
//# sourceMappingURL=sqlite.js.map