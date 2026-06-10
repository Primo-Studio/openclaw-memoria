# Memoria V3 — TODO de passation

> **But de ce fichier** : n'importe quel dev (ou une future session) reprend le travail SANS
> contexte oral. Mis à jour à chaque jalon. Lire d'abord `STATUS.md`, puis ce fichier,
> puis `DECISIONS-LOG.md`. La spec gelée = `~/Downloads/Memoria-V3-Dossier-Dev-2026-06-10/PLAN-Memoria-v3-2026-06-03.md`.

## Comment reprendre le travail

```bash
cd ~/openclaw-memoria        # branche memoria-v1
npm install && npm run build && npm test   # doit être 100% vert AVANT toute modif
```

- Le « juge du produit » = `packages/core/test/benchmark.test.ts` (anti-fuite = 0). Toute
  évolution du recall doit le laisser vert.
- Règle anti « mort silencieuse » : aucun catch muet ; tout chemin actif a un test qui prouve
  qu'il s'exécute. Les 15 bugs legacy sont documentés dans `docs/v3/port-map.json` (avec ~90
  autres) — ne pas les réintroduire.

## Reste à faire (ordre conseillé)

### Intégration vague 2 (si la session 1 s'est arrêtée avant)
- [ ] Récupérer les fichiers des 7 worktrees agents (`.claude/worktrees/wf_700b64fe-*`) — fichiers
      disjoints par piste (secrets, llm, capture/wal, mcp, cli, web, migration). Copier dans le
      repo principal, câbler les exports dans `packages/core/src/index.ts`, build+tests.
- [ ] Câbler dans `Memoria` : redactor + SecretProvider + extraction LLM → `CapturePipeline` ;
      route daemon `POST /v1/memory/capture_turn` ; replay WAL au boot du daemon ;
      enforcement `capture_mode` (incognito → pas de WAL append).
- [ ] `memoria_capture_turn` MCP → daemon (le client MCP est codé, la route doit exister).
- [ ] UI : brancher Memory.tsx sur `GET /v1/admin/facts` (existe) et le bouton pause sur
      `POST /v1/admin/capture_mode` (existe).

### P2/P3 — compléments après intégration
- [ ] `getSecretRef` / `secret_access` de bout en bout (engine → daemon → MCP `memoria_get_secret_ref`).
- [ ] Mode `review-first` : faits extraits → `memory_import_items` (pending) au lieu de facts,
      écran « Revue » dans l'UI.
- [ ] Onboarding UI complet (<60 s, spec §13) : choix emplacement stockage + détection
      Ollama/LM Studio/clé Anthropic + téléchargement modèles avec barres de progression (spec §14).
- [ ] `memoria stop` propre via route admin shutdown (actuellement SIGTERM sur PID).
- [ ] Renommer le repo `openclaw-memoria` → `memoria` (décision Néto, à la release).

### P4 — import & vectoriel
- [ ] **Migration RÉELLE** : récupérer `memoria.db` (mémoire Koda) sur le **Mac Studio de Néto**
      (même réseau — lui demander, il guidera). La passer dans `importLegacyDb` (vague 2), vérifier
      counts + recall de contrôle, garder le backup.
- [ ] Importeurs Markdown + transcripts génériques (spec §7.2) ; spécifiques Claude Code/Codex en v1.5.
- [ ] `sqlite-vec` : table `vec_index`, embeddings via Ollama `nomic-embed-text` (768d, déjà pull),
      recall hybride FTS+vecteur, réindex via `embedding_jobs`, garde dimensions (déjà dans le schéma).
      Mesurer au benchmark (le recall hybride doit battre FTS seul).
- [ ] Job async d'embedding post-capture (bucket B).

### P5 — partage gouverné
- [ ] Topics permissionnables + UI matrice de partage + audit visuel.
- [ ] Écrans Organisations & projets (léger v1) + `active_context` déclaré depuis l'UI.
- [ ] Backup/restore (`VACUUM INTO` + restauration guidée).
- [ ] Hard-delete : étendre aux procédures/observations (facts ✅), vérifier `.md` si markdown sync activé.

### P6 — couches avancées (port depuis legacy/, recettes dans port-map.json)
- [ ] Bucket B async : graph (sain, port quasi tel quel), topics, observations, fact-clusters, revision.
- [ ] Bucket C opt-in : self-observation, markdown sync, dialectic (outil CLI).
- [ ] Bucket D validation : patterns (superseding), auto-skill. JAMAIS dans le chemin bloquant.
- [ ] Hot-tier scoring (legacy `recall.ts:136` l'ignorait — le port-map a la recette).
- [ ] **Adaptateur OpenClaw** : ⚠️ D'ABORD diagnostiquer ce qui a cassé avec le nouvel OpenClaw
      (API plugin vs MCP) — tâche jamais faite. Si le nouvel OpenClaw parle MCP, l'adaptateur
      est peut-être juste une config.

### Desktop (Tauri) — décision Néto : ne pas repousser
- [ ] rustup/cargo INSTALLÉS sur cette machine (stable). Architecture cible : Tauri v2, UI = build
      de `packages/web`, daemon en **sidecar** = binaire Node SEA (single executable) de
      `@memoria/daemon` (attention : better-sqlite3 natif → embarquer le `.node` à côté, le SEA
      doit le charger via chemin relatif). Alternative plus simple si SEA bloque : exiger Node ≥20
      en prérequis v1 (npx), Tauri v1.5.
- [ ] `npx @primo-studio/memoria` : package méta qui lance daemon + ouvre l'UI avec
      `#token=<admin_token>` (lire `daemon.json`).

### Qualité / CI
- [ ] Publier la branche et vérifier la CI GitHub (matrice complète, macos+ubuntu).
- [ ] Tests perf 10K/100K/1M faits (spec §16) — avant/après sqlite-vec.
- [ ] Test crash réel multi-process (kill -9 du daemon pendant capture → 0 perte au replay).
- [ ] `npm pack` de chaque package + test d'install propre (préparer la publication npm).

## Pièges connus (ne pas redécouvrir)
- Vercel n'est PAS concerné ici, mais le compte git : commits en **Hello-Primo** (auth gh active).
- `.claude/`, `dist/`, `*.tsbuildinfo` sont gitignorés — ne pas les committer.
- Les DB de test vivent dans `tmpdir()` — jamais de test contre `~/.memoria`.
- bm25 n'est PAS comparable entre DB → le scoring fan-out repose sur la couverture de requête
  (voir `content.ts searchFacts`). Ne pas « simplifier » en revenant au bm25 brut.
- FTS5 : maintenance par TRIGGERS uniquement. Jamais de rebuild manuel par INSERT sans rowid
  (bug legacy procedural.ts:296).
- Embeddings : `model` + `dimensions` obligatoires, comparaison inter-dimensions interdite
  (bug legacy 768/1536). `cosineSimilarity` throw si longueurs différentes.
