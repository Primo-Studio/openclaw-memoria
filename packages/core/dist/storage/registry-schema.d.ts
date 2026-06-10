/**
 * Schéma de `registry.sqlite` — GOUVERNANCE UNIQUEMENT, aucun fait (spec §3.1).
 * Le schéma relationnel complet est présent dès la v1 ; la logique reste
 * limitée (1 user, own_company) — persons/clients/roles dormants jusqu'en P5.
 */
import type { Migration } from './migrations.js';
export declare const registryMigrations: Migration[];
//# sourceMappingURL=registry-schema.d.ts.map