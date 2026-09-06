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

---

## 9. Assistance à distance : ce qu'on peut faire une fois parti

⚠️ **Point dur** : aujourd'hui l'accès se fait en **SSH sur le WiFi local** (`CCOG@192.168.1.24`).
**Dès qu'on quitte les lieux, cet accès disparaît.** L'IP publique du site (82.123.158.238) n'est pas
exploitable sans ouverture de ports (à éviter). Les options, de la meilleure à la plus limitée :

| Option | Ce qu'on peut faire | Ce qu'il faut | État |
|---|---|---|---|
| **Tailscale** (recommandé) | **Tout** : SSH complet de n'importe où, diagnostic + réparation comme sur place | Compte Tailscale de Néto + **clé d'auth** (`tailscale up --authkey tskey-…`) + **accord de Lucien** | **Client installé le 03/09**, PAS connecté à un réseau |
| **Bot Telegram d'OpenClaw** | Parler à son agent depuis un téléphone, lui faire faire des choses (selon les outils autorisés) | Que Lucien partage/autorise le bot | Déjà en place et fonctionnel |
| **Les 3 boutons** | Lucien se dépanne **seul** : réparer, reconnecter, mettre à jour | Rien | Livrés sur son Bureau |
| **RustDesk** | Voir son écran, manips graphiques | Installation + accord | Non installé |

**Recommandation** : installer le client Tailscale **pendant qu'on est sur place** (fait), puis le
connecter au tailnet de Néto avec une clé d'auth. Sans cette étape, toute intervention future
dépend de Lucien devant sa machine.

⚠️ **Consentement** : rejoindre le tailnet de Néto donne à Néto un accès permanent à la machine de
Lucien. **Lucien doit être d'accord.** Révocation : retirer la machine depuis l'admin Tailscale, et
retirer la clé SSH `primo-mac-openclaw` de `C:\ProgramData\ssh\administrators_authorized_keys`.

---

## 10. ⚠️ Piège d'encodage PowerShell (vécu 03/09, à ne jamais réintroduire)

Deux règles **opposées** selon le type de fichier, sur **Windows PowerShell 5.1** :

| Fichier | Règle | Pourquoi |
|---|---|---|
| **`.json`** (openclaw.json…) | UTF-8 **SANS BOM** | `Set-Content -Encoding UTF8` ajoute un BOM qui **casse les parseurs JSON stricts**. Utiliser `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`. |
| **`.ps1`** (scripts) | **ASCII pur** (ou UTF-8 **AVEC** BOM) | PowerShell 5.1 lit un `.ps1` sans BOM en **ANSI**. Un tiret long `—` ou un accent devient du charabia multi-octets et **casse l'analyse du script** : `Le terminateur " est manquant dans la chaîne`. **Le script ne s'exécute pas du tout.** |

**Vécu** : `Mettre-A-Jour.ps1` écrit avec des `—` et des accents a échoué au *parse* (rien n'a tourné,
donc rien de cassé, mais le bouton était inutilisable). `Memoire-Verifier-Reconnecter.ps1` avait le
même défaut latent. **Les trois `.ps1` sont désormais en ASCII pur**, testés sur la machine cible.

> Les `.command` macOS ne sont pas concernés : bash/macOS gèrent l'UTF-8 nativement.

**Règle pour les futures versions** : tout script `.ps1` livré à un utilisateur doit être **ASCII pur**
et **exécuté au moins une fois sur une vraie machine Windows** avant livraison. Un script qui ne
parse pas est pire qu'un script absent : le bouton existe, l'utilisateur clique, rien ne se passe.

---

## 11. Utilisabilité par la personne (objectif : « qu'il puisse s'en servir »)

### 11.1 🐛 Bug : `memoria ui` n'ouvre pas le navigateur hors Linux
`memoria ui` appelle **`xdg-open`**, commande **Linux uniquement**. Sous **Windows** (et **macOS**)
l'ouverture échoue : `spawn xdg-open ENOENT`, et l'utilisateur ne reçoit qu'une URL à recopier —
inutilisable pour un non-informaticien.
**À corriger dans le core** : ouverture selon la plateforme —
`start ""` (Windows) · `open` (macOS) · `xdg-open` (Linux).
*Contourné pour l'instant par le bouton `Ma-Memoire` qui ouvre le navigateur lui-même.*

### 11.2 Le port et le token changent à chaque démarrage
L'URL de l'interface est `http://127.0.0.1:<port>/ui/#token=<token>`, et **le port change à chaque
redémarrage du daemon** (58866 → 49263 → 59660 → 56563 → 59477). Un favori de navigateur est donc
inutilisable. **À prévoir** : un port stable optionnel, ou un raccourci/tray qui résout l'URL.

