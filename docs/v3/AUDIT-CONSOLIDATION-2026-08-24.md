# Memoria — Audit de consolidation (2026-08-24)

> **Demande de Néto** : analyser ce que Memoria fait et ce qui manque pour qu'elle soit
> **déjà très bien fonctionnelle**, AVANT de se lancer sur de nouvelles features.
> Conclusion en une phrase : **le code est mûr (~90 % du plan, 682 tests verts au 04/08) ;
> ce qui manque n'est PAS des features, c'est le « dernier kilomètre » — faire tourner
> l'existant de façon fiable, l'activer, et le distribuer.**

## A. Ce que Memoria fait (la valeur)
Mémoire long terme partagée pour agents IA (Claude Code, Codex, OpenClaw), locale et gouvernée :
- **Capture** de faits depuis les conversations (WAL-first, extraction LLM, review-first), **redaction
  des secrets** (jamais en clair, coffre Keychain/AES).
- **Recall** hybride : plein-texte (FTS5) + **vectoriel** (sqlite-vec) + **expansion par graphe**
  (entités/relations/observations), avec **anti-fuite inter-clients = 0** (le juge du produit).
- **Gouvernance** : partage par référence (privé → user/org), matrice « qui lit quoi »,
  hard-delete, audit neutre, pause/incognito.
- **Multi-machines** : synchro hub-and-spoke, coffre partagé chiffré, jamais en clair sur le réseau.
- **Interlocuteur** : `person_identifiers` (tel/mail/**Telegram/WhatsApp**/handle) → `identifyInterlocutor`.
- **Desktop** : Memoria.app + DMG. **UI web 14 écrans**. Connexion d'un agent en **1 commande**.

> ⭐ Lien avec le projet « assistant pour l'ami » : la brique **mémoire** existe déjà, et elle sait
> déjà rattacher un **identifiant Telegram/WhatsApp à une personne**. C'est exactement le socle visé.

## B. État réel aujourd'hui (mesuré sur ce poste)
> **Machine = MacBook Pro « MacBook-Pro-de-Primo.local », 192.168.1.23.** Ce n'est NI la Machine A
> (Mac Studio Koda, `.98`, dev dans `~/Documents/BADETTER/`) NI la Machine B (iMac, `~/Documents/
> BADETTE_Robert/`) de la passation : **c'est un 3ᵉ poste**, sans copie dev — seulement le runtime
> `~/openclaw-memoria`. (Rappel règle projet : toujours nommer la machine quand on rapporte une mesure.)
> Ce doc est écrit dans la **copie runtime** — à reporter dans la copie dev le cas échéant.

- ✅ Daemon actif : pid 91870, port 52999, `/v1/health` → `ok:true`. **MCP Claude Code branché**.
  ⚠️ **Adaptateur OpenClaw NON branché ici** (`~/.openclaw/extensions/memoria` absent).
