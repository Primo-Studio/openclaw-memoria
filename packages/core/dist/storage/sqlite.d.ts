/**
 * Ouverture SQLite unifiée : pragmas de défense + garde réseau (spec §8).
 * WAL sur un volume réseau (NAS/iCloud/Dropbox) = risque de corruption →
 * on bascule en journal_mode=DELETE et on remonte un avertissement.
 */
import Database from 'better-sqlite3';
export interface OpenResult {
    db: Database.Database;
    journalMode: string;
    onNetworkVolume: boolean;
}
export declare function openDatabase(path: string): OpenResult;
//# sourceMappingURL=sqlite.d.ts.map