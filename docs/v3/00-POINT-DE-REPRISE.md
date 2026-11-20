# Point de reprise : Memoria

> **À lire en premier** après une pause. Mis à jour le **16 novembre 2026**, complété le **19 novembre**
> (fin de session le 20 au matin : §3 premier import, §4 décisions 6 et 7, §5 point 0).
> Ce qui reste à faire, classé : [`TODO.md`](TODO.md) (T15, T29, T30, T31, T32).
> Partage entre Mac, pas à pas : [`INSTALLATION-RESEAU.md`](INSTALLATION-RESEAU.md).
> Installer ou mettre à jour un poste : [`INSTALLER-ET-METTRE-A-JOUR.md`](INSTALLER-ET-METTRE-A-JOUR.md).

## 1. Où on en est

| | |
|---|---|
| Branche vivante | `memoria-v1`, tout est poussé sur GitHub |
| Tests | **1 931 verts** (185 fichiers), `tsc -b` et build Vite verts ; un test de vitesse (`vector-repair`) peut échouer quand toute la suite tourne en parallèle, il passe seul |
| Poste du propriétaire | daemon sous launchd, écoute `127.0.0.1` seulement ; synchro **non activée** ; garde sensible **non posée** (son choix) |
| Trois postes d'équipe | sur `0465ec3` depuis le 19/11 (voir §3) : moteur OpenAI, **garde sensible active**, Claude Code et Codex branchés, import automatique ; synchro **non activée** (prévue vers mi-décembre) |
| Dépôt | **PUBLIC** (Apache 2.0) : code, tests, démo et docs anonymisés |

## 2. Ce qui a été fait du 13 au 16 novembre

- **Tri de la file de revue** : environ 75 000 faits classés par genre (process, décision, savoir, leçon,
  idée, préférence, style…), rubrique, portée (`entite`, `user`, `perso`), auteur (propriétaire, IA, équipe)
  et sensibilité. Les faits restent dormants jusqu'à leur validation dans l'écran Tri. Coût total d'environ
  4,3 $ (gpt-4o-mini).
- **Passe sur les messages du propriétaire** : idées, décisions et préférences tirées de ses propres messages.
  Le filtre des sujets sensibles s'applique avant tout envoi à l'IA.
- **Passe « styles d'échange »** (`/v1/admin/triage/styles`) : la manière d'échanger du propriétaire, à
  partir de ses messages, et celle de chaque personne de l'équipe, à partir des faits validés qui la nomment.
  Les observations arrivent dormantes, à valider dans Tri.
- **Vitesse** (règle : aucun blocage de la boucle au-delà de 200 ms) : réparation vectorielle et repérage
  du tri découpés, FTS limité aux faits rappelables, badge Revue par simple compte, la main rendue entre
  deux recherches de doublons. Mesuré après la mise en service : 79 ms au pire sur 4 minutes de sonde.
- **Partage entre Mac** (T15, T29) :
  - **par défaut, seul l'espace d'équipe `org` voyage** (un hub peut aussi ouvrir `project` et
    `shared_topic`) ; `user`, privé et quarantaine sont toujours refusés ;
  - contrôle par pair côté hub, avec refus fait par fait, à l'envoi comme à l'arrivée : sensible,
    critical, secret, fait client, dormant ; le hub refuse aussi l'écrasement d'un fait né ailleurs ;
  - la portée `entite` n'est exigée qu'au rangement d'un fait dans `org` (partage ou promotion), pas par
    la synchro elle-même (voir §5) ;
  - curseur par numéro d'ordre qui ne redescend jamais ;
  - join possible sur un Mac qui a déjà des agents, et relançable s'il échoue ;
  - un seul `org` par Mac ;
  - écriture des agents dans `org` (`store_fact`), réglée par `[sharing] machine = "team"` ;
  - le hub peut corriger ou dater un fait né sur un Mac relié ;
  - écoute réseau par défaut (`lan:47600`) sur l'adresse privée du réseau local ; l'invitation n'affiche
    jamais `0.0.0.0` ;
  - essai d'acceptation local réussi, avec un hub et quatre Mac simulés (mesure de session, hors suite
    de tests).
