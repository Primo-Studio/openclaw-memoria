# Moteur Memoria par ABONNEMENT (sans clé API) + industrialisation de l'install

> **Date** : 2026-09-03. **Contexte** : réparation + installation de Memoria chez un ami de Néto
> (Lucien), PC **Windows 11**, à distance en SSH. Objectif produit : Memoria doit **fonctionner avec
> un abonnement existant** (Claude ou ChatGPT), **jamais** une clé API payante en plus, et **pas** de
> modèle local (machine trop faible). Ce document sert de base pour une **meilleure implémentation**
> et vaut pour **Windows ET macOS**.

---

## 1. Le constat technique (ce que le moteur sait faire aujourd'hui)

La couche moteur vit dans `packages/core/src/llm/`. Providers réels : `openai`, `openrouter`,
`anthropic`, `ollama`, `lmstudio`.

**L'authentification est TOUJOURS une clé API :**
- `openai.ts` → en-tête `Authorization: Bearer <clé>`, clé lue via param > `OPENAI_API_KEY` >
  `~/.openai/api_key`. `base_url` **surchargeable** (endpoint compatible OpenAI).
- `anthropic.ts` → en-tête `x-api-key: <clé>`, clé via param > `ANTHROPIC_API_KEY` >
  `~/.anthropic/api_key`. `base_url` surchargeable.
