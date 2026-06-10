/**
 * Runner de migrations additives — table `schema_migrations(version, applied_at)`.
 * Chaque DB (registry, contenu) a sa propre série. Les migrations sont
 * transactionnelles et idempotentes (re-run sans effet).
 */
import type { Database } from 'better-sqlite3';
export interface Migration {
    version: number;
    name: string;
    up: (db: Database) => void;
}
export declare function runMigrations(db: Database, migrations: Migration[]): number;
export declare function schemaVersion(db: Database): number;
//# sourceMappingURL=migrations.d.ts.map