# Memoria V3 — TODO de passation

> **But** : reprendre le travail SANS contexte oral. Lire d'abord `STATUS.md` (état mesuré), puis ce
> fichier, puis `DECISIONS-LOG.md`. Spec gelée = `~/Downloads/Memoria-V3-Dossier-Dev-2026-06-10/PLAN-Memoria-v3-2026-06-03.md`.
> Carte des agents/mémoires du réseau = `AGENTS-RESEAU.md` (snapshot juin).
>
> **Dernière session : `JOURNAL-2026-08-27.md`** — PR #20 à #24, 80 commits d'audit multi-agents,
> **980 tests / 105 fichiers**. À lire en entier avant de toucher `packages/daemon/src/server.ts`,
> `packages/core/src/engine/memoria.ts`, `packages/mcp/src/serve.ts` ou `apps/desktop/src-tauri/src/lib.rs`.
> Puis `PHASES-1-2-3-2026-08-25.md` et `AUDIT-CONSOLIDATION-2026-08-24.md` (contexte), et
> `PASSATION-2026-08-04.md` § 3-4 (remarques non appliquées + pièges de diagnostic, toujours valables).

## Reprendre le travail

```bash
cd ~/openclaw-memoria        # branche memoria-v1
npm install && npm run build && npm test   # doit être 100 % vert AVANT toute modif (980 tests au 27/08)
memoria stop && memoria start              # le daemon pointe sur packages/*/dist : relancer après un rebuild
```

- Le « juge du produit » = `packages/core/test/benchmark.test.ts` (anti-fuite = 0). Toute évolution du
  recall doit le laisser vert.
- Règle anti « mort silencieuse » : aucun catch muet ; tout chemin actif a un test qui le prouve.
  ~106 bugs legacy documentés dans `port-map.json` — ne pas les réintroduire.
- Règle de session : **test rouge avant correctif**, puis vert ; on regarde l'écran (UI) avant de dire « fait ».
- Auteur git = **Hello-Primo**. `.claude/`, `dist/`, `*.tsbuildinfo` gitignorés.

## Décisions produit du 27/08 — à confirmer par Néto (implémentées, réversibles)

- **Les agents écrivent dans `user`** par défaut (`memoria_store_fact scope:'user'`, policy `can_write`
  au pairing + migration douce). Si Néto ne confirme pas : revenir à `can_write=false` par défaut
  (`grantDefaultUserWrite` + `pairAssistant`, `memoria.ts`).
- **OpenClaw en lecture seule** sur `user` (bot de canal exposé à des tiers) → ses propositions passent
  par la Revue.
- **Modes de capture** unifiés : `Revue d'abord` et `Pause` s'appliquent aussi aux faits déclarés
  (`store_fact`), pas seulement à la capture.
- Fait déclaré dédoublonné en **exact** seulement ; `forget({query})` = ET sémantique + `confirm_bulk`.

## Reste à faire (ordre conseillé)

### 🔴 Distribution (seules décisions bloquantes)
- [ ] **Scope npm** : `@memoria/*` → `@primo-studio/*` (4 packages publiables, `files:[dist]` +
      `publishConfig` déjà posés ; web reste `private`). Tant que rien n'est publié, les commandes
      utilisent `node ~/openclaw-memoria/packages/mcp/dist/bin.js` (géré par le daemon / `agents_connect`).
      Au passage : **18 alertes Dependabot sur `main`** (branche figée depuis mars) → remettre `main`
      au niveau de `memoria-v1`.
- [ ] **Notarisation** de `Memoria.app` (signée Developer ID `4QB44XVHNL`, `tauri.conf.json`
      `signingIdentity`, installée dans `/Applications`) — process Igara, **feu vert Néto**. Node
      embarqué SEA = v1.5.
- [ ] Renommer le repo `openclaw-memoria` → `memoria` (à la release, décision Néto).

### Mineurs de revue (JOURNAL-2026-08-27 § « Mineurs restants », non bloquants)
- [ ] Refus de policy sur un fait PARTAGÉ dans correct/merge/pin/expiry → passer par `mapScopeErrors`
      (403 au lieu de 500).
