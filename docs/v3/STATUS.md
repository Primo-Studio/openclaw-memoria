# Memoria V3 — État d'avancement

> État **réel, mesuré contre le code** de la branche `memoria-v1`. Journal détaillé de la dernière
> session : `JOURNAL-2026-08-27.md` (à lire en entier avant de toucher `server.ts`, `memoria.ts`,
> `mcp/serve.ts` ou `lib.rs`). Passation générale : `TODO.md`. Décisions : `DECISIONS-LOG.md`.

**Dernière mise à jour :** 2026-08-27 (fin de journée — après PR #24 + vérification doc ↔ code)

## 🏁 État global : produit complet, en usage réel, dernier kilomètre = distribution

Fondation V3 (daemon / MCP / UI / secrets / migration / partage / providers / desktop) + **24 couches
cognitives** (`COUCHES-ETAT.md`) + adaptateur OpenClaw + synchro inter-machines + identification
d'interlocuteur + install 1 commande + mise à jour depuis l'UI + onboarding moteur + consommation
par modèle + service launchd + icône M dans la barre de menus.

| Compteur (mesuré le 27/08 sur ce dépôt) | Valeur |
|---|---|
| Tests vitest (`npm test`) | **980 tests / 105 fichiers**, tous verts (`packages/core/test` 61 fichiers, daemon 21, cli 8, mcp 4, web 11, adapter-openclaw 1) |
| Tests Rust (`cargo test`, app bureau) | 19 |
| Écrans web (`App.tsx` NAV_IDS) | **16** (+ Onboarding) : 5 « Essentiel » (Tableau de bord, Agents, Mémoire, Thèmes, Revue) + 11 « Avancé » (Récurrences, Procédures, Révisions, Maintenance, Partage, Personnes, Coffre, Système, Journal, Réglages, Docs) |
| Outils MCP (`packages/mcp/src/serve.ts`) | **12** : recall · store_fact · capture_turn · capture_status · correct · pin · set_expiry · feedback · set_context · get_context · identify_interlocutor · identify_or_create_interlocutor |
| Commandes CLI (`buildCli()`) | **28** : ui (défaut) · init · daemon · start · stop · doctor · export · pair · agents · revoke · delete-agent · stats · forget · import · audit · enable · disable · autostart · move · update · sync {status, init-hub, invite, join, now, revoke, leave} |
| Routes HTTP daemon | 93 admin/mémoire loopback + `/v1/health` + `/v1/pairing/complete` + 5 `/v1/sync/*` (LAN, hub) |
| Schémas | registry v5 (`llm_usage`) · contenu v4 · cognition v11 (`fact_cognition`) · topics v21 (entité ancre) |
| Langues UI | 5 (fr, en, es, pt, de), parité stricte testée |

### Ce qui reste (détail dans `TODO.md`)
🔴 **scope npm** (`@memoria/*` → `@primo-studio/*`, 18 alertes Dependabot sur `main` à traiter au passage) ·
🔴 **notarisation** de `Memoria.app` (signée Developer ID, installée dans `/Applications`, feu vert Néto) ·
mineurs de revue (`JOURNAL-2026-08-27.md` § « Mineurs restants ») · adaptateur **push** pour Claude Code
(hooks SessionStart/Stop, décision produit) · **5 révisions** à arbitrer dans l'écran Révisions ·
planificateur `decayCognition` · UI P2 (debounce Mémoire, uniformisation ErrorBanner/humanError).

| Phase | Contenu | État |
|---|---|---|
| Scaffolding | Monorepo npm workspaces, TS strict, vitest, CI stricte (Node 20/22/24 × ubuntu/macos), docs | ✅ |
| P1 — Fondation | core (schéma registry+contenu, storeFact/recall/forget), resolveStorageRoot, daemon singleton HTTP+token | ✅ |
| P2 — Sécurité & WAL | WAL source de vérité (replay boot), redaction secrets (gate dur), Keychain macOS + coffre AES-256-GCM, audit neutre, journal `cloud_send` | ✅ |
| P3 — MCP + UI | pairing (code TTL→token), 12 outils MCP, UI 16 écrans + Onboarding, benchmark anti-fuite | ✅ |
| P4 — Import + vectoriel | importeur OpenClaw legacy, transcripts Claude Code/Codex (job daemon, reprise, état `interrupted`), sqlite-vec + recall hybride RRF, index nommé (dimensions, modèle), auto-import launchd toutes les 6 h | ✅ |
| P5 — Partage gouverné | review-first, partage par référence, matrice Partage, **écriture directe des agents dans `user`** (27/08), hard-delete | ✅ |
| P6 — Couches avancées | graphe/entités/relations/observations, thèmes, récurrences, clusters, auto-skill, révisions, dialectique, adaptateur OpenClaw | ✅ (3D UMAP hors périmètre — ⛔ Néto) |
| Tauri | `Memoria.app` signée Developer ID, icône M (vert/rouge/gris), launchd d'abord, 19 tests Rust | 🟢 (reste notarisation) |

**Benchmark recall (juge du produit)** : ✅ vert — anti-fuite inter-clients = 0, défaut sûr sans contexte,
dormant jamais rappelé, cap tokens. `packages/core/test/benchmark.test.ts`.

## Comportements produit (décisions, telles qu'implémentées ou en cours d'implémentation le 27/08)

### Modes de capture (sélecteur en bas de la barre de gauche, `capture_mode`)
- **Capture auto** (`auto-private`, défaut) : les souvenirs capturés dans les conversations ET ceux
  qu'un agent déclare (`memoria_store_fact`) sont actifs tout de suite.
- **Revue d'abord** (`review-first`) : tout souvenir — capturé **ou déclaré** — naît dormant et attend
  la validation dans l'écran Revue ; aucun agent ne le voit tant qu'il est en attente.
- **Pause** (`incognito`) : rien n'est écrit — la capture est ignorée et `store_fact` répond
  « ignoré : en pause ».
- Distinct du **kill-switch global** (`memoria disable` / toggle Réglages) : toutes les routes mémoire
  répondent alors `200 {disabled:true}` (no-op annoncé, jamais un 404 trompeur).

### Mémoire partagée entre modèles (décision 27/08)
- Chaque agent garde sa mémoire privée. Le scope partagé **`user`** (faits sur l'utilisateur) est
  **lisible ET inscriptible** par défaut pour tout agent (`memoria_store_fact` avec `scope: 'user'`,
  policy `can_write` posée au pairing, migration douce des installations existantes —
  `grantDefaultUserWrite`, `memoria.ts`).
- **Exception** : un agent de type `openclaw` (bot de canal WhatsApp/Telegram, exposé à des tiers)
  reste en **lecture seule** sur `user` → `403` ; ses propositions passent par la Revue.
- Le passage d'un souvenir **privé** vers le partagé reste **manuel** (écran Partage → « Faits sur toi »
  → `shareFacts`). Partager un fait dormant le valide (actif) et clôt son item de revue.
- Refus de policy → `403`, scope inconnu → `404`, scope privé d'un autre agent → `403` ; l'outil MCP
  explique le refus à l'agent (« store it privately and tell the user »).
- Dédup : un fait déclaré n'est dédoublonné qu'en **exact** (dans le même contexte) ; le near-dup
  (Jaccard) reste réservé à la capture automatique, qui compare aussi aux scopes partagés lisibles.

### Moteur d'intelligence
- **Extraction** : OpenAI `gpt-4o-mini` (**recommandé**, badge dans Réglages) · Ollama `qwen2.5:3b`
  (avancé, 100 % local) · LM Studio · Anthropic · OpenRouter. Clé API testée auprès du fournisseur à
  l'enregistrement (`verifyProviderKey`), jamais loggée.
- **Embeddings** : OpenAI `text-embedding-3-small` (1536 dims, recommandé) **ou** Ollama
  `nomic-embed-text` (768 dims, local, avancé) — `POST /v1/admin/llm_embeddings {provider}`,
  `EmbeddingsChooser` (Réglages + Onboarding, détection `machine_caps`, install du modèle en 1 clic).
  Index vec0 nommé par (dimensions, modèle) ; les dormants ne sont pas embeddés avant approbation.
- **Ce qui part au cloud** : le texte des conversations (extraction) et, si embeddings OpenAI, le texte
  de chaque souvenir (indexation). Visible dans Réglages → « Données envoyées au cloud » (journal
  `cloud_send` avec tokens) et « Consommation des modèles » (table `llm_usage`, `GET
  /v1/admin/llm_usage?period=24h|7d|30d|all`, coût estimé `pricing.ts`), et dans `memoria doctor`
  (sections « Données envoyées au cloud (24 h) », « Consommation des modèles (24 h) »).
- **Mode dégradé** : sans moteur, la capture est journalisée (WAL) mais rien n'est extrait ; bannière
  rouge dans le Tableau de bord. La file est traitée au prochain tour capturé de l'agent ou au rejeu
  du WAL au redémarrage (`memoria stop && memoria start`).

### Secrets
- Filtre de redaction **avant** tout stockage (`storeFact` compris) ; valeur dans le **Trousseau macOS**
  ou le **coffre AES-256-GCM** local ; la mémoire ne garde qu'une référence. Jamais en clair dans les
  logs, les réponses aux agents, l'écran ou le réseau.

### Service (daemon) et app bureau
- Service **launchd** (`memoria autostart on`, plist `fr.primo-studio.memoria`, RunAtLoad + KeepAlive,
  attente du verrou au lieu de boucler). `memoria start` fait `launchctl kickstart` si le service
  cible ce stockage (jamais deux daemons) ; `memoria stop` prévient si c'était le service launchd.
- `POST /v1/admin/autostart` → `{ handover: true, mode }` (l'UI affiche « Memoria redémarre… »).
- `GET /v1/health` expose `pid`, `supervisor` (launchd / direct), `built_sha` (le vrai build — la route
  `/v1/admin/version` renvoie le SHA du dépôt, pas du code chargé).
- App Tauri : icône **M** dans la barre de menus (vert actif · rouge éteint · gris démarrage/inconnu),
  « Ouvrir Memoria » ramène la fenêtre, fermer cache l'app, « Démarrer le daemon » désactivé s'il tourne.
- `memoria move --to <dir>` déplace **tout** (bases, registre, config) ; `memoria export` écrit des
  Markdown par thème (`--agent`, `--flat`) **scopes partagés inclus**.

### Connexion des agents
- `memoria pair <type>` (code à coller, TTL 10 min) ou écran Agents → « Détecter » / « Connecter »
  (`agents_detect` / `agents_connect` : pairing + credentials + enregistrement MCP dans le processus
  daemon). OpenClaw : `registerOpenClaw()` lie le plugin `~/.openclaw/extensions/memoria` et pose
  `allowConversationAccess=true`. Déconnexion : `memoria revoke` (jeton) / `memoria delete-agent`
  (efface la DB privée). **Il n'existe pas de commande `memoria connect` / `disconnect`.**
- Identifiants projet/client/org normalisés en slug côté MCP + adaptateur ; `memoria_store_fact`
  hérite du contexte actif.

## 🟢 INSTALLATION RÉELLE (MacBook Pro de Néto, état au 27/08 18:20 — `JOURNAL-2026-08-27.md`)
- Daemon **sous launchd** sur le build `f5109a3`, `/v1/health` ok ; Claude Code + Codex connectés en MCP,
  OpenClaw via l'adaptateur (symlink `~/.openclaw/extensions/memoria`).
- Migrations passées sur les bases réelles : index vectoriels (dims, modèle) réparés, `fact_cognition`,
  policies `user`.
- `Memoria.app` signée, installée dans `/Applications`, M vert. Auto-import launchd toutes les 6 h
  (**remplit la Revue à chaque passage** : tri récurrent à prévoir, cf. TODO).
- Conso 24 h mesurée : gpt-4o-mini 590 appels · 340 k tokens entrés · 120 k sortis ≈ 0,12 $ (import
  planifié de 1 523 fichiers compris). Doctor : 5 révisions à arbitrer.
- ⚠️ Le daemon pointe sur le build du dépôt (`packages/*/dist`) : `memoria stop && memoria start` après
  un rebuild (ou `memoria update`). Autres machines (Mac Studio, iMac) : état non vérifié depuis le 04/08.

## Journal des sessions

### 2026-08-27 — Session 1-3 (PR #20 → #24, 80 commits d'audit) — **980 tests**
Détail complet dans `JOURNAL-2026-08-27.md`. En bref : consolidation 24-25/08 poussée ; daemon
relancé sous launchd ; icône M + app signée ; consommation par modèle ; cache cognitif et boucle LLM
(`fact_cognition`) corrigés ; audit multi-agents 9 dimensions → 6 lanes (mémoire partagée, cognition/LLM,
daemon/CLI, MCP/adaptateur, web, desktop) ; décisions produit (agents écrivent dans `user`, openclaw
lecture seule, dédup exact des déclarations, `forget` borné, `identify_*` borné) ; revue finale
4 lentilles, 4 bloquants corrigés.

### 2026-08-24 / 25 — Consolidation + Phases 1·2·3 (`AUDIT-CONSOLIDATION-2026-08-24.md`,
`JOURNAL-CONSOLIDATION-2026-08-24.md`, `PHASES-1-2-3-2026-08-25.md`) — 686 tests
Audit « très bien fonctionnelle avant features » ; quarantaine triée (23 lots) ; 10 faits partagés dans
`user` ; embeddings OpenAI épinglés ; barre d'état ; P2 UX (i18n, a11y, mobile) ; import auto Claude
Code/Codex ; préparation distribution (signature).

### 2026-08-03 / 04 — Dernier kilomètre (`PASSATION-2026-08-04.md`) — 682 tests
PR #14 → #18 : mise à jour depuis l'UI, embeddings épinglables, adaptateur, autostart.

### 2026-06-11 — Session 5 (readiness test iMac) — 514 tests
Onboarding « Moteur d'intelligence » (`llm_health`, LM Studio, pulls avec progression), détection /
connexion / import d'agents par bouton (job daemon), `memoria import`, `install-memoria.sh` durci,
`memoria ui` = commande par défaut.

### 2026-06-11 — Session 4 (réseau + interlocuteur + install/update) — 430 tests
Écran Personnes + `memoria_identify_interlocutor` ; synchro hub-and-spoke (`SYNC-INTER-MACHINES.md`,
incréments 1-5, second listener LAN `/v1/sync/*`, coffre chiffré GVK) ; `install-memoria.sh` ;
`memoria update` + bouton UI.

### 2026-06-11 — Session 3 (contrôle + visualisation + OpenClaw) — 374 tests
Kill-switch, `delete-agent`, `memoria move`, `memoria autostart`, relations entre thèmes (graphe SVG),
recherche globale, diagnostic OpenClaw 2026.6.5 (`allowConversationAccess`), adaptateur OpenClaw
validé E2E.

### 2026-06-10 — Sessions 1-2 (kickoff + cognition + partage) — 179 tests
Clone, cartographie legacy (`port-map.json`, 106 bugs), scaffolding, core P1, daemon P1, benchmark
recall, vague 2 (secrets, LLM, capture/WAL, MCP, CLI, web, migration), review-first, recall hybride
sqlite-vec, lanceur Tauri, mémoire de Koda récupérée (3 515 faits + graphe), partage gouverné,
couches cognitives bucket B, onboarding + réglages.
