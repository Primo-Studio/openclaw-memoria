import { nowISO } from '../util.js';
export function runMigrations(db, migrations) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
    const applied = new Set(appliedRows.map(r => r.version));
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    let count = 0;
    for (const m of sorted) {
        if (applied.has(m.version))
            continue;
        const run = db.transaction(() => {
            m.up(db);
            db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, nowISO());
        });
        run();
        count++;
    }
    return count;
}
export function schemaVersion(db) {
    try {
        const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
        return row.v ?? 0;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=migrations.js.map