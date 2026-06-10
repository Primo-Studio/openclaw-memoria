# Memoria V3 — État d'avancement

> Mis à jour en continu pendant le build. Phases = roadmap de la spec
> (`PLAN-Memoria-v3-2026-06-03.md` §15), adaptée par la décision kickoff
> (monorepo direct, Phase 0 fusionnée dans le port).

**Dernière mise à jour :** 2026-06-10 (session kickoff)

| Phase | Contenu | État |
|---|---|---|
| Scaffolding | Monorepo npm workspaces, TS strict, vitest, CI stricte, docs | 🟡 en cours |
| P1 — Fondation | core (schéma registry+contenu, storeFact/recall/forget), resolveStorageRoot, daemon singleton HTTP+token, migration v3.34 | ⚪ à faire |
| P2 — Sécurité & WAL | WAL source de vérité (replay boot), redaction secrets, SecretProvider (Keychain+AES), audit neutre | ⚪ à faire |
| P3 — MCP + UI | pairing (code TTL→token), serveur MCP, adaptateurs Claude Code/Codex, recall fan-out+budget, UI web (onboarding/stockage/agents/mémoire/pause), benchmark anti-fuite v1 | ⚪ à faire |
| P4 — Import + vectoriel | importeur OpenClaw/MD/transcripts → quarantaine+provenance, sqlite-vec, recall hybride | ⚪ à faire |
| P5 — Partage gouverné | topics permissionnables, org/client/projet actifs, partage par référence, hard-delete complet, backup/restore | ⚪ à faire |
| P6 — Couches avancées | graph avancé+decay, observations/clusters batch, 3D UMAP, couches D sur validation, adaptateur OpenClaw (⚠️ diagnostiquer la casse OpenClaw d'abord) | ⚪ à faire |
| Tauri | apps/desktop (double-clic non-dev) | ⚪ à faire |

## Journal de session

### 2026-06-10 — Session 1 (kickoff)
- Clone `Primo-Studio/openclaw-memoria` → `~/openclaw-memoria`, HEAD = `4556c4d` (v3.34.0, base de l'audit).
- Branche `memoria-v1`, ancien code → `legacy/` (commit 1).
- Décisions kickoff Néto (voir DECISIONS-LOG.md).
- Workflow de cartographie lancé : 10 agents mappent `legacy/` + audits → recettes de portage par module.
- Scaffolding monorepo : root + core/daemon/mcp/cli, CI stricte (remplace la CI menteuse), vitest 4.
- Ollama : pull `nomic-embed-text` + `qwen2.5:3b` (en cours).
