# Installer Memoria sur une autre machine, et la mettre à jour

> **Pour qui** : Néto, ou n'importe qui devant un Mac où Memoria n'est pas encore installé (le Mac
> Studio, l'iMac, le Mac d'un ami). Aucune connaissance de développement n'est nécessaire.
>
> **Ce document est un compte rendu de test, pas une brochure.** Chaque commande ci-dessous a été
> exécutée le 28/08/2026 sur une installation neuve (dossier personnel temporaire, cache vide), et
> les durées sont mesurées. Ce qui n'a **pas** été testé est signalé par la mention
> **⚠️ non testé** — il n'y en a que trois, listés au § 10.
>
> Ce guide parle d'**une** machine : l'installer, la faire marcher, la mettre à jour. Pour **relier
> plusieurs machines entre elles** et partager la mémoire, c'est l'autre document :
> [`INSTALLATION-RESEAU.md`](INSTALLATION-RESEAU.md).

---

## 1. En un coup d'œil

| Question | Réponse mesurée |
|---|---|
| Combien de temps pour installer ? | **46 secondes** sur un Mac qui a déjà Node et une bonne connexion. 2 à 3 minutes sinon. |
| Faut-il un compte GitHub ? | **Non.** Le dépôt est public, le clone et les mises à jour se font sans identifiants. |
| Faut-il compiler quoi que ce soit ? | **Non.** Les morceaux techniques (`better-sqlite3`, `sqlite-vec`) arrivent déjà compilés. |
| Faut-il payer ? | Pas pour installer. Mais **oui pour que Memoria serve à quelque chose** — voir § 2. |
| Combien de place sur le disque ? | **233 Mo** pour le programme + ~1 Mo de données au départ. |
| Combien de temps pour mettre à jour ? | **14 s** en ligne de commande, **7 s** depuis le bouton de l'interface. Le service est indisponible ~2 s pendant le redémarrage. |
| Peut-on mettre à jour depuis une autre machine ? | **Pas encore** au sens « un bouton ici met à jour là-bas ». Il faut être devant la machine, ou y entrer par SSH. Voir § 9. |

---

## 2. Avant de commencer — les trois choses qui manquent souvent

### a) Node.js 20 ou plus (22 LTS recommandé)

Le script d'installation vérifie et **s'arrête** si Node manque, avec ce message : « Node.js manquant.
Installe Node 22 LTS depuis https://nodejs.org puis relance. »

Sur nodejs.org il faut choisir le bon bouton. Pour un Mac récent (puce Apple M1/M2/M3/M4) : prendre
le fichier **`.pkg` macOS Apple Silicon**, le double-cliquer, suivre les étapes, puis revenir au
Terminal.

### b) Les outils de développement d'Apple

Le script s'en occupe : s'ils manquent il ouvre lui-même la fenêtre système d'installation (~5 min)
puis demande de **relancer la même commande**.

> ⚠️ **Piège vécu** : après 5 minutes d'attente, le Terminal a souvent été fermé et la commande
> d'origine n'est plus sous les yeux. **Garder cette page ouverte**, ou noter la commande du § 3
> avant de lancer quoi que ce soit.

### c) Une clé pour le moteur d'intelligence — le vrai prérequis

**Ceci est le point le plus important de ce document.**

L'installation ne demande aucune clé et se termine par « ✓ Memoria est installé et lancé. » Mais
**sans moteur d'intelligence, Memoria n'extrait aucun souvenir** : il enregistre les conversations et
n'en tire rien. Une installation « réussie » peut donc ne rien mémoriser pendant des jours.

Deux options, à préparer **avant** de s'asseoir devant la machine de l'ami :

- **Clé API OpenAI** (recommandé) — à créer sur le compte OpenAI, coût réel mesuré chez Néto :
  environ **0,12 $ pour 24 h d'usage intensif** (590 appels, dont un import de 1 523 fichiers).
- **Ollama** (100 % local et gratuit) — à installer sur la machine, mais il faut un Mac assez
  puissant ; l'écran d'accueil de Memoria le détecte et propose l'installation du modèle en un clic.

Le choix se fait dans l'interface au premier lancement (§ 5).

---

## 3. Installer

Ouvrir le **Terminal** (Applications → Utilitaires → Terminal) et coller cette ligne, puis Entrée :

```sh
curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/memoria-v1/scripts/install-memoria.sh | sh
```

### Ce qui se passe, étape par étape (durées mesurées)

