# Point de reprise : Memoria

> **À lire en premier** après une pause. Mis à jour le **16 novembre 2026**, complété le **19 novembre**.
> Ce qui reste à faire, classé : [`TODO.md`](TODO.md) (T15, T29, T30, T31).
> Partage entre Mac, pas à pas : [`INSTALLATION-RESEAU.md`](INSTALLATION-RESEAU.md).
> Installer ou mettre à jour un poste : [`INSTALLER-ET-METTRE-A-JOUR.md`](INSTALLER-ET-METTRE-A-JOUR.md).

## 1. Où on en est

| | |
|---|---|
| Branche vivante | `memoria-v1`, tout est poussé sur GitHub |
| Tests | **1 903 verts** (184 fichiers), `tsc -b` et build Vite verts |
| Poste du propriétaire | daemon sous launchd sur ce build, écoute `127.0.0.1` seulement ; synchro **non activée** |
| Deux autres postes du bureau | mis à jour sur `d46ef97` le 16/11 (voir §3), synchro **non activée** ; l'iMac est **en pause** (vu le 19/11) |
| Troisième poste d'équipe | Memoria **installé le 19/11**, sans moteur d'IA (il ne retient rien tant qu'un moteur n'est pas choisi), synchro **non activée** |
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
  (vu le 19/11). La surveillance qui aurait dû le voir est la tâche **T31**.

## 3. Ce qui tourne pendant la pause

- **Poste du propriétaire** :
  - le daemon (launchd `fr.primo-studio.memoria`) capture et indexe ;
  - l'import automatique toutes les 6 h (`fr.primo-studio.memoria.autoimport`) coûte quelques centimes
    par jour ;
  - le veilleur local (`fr.primo-studio.memoria.watchdog`, `scripts/watchdog.sh`) sonde `/v1/health`
    chaque minute et affiche une notification après 3 échecs, sans rien réparer ;
  - aucun tri ni aucune passe ne tourne : ils ne partent qu'à la main.
- **Mac Studio du bureau** (toujours allumé, il héberge un agent OpenClaw et des runners CI) : daemon sur
  `d46ef97`, Node nvm 24.18.0, plist d'origine gardé. Les deux jetons OpenClaw répondent.
- **iMac du bureau** (8 Go, il héberge un agent OpenClaw) : daemon sur `d46ef97`, service recréé par
  `autostart on` avec **Node nvm 22.22.0**, parce que better-sqlite3 y est compilé pour cette ABI.
  Passé à `c46d1cd` le 18/11 par le bouton « Mise à jour » de l'interface. **Vu le 19/11 : Memoria y est en
  pause** (`enabled = false` depuis le 12/10). Son agent n'a donc aucune mémoire. Le réactiver fait dépenser
  la clé OpenAI de ce poste : accord du propriétaire requis.
- **Vu le 19/11 vers 8 h** : le Mac Studio était éteint. Rallumé vers 8 h 50, Memoria est reparti seul.
- **Troisième poste d'équipe** (installé le 19/11) :
  - installation à la main par SSH, sans le script, qui ouvre le navigateur à la fin ;
  - Node 22 fixé dans `~/.memoria-runtime/`, et non le Node de Homebrew, qui change à chaque mise à jour ;
  - pas de moteur d'IA, ni plugin OpenClaw, ni MCP dans les assistants : ces choix reviennent au
    propriétaire ;
  - un import sans moteur extrait zéro fait.
- Sur les postes d'équipe, Claude Code efface ses conversations après 30 jours (réglage par défaut). Pour
  les importer plus tard, il faut relever `cleanupPeriodDays`.
- Sur ces deux postes : sauvegarde d'avant la mise à jour dans `~/.memoria-sauvegarde-avant-maj-20261116`.
  Un retour arrière demande l'ancien commit **et** cette sauvegarde, car les migrations ne reviennent pas
  en arrière. Aucun n'est relié à un hub ; rien n'écoute sur 47600.

## 4. Les décisions qui attendent le propriétaire

Pour le branchement des Mac (prévu mercredi 18/11) :

| # | Décision | Recommandé |
|---|---|---|
| 1 | Quel poste sert de hub | le Mac Studio : toujours allumé, c'était le plan d'origine |
| 2 | L'agent OpenClaw joignable par des tiers lit-il encore `org` | non, retrait en une commande |
| 3 | Moteur d'IA des postes d'équipe | clé d'équipe plafonnée (dépense) ou modèle local ; jamais la clé personnelle du propriétaire |
| 4 | Remplissage de `org` | seulement ce que le propriétaire valide dans la liste « proposés pour l'équipe » |
| 5 | Filtre des sujets sensibles vers `org` | le garder strict ; reformuler les phrases banales qu'il refuse (« clé RSA », « taux horaire du rendu ») |

Aussi en attente : la validation des styles d'échange dans Tri, et l'avis sur la maquette de l'écran
« idées regroupées », qui reste locale.

Décisions plus anciennes (état du 31/08, à revérifier) : versionnage incohérent (tag `v4.0.0`, paquets en
`0.1.0`), notarisation de l'app macOS, organisation npm, réécriture de l'historique git (anciens commits
non anonymisés, un fork existe), accès à Grok.

## 5. À faire au retour, dans cet ordre

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