### 11.3 Démarrage automatique : vérifié
Les deux tâches planifiées (`Memoria Daemon`, `Memoria Subscription Bridge`) sont en déclencheur
**à l'ouverture de session** de l'utilisateur, en `Interactive`. Vérifié : le daemon lancé par la
tâche **survit** à la fin de la tâche (contrairement à un lancement depuis une session SSH, où il
mourait avec la session). Dernier résultat de tâche = 0.

---

## 12. Ce que la mise à jour OpenClaw a cassé (essai réel 03/09, 2026.7.1-2 → 2026.9.1)

Le bouton `Mettre-A-Jour` a été **exécuté pour de vrai** sur la machine de Lucien, volontairement
pendant qu'on avait encore l'accès. Résultats :

### 12.1 🔴 La mise à jour DÉSACTIVE la tâche planifiée de la passerelle
Après passage en **2026.9.1**, la tâche **`OpenClaw Gateway` se retrouve à l'état `Disabled`**.
Conséquence : la passerelle ne démarre plus (`ECONNREFUSED`), **l'agent ne répond plus, ni en CLI ni
sur Telegram** — et **elle ne redémarrera pas non plus au prochain allumage**.
**Réparation** : `Enable-ScheduledTask -TaskName 'OpenClaw Gateway'` puis `openclaw daemon start`.
> À vérifier après CHAQUE montée de version majeure d'OpenClaw. C'est le piège le plus sournois :
> tout semble installé, et le service est simplement éteint.

### 12.2 🔴 `openclaw doctor --yes` peut se BLOQUER sur un saut de version
Sur ce saut de deux versions, `doctor --yes` est resté figé sans rendre la main (aucune sortie
pendant plus de 20 min), bloquant tout le script. **Correctif appliqué au bouton** : l'étape
`doctor` est désormais **bornée par un délai** (3 min) et abandonnée proprement si elle dépasse.

### 12.3 ✅ Ce qui a bien marché (le garde-fou a joué son rôle)
- Le bouton a **détecté** que l'assistant ne répondait plus et a **renvoyé vers le bouton de
  réparation** au lieu de laisser l'utilisateur devant une machine muette.
- **Memoria n'a pas bougé** : daemon et pont toujours actifs, moteur opérationnel, **6 souvenirs
  intacts**. La mémoire est bien **indépendante** de la passerelle OpenClaw — c'est une bonne
  séparation, à conserver.
- La mise à jour Memoria a échoué proprement, avec le message « ta mémoire continue de
  fonctionner », sans rien casser.

### 12.4 Leçon pour les futures versions
Un bouton de mise à jour livré à un non-informaticien **doit** : borner chaque étape par un délai,
**re-vérifier après coup**, ne jamais laisser la machine muette sans le dire, et **vérifier que les
services sont encore ACTIVÉS** (pas seulement installés).

### 12.5 🔴 OpenClaw 2026.9.1 est INUTILISABLE sur cette machine — retour à 2026.7.1-2
Après la montée en **2026.9.1**, la passerelle ne devient jamais saine :
```
Gateway start timed out after 90s waiting for /healthz and /readyz.
```
et les commandes de service (`doctor --yes`, `daemon start`, `daemon install`) **restent bloquées
sans rendre la main**. Rien à voir avec notre config : c'est la version qui ne démarre pas ici.

**Décision** : **revenir à `openclaw@2026.7.1-2`**, la version qui a fonctionné toute la journée
(agent, Telegram, MCP Memoria). Version à considérer comme **connue-bonne** pour ce poste.

