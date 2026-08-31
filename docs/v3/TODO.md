# Memoria V3 — TODO de passation

> **Reprise après une pause : commence par [`00-POINT-DE-REPRISE.md`](00-POINT-DE-REPRISE.md)** — état, décisions en attente, ordre des prochaines actions.

> **But** : reprendre le travail SANS contexte oral. Lire d'abord `STATUS.md` (état mesuré), puis ce
> fichier, puis `DECISIONS-LOG.md`. Spec gelée = `PLAN-Memoria-v3-2026-06-03.md` (dossier dev).
> Carte des agents/mémoires du réseau = `AGENTS-RESEAU.md` (snapshot juin).
> Installer / mettre à jour une autre machine = `INSTALLER-ET-METTRE-A-JOUR.md`.
>
> **Dernière session : `JOURNAL-2026-08-28.md`** — refonte de l'interface sur shadcn/ui (PR #26),
> 16 écrans migrés, ancien CSS supprimé, deux correctifs serveur. Session précédente :
> `JOURNAL-2026-08-27.md` (PR #20 à #24, 80 commits d'audit) — à lire en entier avant de toucher
> `packages/daemon/src/server.ts`, `packages/core/src/engine/memoria.ts`, `packages/mcp/src/serve.ts`
> ou `apps/desktop/src-tauri/src/lib.rs`. Puis `PHASES-1-2-3-2026-08-25.md` et
> `AUDIT-CONSOLIDATION-2026-08-24.md` (contexte), et `PASSATION-2026-08-04.md` § 3-4 (remarques non
> appliquées + pièges de diagnostic, toujours valables).
>
> **Cet inventaire a été refait de bout en bout le 28/08 contre le code et les commandes**, pas
> recopié. Plusieurs consignes de la version précédente étaient fausses ou périmées : elles sont
> corrigées ci-dessous, avec la preuve.

## Reprendre le travail

```bash
cd ~/openclaw-memoria        # branche memoria-v1
npm install && npm run build && npm test   # 100 % vert AVANT toute modif (1 091 tests au 28/08)
memoria stop && memoria start              # le daemon pointe sur packages/*/dist : relancer après un rebuild
```

- Le « juge du produit » = `packages/core/test/benchmark.test.ts` (anti-fuite = 0). Toute évolution du
  recall doit le laisser vert.
- Règle anti « mort silencieuse » : aucun catch muet ; tout chemin actif a un test qui le prouve.
  ~106 bugs legacy documentés dans `port-map.json` — ne pas les réintroduire.
- Règle de session : **test rouge avant correctif**, puis vert ; on regarde l'écran (UI) avant de dire « fait ».
- Auteur git = **Hello-Primo**. `.claude/`, `dist/`, `*.tsbuildinfo` gitignorés.
- ⚠️ `npm test` sous un `HOME` temporaire fait échouer 2 fichiers (`core/test/secrets.test.ts` a besoin
  du Trousseau de la session ouverte, `daemon/test/lock-race.test.ts` est sensible à la charge) : ce
  n'est pas une régression.

---

# ⛳ DÉCISIONS QUI N'APPARTIENNENT QU'À NÉTO

Rien de tout cela n'est du travail technique en attente : ce sont des choix. Tant qu'ils ne sont pas
tranchés, les tâches qui en dépendent sont bloquées, et personne d'autre ne peut décider à sa place.

| # | Décision | Ce qu'elle débloque | Ce qu'il faut savoir pour trancher |
|---|---|---|---|
| D1 | **Nom de version publique** : « Memoria 1.0 » (nouvelle génération) ou « 4.0 » (continuité v3.x) ? | Le tag, les notes de version, la page publique | Ouvert depuis le `DECISIONS-LOG.md` du 10/06, jamais clos. Aujourd'hui **trois numérotations coexistent** : paquets en `0.1.0`, dernier tag `v4.0.0`, produit appelé « V3 ». |
| D2 | **Scope npm** : créer un compte npm et publier sous quel nom ? | La publication des 4 paquets, et donc des installations sans compilation | ⚠️ **`@memoria` ne nous appartient pas** : `npm view @memoria/cli` renvoie un paquet d'un tiers (18 versions). Impossible d'y publier. `npm whoami` → `ENEEDAUTH` : aucun compte n'est même connecté. En revanche `memoria-plugin` est libre. Coût : gratuit, ~1 h de mise en place. |
| D3 | **Notarisation de `Memoria.app`** : feu vert + Apple ID et mot de passe d'application | La distribution de l'app bureau | Mesuré : `spctl -a -vvv -t exec /Applications/Memoria.app` → `rejected · source=Unnotarized Developer ID`, `xcrun stapler validate` → pas de ticket. **Sur le Mac d'un ami, macOS refuse de l'ouvrir.** Memoria fonctionne entièrement sans l'app — ce n'est pas bloquant pour l'usage, seulement pour l'app. |
| D4 | **Renommer le dépôt** `openclaw-memoria` → `memoria` | La cohérence du nom public | Le produit n'est plus un plugin OpenClaw. Attention : le nom du dépôt est écrit en dur dans `install-memoria.sh` et dans toutes les docs ; GitHub redirige, mais il faudra repasser dessus. |
| D5 | **Adaptateur PUSH pour Claude Code** (hooks) : on le fait ou on assume le pull ? | Que la mémoire serve vraiment au quotidien | C'est **le manque qui pèse le plus sur la valeur ressentie**. Aujourd'hui Claude Code et Codex sont en *pull* pur : l'agent doit décider d'appeler `memoria_recall`. Résultat rapporté : ~12 recalls depuis juin pour 11 000+ souvenirs stockés. Les hooks existent déjà… mais **uniquement pour OpenClaw** (`packages/core/src/agents/register.ts:219-268`). |
| D6 | **Ré-extraction payante** (~0,30 $) pour nettoyer les corrélations | Un graphe moins bruité | ⚠️ **Ne pas dire oui tout de suite** : l'outil n'existe pas (aucune commande ni route de ré-extraction, grep vide) et, tant que `reinforceCooccurrence` tourne sans condition, une ré-extraction ajouterait de bonnes relations **par-dessus** le bruit sans le retirer. Il faut d'abord décider du sort des arêtes `related_to` existantes. Voir T13. |
| D7 | **Confirmer les décisions produit du 27/08** (implémentées, réversibles) | Rien — elles tournent déjà | Les agents **écrivent** dans le scope partagé `user` par défaut ; OpenClaw reste en **lecture seule** sur `user` (bot de canal exposé à des tiers) ; « Revue d'abord » et « Pause » s'appliquent aussi aux faits déclarés ; un fait déclaré n'est dédoublonné qu'en exact. Si Néto ne confirme pas : revenir à `can_write=false` par défaut (`grantDefaultUserWrite` + `pairAssistant`, `memoria.ts`). |

---

# 🔴 P0 — Ce qui bloque la diffusion ailleurs

### T1. `main` est figée au 31/03 et montre un autre produit
**Mesuré** : `origin/main` = `4556c4d` (31/03/2026). `git rev-list --count origin/main..origin/memoria-v1`
= **365**. `git rev-list --count origin/memoria-v1..origin/main` = **0** → `main` ne contient
strictement rien d'unique, c'est un **fast-forward pur, sans rien à perdre**. Le README de `main`
décrit l'ancien plugin OpenClaw v3.22.3 (« 21 memory layers ») et `main` n'a même pas `docs/v3/`.

**Pourquoi ça compte** : quiconque ouvre la page du dépôt (un ami, un collègue, Néto sur une autre
machine) lit la description d'un produit qui n'existe plus ; un `git clone` sans `--branch memoria-v1`
récupère du code de mars qui ne compile pas. Le script d'installation s'en sort (il force la branche,
`install-memoria.sh:19`), mais toute lecture humaine du dépôt est trompeuse.

**Effort** : S. `git push origin memoria-v1:main` (fast-forward), puis vérifier la page publique.

### T2. Aucun tag ne repère l'état actuel
**Mesuré** : `git tag --contains HEAD` → vide. `git describe --tags HEAD` → `v4.0.0-272-g973dedf` :
272 commits sans repère. Dernier tag `v4.0.0` du 21/07. Aucun job de release dans
`.github/workflows/ci.yml` (build + test seulement).

**Pourquoi ça compte** : impossible de dire à une autre machine « installe la version X », ni de
revenir en arrière si une mise à jour casse quelque chose — `memoria update` prend toujours le sommet
de la branche. **Dépend de D1.** **Effort** : S.

### T3. `Memoria.app` n'est pas notarisée
Voir **D3**. Signée Developer ID (4QB44XVHNL), hardened runtime, mais aucun ticket. Aucune config de
notarisation dans `tauri.conf.json`, aucune variable `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`,
aucun job en CI. **Effort** : M (process Igara déjà connu).

### T4. Publication npm impossible en l'état
Voir **D2**. 4 paquets prêts (`files:[dist]` + `publishConfig.access=public` déjà posés, web reste
`private`), mais le scope est détenu par un tiers et aucun compte npm n'est connecté.

**Conséquence tant que rien n'est publié** : chaque installation passe par un clone git + compilation
locale, et la commande à coller dans un agent reste un chemin absolu vers
`~/openclaw-memoria/packages/mcp/dist/bin.js`, différent sur chaque poste. **Effort** : M.

---

# 🟠 P1 — Travail à faire (aucune décision requise)

### T5. `memoria doctor` annonce « ✓ OK » sans moteur d'IA configuré
**C'est le pire scénario pour un non-technicien** : la seule commande de diagnostic dit que tout va
bien pendant que rien ne se mémorise.

**Vérifié à trois niveaux** : (1) sortie réelle sur une mémoire vide — aucune section moteur, conclut
« État : ✓ OK » ; (2) `DoctorReport` (`packages/core/src/types.ts:500-519`) n'a **aucun champ**
moteur/fournisseur ; (3) les seuls `warnings.push` de `doctor()`
(`packages/core/src/engine/memoria.ts:3359`, warnings aux lignes 3377-3412) couvrent pause, WAL
bloqué, révisions et latence — jamais l'absence de moteur, donc `ok = warnings.length === 0` reste
vrai. Et le texte d'aide de la commande promet « stockage, **moteur d'IA**, activité… »
(`packages/cli/src/commands/doctor.ts:14`).

**Correction** : ajouter l'état du moteur au `DoctorReport` (fournisseur, modèle, clé présente ou non)
et pousser un avertissement bloquant quand il manque — « Aucun moteur d'IA configuré : Memoria capture
les conversations mais n'en extrait aucun souvenir. Ouvre `memoria ui` → Réglages → Moteur
d'intelligence. » Tant que c'est le cas, `ok` doit être **false**. Ajouter un test qui verrouille :
config sans moteur → `doctor` ne renvoie jamais ✓ OK. **Effort** : S.

### T6. Le message d'échec « dépôt sale » est du git brut en anglais
**Le cas d'échec le plus probable en pratique** : il suffit qu'un agent ou un éditeur ait touché un
fichier du dossier.

**Mesuré, sur les deux canaux** (CLI et bouton de l'UI) : l'échec est **propre** — `exit=1` /
`ok=false`, HEAD inchangé, marqueur inchangé, daemon toujours vivant sur l'ancien build, interface
servie inchangée. Rien n'est cassé à moitié. Le problème est **uniquement le texte** :

```
Command failed: git -C /Users/…/openclaw-memoria pull --ff-only
error: Your local changes to the following files would be overwritten by merge: packages/web/src/App.tsx
Please commit your changes or stash them before you merge. Aborting
```

**Correction** : dans `explainFailure()` (`packages/daemon/src/update.ts:183`, qui ne traduit
aujourd'hui que « npm introuvable » et « git introuvable »), ajouter un cas
`would be overwritten by merge` / `Please commit your changes` → texte français actionnable
(« Ce dossier contient des modifications locales (fichiers : …). Memoria ne les écrase pas. Tape
`cd ~/openclaw-memoria && git stash` puis relance la mise à jour — ou demande à Néto. »), plus un cas
« Not possible to fast-forward » (branche divergente). Faire remonter la liste des fichiers en cause
pour que l'UI l'affiche proprement. **Effort** : S.

### T7. Mise à jour à distance : rien n'existe
**C'est la moitié de la demande de Néto, et elle n'a aucune réponse produit aujourd'hui.**

**Vérifié** : le serveur d'admin écoute en dur sur la boucle locale
(`server.listen(opts.port ?? 0, '127.0.0.1', …)`, `packages/daemon/src/server.ts:1246`) avec en plus
un filtre anti-DNS-rebinding (`isLoopbackHost` / `isAllowedOrigin` → 403). Le second listener, celui
de la synchro entre machines, ne sert **que** `/v1/sync/*` (5 routes : pairing/complete, snapshot,
pull, push, secrets) : il transporte des souvenirs, jamais une commande d'administration.

**Il manque aussi la moitié amont** : recherche exhaustive (`ls-remote`, `fetch --dry-run`, `behind`,
`rev-list`) → **zéro résultat**. Rien ne compare jamais le dépôt local à `origin`, donc **rien ne dit
jamais qu'une nouvelle version existe**. `GET /v1/admin/version` ne renvoie que la version locale.

**Correction, par ordre de coût** :
- (a) **Sans code, tout de suite** : documenter la procédure Tailscale + SSH (`ssh <machine> 'memoria update'`)
  — c'est l'architecture déjà retenue pour l'accès au PC du collègue.
- (b) Ajouter à `currentVersion()` un `git ls-remote origin memoria-v1` avec cache court (1 h) et
  timeout, comparé à HEAD → `{ behind, remote_sha }` ; pastille « Nouvelle version disponible » dans
  Réglages et bouton renommé « Mettre à jour maintenant ». **Coût faible, gain direct.**
- (c) **Propre** : route `POST /v1/sync/update` sur le listener LAN, réservée aux pairs déjà appairés
  (même HMAC que `peer-auth.ts`), déléguant à `pullAndBuild()` + `scheduleRestart()`, plus un bouton
  « Mettre à jour cette machine » en face de chaque machine de l'écran Partage.

**Effort** : S pour (a) et (b), M pour (c).

### T8. Le chemin launchd — le vrai démarrage sur un Mac tiers — n'est validé par aucun test réel
Sur macOS le script fait `memoria autostart on` **sans condition** (`scripts/install-memoria.sh:103`) :
ni question, ni variable d'environnement pour refuser. Comme le label est la constante
`fr.primo-studio.memoria` (`packages/core/src/control/autostart.ts`) et que `launchctl bootout` est
scopé à l'**UID** et non à `$HOME`, toute simulation sur cette machine ferait tomber le service de
production. Le démarrage sous launchd, la reprise après redémarrage et le KeepAlive restent donc
**NON VÉRIFIÉS** en conditions neuves. Les tests existants (`packages/cli/test/install-script.test.ts`)
n'utilisent que de faux outils : ils vérifient la **séquence** des commandes, jamais le vrai launchd.

**Correction** : (1) rendre le script testable — accepter `MEMORIA_SKIP_AUTOSTART=1` et/ou un
`MEMORIA_AUTOSTART_LABEL` surchargeable ; (2) **valider une vraie fois** le chemin launchd sur une
machine jetable (VM ou second compte macOS) **avant** d'installer chez un ami. C'est le seul trou de
couverture restant sur le parcours d'installation. **Effort** : S + une demi-heure de VM.

### T9. Aucune commande de sauvegarde / restauration
**Le manque dont la conséquence est la plus irréversible de toute la liste.** Vérifié : `grep backup`
dans `packages/cli/src` et `packages/daemon/src/server.ts` = **vide**. Il n'existe que le `.backup` de
migration et `memoria move --to <dir>`, qui **déplace** tout. Point ⚪ de `PLAN-vs-REALISE.md`
(Phase 5, §11), ouvert depuis juin.

11 000+ souvenirs, une seule copie, sur un seul disque. Un SSD qui lâche ou un `memoria forget`
malheureux, et la mémoire de tous les agents disparaît. **Effort** : M.

⚠️ Piège à traiter en même temps : `db_registry` stocke des chemins **ABSOLUS**
(`packages/core/src/storage/registry.ts:506`), donc copier un `storage_root` et l'ouvrir fait ouvrir
et migrer les bases **d'origine** — piège avéré pendant la relecture. Toute sauvegarde naïve est
dangereuse tant que ce n'est pas réglé.

### T10. Refus de droits et isolation incomplets sur les faits PARTAGÉS
Six constats du 27/08, tous sur la mémoire partagée `user` devenue inscriptible. **À traiter en
premier : `knownAboutPerson`** — c'est le seul de la série qui touche la promesse n°5 du README
(« isolation client = non négociable, 0 % de fuite »).

- [ ] `packages/core/src/engine/memoria.ts:542` — `knownAboutPerson` n'applique pas
      `passesClientIsolation` : un fait cloisonné sous un client peut ressortir.
- [ ] `packages/daemon/src/server.ts:1011` — les refus de policy dans correct/merge/pin/expiry ne
      passent pas par `mapScopeErrors` → **500 au lieu de 403**.
- [ ] `memoria.ts:1341` — `reinforceFacts` écrit dans la base partagée (used_count,
      relevance_weight, expertise) sur simple `can_read` : un agent en lecture seule modifie le
      classement pour **tous**.
- [ ] `memoria.ts:2482` — `forget` avec `ids` incrémente `matched` par base sans vérifier l'existence
      → **le `dry_run` ment** (1 id réel, 3 bases → `{deleted:0, matched:3}`). Dangereux avant un
      effacement de masse.
- [ ] `memoria.ts:2235` — `shareFacts` ne dédoublonne pas contre la base cible (doublons dans `user`),
      et son `INSERT OR IGNORE` (:2247) laisse dormant un id déjà présent en dormant.
- [ ] `server.ts:981` — le corps de `/v1/memory/store_fact` est relayé tel quel, sans liste blanche.

**Effort** : M.

### T11. Hygiène des données : ~35 Mo morts, dormants réindexés, orphelins
Vérifié sur les bases réelles le 27/08.

- [ ] `packages/core/src/vector/vec-table.ts:97` — tables héritées `vec_index_768` / `vec_index_1536`
      jamais supprimées après migration : 1 024 + 5 285 lignes ≈ **35 Mo morts**.
- [ ] `vec-table.ts:178` — `repairVecIndex` réinsère **tous** les embeddings sans filtre de cycle de
      vie : **4 238 des 5 286 vecteurs** du nouvel index sont des faits **dormants** (quarantaine).
- [ ] `packages/core/src/storage/content.ts:387` — `hardDeleteFacts` laisse des orphelins dans
      `fact_entities` (1 orphelin constaté sur copie réelle).
- [ ] `memoria.ts:689` et `:1783` — aucune garde de concurrence sur `scheduleEmbeddings` /
      `indexEmbeddings` : deux `runAll` peuvent tourner en parallèle sur le même index.
- [ ] `memoria.ts:209` — `grantDefaultUserWrite` est une migration de données **hors framework**,
      rejouée à **chaque** construction de Memoria, par n'importe quel processus (CLI, daemon, tests).
- [ ] `storage/registry.ts:506` — chemins absolus dans `db_registry` (voir T9).

**Effort** : M.

### T12. Deux daemons orphelins tournent depuis le 27/08
**Mesuré aujourd'hui** : deux processus `packages/daemon/dist/bin.js --storage-root
/var/folders/.../memoria-ensure-launchd-{KxO67V,t0Y02j}`, démarrés jeudi 09:00, toujours vivants ;
les dossiers temporaires existent encore. Origine : `packages/daemon/test/lifecycle.test.ts` spawne le
**vrai** `dist/bin.js` dans un processus séparé, et `control-routes.test.ts:169` laisse un premier
daemon jamais fermé.

Chaque `npm test` peut donc laisser des daemons résidents qui gardent des bases ouvertes et brouillent
tout diagnostic (« combien de daemons tournent ? » n'a plus de réponse simple — le piège documenté
dans `PASSATION-2026-08-04.md` § 4). Sur une machine tierce, ça donne un produit qui a l'air de fuir.
*(Ceux-là n'ont pas été tués : la session qui les a lancés n'est pas celle qui écrit ces lignes.)*
**Effort** : S.

### T13. Corrélations bruitées : le `related_to` est structurel, et l'outil de ré-extraction n'existe pas
**Vérifié** : `reinforceCooccurrence` (`packages/core/src/cognition/graph.ts:95-101`) crée une
relation `related_to` pour **chaque paire d'entités** d'un même fait — et elle est appelée dans la
transaction de persistance (`cognition/index.ts:154-160`) **même quand la branche LLM a réussi**, en
plus des relations typées. Sans LLM (ou sur échec, `index.ts:120-134`), on retombe sur
`heuristicEntities` avec `relations: []` → il ne reste **que** du `related_to`. La dominance des
relations heuristiques n'est donc pas un réglage à ajuster : elle est **câblée**.

**Point dur** : aucune commande ni route de ré-extraction n'existe (grep
`reprocess|re-extract|rebuild_graph|backfill` dans `server.ts` et `packages/cli/src` = vide). Les
~0,30 $ chiffrés sont **un plan sans outil**. Voir **D6**. **Effort** : L.

### T14. La Revue se re-remplit à chaque import, et son badge télécharge toute la liste
- [ ] **5 révisions** à arbitrer (source : `memoria doctor` du 27/08 ; non re-mesuré).
- [ ] L'auto-import launchd (toutes les 6 h) **re-remplit la Revue à chaque passage**. Décider :
      bouton « tout approuver pour cet agent » vs tri manuel. Une file qui se remplit plus vite qu'on
      ne la vide finit par ne plus jamais être regardée — et `doctor` reste en avertissement
      permanent, ce qui vide le voyant de son sens.
- [ ] `GET /v1/admin/stats` (`server.ts:698`) n'expose **aucun** `review_pending`, donc
      `App.tsx` fait `getReview().then(items => setReviewCount(items.length))` : **la liste entière
      est téléchargée en boucle** juste pour afficher un nombre. Exposer un compteur.

**Effort** : M.

### T15. Synchro inter-machines : le moteur existe, l'usage réel ne tient pas debout
**Existe et testé** : incréments 1 à 5 (provenance + merge LWW, auth machine-à-machine HMAC,
pull/push + curseur, coffre GVK, bootstrap 1 commande), routes `/v1/sync/*` LAN + `/v1/admin/sync/*`,
7 sous-commandes CLI (`status`, `init-hub`, `invite`, `join`, `now`, `revoke`, `leave`).

**Manque pour s'en servir vraiment** :
- [ ] Incrément 6 : relais NAS de secours et `sync verify` (réconciliation / anti-dérive) — absents.
      Sans eux, le risque assumé par la spec (perte du hub = état canonique perdu) n'a aucun filet.
- [ ] `sync rotate-key` absent : aucun moyen de faire tourner la clé du groupe si une machine est perdue.
- [ ] Aucune découverte réseau (pas de mDNS/Bonjour) → il faut connaître et taper l'IP:port du hub à
      la main, et cette IP change au gré du DHCP.
- [ ] `SyncEngine.shareSecret` n'a **aucun appelant** : le partage de secrets n'est branché sur aucun bouton.
- [ ] Machines A (Mac Studio) et B (iMac) : **état inconnu depuis le 04/08** — ni version, ni
      `[llm.embeddings]`, ni `built_sha`. À vérifier sur place (`memoria doctor` + `/v1/health`).

En pratique aucune des trois machines n'est reliée, et le premier `sync join` demandera de connaître
l'IP du hub, d'ouvrir le pare-feu macOS et de vérifier que les deux machines ont le même build : trois
obstacles qu'un non-technicien ne franchit pas seul. **Effort** : L.

### T16. Gateway OpenClaw arrêtée depuis le 24/08
**Mesuré** : le lien de l'adaptateur est en place (`~/.openclaw/extensions/memoria` →
`~/openclaw-memoria/packages/adapter-openclaw`, posé le 24/08 11:33) et `~/.openclaw/openclaw.json`
porte `allowConversationAccess: true`, `allowPromptInjection: true`. Mais **aucun processus gateway ne
tourne** (`ps aux | grep -i openclaw` → rien) ; aucun service launchd OpenClaw dans
`~/Library/LaunchAgents` (seuls les deux plists Memoria y sont).

La branche OpenClaw/Koda du réseau d'agents est donc morte depuis 4 jours : rien n'est capturé côté
WhatsApp/Telegram, la décision produit du 27/08 (OpenClaw en lecture seule sur `user`) n'est plus
exercée par personne, et le code de l'adaptateur n'est plus testé en conditions réelles.
**Effort** : S.

### T17. 18 alertes Dependabot — ⚠️ l'ancienne consigne était FAUSSE
**Le TODO et le STATUS précédents disaient** : « 18 alertes sur `main` (branche figée depuis mars) →
remettre `main` au niveau de `memoria-v1` ». **C'est faux, et le remède ne soigne rien.**

**Mesuré** : `gh api /repos/Primo-Studio/openclaw-memoria/dependabot/alerts` → 18 alertes ouvertes
(4 high, 12 medium, 2 low) sur hono ×7, fast-uri ×3, ip-address ×3, postcss ×2, @hono/node-server,
body-parser, esbuild. Ces 6 paquets ont **0 occurrence** dans le `package-lock.json` de `main`
(18 Ko, 42 entrées) et **1 chacune** dans celui de `memoria-v1`. **Aligner `main` laissera les 18
alertes debout** (le faire reste juste — voir T1 — mais pour une autre raison).

**Bonne nouvelle sur le risque réel** : traçabilité faite. hono / ip-address / fast-uri / body-parser
arrivent tous par `@modelcontextprotocol/sdk@1.30.0` (express, ajv, @hono/node-server) — **chemins
serveur HTTP jamais instanciés**, `packages/mcp/src/serve.ts:766` n'utilise que
`StdioServerTransport`. postcss et esbuild viennent de vite 7 / vitest 4 (outillage de build).
**Surface d'exécution réelle : nulle.** Restent 18 pastilles rouges sur la page publique et des PR
Dependabot qui continuent d'arriver.

**Correction** : des `overrides` existent déjà dans le `package.json` racine (fast-uri, hono,
body-parser, esbuild) et **n'ont pas fait tomber les alertes** — il faut de vraies montées de version,
ou une montée du SDK MCP. `npm audit` sur `memoria-v1` : 6 paquets vulnérables, `fixAvailable: true`
partout. **Effort** : S.

---

# 🟡 P2 — Ensuite

### T18. Portabilité et confort de l'installation
- [ ] `install-memoria.sh:73` fait `npm install` alors qu'un `package-lock.json` de 238 Ko est
      versionné : le lock peut être réécrit et des versions différentes de celles sur lesquelles les
      1 091 tests sont verts peuvent être résolues. → `npm ci`, avec repli sur `install` si le lock
      est désynchronisé. Installation reproductible, et généralement plus rapide.
- [ ] `install-memoria.sh:74-75` : le `npm run build` ne pose **jamais** le marqueur de build, donc
      `/v1/health` renvoie `built_sha: null` après une installation neuve — on ne peut pas savoir à
      distance quelle version tourne chez l'ami tant qu'il n'a pas lancé `memoria update`. →
      `git -C $DEST rev-parse HEAD > .memoria-built-sha` à la fin du build, ou mieux : que le daemon
      calcule `built_sha` depuis le HEAD git quand le marqueur est absent.
- [ ] Prérequis Node : donner le lien direct du `.pkg` macOS Apple Silicon et une phrase simple
      (`install-memoria.sh:47`). Outils Apple : écrire **la commande complète à recopier** dans le
      message de relance (`:38`) — le `curl | sh` d'origine n'est plus sous les yeux après 5 min
      d'attente et un Terminal fermé.
- [ ] `memoria pair` : ajouter « (copie-colle la ligne ci-dessus telle quelle dans le chat de
      l'agent, tu as 10 minutes) » et, si possible, `pbcopy` avec confirmation « ✓ commande copiée ».
      La ligne fait ~200 caractères et commence par un chemin absolu : impossible à retaper.
      (`packages/cli/src/commands/pair.ts`)
- [ ] Plist d'auto-import portable : `scripts/fr.primo-studio.memoria.autoimport.plist` code en dur
      `/Users/primostudio/openclaw-memoria/…` et `auto-import.sh:16-17` code en dur
      `/Users/primostudio/.nvm/versions/node/v22.22.2/bin/node`. **Sur toute autre machine, l'import
      automatique ne tourne jamais, en silence.** Et aucune commande `memoria autoimport` n'existe
      (grep vide) → la générer depuis la CLI avec `$HOME` et le node courant.
- [ ] Service launchd et chemin Node en dur : `daemonProgramArguments()`
      (`packages/daemon/src/client.ts:201`) inscrit `process.execPath`, soit
      `/Users/primostudio/.nvm/versions/node/v22.22.2/bin/node` (vérifié par `ps` sur le service
      réel). Six versions de Node cohabitent sous nvm sur ce Mac : le jour où celle-là est supprimée,
      le service ne démarre plus au login — et `memoria update` ne répare pas, puisque son
      redémarrage passe par ce même Node. → vérifier l'existence du chemin au démarrage et le
      signaler dans `doctor` ; réécrire le plist si le chemin devient invalide.

### T19. Marqueur de build, versions affichées, redémarrage
- [ ] **Normaliser le marqueur** : `gitSha()` (`packages/daemon/src/update.ts:117`) produit du SHA
      **court**, `lastBuiltSha()` (:159) renvoie le contenu brut, `needsRebuild()` (:179) compare en
      égalité stricte. Or le `.memoria-built-sha` de production contient le SHA **long** (41 octets,
      posé à la main par une session précédente) → `rebuilt=true` à **chaque** appel : npm install +
      build + redémarrage du daemon même quand il n'y a rien de neuf, avec le message trompeur
      « Aucune nouveauté, mais le build était en retard sur les sources — reconstruit ».
      → `raw.slice(0, 7)` dans `lastBuiltSha()` (ou comparaison par préfixe). En attendant, sur cette
      machine : `git rev-parse --short HEAD > ~/openclaw-memoria/.memoria-built-sha`.
- [ ] `packages/web/src/screens/Settings.tsx:701` : `setNote(r.message + (r.changed ? … ))` et le
      rafraîchissement de version sont conditionnés à `r.changed`, alors que le daemon planifie son
      redémarrage sur **`r.rebuilt`** (`server.ts:1013`). Dans le cas « pas de nouveauté git mais
      build en retard » — exactement celui que provoque le point ci-dessus — l'utilisateur ne voit
      pas le rappel « recharge cette page dans ~10 s » pendant que le service coupe.
      → remplacer les deux `r.changed` par `r.rebuilt`.
- [ ] `GET /v1/admin/version` (`server.ts:998`) renvoie le SHA du **dépôt**, pas du build chargé ;
      seul `/v1/health.built_sha` dit la vérité, et l'UI ne l'affiche pas. → renvoyer aussi
      `built_sha` et l'afficher dans `VersionFoot` (écart dépôt / build).
- [ ] `scheduleRestart` (`update.ts:262`) transmet `--storage-root` mais **pas** `--config` : sans
      effet sur une installation standard, mais une machine lancée avec un `--config` personnalisé
      redémarrerait sur la mauvaise configuration après une mise à jour.
- [ ] Port stable persisté dans `config.toml` (réutilisé par `ensureDaemon` et le plist) +
      `admin_token` stable dans `storageRoot/admin_token` : aujourd'hui le port change à chaque
      démarrage (mesuré : 56414 aujourd'hui, 56775 le 27/08) et il faut refaire l'appairage de l'UI
      après chaque mise à jour. **Pour un non-technicien à distance, c'est le moment exact où il
      abandonne.**

### T20. Planificateurs jamais déclenchés
- [ ] `decayCognition()` existe mais **n'a aucun appelant** : ni `setInterval` quotidien, ni option
      `memoria doctor --decay`. Le graphe et les poids de pertinence ne vieillissent donc jamais — les
      anciennes corrélations gardent le même poids que les récentes, ce qui **aggrave le bruit de T13**.
- [ ] Le WAL n'est rejoué qu'au démarrage du daemon ou au prochain `capture_turn` : quand le moteur
      redevient disponible après une panne (clé expirée, Ollama éteint), la file reste en attente sans
      que rien ne le signale. → rejeu sur `POST /v1/admin/llm_extraction` ou sur un tick `llm_health`.

### T21. Six routes servies sans aucun client
Vérifié par recoupement des 93 routes de `server.ts` avec **tous** les appelants (web, CLI, MCP,
adaptateur, client daemon) : `POST /v1/admin/adopt_legacy`, `GET /v1/admin/clusters`,
`POST /v1/admin/dialectic`, `GET /v1/admin/skill_proposals`, `GET /v1/admin/sync/peers`,
`POST /v1/memory/merge` → **aucun appelant**. Du code authentifié, testé, maintenu, que rien n'appelle.
`skill_proposals` en particulier propose des compétences que personne ne peut accepter (pas de route
`skill_accept`) : la couche auto-skill tourne dans le vide. → brancher (outil MCP / écran) ou retirer.

*(Correction d'un faux positif : `review/approve` et `review/reject` **sont** utilisées, via le
gabarit `api.ts:865`. Et aucun écran web n'est orphelin : les 16 fichiers de `packages/web/src/screens/`
ont tous une entrée de navigation.)*

### T22. Isolation client / projet incomplète
Slugification des identifiants de contexte faite le 27/08 (MCP + adaptateur). Manque : le **mapping**
des identifiants reçus contre le registre (rien ne vérifie qu'un `project_id` ou un `client_org_id`
envoyé par un agent correspond à une entrée réelle), et l'isolation **projet → client**
(`passesClientIsolation` ne regarde que `client_org_id`, pas la chaîne projet→client).

Le benchmark anti-fuite reste vert sur le cas testé, mais un agent qui déclare un `project_id` inventé
ou mal orthographié crée un **contexte fantôme** sans avertissement : les faits y sont écrits et ne
remontent plus jamais. Avec plusieurs clients réels, c'est le genre de dérive qui ne se voit
qu'après coup.

### T23. `secret_access` / `getSecretRef` : promis dans le plan, absent de bout en bout
Le type `SecretAccess = 'none' | 'refs_only' | 'value_on_request'` existe
(`packages/core/src/types.ts:23`), la colonne existe (`registry-schema.ts:108`), la policy est
stockable et modifiable (`registry.ts:460-489`, `memoria.ts:2528`). Mais la valeur est posée à `'none'`
à l'appairage (`memoria.ts:326` et `:337`) et **aucun `getSecretRef` n'existe nulle part** : aucune
route daemon, aucun outil MCP, aucun écran. Point ⚪ §9 de `PLAN-vs-REALISE.md`.

Le coffre stocke donc des secrets qu'aucun agent ne peut jamais demander, et la matrice de permissions
affiche une colonne qui ne pilote rien : un utilisateur peut croire avoir accordé un accès qui
n'existe pas. → faire, ou retirer la colonne.

### T24. Tests non discriminants, dépendants du poste, ou qui fuient sur le réseau
Les 1 091 tests verts rassurent moins qu'ils ne le devraient : plusieurs ne casseraient pas si le bug
revenait. C'est la classe de pannes « qui n'apparaissent jamais en CI » — et c'est ce qui mordra sur
la machine d'un ami.

- [ ] `daemon/test/lifecycle.test.ts` spawne le vrai `dist/bin.js` hors de portée de la garde
      anti-LLM-local (source des daemons orphelins, T12).
- [ ] `core/test/llm-profile-refresh.test.ts` émet un vrai `POST http://127.0.0.1:11434/api/chat`
      (trace mesurée).
- [ ] `daemon/test/sync-http.test.ts` fixe le port LAN **47733** au lieu du port 0.
- [ ] `cli/test/auto-import.test.ts:136` ne vérifie que le **suffixe** du chemin du plist : il ne
      verra donc jamais les chemins codés en dur `/Users/primostudio/…` (T18).
- [ ] `daemon/test/killswitch-http.test.ts` vérifie le champ de réponse mais pas l'état en base.
- [ ] `daemon/test/recall-dormant-guard.test.ts` passerait même si le correctif était absent.
- [ ] `mcp/test/mcp.test.ts:445` lit des internes privés du SDK MCP (`_registeredTools`) : cassera à
      la prochaine montée de version.
- [ ] **Aucun test de composant React** (les tests web couvrent `api.ts` et des helpers purs) —
      jsdom / @testing-library avaient été écartés comme dépendance nouvelle. À rediscuter.

*(Points propres, à ne pas chercher : **zéro** `TODO` / `FIXME` dans tout le code source, et un seul
`describe.skipIf` — Keychain macOS, conditionnel légitime.)*

### T25. UI — P2 restants après la refonte
Après la refonte shadcn/ui du 28/08 (16 écrans migrés, 2 P0 mobiles corrigés, contrastes mesurés,
ancien CSS de 1 406 lignes supprimé), il reste :
- [ ] Recherche **au frappé** dans Mémoire (formulaire à soumission aujourd'hui).
- [ ] `humanError()` non appliqué partout — `Maintenance.tsx:60` affiche `err.message` brut, y compris
      un 401.
- [ ] Pas de piège de focus ni de verrou de défilement sur le menu hamburger (`App.tsx:125`).
- [ ] `CaptureModeSwitch` (`App.tsx:282`) garde la valeur optimiste si le daemon tombe.
- [ ] `fmtUsd` (`Settings.tsx:645`) suffixe « $ » en dur dans les 5 langues.
- [ ] Clés i18n mortes (`onboarding.agent.copied`, `patterns.service_unavailable`,
      `procedures.error_service`…).
- [ ] Actions d'audit `store_fact_dedup` et `grant_user_write_default` absentes de `KNOWN_ACTIONS` et
      des 5 catalogues → elles s'affichent **en brut** dans le Journal.
- [ ] Toast après action, bouton « Exporter maintenant », empty-states actionnables (Thèmes,
      Récurrences).
- [ ] **Écran Organisations & projets** (créer une org cliente, un projet, des scopes) : n'existe pas
      alors que la logique core est prête. Sans lui, toute structuration multi-clients passe par la
      CLI — ce que Néto ne fera pas.

### T26. Textes personnels et français en dur dans l'interface livrée
Le dépôt et l'app sont publics (Apache-2.0, README anglais).
- [ ] `packages/web/src/messages/fr.ts` — `settings.sync.makeHubDesc` cite une machine personnelle
      nommée, en fr/en/es/pt (préexistant à la refonte).
- [ ] `apps/desktop/src-tauri/src/lib.rs` — les infobulles de la barre de menus sont **100 %
      françaises** (« Memoria — vérification… », « état inconnu : {e} », « démarrage échoué :
      {error} ») dans un produit annoncé en 5 langues.
- [ ] `scripts/install-memoria.sh` — l'en-tête et le message final citent des machines et des
      personnes par leur nom.

### T27. Dérive documentation ↔ code
- [x] **Corrigé le 28/08** : l'attribution des 18 alertes Dependabot à `main` (fausse — voir T17) ;
      le comptage « 28 commandes CLI » (27) ; « 5 écrans Essentiel + 11 Avancé » (3 groupes :
      5 + 4 + 7) ; « 980 tests » (1 091).
- [x] **Item périmé, retiré** : « commentaire d'en-tête de `packages/cli/src/commands/sync.ts` :
      sous-commande `peers` inexistante ». Vérifié — l'en-tête (l.1-11) liste
      `init-hub | invite | join | now | status | revoke | leave`, **sans `peers`** ; le mot n'apparaît
      dans le fichier que comme champ de `syncStatus` (l.32-38). Rien à faire.
- [x] **Item partiellement périmé** : le `--help` de `memoria doctor` a été mis à jour — il annonce
      désormais « stockage, moteur d'IA, activité, consommation des modèles »
      (`packages/cli/src/commands/doctor.ts:14`). Mais il **promet le moteur d'IA que le rapport ne
      contient pas** : c'est devenu la preuve n°3 de T5, pas un item séparé.
- [ ] Reste vrai : `onboarding.engine.ollamaHint` dit encore « Recommandé » pour Ollama alors que
      Réglages et Docs recommandent OpenAI.

---

## ⛔ Hors périmètre (Néto, 24/08, toujours valable)
Carte 3D UMAP, continuous-learning OpenClaw (`llm_output`), **et toute nouvelle feature avant la
distribution**.

## ✅ Fait (résumé — détail dans STATUS.md et les journaux)
Fondation V3, 24 couches cognitives, recall hybride sqlite-vec + graphe, capture WAL-first, redaction
+ Keychain/AES, review-first, pairing, partage gouverné + écriture directe dans `user`, 16 écrans UI
en 5 langues **refondus sur shadcn/ui**, 12 outils MCP, 27 commandes CLI, adaptateur OpenClaw,
synchro hub-and-spoke incréments 1-5, Personnes, install 1 commande, `memoria update`, onboarding
moteur, détection/connexion/import d'agents, consommation par modèle + journal cloud, launchd d'abord,
icône M, app signée, import auto launchd, `fact_cognition`, index vectoriel (dims, modèle).
Import des mémoires : Koda (3 515 faits + graphe), transcripts Claude Code/Codex (1 523 fichiers le
27/08), quarantaine triée le 24/08 (re-remplie depuis, cf. T14).

## Pièges connus
- bm25 NON comparable entre DB → scoring fan-out = couverture de requête (`content.ts searchFacts`).
  Ne pas « simplifier ».
- FTS5 : maintenance par TRIGGERS uniquement (pas de rebuild manuel sans rowid).
- Embeddings : `model` + `dimensions` obligatoires, comparaison inter-dim interdite (cosine throw) ;
  index nommé `(dims, modèle)`.
- Mode JSON Ollama : demander un OBJET `{"facts":[...]}`, pas un tableau nu (petits modèles).
- Le daemon pointe sur le build du dépôt : `memoria stop && memoria start` après un rebuild ; vérifier
  `built_sha` dans `GET /v1/health` (la route `version` lit le dépôt, pas le build).
- `autostart on` puis `start` : `start` passe par launchd (kickstart) — ne pas spawner à la main.
- ⚠️ Le label launchd `fr.primo-studio.memoria` est une **constante** et `launchctl bootout` est scopé
  à l'**UID**, pas à `$HOME` : on ne peut PAS tester le chemin autostart dans un HOME temporaire sans
  couper le service de production. Voir T8.
- Migration : toujours `.backup` (snapshot cohérent) côté source, jamais toucher l'original.
- `db_registry` stocke des chemins **absolus** : copier un `storage_root` et l'ouvrir fait travailler
  sur les bases **d'origine**. Voir T9/T11.
- Plusieurs machines, deux copies du dépôt par machine, logs trompeurs : `PASSATION-2026-08-04.md` § 4.
- Commandes qui n'existent PAS (docs anciennes) : `memoria connect` / `disconnect`, `npx @memoria/web`.
- Clés i18n en double après une fusion par union → le build Vite échoue sur « Duplicate key ».
  Toujours dédoublonner après une union de catalogues.
