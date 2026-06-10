# Memoria V3 — État d'avancement

> Mis à jour en continu pendant le build. Phases = roadmap de la spec
> (`PLAN-Memoria-v3-2026-06-03.md` §15), adaptée par la décision kickoff
> (monorepo direct, Phase 0 fusionnée dans le port).

**Dernière mise à jour :** 2026-06-10 (session 1, en cours)

| Phase | Contenu | État |
|---|---|---|
| Scaffolding | Monorepo npm workspaces, TS strict, vitest, CI stricte, docs | ✅ fait |
| P1 — Fondation | core (schéma registry+contenu, storeFact/recall/forget), resolveStorageRoot, daemon singleton HTTP+token | ✅ fait (migration v3.34 en vague 2) |
| P2 — Sécurité & WAL | WAL source de vérité (replay boot), redaction secrets, SecretProvider (Keychain+AES), audit neutre | 🟡 vague 2 en cours (audit neutre ✅) |
| P3 — MCP + UI | pairing ✅ (code TTL→token), serveur MCP, UI web, benchmark anti-fuite v1 ✅ | 🟡 vague 2 en cours |
| P4 — Import + vectoriel | importeur OpenClaw → quarantaine+provenance (vague 2), sqlite-vec, recall hybride | 🟡 partiel |
| P5 — Partage gouverné | topics permissionnables, org/client/projet actifs, partage par référence, hard-delete complet ✅ (facts), backup/restore | ⚪ à faire |
| P6 — Couches avancées | graph avancé+decay, observations/clusters batch, 3D UMAP, couches D sur validation, adaptateur OpenClaw (⚠️ diagnostiquer la casse OpenClaw d'abord) | ⚪ à faire |
| Tauri | apps/desktop (double-clic non-dev) — rustup installé, toolchain prête | ⚪ à faire |

**Benchmark recall (juge du produit)** : ✅ vert — anti-fuite inter-clients = 0 sur batterie de 5 requêtes,
défaut sûr sans contexte, pas de sur-masquage, dormant explicite, cap tokens. `packages/core/test/benchmark.test.ts`.

## Journal de session

### 2026-06-10 — Session 1 (kickoff)
- Clone `Primo-Studio/openclaw-memoria` → `~/openclaw-memoria`, HEAD = `4556c4d` (v3.34.0, base de l'audit).
- Branche `memoria-v1`, ancien code → `legacy/` (commit 1).
- Décisions kickoff Néto (voir DECISIONS-LOG.md).
- Cartographie legacy TERMINÉE : 10 agents, `docs/v3/port-map.json` (106 bugs documentés file:line,
  recettes de portage par module, schéma v3.34 complet pour la migration).
- Scaffolding monorepo : root + core/daemon/mcp/cli/web, CI stricte (remplace la CI menteuse), vitest 4.
- Ollama : `nomic-embed-text` + `qwen2.5:3b` téléchargés ✓. rustup/cargo installés ✓ (Tauri prêt).
- **Core P1 livré** : registry+contenu (schéma complet, FTS triggers, embeddings model/dim), pairing
  code→token, storeFact gouverné, recall fan-out anti-fuite, forget hard-delete, doctor/stats,
  browseFacts, capture_mode. 30 tests.
- **Daemon P1 livré** : HTTP 127.0.0.1, auth 3 niveaux, singleton lock-file, routes admin+memory,
  service statique UI /ui/, boot-test CI.
- **Benchmark recall v1 vert** (a déjà attrapé un vrai bug de conception : bm25 non comparable
  inter-DB → scoring couverture-dominant).
- Vague 2 lancée (7 agents, worktrees) : secrets, LLM, capture/WAL, MCP, CLI, web, migration legacy.