- [ ] `reinforceFacts` écrit dans la DB partagée sur simple `can_read` (classement modifié pour tous).
- [ ] `forget` avec `ids` : `matched` compté par DB sans vérifier l'existence → `dry_run` ment.
- [ ] `knownAboutPerson` n'applique pas `passesClientIsolation`.
- [ ] `shareFacts` ne dédoublonne pas contre la DB partagée cible ; `INSERT OR IGNORE` laisse un
      dormant dormant.
- [ ] `hardDeleteFacts` laisse des orphelins `fact_entities` (nettoyage centralisé à faire).
- [ ] Tables legacy `vec_index_768` / `vec_index_1536` jamais supprimées après migration (≈ 35 Mo morts).
- [ ] `repairVecIndex` réinsère aussi les dormants (4 238 / 5 286 vecteurs sur la base réelle).
- [ ] Concurrence `indexEmbeddings` / `scheduleEmbeddings` (deux `runAll` sur le même store).
- [ ] Corps de `/v1/memory/store_fact` relayé sans liste blanche.
- [ ] `explain()` MCP : distinguer « privé d'un autre agent » de « pas de droit d'écriture » ; branche
      404 périmée (« paused » → la pause répond `200 {disabled:true}`) ; expliquer `disabled` au LLM.
- [ ] Clés i18n mortes (`onboarding.agent.copied`, `patterns.service_unavailable`, …) ; actions d'audit
      `store_fact_dedup` / `grant_user_write_default` absentes des catalogues ; `fmtUsd` suffixe `$` en dur.
- [ ] Tests : `sync-http.test.ts` port LAN fixe 47733 → port 0 ; `lifecycle.test.ts` spawn du vrai
      `dist/bin.js` ; fuite `POST 11434` dans `llm-profile-refresh.test.ts` ; `auto-import.test.ts` ne
      vérifie que le suffixe du chemin du plist.
- [ ] Commentaire d'en-tête `packages/cli/src/commands/sync.ts` : sous-commande `peers` inexistante.
- [ ] `--help` de `memoria doctor` (« santé du stockage ») en retard sur le rapport réel (activité,
      envois cloud, coût) — la doc UI est déjà alignée.
