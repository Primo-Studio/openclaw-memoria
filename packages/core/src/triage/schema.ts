/**
 * Schéma du TRI (migrations 80 et 81 des bases de contenu). Le créneau 80-89
 * est réservé à cette couche (contenu 1-9, cognition 10-11, topics 20-24,
 * patterns 30, procedural 40, feedback 50, clusters 60, self-observation 70,
 * révision 90).
 *
 *  - 80 `fact_triage` : une ligne par fait trié. Clé étrangère vers `facts`
 *    en ON DELETE CASCADE (les clés étrangères sont actives, voir sqlite.ts) :
 *    un oubli, un rejet en revue ou un partage (qui efface la ligne d'origine)
 *    emportent la ligne de tri. Le partage la recopie d'abord (shareFacts).
 *    `fact_triage_vectors` : vecteurs des faits EN ATTENTE, quantifiés en int8,
 *    jamais dans `embeddings` ni dans l'index vec0 (le rappel par le sens
 *    demande 100 voisins puis filtre : des dizaines de milliers de dormants
 *    l'auraient vidé, et repairVecIndex réinjecte toute ligne d'`embeddings`).
 *  - 81 `user_message_state` : état par message de la passe sur les messages
 *    de l'utilisateur (idempotence, reprise).
 *  - 82 `style_pass_state` : état par période de la passe styles (un mois du
 *    propriétaire, ou une personne). Petite table neuve, sa seule clé
 *    primaire : aucun index sur une grosse table (un index de la file de
 *    revue figeait le premier démarrage 220 à 430 ms et a été retiré).
 */
import type { Migration } from '../storage/migrations.js'

export const triageMigrations: Migration[] = [
  {
    version: 80,
    name: 'fact-triage',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fact_triage (
          fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
          genre TEXT,
          sous_type TEXT,
          rubriques TEXT NOT NULL DEFAULT '[]',
          portee TEXT,
          person_id TEXT,
          auteur TEXT,
          auteur_source TEXT NOT NULL DEFAULT 'inconnu'
            CHECK (auteur_source IN ('message','llm','inconnu')),
          auteur_preuve TEXT,
          approuve_par_owner INTEGER NOT NULL DEFAULT 0,
          durabilite INTEGER,
          importance INTEGER,
          autonome INTEGER,
          projet TEXT,
          titre TEXT,
          citation TEXT,
          entites TEXT NOT NULL DEFAULT '[]',
          conversation_at TEXT,
          conversation_at_source TEXT NOT NULL DEFAULT 'inconnu',
          origine TEXT CHECK (origine IS NULL OR origine IN ('session','sous-agent')),
          amas_id TEXT,
          amas_size INTEGER NOT NULL DEFAULT 1,
          same_as_active TEXT,
          sensible INTEGER NOT NULL DEFAULT 0,
          secret_found INTEGER NOT NULL DEFAULT 0,
          verdict TEXT CHECK (verdict IS NULL OR verdict IN ('faux')),
          raison TEXT,
          modele TEXT,
          prompt_version TEXT,
          triaged_at TEXT NOT NULL,
          corrected_at TEXT,
          corrected_fields TEXT NOT NULL DEFAULT '[]',
          llm_failures INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_fact_triage_genre ON fact_triage(genre, importance);
        CREATE INDEX IF NOT EXISTS idx_fact_triage_auteur ON fact_triage(auteur);
        CREATE INDEX IF NOT EXISTS idx_fact_triage_amas ON fact_triage(amas_id);
        CREATE INDEX IF NOT EXISTS idx_fact_triage_conversation ON fact_triage(conversation_at);

        -- Provenance d'un fait (fait → item d'import → source) : sans index,
        -- chaque fait balayait toute la file de revue (des dizaines de milliers de lignes).
        CREATE INDEX IF NOT EXISTS idx_import_items_target ON memory_import_items(target_memory_id);

        CREATE TABLE IF NOT EXISTS fact_triage_vectors (
          fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector BLOB NOT NULL
        );
      `)
    },
  },
  {
    version: 81,
    name: 'user-message-state',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_message_state (
          msg_key TEXT PRIMARY KEY,
          source_key TEXT NOT NULL,
          ts TEXT,
          status TEXT NOT NULL CHECK (status IN ('done','sensitive','skipped','failed')),
          facts INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_message_state_source ON user_message_state(source_key);
      `)
    },
  },
  {
    version: 82,
    name: 'style-pass-state',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS style_pass_state (
          state_key TEXT PRIMARY KEY,
          mode TEXT NOT NULL CHECK (mode IN ('owner','person')),
          person_id TEXT,
          period TEXT NOT NULL,
          items INTEGER NOT NULL DEFAULT 0,
          last_at TEXT,
          closed INTEGER NOT NULL DEFAULT 0,
          facts INTEGER NOT NULL DEFAULT 0,
          prompt_version TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
    },
  },
]