- **Les deux autres postes du bureau** : leur daemon bouclait en échec depuis des semaines (verrou d'un
  démarrage précédent, module natif compilé pour un autre Node). Leurs agents OpenClaw tournaient sans
  mémoire, sans aucun signal. Ils sont réparés et mis à jour, voir §3, mais l'iMac est resté en pause
  jusqu'au 19/11. La surveillance qui aurait dû le voir est la tâche **T31**.

## 3. Ce qui tourne pendant la pause

- **Poste du propriétaire** :
  - le daemon (launchd `fr.primo-studio.memoria`) capture et indexe ;
  - l'import automatique toutes les 6 h (`fr.primo-studio.memoria.autoimport`) coûte quelques centimes
    par jour ;
  - le veilleur local (`fr.primo-studio.memoria.watchdog`, `scripts/watchdog.sh`) sonde `/v1/health`
    chaque minute et affiche une notification après 3 échecs, sans rien réparer ;
  - aucun tri ni aucune passe ne tourne : ils ne partent qu'à la main.
- **Les trois postes d'équipe, réglés le 19/11** (accord du propriétaire) :
  - code `0465ec3`, service launchd sur le Node de chaque poste ;
  - moteur OpenAI : `gpt-4o-mini` pour l'extraction (le modèle du poste du propriétaire, retenu par le
    projet pour la qualité des faits) et `text-embedding-3-small` pour les vecteurs ;
  - `[llm] sensitive_gate = true` : rien de paie, d'impôts, de santé ou d'identité ne part vers OpenAI ;
    `memoria doctor` affiche « garde sensible: active » ;
  - Claude Code (scope user) et Codex (`~/.codex/config.toml`) branchés sur Memoria ;
  - import automatique toutes les 6 h (`fr.primo-studio.memoria.autoimport`, Node du poste passé par
    `MEMORIA_NODE`) ;
  - copies d'avant : `config.toml.avant-20261119`, `~/.claude.json.avant-memoria-20261119`,
    `~/.codex/config.toml.avant-memoria-20261119` ;
  - **premier import lancé le 19/11 en fin de matinée** : troisième poste 51 conversations Claude Code et
    52 Codex, iMac 105 et 23, Mac Studio 48 et 1. Coût mesuré sur les premiers appels : environ 0,006 $
    pour deux conversations, soit de l'ordre de 1 $ pour les trois postes (estimation), puis quelques
    centimes par jour. **Résultat final pas encore relevé** (voir §5, point 0) ;
  - les faits tirés des anciennes conversations arrivent **dormants**, comme sur le poste du propriétaire :
    gardés pour l'analyse, mais pas servis au rappel tant qu'ils ne sont pas validés (voir §4, décision 7) ;
  - Claude Code et Codex ne voient Memoria qu'après avoir été **relancés** sur chaque poste ;
  - **facturation** : les clés des postes sont dans le même projet OpenAI que celle du propriétaire, donc une
    seule facture et **aucun plafond par poste**. Le troisième poste utilise la clé du Mac Studio : changer
    l'une coupe les deux. La clé personnelle du propriétaire n'est sur aucun poste d'équipe.
- **Mac Studio** (il héberge un agent OpenClaw et des runners CI) : Node nvm 24.18.0. Il était éteint le
  19/11 vers 8 h ; rallumé, Memoria est reparti seul.
- **iMac** (8 Go, il héberge un agent OpenClaw) : Node nvm 22.22.0 (ABI de better-sqlite3). Il était
  **en pause** depuis le 12/10 (`enabled = false`), sans que rien ne le signale. Réactivé le 19/11 : le rappel
  de son agent répond de nouveau.
- **Troisième poste** (installé le 19/11) :
  - installé à la main par SSH, sans le script, qui ouvre le navigateur à la fin ;
  - Node 22 fixé dans `~/.memoria-runtime/`, et non le Node de Homebrew, qui change à chaque mise à jour ;
  - plugin OpenClaw laissé de côté : Memoria y avait été retiré exprès.
