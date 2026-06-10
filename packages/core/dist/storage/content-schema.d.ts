/**
 * Schéma des DB de contenu (spec §3.2) — une par instance d'assistant
 * (`assistants/<instance_id>/memory.sqlite`) + une par scope partagé
 * (`shared/<scope>.sqlite`).
 *
 * Corrections de bugs GRAVÉES dans le schéma :
 *  - pas de colonne `status` → `superseded` + `lifecycle_state` (bug db.ts:604) ;
 *  - `failure_reasons` présente sur procedures (bug procedural.ts:1053) ;
 *  - FTS5 external-content synchronisé par TRIGGERS sur rowid explicite —
 *    plus jamais de rebuild manuel désaligné (bug procedural.ts:296) ;
 *  - `embeddings.model` + `dimensions` obligatoires — la comparaison
 *    inter-dimensions est interdite (bug fallback 768/1536).
 *
 * Les tables des couches cognitives avancées (observations, entities,
 * relations, cluster_members…) arrivent par migrations additives au moment
 * du port de chaque couche.
 */
import type { Migration } from './migrations.js';
export declare const contentMigrations: Migration[];
//# sourceMappingURL=content-schema.d.ts.map