| Étape | Ce qu'on voit | Durée |
|---|---|---|
| Vérification des outils Apple et de Node | « ▸ Outils de développement OK », « ▸ Node v22.x OK » | instantané |
| Téléchargement de Memoria | « ▸ Clonage de Memoria dans /Users/…/openclaw-memoria » | 15 s |
| Installation des morceaux | « added 338 packages » | 21 s |
| Construction | quelques lignes techniques | 8 s |
| Préparation du stockage et démarrage | « ✓ config écrite », « ✓ stockage prêt », « ✓ daemon actif » | 1 s |
| Raccourci `memoria` ajouté au Terminal | « ▸ Commande « memoria » ajoutée au PATH » | instantané |
| **Total** | « ✓ Memoria est installé et lancé. » puis l'interface s'ouvre | **46 s** |

Le message final donne l'adresse de l'interface (avec sa clé d'accès), rappelle `memoria ui` pour la
rouvrir plus tard, et indique que Memoria redémarrera tout seul au prochain allumage du Mac.

### Où va quoi

- Le programme : `~/openclaw-memoria` (233 Mo)
- Les souvenirs : `~/.memoria` — **c'est le dossier à sauvegarder**, jamais l'autre
- Le raccourci `memoria` : `~/.local/bin/memoria`, ajouté au PATH dans `~/.zshrc`

### Relancer l'installation ?

Sans risque **sur une machine propre** : le script est idempotent. En revanche, si le dossier
`~/openclaw-memoria` contient des modifications locales, il **refuse** et conseille `memoria update`
— c'est voulu, il ne doit jamais écraser du travail en cours.

---

## 4. Ouvrir l'interface

L'interface s'ouvre toute seule à la fin de l'installation. Si le Terminal a été fermé entre-temps,
rien n'est perdu :

```sh
memoria
```

(ou `memoria ui`, c'est la même chose). L'adresse et la clé d'accès sont réaffichées, et le navigateur
s'ouvre. Vérifié : cela fonctionne dans un Terminal tout neuf, après fermeture du premier.

L'interface compte **16 écrans** en 5 langues (français, anglais, espagnol, portugais, allemand),
répartis en trois groupes dans la barre de gauche : *Essentiel*, *Ce qu'elle a compris*, *Avancé*.

---

## 5. Choisir le moteur d'intelligence (l'étape à ne pas sauter)

Au premier lancement, l'écran d'accueil guide le choix : OpenAI (recommandé), Ollama, LM Studio,
Anthropic, OpenRouter. La clé saisie est testée auprès du fournisseur au moment de l'enregistrement.

Ce choix se refait ou se change à tout moment dans **Réglages → Moteur d'intelligence**.

⚠️ **non testé** : cet écran d'accueil n'a pas été parcouru au navigateur pendant le test
d'installation du 28/08 (le test s'est arrêté aux vérifications en ligne de commande). Le code est
là et couvert par les tests automatiques, mais le parcours réel dans le navigateur sur une machine
neuve reste à confirmer une fois.

---

## 6. Connecter un agent (Claude Code, Codex…)

Deux chemins.

**Le plus simple — depuis l'interface** : écran **Agents** → bouton *Détecter*, puis *Connecter*.
Memoria trouve les agents installés sur la machine et fait tout.

**Depuis le Terminal**, si l'agent est ailleurs :

```sh
memoria pair claude-code
```

Affiche un code dans un cadre, par exemple :

```
Code de pairing : ZEVU-75MW
Expire dans 10 minutes (usage unique)
```

…suivi d'une **longue ligne à copier-coller telle quelle dans le chat de l'agent**. Elle fait environ
200 caractères et commence par un chemin de fichier : c'est normal, elle n'est pas faite pour être
retapée à la main — il faut la **sélectionner et la copier**. Et le code expire au bout de
**10 minutes** : ne pas le générer avant d'aller chercher l'autre machine.

Types d'agents acceptés : `claude-code`, `codex`, `openclaw`.

---

## 7. Vérifier que ça marche vraiment

### Ce qui ne suffit pas

```sh
memoria doctor
```

Cette commande affiche un bilan complet en français (stockage, activité, ce qui est parti au cloud et
combien ça a coûté) et conclut par « État : ✓ OK ».

> 🔴 **Attention — défaut connu, à corriger** : sur une installation neuve **sans moteur
> d'intelligence**, `doctor` répond quand même « État : ✓ OK ». Le type `DoctorReport`
> (`packages/core/src/types.ts:500`) n'a aucun champ pour le moteur, et `doctor()`
> (`packages/core/src/engine/memoria.ts:3359`) ne lève aucun avertissement à ce sujet. Le texte
> d'aide de la commande promet pourtant un bilan du « moteur d'IA ».
>
> **Conséquence concrète** : la seule commande de diagnostic peut dire que tout va bien pendant que
> rien ne se mémorise. C'est inscrit en tête du [`TODO.md`](TODO.md).

### Ce qui marche

1. **Ouvrir le Tableau de bord** dans l'interface. Sans moteur configuré, une **bannière rouge**
   l'annonce clairement. C'est aujourd'hui le contrôle fiable.
2. **Avoir une vraie conversation** avec un agent connecté, puis regarder l'écran **Mémoire** :
   des souvenirs doivent apparaître. S'il n'y en a aucun après une conversation, le moteur n'est pas
   branché — quoi qu'en dise `doctor`.

---

## 8. Mettre à jour

Deux chemins, testés tous les deux, qui donnent **exactement le même résultat**.

### a) Depuis l'interface (le plus simple)

**Réglages → Mise à jour → bouton « Vérifier et mettre à jour »**.

Mesuré : réponse en **7 secondes** (« Mis à jour e286471 → 973dedf. Redémarrage du service… »), puis
le service redémarre. L'interface prévient qu'il faut recharger la page une dizaine de secondes plus
tard.

### b) Depuis le Terminal

```sh
memoria update
```

Mesuré : **14 secondes** tout compris. Sortie réelle :

```
Version actuelle : 0.1.0 (e286471)
Téléchargement + reconstruction…
Mis à jour e286471 → 973dedf. Redémarrage du service…
```

### Ce que ça fait vraiment (vérifié)

Récupère la dernière version depuis GitHub, réinstalle ce qui a changé, reconstruit, puis redémarre
le service. Le service est **injoignable environ 2 secondes**, et tout est revenu **11 secondes**
après le lancement de la commande. Les souvenirs ne sont jamais touchés : la mise à jour ne travaille
que dans le dossier du programme.

---

## 9. Vérifier qu'une mise à jour a bien pris

La méthode fiable aujourd'hui, dans le Terminal de la machine concernée :

```sh
git -C ~/openclaw-memoria rev-parse --short HEAD
```

Comparer avec la dernière version publiée sur GitHub (branche `memoria-v1`). Si les deux
correspondent, la machine est à jour.

Il existe aussi une adresse qui dit quelle version **tourne réellement** :

```sh
PORT=$(node -p "require(process.env.HOME + '/.memoria/data/daemon.json').port")
curl -s http://127.0.0.1:$PORT/v1/health
```

Elle renvoie notamment `built_sha` — la révision réellement chargée par le service.

> ⚠️ **Deux défauts connus sur cette vérification** :
> 1. Après une **installation neuve**, `built_sha` vaut **`null`** : le marqueur de build n'est écrit
>    que par `memoria update`, jamais par l'installation. Contournement : lancer `memoria update` une
>    fois, même s'il n'y a rien de neuf — cela pose le marqueur.
> 2. Sur la machine de Néto, le marqueur contient la révision **longue** (40 caractères) alors que le
>    code compare avec la révision **courte** (7 caractères) : la comparaison automatique ne tombe
>    jamais juste, et chaque `memoria update` reconstruit inutilement. Détail et correctif dans
>    [`TODO.md`](TODO.md).

---

## 10. Mettre à jour « à distance » : ce qui n'existe pas encore

C'est la demande explicite de Néto, et il faut être franc : **il n'y a pas de bouton « mettre à jour
les autres machines »**, ni aujourd'hui ni bientôt sans un développement dédié.

**Pourquoi** (vérifié dans le code) : le serveur d'administration écoute uniquement sur la boucle
locale `127.0.0.1` (`packages/daemon/src/server.ts:1246`), avec en plus un filtre qui refuse les
requêtes venues d'ailleurs. Le second canal réseau, celui qui relie les machines entre elles, ne
transporte **que des souvenirs** (`/v1/sync/*`) — jamais une commande d'administration.

**Il manque aussi la moitié amont** : rien ne compare jamais la machine à GitHub, donc **personne
n'est prévenu qu'une nouvelle version existe**. Le bouton s'appelle « Vérifier et mettre à jour » et
il faut avoir l'idée de cliquer.

### Ce qu'on peut faire dès maintenant

- **Se connecter à la machine** (écran partagé, TeamViewer, ou SSH via Tailscale — l'architecture
  déjà retenue pour l'accès au PC du collègue) et taper `memoria update`, ou cliquer le bouton.
- **Demander à la personne** de cliquer elle-même : *Réglages → Mise à jour → « Vérifier et mettre à
  jour »*. C'est deux clics, c'est en français, et ça ne casse rien si elle est déjà à jour.

### Ce qui reste à construire

Une route de mise à jour sur le canal entre machines déjà appairées, et un signal « nouvelle version
disponible » dans l'interface. Les deux sont décrits avec leur emplacement exact dans
[`TODO.md`](TODO.md).

---

## 11. Quand ça se passe mal — les cas réellement rencontrés

### « Des modifications locales existent dans … » à l'installation

Le dossier a déjà servi et contient du travail en cours. Le script refuse d'écraser : c'est voulu.
Utiliser `memoria update` à la place.

### La mise à jour échoue avec un mur de texte anglais

Message typique :

```
Command failed: git -C /Users/…/openclaw-memoria pull --ff-only
error: Your local changes to the following files would be overwritten by merge: …
Please commit your changes or stash them before you merge. Aborting
```

**Ce que ça veut dire** : quelqu'un (ou un agent) a modifié un fichier dans le dossier du programme.
Memoria refuse de l'écraser.

**Bonne nouvelle, vérifié** : rien n'est cassé à moitié. Après cet échec, l'ancienne version continue
de tourner normalement, le service ne redémarre pas, l'interface reste celle d'avant.

**Comment s'en sortir** :

```sh
cd ~/openclaw-memoria && git stash
```

…puis relancer la mise à jour. En cas de doute, demander à Néto plutôt que d'insister.

> Le texte brut en anglais est un défaut connu : la traduction de ce cas d'échec est le premier point
> de la section « travail à faire » du [`TODO.md`](TODO.md).

### La commande `memoria` n'est pas reconnue

Fermer le Terminal et en rouvrir un neuf (le raccourci n'est pris en compte qu'au démarrage du
Terminal). Vérifié : dans un Terminal neuf, `memoria --version` répond `0.1.0`.

### L'interface ne s'ouvre pas / l'adresse ne répond plus

Le service choisit un port libre à chaque démarrage, et il change après une mise à jour : l'onglet
resté ouvert pointe alors dans le vide. Taper `memoria` dans le Terminal pour récupérer la bonne
adresse. (Rendre ce port stable est au [`TODO.md`](TODO.md).)

### Le service ne redémarre plus après une mise à jour de Node

Le service au login retient le **chemin exact** de la version de Node utilisée à l'installation. Si
cette version-là est supprimée, le service ne démarre plus au login, en silence. Solution :
réinstaller ou relancer `memoria autostart on`. C'est également au [`TODO.md`](TODO.md).

---

## 12. Ce qui n'a pas été testé (à assumer)

Trois points, et seulement trois :

1. **Le démarrage automatique au login sur un Mac neuf** (`memoria autostart on`). C'est pourtant le
   mécanisme réel de démarrage sur la machine d'un ami. Il n'a pas pu être exercé : l'identifiant du
   service est le même pour toutes les installations, et le simuler aurait coupé le service de
   production de Néto. **À valider une fois sur une machine jetable (ou un second compte macOS) avant
   d'installer chez quelqu'un.**
2. **L'écran d'accueil au navigateur** sur une installation neuve (§ 5).
3. **L'app `Memoria.app`** (l'icône **M** dans la barre de menus) : elle est signée mais **pas encore
   notarisée** par Apple — sur une autre machine, macOS refusera de l'ouvrir. Elle n'est pas
   nécessaire : Memoria fonctionne entièrement sans elle. Le script d'installation ne l'installe pas.

---

## 13. Sauvegarder, déplacer, désinstaller

**Sauvegarder** : il n'existe **pas encore** de commande de sauvegarde. Le dossier à copier est
`~/.memoria`, service arrêté (`memoria stop`) pour obtenir une copie cohérente.

> ⚠️ Ne pas se contenter de copier le dossier ailleurs et de le rouvrir : le registre interne retient
> des chemins **absolus**, et une copie ouverte telle quelle irait travailler sur les bases
> d'origine. Une vraie commande de sauvegarde/restauration est au [`TODO.md`](TODO.md) — c'est le
> manque dont les conséquences seraient les plus irréversibles.

**Déplacer** le stockage vers un autre disque :

```sh
memoria move --to /chemin/du/nouveau/dossier
```

**Arrêter** temporairement : `memoria stop`. **Relancer** : `memoria start`.

**Mettre en pause sans rien effacer** : le sélecteur en bas de la barre de gauche de l'interface
(*Capture auto* / *Revue d'abord* / *Pause*), ou `memoria disable` puis `memoria enable`.

---

## 14. Aide-mémoire des commandes

| Commande | Ce qu'elle fait |
|---|---|
| `memoria` | Ouvre l'interface (raccourci de `memoria ui`) |
| `memoria doctor` | Bilan de santé — ⚠️ ne détecte pas encore l'absence de moteur d'IA |
| `memoria update` | Met à jour et redémarre le service |
| `memoria pair claude-code` | Génère un code pour connecter un agent (valable 10 min) |
| `memoria agents` | Liste les agents connectés |
| `memoria stats` | Chiffres de la mémoire |
| `memoria stop` / `memoria start` | Arrête / relance le service |
| `memoria autostart on` | (Re)met en place le démarrage au login |
| `memoria export` | Exporte les souvenirs en fichiers Markdown |
| `memoria move --to <dossier>` | Déplace tout le stockage |
| `memoria sync status` | État de la synchro entre machines |

Liste complète : `memoria --help`. Deux commandes citées dans de vieux documents **n'existent pas** :
`memoria connect` et `memoria disconnect`.
