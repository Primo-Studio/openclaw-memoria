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
- [x] ~~Intégration vague 2~~ FAIT (commit « vague 2 intégrée + capture bout-en-bout »).
- [x] ~~Mode review-first~~ FAIT : faits dormants + file de revue, écran UI « Revue »,
      sélecteur de capture (auto/revue/pause) toujours visible dans la sidebar.
- [ ] `getSecretRef` / `secret_access` de bout en bout (engine → daemon → MCP `memoria_get_secret_ref`).
- [ ] Onboarding UI complet (<60 s, spec §13) : choix emplacement stockage + détection
      Ollama/LM Studio/clé Anthropic + téléchargement modèles avec barres de progression (spec §14).
- [ ] `memoria stop` propre via route admin shutdown (actuellement SIGTERM sur PID).
- [ ] Auto-démarrage du daemon au login (launchd plist macOS) — actuellement il faut
      `memoria start` après un reboot, et relancer après un rebuild du repo.
- [ ] Renommer le repo `openclaw-memoria` → `memoria` (décision Néto, à la release).
- [ ] Publier les packages npm (@memoria/* ou @primo-studio/memoria) — tant que ce n'est pas fait,
      les snippets `npx -y @memoria/mcp` imprimés par pair/connect ne marchent PAS tels quels :
      utiliser `node ~/openclaw-memoria/packages/mcp/dist/bin.js …` (c'est ainsi que l'instance
      Claude Code de Néto est enregistrée).

### P4 — import & vectoriel
- [x] ~~Migration RÉELLE de Koda~~ **FAIT 2026-06-10** : `memoria.db` du Mac Studio (3573 faits)
      rapatriée, importée, **adoptée dans la mémoire privée de Koda** (instance `405290ba`),
      1917 embeddings réindexés (nomic-embed-text). Backup dans `~/.memoria/data/backups/`.
      `adoptLegacyInto()` + route daemon `/v1/admin/adopt_legacy`.
- [ ] **Récupérer les AUTRES agents** → voir `docs/v3/AGENTS-RESEAU.md` : **Sol** sur la **Mac mini**
      (autre agent OpenClaw, à NE PAS confondre avec Koda), Codex (`~/.codex/`), autres Claude Code.
      Procédure validée sur Koda documentée dans AGENTS-RESEAU.md.
- [ ] **Partage identité Néto** : remonter les faits « sur Néto » de la mémoire privée Koda vers le
      scope `user` partagé — sur décision de Néto, via l'UI partage (P5).
- [x] ~~`sqlite-vec` + recall hybride~~ FAIT (vague 3).
- [ ] Importeurs Markdown + transcripts génériques (spec §7.2) ; spécifiques Claude Code/Codex en v1.5.
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
- [ ] **Adaptateur OpenClaw** : diagnostic ✅ FAIT → `docs/v3/DIAG-OPENCLAW.md`. Conclusion :
      OpenClaw parle MCP nativement (`openclaw mcp set memoria '{"command":"memoria-mcp",…}'`)
      → étape 1 triviale. Étape 2 = adaptateur hooks mince (~200 lignes, prependContext sur
      before_prompt_build + capture fire-and-forget sur agent_end) dans packages/adapters/openclaw.
      ⚠️ Avant : récupérer sur le Mac Studio `openclaw --version` + `openclaw plugins doctor`
      (confirme la cause exacte de la casse v3.34 : ABI better-sqlite3 / config rejetée / bug npm).

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