- [ ] `onboarding.engine.ollamaHint` dit encore « Recommandé » pour l'extraction Ollama alors que
      Réglages et Docs recommandent OpenAI (clé hors périmètre docs, à aligner dans l'onboarding).
- [ ] Routes servies sans client : `adopt_legacy`, `clusters`, `dialectic`, `skill_proposals`,
      `sync/peers`, `/v1/memory/merge` — brancher (outil MCP / écran) ou retirer.

### Adaptateur PUSH pour Claude Code (décision produit)
- [ ] Hooks `SessionStart` / `UserPromptSubmit` → `memoria recall` injecté, `Stop` → `capture_turn` du
      dernier tour via `transcript_path`, installés par `register.ts`. Aujourd'hui Claude Code est en
      **pull** (outils MCP) + auto-import launchd toutes les 6 h.

### Données réelles
- [ ] **5 révisions** à arbitrer (écran Révisions, `doctor` l'affiche en avertissement).
- [ ] **Revue re-remplie à chaque auto-import** (toutes les 6 h) : décider « tout approuver par agent »
      (bouton à créer) vs tri manuel ; exposer `review_pending` dans `/stats` pour le badge Revue.
- [ ] Isolation client/projet : slugification faite (27/08), mapping registre ⚪, isolation
      projet→client ⚪ (`passesClientIsolation` ne regarde que `client_org_id`).
- [ ] Machines A (Mac Studio) / B (iMac) : état inconnu depuis le 04/08 (adaptateur, `[llm.embeddings]`,
      rebuild) — vérifier sur place, `memoria doctor` + `/v1/health.built_sha`.

### Planificateurs / robustesse
- [ ] `decayCognition()` existe mais n'est appelée par personne : `setInterval` quotidien après
      `replayWal()` (comme le tick sync) ou `memoria doctor --decay`.
- [ ] Rejouer le WAL quand un moteur redevient disponible (`POST /v1/admin/llm_extraction` ou tick
      `llm_health`) — aujourd'hui la file attend le prochain `capture_turn` ou le boot.
- [ ] `/v1/admin/version` : renvoyer aussi `built_sha` et l'afficher dans `VersionFoot` (écart dépôt/build).
- [ ] Plist auto-import portable : généré par la CLI (`memoria autoimport on`) avec `$HOME` et le node
      courant, au lieu du plist versionné aux chemins de ce poste.
- [ ] Port stable persisté + `admin_token` stable (redémarrage après mise à jour sans re-pairing UI).
- [ ] Synchro : `sync peers` CLI (route déjà là), `sync verify` / `rotate-key`, relais NAS (incrément 6),
      opt-in de partage de secrets (aucun appelant de `SyncEngine.shareSecret`).

### UI P2 restants (AUDIT-UX-UI § 9)
- [ ] Recherche au frappé dans Mémoire (formulaire à soumission) ; uniformisation ErrorBanner /
      humanError (Settings, Dashboard, Audit, System, Review, Vault) ; focus trap du menu hamburger.
- [ ] Toast après action, bouton « Exporter maintenant », empty-states actionnables (Thèmes, Récurrences).
- [ ] Écran Organisations & projets (créer org client, projet, scopes) — logique core prête.
- [ ] `getSecretRef` / `secret_access` de bout en bout (engine → daemon → MCP).

### Hors périmètre (⛔ Néto, 24/08)
- Carte 3D UMAP, continuous-learning OpenClaw (`llm_output`), nouvelles features avant la distribution.

## ✅ Fait (résumé, détail dans STATUS.md et les journaux)
- Fondation V3, 24 couches cognitives, recall hybride sqlite-vec + graphe, capture WAL-first,
  redaction + Keychain/AES, review-first, pairing, partage gouverné + écriture directe dans `user`,
  16 écrans UI (5 langues), 12 outils MCP, 28 commandes CLI, adaptateur OpenClaw (`allowConversationAccess`),
  synchro hub-and-spoke incréments 1-5, Personnes, install 1 commande, `memoria update`, onboarding
  moteur, détection/connexion/import d'agents, consommation par modèle + journal cloud, launchd d'abord,
  icône M, app signée, import auto launchd, `fact_cognition`, index vectoriel (dims, modèle).
- Import des mémoires : Koda (3 515 faits + graphe), transcripts Claude Code/Codex (bulk 06/06,
  1 355 fichiers le 25/08, 1 523 le 27/08), quarantaine triée le 24/08 (re-remplie depuis, cf. ci-dessus).

## Pièges connus
- bm25 NON comparable entre DB → scoring fan-out = couverture de requête (`content.ts searchFacts`). Ne pas « simplifier ».
- FTS5 : maintenance par TRIGGERS uniquement (pas de rebuild manuel sans rowid).
- Embeddings : `model`+`dimensions` obligatoires, comparaison inter-dim interdite (cosine throw) ; index
  nommé `(dims, modèle)`.
- Mode JSON Ollama : demander un OBJET `{"facts":[...]}`, pas un tableau nu (petits modèles).
- Le daemon pointe sur le build du repo : `memoria stop && memoria start` après un rebuild ; vérifier
  `built_sha` dans `GET /v1/health` (la route `version` lit le dépôt, pas le build).
- `autostart on` puis `start` : `start` passe par launchd (kickstart) — ne pas spawner à la main.
- Migration : toujours `.backup` (snapshot cohérent) côté source, jamais toucher l'original.
- Plusieurs machines, deux copies du dépôt par machine, logs trompeurs : `PASSATION-2026-08-04.md` § 4.
- Commandes qui n'existent PAS (docs anciennes) : `memoria connect` / `disconnect`, `npx @memoria/web`.