- **Conversations** : Claude Code garde son réglage par défaut de 30 jours sur les postes d'équipe. C'est un
  choix du propriétaire : Memoria retient ce qui touche la personne et l'entreprise, pas les conversations
  entières. L'import automatique passe avant l'effacement.
- Mac Studio et iMac : sauvegarde d'avant la mise à jour du 16/11 dans `~/.memoria-sauvegarde-avant-maj-20261116`.
  Un retour arrière demande l'ancien commit **et** cette sauvegarde, car les migrations ne reviennent pas
  en arrière. Aucun n'est relié à un hub ; rien n'écoute sur 47600.

## 4. Les décisions qui attendent le propriétaire

Pour relier les Mac entre eux (vers mi-décembre, quand le propriétaire aura le temps) :

| # | Décision | Recommandé |
|---|---|---|
| 1 | Quel poste sert de hub | le Mac Studio : toujours allumé, c'était le plan d'origine (il était pourtant éteint le 19/11 au matin) |
| 2 | L'agent OpenClaw joignable par des tiers lit-il encore `org` | non, retrait en une commande |
| 3 | ~~Moteur d'IA des postes d'équipe~~ | **tranché le 19/11** : OpenAI, avec la garde sensible |
| 4 | Remplissage de `org` | seulement ce que le propriétaire valide dans la liste « proposés pour l'équipe » |
| 5 | Filtre des sujets sensibles vers `org` | le garder strict ; reformuler les phrases banales qu'il refuse (« clé RSA », « taux horaire du rendu ») |

Posées le 19/11, sans réponse à la fin de la session :

| # | Décision | Recommandé |
|---|---|---|
| 6 | **Garde sensible sur le poste du propriétaire** : depuis août, son import envoie ses conversations à OpenAI avec les secrets masqués, mais **sans filtre des sujets** (paie, impôts, santé, identité). C'est un écart à la règle « filtrer avant tout envoi à une IA ». | l'activer (`[llm] sensitive_gate = true`, puis relance hors import) ; contrepartie : moins de souvenirs sur la paie et les RH. Ne pas l'activer sans son accord. |
| 7 | **Faits dormants des postes d'équipe** : qui les valide, et faut-il un plafond de dépense | les laisser dormants jusqu'à l'analyse prévue ; pour un plafond, un projet OpenAI séparé avec budget, puis de nouvelles clés sur les postes |

Aussi en attente :
- prévenir les trois personnes de l'équipe que Memoria retient désormais ce qui sort de leurs conversations
  avec l'IA (c'est au propriétaire de le faire) ;
- la validation des styles d'échange dans Tri, et l'avis sur la maquette de l'écran « idées regroupées »,
  qui reste locale.

Décisions plus anciennes (état du 31/08, à revérifier) : versionnage incohérent (tag `v4.0.0`, paquets en
`0.1.0`), notarisation de l'app macOS, organisation npm, réécriture de l'historique git (anciens commits
non anonymisés, un fork existe), accès à Grok.

## 5. À faire au retour, dans cet ordre

0. **Relever le premier import des postes d'équipe**, au prochain passage au bureau. Le 20/11 à 8 h, aucun
   poste du bureau n'était joignable depuis le poste du propriétaire (éteints ou hors réseau) :
   - `GET /v1/admin/import_status` : état `done`, et `windows_sensitive_skipped` dans le résumé (fenêtres
     écartées par la garde) ;
   - `memoria doctor`, section « Données envoyées au cloud » : coût réel des dernières 24 h ;
   - `~/.memoria/auto-import.log` : les passages de 6 h qui ont suivi ;
   - lecture seule, et jamais de relance du daemon tant qu'un import tourne.