- ✅ Node v22.22.2 (ABI 127, cohérent avec better-sqlite3).
- 🔴 **Machine à moitié migrée (état que J'AI créé aujourd'hui)** : j'ai récupéré les **60 commits**
  de retard (`git merge --ff-only`), mais **le build n'est pas refait** — `packages/daemon/dist` et le
  daemon en mémoire sont encore l'**ancien code**, et `.memoria-built-sha` est absent (HEAD=`6fb0bcf`).
  Conséquence directe : le daemon tourne l'**ancien `update.ts`** (`changed = before !== after`) ; comme
  le `git pull` est déjà fait, **le bouton « Vérifier et mettre à jour » de l'UI va répondre « Déjà à
  jour » sur un build périmé** (c'est exactement le 2ᵉ bug de #14). **Correctif = rebuild en Terminal**
  (`npm install && npm run build && memoria stop && memoria start`). ⚠️ `autostart` a `KeepAlive` :
  toute mort du daemon recharge l'ancien dist tant que le rebuild n'est pas fait.
- ⚠️ `~/.memoria/config.toml` : `[llm.extraction] gpt-4o-mini` présent, **`[llm.embeddings]` absent**
  → les embeddings partent en OpenAI par le **repli `cloudAllowed`**, pas par un choix épinglé
  (risque de base hétérogène = recall faux). Trou déjà documenté dans la passation 04/08.
- ℹ️ Lignes git : `main` figée en mars (v3.34) ; ligne vivante = **`memoria-v1`** (141 commits devant).
  Le tag **`v4.0.0`** (21/07) est **sur `memoria-v1`** (pas une release parallèle) ; la branche a
  continué au-delà jusqu'à `6fb0bcf` (04/08).
- ✅ **MESURÉ sur ce poste** (Node v22, aujourd'hui) : `tsc -b` + vite **compilent sans erreur**,
  **682 tests / 64 fichiers PASSENT** (8 s). Pas de souci ABI better-sqlite3. Le « produit mûr » est
  donc vérifié ici, pas seulement cité.
- ✅ **Demi-migration résolue aujourd'hui** : rebuild fait + marqueur `.memoria-built-sha` posé +
  **daemon redémarré** → nouveau pid 6068, `/v1/admin/version` = SHA **`6fb0bcf`** (le code à jour tourne
  enfin). (Le port a changé 52999→59062 ; MCP/adaptateur le redécouvrent via `daemon.json`.)
- 📊 **Mémoire réelle en base (mesurée)** : **5787 faits**, 7 bases, 6 instances. Détail dormants
  (quarantaine à trier) : **Codex 1245 + Claude Code 1021 = 2266 dormants** (identique à août → rien
  n'a été trié depuis) ; **Koda (openclaw) 3515 actifs** (déjà adoptés). 3 bases vides. NB : ces
  instances ont `machine_id = MacBook-Pro-de-Primo.local` → **c'est ce poste qui héberge la mémoire
  principale**, pas seulement un client.

## C. Ce qui manque pour être « très bien fonctionnelle » (= consolidation, PAS features)
Classé par priorité. Rien ici n'est une nouvelle fonctionnalité — c'est rendre l'existant solide.

### P0 — Aligner le runtime sur le code (sinon on juge un vieux build)
1. Sur **chaque machine**, rebuild + redémarrage des **deux** copies du dépôt (dev + runtime) :
   `cd ~/openclaw-memoria && git pull && npm install && npm run build && memoria stop && memoria start`.
   → active enfin le bouton MAJ fiable, l'autostart vérifié, les correctifs de l'adaptateur.
2. **Redémarrer le gateway OpenClaw** pour charger le nouvel adaptateur (coupe les sessions en cours).
3. Épingler les embeddings dans `config.toml` :
   `[llm.embeddings] provider="openai" model="text-embedding-3-small"`. Graver la règle
   **« OpenAI partout, pas de local »** (parc pas assez puissant) dans l'onboarding/health.

### P1 — Combler la dette de tests du « dernier kilomètre » (la vraie leçon d'août)
Les pannes qui blessent l'utilisateur (install / update / autostart / service launchd / chemins
système) **n'apparaissent jamais en CI**. Deux bugs consécutifs sont passés car `update.ts` n'avait
**aucun test** ; `autostart.ts` a refait la même démonstration le lendemain. À couvrir en priorité :
`update.ts`, `control/autostart.ts`, `daemon/src/static.ts`, `core/src/engine/scoring.ts`,
`core/src/sync/{peer-auth,secrets-sync,clock}.ts`, `mcp/src/bin.ts`, `cli/commands/export.ts`.
Règle : **le code de sortie de launchctl/npm ne prouve rien** — vérifier l'état réel après action.

### P1 — Activer la mémoire déjà capturée (elle est là mais dormante)
- **Trier la quarantaine** : **2266 faits dormants confirmés live aujourd'hui** (Claude Code 1021 +
  Codex 1245 ; rien trié depuis août). Décision Néto : « Tout approuver » par agent (rapide, un peu de
  bruit mais ranké) vs tri sélectif.
- **Partager les faits sur Néto** : écran Partage → `suggestIdentityFacts` (≈50 candidats/agent) →
  cocher → `shareFacts` vers `user`. Sans ça, chaque agent re-découvre les mêmes préférences.

### P2 — Enlever les pièges structurels (temps perdu récurrent)
- **Deux copies du dépôt par machine** (dev `~/Documents/…` vs runtime `~/openclaw-memoria`) :
  source n°1 de confusion. **Décision à trancher** : unifier (symlink) ou garder + discipline.
- **Isolation client/projet non réellement configurée** : `projectId/clientOrgId/orgId` absents (A)
  ou nuls (B, 0 projet/0 client) → l'isolation annoncée **ne fait rien**. La configurer pour de vrai
  OU ne pas la compter comme acquise.
- **Sync flaky** (préexistant) : `sync-engine`/`sync-http` se disputent le Keychain réel + port LAN
  fixe 47733 → passer ces tests sur `aes-vault` + port 0.

### P2 — Distribution (condition pour installer ailleurs, ex. chez l'ami)
- **Publier npm** (`@primo-studio/memoria`) : tant que non publié, tout passe par des chemins locaux
  `node ~/openclaw-memoria/...` → install fragile et non distribuable à un tiers.
- **Signer/notariser `Memoria.app`** (process Igara) + Node embarqué → app installable proprement.

### P3 — Finitions du plan initial encore ⚪ (petits blocs, pas des features neuves)
- **Backup/restore** général (Phase 5 : seul le backup de migration existe).
- **Cron `decayCognition`** quotidien (méthode prête, il manque juste le scheduler).
- **`getSecretRef` / `secret_access: value_on_request`** de bout en bout (engine→daemon→MCP).

## D. Ce que je NE ferais PAS maintenant (ce sont des features, pas de la consolidation)
À garder pour APRÈS que A–C soit solide : carte **3D UMAP**, **clusters**, **couches D** (auto-skill),
hooks **continuous-learning** (`llm_output`) et `after_compaction`, relais **NAS QNAP** pour le sync.

## Ordre conseillé pour « déjà très bien fonctionnelle »
1. **P0** (runtime aligné + embeddings épinglés) — quelques commandes, effet immédiat.
2. **P1 tests dernier kilomètre** + **activer la quarantaine/partage** — la mémoire devient utile.
3. **P2 pièges + distribution npm/app** — condition pour installer ailleurs (l'ami).
4. Ensuite seulement : nouvelles features (section D).