- `ollama` / `lmstudio` → local, compatible OpenAI via `base_url`.
- `detect.ts` ne lit que des profils **`type: api_key`** (y compris ceux d'OpenClaw). **Aucun
  jeton OAuth d'abonnement n'est réutilisé.**

**Donc, tel quel, Memoria ne peut PAS utiliser un abonnement ChatGPT ou Claude.** Il lui faut une
clé API, ou un **endpoint HTTP compatible OpenAI** (le hook `base_url`, déjà documenté pour LM Studio).

Les **embeddings** sont **optionnels** : provider ∈ `ollama|openai`. Absents → « recherche par mots-clés
seule » (l'extraction et le stockage fonctionnent quand même). C'est un warning, pas une panne.

---

## 2. La solution retenue aujourd'hui : un PONT abonnement → OpenAI (PoC validé)

Puisque `base_url` accepte tout endpoint compatible OpenAI, on interpose un **petit pont HTTP local**
qui délègue à un **CLI d'agent déjà connecté par abonnement**.

- Fichier : `scripts/subscription-bridge/bridge.mjs` (Node, ~100 lignes, sans dépendance).
- Écoute `127.0.0.1:11435`, route `POST /v1/chat/completions`.
- Concatène les messages → lance `claude -p` en **headless** (abonnement **Claude**, aucune clé) →
  renvoie une réponse **au format OpenAI** (`finish_reason:"stop"`).
- Configurable : `MEMORIA_BRIDGE_CMD` (JSON) pour viser un autre CLI (ex. ChatGPT via `codex`),
  `MEMORIA_BRIDGE_PORT`, `MEMORIA_BRIDGE_TIMEOUT_MS`.

**Config Memoria côté client** (`~/.memoria/config.toml`) :
```toml
[llm]
profile = "custom"
[llm.extraction]
provider = "openai"
model = "subscription-bridge"
base_url = "http://127.0.0.1:11435/v1"
# pas de [llm.embeddings] → recherche par mots-clés (assumé)
```
Plus une **clé factice** `~/.openai/api_key` = `sk-local-bridge-dummy` (le provider `openai` de
Memoria refuse de démarrer si `apiKey === null` ; le pont ignore l'auth).

**Preuve (03/09, machine de Lucien)** : requête d'extraction envoyée au pont →
`{"faits":["L'utilisateur s'appelle Lucien.","Il travaille dans le secteur du bâtiment.","Il est
basé à Cayenne."]}`. `memoria doctor` affiche désormais **« extraction : openai · subscription-bridge »**.

**Limites du pont (assumées)** : process supplémentaire à garder actif (tâche planifiée), démarrage
à froid de quelques secondes par appel, pas d'embeddings (le CLI ne vectorise pas), qualité = celle
du modèle par défaut de l'abonnement.

---

## 3. La bonne implémentation (à construire ensemble)

Le pont est un **PoC**. La version propre = **un provider natif « abonnement » dans le core**, pas un
process séparé.

### 3.1 Provider `claude-cli` (prioritaire — Lucien a Claude Code 2.1.259 + abonnement)
- Nouveau fichier `packages/core/src/llm/claude-cli.ts` implémentant l'interface `LlmProvider`.
- `complete()` = `spawn('claude', ['-p','--output-format','json'])`, prompt sur stdin, parse la sortie.
- `isAvailable()` = binaire `claude` présent + une petite requête témoin réussie.
- Avantages : **zéro clé, zéro proxy, cross-platform** (le CLI existe sur macOS et Windows), qualité
  Claude. Enregistré comme option de moteur dans l'UI (« Utiliser mon abonnement Claude »).

### 3.2 Provider `codex-cli` (ChatGPT, secondaire)
- Idem via `codex exec`/print (Lucien a aussi l'abonnement ChatGPT, déjà utilisé par OpenClaw).
- Utile pour offrir le choix **« Claude » ou « ChatGPT »** selon l'abonnement de la personne.

### 3.3 Détection automatique
- `detect.ts` : détecter la présence de `claude` / `codex` connectés et **proposer l'abonnement en
  premier** dans l'onboarding, avant de réclamer une clé API. « Moteur détecté : ton abonnement Claude. »

### 3.4 Embeddings sans cloud ni clé
- Aujourd'hui embeddings = `openai|ollama`. Pour la recherche sémantique sans clé ni GPU costaud :
  intégrer un **embedder local léger** (ex. `@xenova/transformers` / modèle `bge-small`, CPU) en
  option « embeddings locaux ». Sinon rester en mots-clés (acceptable pour démarrer).

---

## 4. Industrialisation de l'installation (Windows + macOS)

Aujourd'hui l'installateur officiel (`scripts/install-memoria.sh`) est **macOS uniquement** (zsh,
outils Apple, launchd, `~/.local/bin`). L'install Windows a été faite **à la main** ce 03/09. À
industrialiser :

### 4.1 Installateur Windows `scripts/install-memoria.ps1` (à écrire, miroir du .sh)
Étapes vécues et validées ce jour :
1. Vérifier **Node ≥ 20** (Lucien : Node 24 OK).
2. `git clone --branch memoria-v1 --depth 1 https://github.com/Primo-Studio/openclaw-memoria.git`.
3. `npm install` → **les modules natifs se compilent bien sous Windows** (`better-sqlite3`,
   `sqlite-vec-windows-x64` — vérifié). `npm run build`.
4. `memoria init` (config + stockage) puis démarrage.
5. **Autostart Windows** = **tâche planifiée** `Register-ScheduledTask -AtLogOn` (l'autostart natif
   est launchd, donc Mac-only). Fait ce jour pour le daemon **et** le pont.

### 4.2 Branchement OpenClaw en **MCP** (pas le plugin)
- Le plugin `memoria-plugin` **3.34.0** est **incompatible** avec OpenClaw 2026.7.1-2 (« plugin API »).
  Le nouveau `packages/adapter-openclaw` est en **4.0.0** mais on n'en dépend pas ici.
- On branche via **MCP** : `mcp.servers.memoria = { command: node, args: [".../packages/mcp/dist/bin.js",
  "serve","--instance","<id>"] }` dans `~/.openclaw/openclaw.json`. `openclaw mcp probe memoria` = **12 tools**.
- ⚠️ **Piège Windows** : `openclaw mcp set memoria '<json>'` **casse le JSON** (quoting cmd/PowerShell).
  → **injecter la clé `mcp` directement dans openclaw.json** (édition fichier validée par
  `ConvertFrom-Json`), ne pas passer par la ligne de commande.
- Le pairing `memoria pair openclaw` génère un code ; `memoria-mcp connect --code XXXX-XXXX` enregistre
  l'agent (register auto échoue si la CLI `openclaw` n'est pas dans le PATH du sous-process → faire le
  `mcp set`/injection soi-même).

### 4.3 ⚠️ Piège BOM (vécu, coûteux)
Éditer `openclaw.json` (ou tout JSON) avec **`Set-Content -Encoding UTF8`** sous **Windows PowerShell
5.1** ajoute un **BOM** qui **casse les parseurs JSON stricts** (l'install-hook de Memoria a échoué là-
dessus). **Toujours écrire en UTF-8 sans BOM** :
`[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.

---

## 5. Fonctionnalités à faire (backlog priorisé)

1. **Provider `claude-cli`** (abonnement) + option UI « Utiliser mon abonnement Claude ». *(cœur)*
2. **Provider `codex-cli`** (abonnement ChatGPT) + choix Claude/ChatGPT à l'onboarding.
3. **Installateur Windows `.ps1`** (miroir du `.sh`) + service/tâche planifiée d'autostart intégrée.
4. **Assistant de branchement OpenClaw en MCP** intégré (`memoria pair openclaw` qui écrit lui-même
   la clé `mcp` dans openclaw.json, en UTF-8 sans BOM, sans passer par `openclaw mcp set`).
5. **Embeddings locaux légers** (CPU) en option, pour la recherche sémantique sans clé.
6. **Écran « Santé / quota » unifié** (repris de `OpenClaw-Helper`) : moteur, canal, quota d'abonnement.
7. **Compat plugin OpenClaw 4.0.0** OU officialiser la voie MCP comme intégration recommandée.
8. **Garde-fous quota d'abonnement** : mesurer la conso, prévenir avant d'épuiser la fenêtre (5 h / semaine).

---

## 6. État laissé chez Lucien (03/09)

- Memoria V3 installé (`C:\Users\CCOG\openclaw-memoria`), daemon en tâche planifiée « Memoria Daemon ».
- Pont abonnement (`C:\Users\CCOG\memoria-claude-bridge\bridge.mjs`) en tâche planifiée
  « Memoria Subscription Bridge », sur `127.0.0.1:11435`, via `claude -p` (**abonnement Claude**).
- Extraction Memoria branchée sur le pont (`config.toml` + clé factice). `doctor` : moteur reconnu.
- Branché à OpenClaw en MCP (12 tools).
- **RESTE / à surveiller** : que l'abonnement Claude de Lucien reste connecté (`claude` login) ;
  qualité/latence de l'extraction via le pont sur des vrais imports ; embeddings absents (mots-clés).

---

## 7. ✅ RÉSULTAT (03/09) — l'abonnement extrait vraiment + BUG core corrigé

**Ça marche de bout en bout.** Après branchement du pont, une capture de conversation via le serveur
MCP (`memoria_capture_turn`) a produit **6 faits** extraits par l'**abonnement Claude** (log daemon :
« WAL rejoué : 4 entrées → 6 faits »). `doctor` : `faits : 6 actifs`, moteur `openai · subscription-bridge`.

### 🐛 Bug corrigé dans le core (indispensable, sinon rien ne marche)
`packages/core/src/llm/index.ts`, `buildExplicitProvider` : le cas **`openai` (extraction) NE
passait PAS `baseUrl`** au `OpenAiProvider` (alors que `ollama`, `lmstudio` et les embeddings openai
le passent). Conséquence : `[llm.extraction] base_url` était **ignoré**, la requête partait vers
`api.openai.com` et échouait en **401** avec la clé factice. **Corrigé** : ajout de
`...(baseUrl ? { baseUrl } : {})` aux cas `openai` et `openrouter`. **À committer** (fait dans la
source ; chez Lucien, le `dist` compilé a été patché à la main + `.bak`).

### Embeddings
La clé factice `~/.openai/api_key` faisait aussi tenter des embeddings OpenAI → 401 en boucle. On a
mis `[llm.embeddings] provider = "ollama"` (local absent) → recherche sémantique **OFF proprement**,
zéro appel cloud. Recherche = FTS/mots-clés. (Voir §3.4 pour un embedder local léger plus tard.)

### ⚠️ Limite importante à retenir (intégration)
Le branchement **MCP expose les OUTILS** memoria à l'agent (recall/store/capture), mais **n'auto-
capture PAS** les conversations : l'auto-capture était le rôle du **plugin** (incompatible 2026.7.1-2).
Aujourd'hui l'agent doit **décider** d'appeler `memoria_capture_turn`/`memoria_store_fact`. Pour une
mémoire passive (apprendre de chaque échange), il faut soit rendre le **plugin 4.0.0 compatible**,
soit un **hook OpenClaw** qui appelle l'outil de capture après chaque tour. → Feature #4/#7.

### Recette config finale posée chez Lucien (`~/.memoria/config.toml`)
```toml
storage_path = 'C:\Users\CCOG\.memoria\data'
enabled = true
[llm]
profile = "custom"
[llm.extraction]
provider = "openai"
model = "subscription-bridge"
base_url = "http://127.0.0.1:11435/v1"
[llm.embeddings]
provider = "ollama"
```
+ `~/.openai/api_key` = `sk-local-bridge-dummy` (le provider openai refuse `apiKey===null` ; le pont ignore l'auth).

---

## 8. Ergonomie Windows, reconnexion, et fonctions dégradées (décisions 03/09)

### 8.1 Présence visible (manque à combler)
Sur Windows, Memoria tourne **en tâche de fond** (daemon + pont, tâches planifiées) : **aucune
icône dans la barre des tâches, aucune fenêtre**. Néto l'a remarqué (« il n'y a pas Memoria là ? »).
- **Interim livré** : bouton **`Memoire-Verifier-Reconnecter.bat`** sur le Bureau de Lucien +
  ouverture de l'UI via `memoria ui`.
- **Futures versions** : donner à Memoria une **présence tray Windows** (icône + menu : Ouvrir,
  État, Reconnecter, Pause) et un **vrai service** (au lieu de deux tâches planifiées séparées).
  Idéalement, l'app desktop (`apps/desktop`) packagée pour Windows.

### 8.2 Reconnexion par l'utilisateur (demande explicite de Néto)
Le moteur dépend de l'abonnement Claude connecté (`claude`). S'il se déconnecte, l'extraction
s'arrête. Lucien doit pouvoir **se reconnecter seul**, sans Néto.
- Vérifier : `claude auth status` (ou un `echo ping | claude -p` témoin).
- Reconnecter : **`claude auth login`** (ouvre une page de connexion).
- **Interim livré** : le bouton `Memoire-Verifier-Reconnecter` : relance daemon+pont si arrêtés,
  détecte la déconnexion Claude et lance `claude auth login` dans la fenêtre, puis re-teste.
- **Futures versions** : intégrer « Reconnecter mon abonnement » dans l'UI Memoria et dans le tray ;
  détecter la déconnexion et **prévenir** (notification) au lieu d'échouer en silence.

### 8.3 Fonctions dégradées ASSUMÉES (décision Néto : « pas grave, manuel »)
Sans clé API et sans local costaud, deux fonctions passent en mode réduit — **acceptable** :
1. **Recherche par le sens (embeddings)** → **OFF**. Reste la **recherche par mots-clés** (FTS).
   Suffisant pour retrouver un souvenir. *(Amélioration future : embedder local léger, §3.4.)*
2. **Auto-capture des conversations** → **non automatique** (le MCP expose les outils mais le
   plugin auto-capture est incompatible). La personne (ou l'agent, sur demande) **mémorise
   manuellement** via les outils memoria. *(Amélioration future : hook OpenClaw / plugin 4.0.0, §5.)*
Ces limites ne cassent rien : Memoria enregistre, extrait (via l'abonnement) et restitue par
mots-clés. Le reste est du confort à ajouter.

### 8.4 Fichiers livrés côté client (Windows, Bureau de Lucien)
- `Verifier-Reparer-OpenClaw.bat` — santé/réparation OpenClaw.
- `Memoire-Verifier-Reconnecter.bat` — santé/reconnexion Memoria (**nouveau**).
- Tâches planifiées : `Memoria Daemon`, `Memoria Subscription Bridge` (autostart au login).

### 8.5 Les deux boutons existent maintenant pour les DEUX systèmes
| Bouton | Windows | macOS |
|---|---|---|
| Santé/réparation OpenClaw | `Verifier-Reparer-OpenClaw.bat` | `Verifier-Reparer-OpenClaw.command` |
| Santé/reconnexion Memoria | `Memoire-Verifier-Reconnecter.bat` | `Memoire-Verifier-Reconnecter.command` |

Règles communes durcies le 03/09 :
- **« Service pas démarré » ≠ « moteur cassé »** : on démarre le service, on ne déclenche PAS de
  mise à jour. (Sans ça, le bouton aurait mis à jour l'OpenClaw du Mac de Néto sans raison.)
- Le bouton Memoria **détecte le moteur** : abonnement (pont) ou clé API, et n'affiche la
  reconnexion Claude que dans le cas abonnement.
- ⚠️ macOS : charger `nvm` puis n'ajouter `/usr/local/bin` qu'en **fin** de PATH (un Node 18 périmé
  y traîne souvent et casse tout).
