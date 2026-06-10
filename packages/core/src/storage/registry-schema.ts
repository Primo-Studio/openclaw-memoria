/**
 * Schéma de `registry.sqlite` — GOUVERNANCE UNIQUEMENT, aucun fait (spec §3.1).
 * Le schéma relationnel complet est présent dès la v1 ; la logique reste
 * limitée (1 user, own_company) — persons/clients/roles dormants jusqu'en P5.
 */
import type { Migration } from './migrations.js'

export const registryMigrations: Migration[] = [
  {
    version: 1,
    name: 'registry-initial',
    up(db) {
      db.exec(`
        CREATE TABLE human_users (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          local_profile_name TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE assistants (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          display_name TEXT NOT NULL,
          owner_user_id TEXT NOT NULL REFERENCES human_users(id),
          default_scopes TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE TABLE assistant_instances (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL REFERENCES assistants(id),
          machine_id TEXT NOT NULL,
          profile_id TEXT,
          created_at TEXT NOT NULL,
          last_seen_at TEXT,
          token_hash TEXT,
          revoked_at TEXT
        );
        CREATE INDEX idx_instances_assistant ON assistant_instances(assistant_id);
        CREATE INDEX idx_instances_token ON assistant_instances(token_hash) WHERE token_hash IS NOT NULL;

        -- Dormants en P1 (logique P5) — présents pour ne jamais re-migrer le modèle
        CREATE TABLE persons (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE person_roles (
          person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
          role_type TEXT NOT NULL,
          ref_id TEXT,
          PRIMARY KEY (person_id, role_type, ref_id)
        );

        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          org_type TEXT NOT NULL CHECK (org_type IN ('own_company','client','vendor','partner')),
          parent_org_id TEXT REFERENCES organizations(id),
          created_at TEXT NOT NULL
        );

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner_org_id TEXT NOT NULL REFERENCES organizations(id),
          client_org_id TEXT REFERENCES organizations(id),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
          created_at TEXT NOT NULL
        );

        CREATE TABLE project_participants (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          participant_type TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          role TEXT,
          PRIMARY KEY (project_id, participant_type, participant_id)
        );

        CREATE TABLE storage_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_path TEXT NOT NULL,
          db_path TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE memory_scopes (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('private','user','org','client','project','shared_topic','legacy_to_review')),
          name TEXT NOT NULL,
          owner_user_id TEXT REFERENCES human_users(id),
          org_id TEXT REFERENCES organizations(id),
          client_org_id TEXT REFERENCES organizations(id),
          project_id TEXT REFERENCES projects(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_scopes_type ON memory_scopes(type);

        CREATE TABLE assistant_scope_policy (
          assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
          scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
          can_read INTEGER NOT NULL DEFAULT 0,
          can_write INTEGER NOT NULL DEFAULT 0,
          can_share INTEGER NOT NULL DEFAULT 0,
          secret_access TEXT NOT NULL DEFAULT 'none' CHECK (secret_access IN ('none','refs_only','value_on_request')),
          PRIMARY KEY (assistant_id, scope_id)
        );

        CREATE TABLE pairings (
          id TEXT PRIMARY KEY,
          assistant_instance_id TEXT NOT NULL REFERENCES assistant_instances(id),
          code_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','expired','revoked')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_pairings_status ON pairings(status);

        -- Append-only, JAMAIS de contenu (audit neutre, spec §11)
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('assistant','user','system')),
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_id_hash TEXT,
          scope_id TEXT,
          reason TEXT
        );
        CREATE INDEX idx_audit_ts ON audit_log(ts);

        CREATE TABLE secret_refs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          service TEXT,
          location TEXT NOT NULL,
          scope_id TEXT REFERENCES memory_scopes(id),
          allowed_assistants TEXT NOT NULL DEFAULT '[]',
          sensitivity TEXT NOT NULL DEFAULT 'critical' CHECK (sensitivity IN ('normal','sensitive','critical')),
          last_verified_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE db_registry (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('registry','assistant','shared')),
          path TEXT NOT NULL,
          assistant_instance_id TEXT REFERENCES assistant_instances(id),
          scope_id TEXT REFERENCES memory_scopes(id)
        );
      `)
    },
  },
  {
    version: 2,
    name: 'registry-settings',
    up(db) {
      // Réglages runtime globaux (capture_mode pause/incognito, etc.)
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
    },
  },
]