1. **Branchement des Mac** (après les décisions 1 à 4), en suivant `INSTALLATION-RESEAU.md` :
   - ne jamais relier un poste dont le code est antérieur à `d46ef97` ;
   - avant `init-hub`, vérifier que l'`org` du hub est vide ou entièrement de portée `entite` : la synchro
     ne relit pas la portée des faits déjà rangés dans `org` ;
   - sur un poste d'équipe, `[sharing] machine = "team"` puis redémarrage, avant ou après le join ;
   - appairage en HTTP clair : sur le réseau du bureau seulement.
2. **Limites à annoncer** :
   - un fait déjà parti ne se retire pas des autres postes (`forget` ne se propage pas) ;
   - un poste d'équipe ne corrige pas un fait né ailleurs (403, le demander au propriétaire) ;
   - au-delà d'environ 13 000 faits `org`, le join bloque plus de 200 ms.
3. **Écrans** : Tri et Partage (validation de la liste équipe sans passer par l'API), puis l'écran des
   idées regroupées une fois la maquette validée.
4. **T31, le veilleur** : vérifier chaque poste, réparer les pannes connues, prévenir le propriétaire.
   **T32, changement de compte ou d'organisation chez l'assistant** : essai réel à faire au branchement des
   Mac (la mémoire doit suivre le poste, pas le compte), puis import de l'export claude.ai.
5. **Vitesse, restes mesurés** :
   - `GET /v1/admin/triage` sans paramètre bloque 150 à 160 ms (index de `listPage`) ;
   - la passe sur les messages bloque encore environ 575 ms (lecture et hachage des grosses conversations) ;
   - `purgeFactVectors` supprime fait par fait (environ 15 ms chacun sur vec0) ;
   - coût CPU du KNN vec0 ;
   - `promoteTriaged` sans cession.
   - La branche `perf/point-de-controle-wal` (`e130ad2`) n'est **pas** fusionnée, et ne doit pas l'être
     telle quelle : pilote résolu depuis le daemon, fsync multipliés.
6. **Relevé le 19/11** :
   - GitHub signale 68 failles ouvertes dans les dépendances (1 critique, 20 hautes), presque toutes
     amenées par le kit MCP (`@modelcontextprotocol/sdk`, via express) ; le MCP de Memoria parle en stdio ;
   - le dépôt public contient encore des noms réels (le nom complet du propriétaire dans des tests, des docs
     et une liste en dur du moteur) : l'anonymisation n'est pas finie, malgré le §1.
7. **Reporté** : tombstones et « retirer du partage », TLS, `rotate-key`, relais NAS, tri de l'agent
   OpenClaw (budget à accorder), import ChatGPT à réception de l'export.

## 6. Les réflexes à ne pas perdre

- **Le dépôt est public** : jamais de nom réel, de montant, d'adresse, d'IP ou de contact dans le code, les
  tests, la démo, les docs ou les messages de commit.
- **Filtrer les données sensibles AVANT tout envoi à une IA**, et tester le filtre.
- **Ne jamais redémarrer le daemon pendant un tri ou un import.** Avant un redémarrage :
  `/v1/admin/triage/run`, `/v1/admin/triage/messages`, `/v1/admin/triage/styles` et `import-status.json`
  au repos ; éviter la fenêtre de l'import automatique.
- **Mesurer la règle des 200 ms par une sonde séquentielle de `/v1/health`** pendant et après la mise en
  service, pas seulement par les tests.
- **Mettre à jour un autre poste** :
  - sauvegarder `~/.memoria`, daemon arrêté (`launchctl bootout`) ;
  - `git pull --ff-only`, puis `npm install` et `npm run build` avec **le Node du service** en tête du PATH ;
  - vérifier `require('better-sqlite3')` avec ce Node, car npm 12 bloque les scripts d'installation et un
    module natif d'une autre ABI fait boucler le service ;
  - renommer un vieux `daemon.lock`, sans jamais tuer son pid, qui peut appartenir à un process système ;
  - relancer, puis vérifier `/v1/health`, les comptes de faits et un rappel avec le jeton de chaque agent.
- **Après un `memoria stop`, toujours `memoria start`** (le service launchd ne redémarre pas seul).
- **Aperçu de l'interface sans toucher à la vraie mémoire** : `npm run ui:preview` (données fictives).