### 12.6 Conséquence de conception : le bouton doit SAVOIR REVENIR EN ARRIÈRE
Mettre « la dernière version » sans filet est dangereux chez un non-informaticien : personne ne sera
là pour réparer. Le bouton `Mettre-A-Jour` doit donc :
1. **mémoriser la version installée avant** ;
2. mettre à jour, puis **re-tester réellement** (l'agent doit répondre) ;
3. si le test échoue → **réinstaller automatiquement la version précédente**, la redémarrer, et le
   **dire clairement** à l'utilisateur ;
4. ne jamais laisser la machine muette.
> *Implémenté le 03/09 dans `Mettre-A-Jour.ps1` (retour arrière automatique).*

### 12.7 🔴 LEÇON MAJEURE : on ne revient PAS en arrière sur OpenClaw en réinstallant le paquet
Le retour arrière « npm install -g openclaw@<ancienne> » **ne suffit pas** et laisse la machine
**cassée**. En montant de version, OpenClaw migre **trois choses en avant**, de façon irréversible :

| Ce qui migre | Effet au retour arrière |
|---|---|
| **Base d'état** `~/.openclaw/state/openclaw.sqlite` | passée en **schéma 15** ; l'ancienne version ne gère que le **schéma 1** → refus de démarrer |
| **Clés de configuration** (`meta`, `agents`, `agents.defaults`) | `openclaw config validate` → **config invalide** pour l'ancienne version |
| **Plugins gérés** (`~/.openclaw/npm`) | `@openclaw/codex` installé en **API ≥ 2026.9.1** → au démarrage : *« startup migrations did not complete cleanly »*, **la CLI ne démarre plus du tout** |

Retirer le paquet, la dépendance, l'entrée `plugins.entries.codex` **et** `plugins.allow` **n'a pas
suffi** : la référence persiste ailleurs et bloque encore le démarrage.

**Conséquence de conception (corrige le §12.6)** : un retour arrière fiable exige de **sauvegarder
tout `~/.openclaw` AVANT la mise à jour** (config + état + plugins gérés) et de **restaurer ce
dossier entier** si la vérification échoue. Réinstaller seulement le paquet npm est un piège.

**Autre option, plus sage pour un poste d'utilisateur** : **ne pas suivre « latest »**. Épingler une
version connue-bonne et ne la changer que sur décision, en présence de quelqu'un.

---

## 13. 🔴 Le blocage qui reste à corriger : MCP au démarrage de la passerelle (2026.9.1)

**Découverte de fin de session (03/09)** : sur **OpenClaw 2026.9.1**, la présence de
`mcp.servers.memoria` dans `openclaw.json` **empêche la passerelle de démarrer**. Elle reste bloquée
et n'atteint jamais `ready` (« timed out waiting for /healthz and /readyz »).

**Preuve** : en retirant la clé `mcp`, la passerelle démarre en 16 s et affiche :
```
[gateway] http server listening (4 plugins: codex, memory-core, openai, telegram)
[gateway] agent model: openai/gpt-5.4
[gateway] ready
[telegram] [default] starting provider (@…)
```
En 2026.7.1-2 le même branchement MCP fonctionnait (probe = 12 tools). **C'est donc une régression
de 2026.9.1** : le démarrage attend la connexion MCP au lieu de la faire en tâche de fond.

**Conséquence sur la machine de Lucien** : pour rendre l'assistant fonctionnel, la clé `mcp` a été
**retirée** (sauvegarde : `~/.openclaw/openclaw.json.avec-mcp`). Donc **l'agent n'a plus les outils
Memoria**. Memoria fonctionne toujours seule (interface, extraction), mais l'assistant ne s'en sert
plus.

**À faire** : rendre la connexion MCP **non bloquante au démarrage** (connexion paresseuse + délai),
ou attendre un correctif OpenClaw. C'est le point n°1 pour rebrancher mémoire et assistant.

## 14. ⚠️ État réellement laissé chez Lucien le 03/09 (vérification finale NON faite)

La session SSH a été coupée au départ des lieux : **le dernier test de l'agent n'a jamais abouti**.
Ce qui est établi, et ce qui ne l'est pas :

| Élément | État | Vérifié ? |
|---|---|---|
| Passerelle OpenClaw 2026.9.1 | tâche `Running`, port 18789 ouvert | ✅ mesuré |
| Telegram | provider démarré dans le journal | ✅ vu au journal |
| Réponse réelle de l'agent | — | ❌ **jamais confirmée** |
| Memoria daemon + pont | actifs, autostart à l'ouverture de session | ✅ mesuré |
| Memoria ↔ agent (MCP) | **débranché** (voir §13) | ✅ volontaire |
| Boutons sur le Bureau | 4 boutons déployés | ✅ |

**Signalement de Lucien le 05/09 au soir : « ça ne marche plus »**, sans détail et sans accès
possible. Hypothèses, par ordre de vraisemblance :
1. **Limite d'abonnement atteinte** (le plus probable : le quota OpenClaw était déjà à 98–99 % le
   03/09 ; l'abonnement Claude alimente en plus l'extraction Memoria). Les boutons affichent le quota.
2. **Jeton d'authentification expiré** (déjà arrivé le 23/08) → le bouton mémoire propose la
   reconnexion.
3. **Redémarrage du PC** : les tâches doivent repartir à l'ouverture de session ; à confirmer.
4. Séquelle de la montée en 2026.9.1.

→ Marche à suivre remise à Lucien : `OpenClaw-Helper/MESSAGE-POUR-LUCIEN.txt`.

## 15. Demande produit : thèmes, sujets et relations entre sujets

Lucien **travaille sur ses projets avec ces IA**. L'intérêt de Memoria pour lui n'est pas seulement
de retenir des faits isolés, mais de **structurer** : quels **thèmes**, quels **sujets**, et
**comment les sujets se relient entre eux**. L'export existe déjà « un fichier Markdown par thème » ;
il manque la **relation** entre sujets.

**À concevoir** (backlog) :
- une **carte des sujets** (qui est lié à quoi, et pourquoi) visible dans l'interface ;
- des **liens typés** entre sujets (dépend de, contredit, fait suite à, même client…) ;
- une vue « **où en est ce projet** » qui rassemble faits, décisions et questions ouvertes d'un sujet ;
- des thèmes **proposés automatiquement** à l'extraction, pas seulement à l'export.
