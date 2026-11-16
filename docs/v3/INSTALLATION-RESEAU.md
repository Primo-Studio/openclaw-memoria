# Installer Memoria sur une nouvelle machine + partager la mémoire (réseau)

Guide non-technique. Objectif : installer Memoria sur une machine neuve (un Mac de l'équipe), la
relier à la machine « hub » (le Mac toujours allumé) et partager la mémoire d'équipe (`org`).

> Tout ce qui est décrit ici existe dans le code au 27/08/2026 (écrans Réglages / Agents / Partage,
> commandes `memoria …`) ; les parties 2 à 4 et la sécurité réseau sont à jour au 16/11/2026 (seul
> `org` part vers les Mac de l'équipe). L'onglet **Docs** de l'interface reprend l'ancien contenu en
> 5 langues : il n'a pas encore suivi ces changements.

## 1. Installer sur une machine neuve

Ouvrir le Terminal et coller **une seule commande** :

```sh
curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/memoria-v1/scripts/install-memoria.sh | sh
```

(ou, si le dépôt est déjà cloné : `sh scripts/install-memoria.sh`)

Le script fait tout : il vérifie les outils, télécharge Memoria, l'installe, le construit, démarre le
service, configure la commande `memoria` (PATH dans `~/.zshrc`), active le **lancement automatique
au démarrage du Mac** (service launchd, relancé tout seul s'il tombe) et **ouvre l'interface** dans
le navigateur.

Pour rouvrir l'interface plus tard : taper **`memoria ui`** (ou `memoria` tout court) dans le
Terminal. Pas besoin de relancer quoi que ce soit après un redémarrage : Memoria démarre tout seul.

> Pré-requis : **Node.js 20 ou plus** (https://nodejs.org — **22 LTS recommandé**). Le script vérifie
> sa présence et s'arrête proprement s'il manque (il avertit aussi si une version non-LTS est
> installée). Les **outils de développement Apple** sont gérés par le script lui-même : s'ils
> manquent, il ouvre la fenêtre d'installation système (~5 min) et demande simplement de le relancer.

> Sécurité : si le dossier `~/openclaw-memoria` contient des modifications locales (machine de
> développement), le script **refuse** de l'écraser et conseille `memoria update` à la place.

### L'app Memoria (optionnel)
`Memoria.app` (signée, dossier `/Applications` sur le poste de Néto) affiche une icône **M** dans la
barre de menus : **vert** = service actif, **rouge** = éteint, **gris** = démarrage ou état inconnu.
« Ouvrir Memoria » ramène la fenêtre ; fermer la fenêtre cache l'app (le M reste). Elle démarre le
service par launchd, jamais en double.

## 1bis. Choisir le moteur d'intelligence

Au premier lancement, l'écran d'accueil te guide pour brancher le **moteur d'intelligence** — c'est
lui qui transforme les conversations en souvenirs (extraction) et qui permet la recherche par le
sens (embeddings). L'onboarding scanne la machine et propose :

- **Clé API OpenAI** (**recommandé**, le plus simple) : zéro installation, `gpt-4o-mini` pour
  l'extraction et `text-embedding-3-small` pour les embeddings. Payant à l'usage — quelques millièmes
  de dollar par conversation, le coût est affiché dans Réglages.
- **Ollama** (avancé) : 100 % local et gratuit, si la machine est assez puissante — l'écran le détecte
  et n'offre l'installation en 1 clic (`qwen2.5:3b` + `nomic-embed-text`) que si c'est pertinent.
- **LM Studio** : local aussi, si tu préfères son application.
- Autres clés API (Anthropic, OpenRouter) : moteur dans le cloud.

Sans moteur configuré, Memoria capture les conversations mais **n'extrait aucun souvenir** — et te
l'affiche clairement en rouge dans le Tableau de bord (rien n'échoue en silence). Une fois le moteur
branché, la file est traitée au prochain échange de l'agent ou au redémarrage du service.

### Ce qui part au cloud, et combien ça coûte
Avec un moteur cloud, le texte des conversations à analyser part chez le fournisseur ; avec les
embeddings OpenAI, le texte de chaque souvenir part aussi pour être indexé. Avec Ollama / LM Studio,
rien ne sort. Pour vérifier : **Réglages → « Données envoyées au cloud »** (journal des envois) et
**« Consommation des modèles »** (appels, tokens, coût estimé sur 24 h / 7 jours / 30 jours / depuis
le début) — ou en terminal `memoria doctor` (mêmes sections). Les clés API sont testées à
l'enregistrement et n'apparaissent jamais dans les logs.

## 1ter. Connecter les agents et importer leurs souvenirs

**Agents → « Sur cette machine »** : Memoria détecte Claude Code, Codex, OpenClaw… → **Connecter**
(1 clic). Pour un agent à distance : `memoria pair claude-code` donne un code (10 min) à coller dans
le chat de l'agent. Il n'y a pas de commande « connect » : c'est le pairing.

**Importer** récupère les souvenirs existants avec une barre de progression : les conversations
(transcripts) arrivent **dormantes dans la Revue** ; une mémoire OpenClaw legacy est adoptée telle
quelle. Sur le poste de Néto, un import automatique tourne toutes les 6 h (`scripts/auto-import.sh`
+ plist launchd, chemins de ce poste — voir TODO pour la version portable) et remplit la Revue.

## 2. Désigner le hub (la machine toujours allumée)

> **Ce qui part vers les Mac de l'équipe : l'espace d'équipe `org`, et lui seul.** L'espace `user`
> (ce qui concerne le propriétaire), les mémoires privées des agents, la Revue et les secrets ne
> quittent jamais ce Mac. Le hub contrôle **chaque** requête d'un Mac relié : un autre espace
> demandé, et c'est un refus (403).

> **L'appairage passe en clair sur le réseau.** Le faire **seulement sur le réseau du bureau**,
> jamais sur un Wi-Fi invité, public ou partagé (voir « Sécurité réseau » plus bas).

Sur le hub, en terminal :

```sh
memoria sync init-hub          # = --listen lan:47600 --scopes org
memoria stop && memoria start  # le hub n'écoute le réseau qu'après ce redémarrage
memoria sync status
```

`sync status` doit afficher :
- `écoute LAN : lan:47600 → 192.168.x.y:47600 (active)` ;
- `à donner aux autres Mac : 192.168.x.y:47600 (ou <nom>.local:47600)` ;
- `espaces partagés avec les Mac reliés : org`.

Dans l'interface : **Réglages → Synchro entre machines → « Faire de cette machine le hub »**, puis
redémarrer le service.

**Ce que fait `init-hub`** :
- **Écoute** : `lan:47600` veut dire « l'adresse IPv4 privée de l'interface du réseau local »
  (Wi-Fi ou Ethernet), retrouvée **à chaque démarrage**. Le hub n'écoute donc ni sur un VPN ni sur un
  autre réseau, et un changement d'IP par le DHCP est rattrapé au redémarrage suivant. S'il n'y a pas
  encore de réseau au démarrage (Wi-Fi pas prêt à l'ouverture de session), il réessaie toutes les
  30 s et le note une fois dans le journal. `--listen 0.0.0.0:47600` (toutes les interfaces) reste
  possible mais **déconseillé**.
- **Espaces** : `org` par défaut. `--scopes org,project` ajoute les projets. `user`, `private` et la
  quarantaine sont **refusés** (erreur), même écrits à la main dans `config.toml`.
- **Clés du groupe** : tirées **neuves** tant qu'aucun Mac n'est relié. Les clés qu'un ancien essai
  aurait laissées au Trousseau ne sont jamais reprises. Avec des Mac déjà reliés, relancer
  `init-hub` (pour changer l'adresse, par exemple) **garde** les clés, sinon tous seraient coupés.
- **Pare-feu macOS** : s'il est activé, autoriser les connexions entrantes de `node` (port 47600).

## 3. Inviter un Mac de l'équipe

Sur le hub : `memoria sync invite --name "Mac de l'équipe"` (ou **Réglages → Synchro → « Inviter
une machine »**). S'affichent :
- un **code** valable **10 min** ; 5 codes faux de suite annulent l'invitation ;
- les **espaces** que ce Mac recevra (`org`) ;
- la **commande exacte** à taper sur l'autre Mac, avec l'adresse réseau local du hub (jamais
  `0.0.0.0`), et le nom `<nom>.local:47600` en second choix si l'IP a changé.

`--scopes org,project` limite ou élargit ce que CE Mac recevra (dans la liste du hub, jamais `user`).

## 4. Relier le Mac de l'équipe au hub

**Avant** : même version de Memoria sur les deux Mac (`built_sha` de `/v1/health`), même réseau de
bureau, horloges à l'heure (plus de 60 s d'écart = refus).

Sur le Mac de l'équipe, la commande donnée par `invite` :

```sh
memoria sync join --hub 192.168.x.y:47600 --code XXXX-XXXX
```

(ou **Réglages → Synchro → « Relier au hub »** : adresse + code).

**Ce que fait le join** :
- Il récupère l'historique de l'espace `org` du hub, puis la **synchro automatique démarre tout de
  suite** (toutes les 2 min), **sans redémarrer** Memoria.
- Un Mac qui a **déjà des agents et des souvenirs** garde tout : son espace `org` local prend
  l'identifiant de celui du hub en emmenant ses faits, les droits de ses agents et ses réglages ; ses
  faits `org` partent ensuite vers le hub. Son espace `user` reste le sien et ne part jamais.
- **S'il échoue** (réseau coupé, hub arrêté…) : le Mac est remis comme avant (clés du groupe, lien
  au hub, réglages), le hub est prévenu et coupe l'appairage. Relancer **la même commande** (même
  code, dans les 10 min) ou demander une nouvelle invitation. Si le hub était injoignable au moment
  de l'échec, il coupe seul l'appairage jamais confirmé au bout de 15 min. Les faits d'équipe déjà
  reçus avant la panne restent sur le Mac.

**Vérifier** : `memoria sync status` sur le Mac de l'équipe → hub, espaces `org`, « synchro
automatique : armée », dernière passe et ses éventuelles erreurs. Sur le hub, chaque Mac relié est
listé avec ses espaces (`org`) et « appairage en cours » tant qu'il n'a pas tout reçu.

Les agents du Mac de l'équipe lisent l'espace `org` selon la matrice **Partage** ; leur droit d'y
écrire est suivi dans T29.

**Couper un Mac** depuis le hub : `memoria sync revoke <machine_id>`. **Quitter** depuis le Mac de
l'équipe : **« Se déconnecter »** (`memoria sync leave`) ; le hub est prévenu et le coupe (s'il est
injoignable, faire aussi `revoke` sur le hub).

### Ce qui se partage — et ce qui NE se partage PAS

| Part vers les Mac de l'équipe | Ne part JAMAIS (ni envoyé, ni accepté d'un Mac relié) |
|---|---|
| Espace **`org`** : process, savoirs, leçons d'équipe | Espace **`user`** (personnel au propriétaire) |
| Projets et sujets, **seulement** si `--scopes` les ajoute | Mémoire **privée** de chaque agent, quarantaine de revue (imports) |
| L'expiration d'un fait (il s'efface partout à la même date) | Faits **`critical`**, faits **en attente de revue** (dormants), faits **marqués d'un client** |
| — | Télémétrie d'usage locale |
| — | **Secrets** : le coffre inter-machines existe côté moteur (chiffré GVK), mais aucun secret n'est partagé |

**Règles appliquées par le hub** à ce qu'envoie un Mac relié :
- chaque fait doit appartenir à l'espace de la requête, sinon il est refusé ;
- un fait `critical` ou marqué d'un client est refusé ;
- un Mac ne modifie ou ne supprime **que les faits nés sur sa machine**, jamais ceux du hub ni d'un
  autre collègue ;
- les refus sont comptés (journal d'audit du hub ; `memoria sync now` affiche le nombre).

### Qui écrit dans l'espace `user` ? (il reste sur chaque Mac)
- Tes agents (Claude Code, Codex…) peuvent **déclarer directement un fait sur toi** dans `user`
  (préférence, façon de travailler) : il est visible par tes assistants **de ce Mac**, et ne part
  vers aucun Mac de l'équipe. Tu le vois, le corriges ou l'oublies dans **Partage** ou **Mémoire**.
- Les **bots de canal OpenClaw** (WhatsApp, Telegram — exposés à des tiers) sont en **lecture seule** :
  leurs propositions passent par la **Revue**.
- Un souvenir **privé** ne devient partagé que par ton clic : **Partage → « Faits sur toi »** propose,
  tu coches. La matrice Partage règle qui **lit** quel espace.
- En mode **« Revue d'abord »**, même les faits déclarés attendent ta validation ; en **« Pause »**,
  rien n'est écrit nulle part.

## 5. Mettre à jour Memoria (toutes machines)

**Réglages → Mise à jour → « Vérifier et mettre à jour »** : télécharge la dernière version,
reconstruit, redémarre le service tout seul (refusé pendant un import). En terminal : `memoria update`.
Pour savoir quel build tourne vraiment : `curl -s http://127.0.0.1:<port>/v1/health` → `built_sha`.

## 6. Identifier l'interlocuteur

Dans **Personnes**, enregistrer qui peut parler aux agents (toi, des collègues, des stagiaires, un
client) avec leurs identifiants (Telegram, WhatsApp, e-mail, handle). Les agents appellent
`memoria_identify_interlocutor` pour savoir à qui ils parlent et adapter ton + contexte.

## Sécurité réseau (résumé)

- **L'appairage et les échanges passent en clair (HTTP, pas de TLS).** Pendant l'appairage, le code,
  le jeton du Mac et la clé de signature transitent sans chiffrement : quelqu'un qui écoute ce
  réseau à ce moment-là peut tout récupérer. Ensuite, le texte des faits `org` circule signé mais
  non chiffré (seules les valeurs de secrets le seraient). **Appairer et synchroniser seulement sur
  le réseau du bureau.**
- Le hub n'écoute que sur l'interface du réseau local (`lan:47600`), et seulement les routes
  `/v1/sync/*`, derrière un **jeton de pair + signature HMAC + anti-rejeu** (horodatage à ±60 s). Les
  routes d'administration et de mémoire restent strictement locales (127.0.0.1).
- Chaque requête d'un Mac relié est contrôlée **par Mac** : espaces accordés à son invitation, encore
  synchronisés par le hub, jamais `user`, privé ni quarantaine.
- Les clés (coffre de groupe GVK, clé de signature CPK, jeton de pair) vivent dans le **Trousseau**
  (Keychain) / coffre chiffré AES — **jamais** dans un fichier en clair, jamais dans les journaux.
  Un Mac révoqué garde les clés du groupe : pas encore de rotation (voir « Reporté »).
- En cas d'édition concurrente du même fait sur deux machines, la dernière écriture gagne (règle
  déterministe) ; la version perdante n'est pas conservée.
- **Oublier ne se propage pas encore** : un fait `org` parti par erreur doit être oublié sur chaque
  Mac. De même, un fait passé `critical`, en revue ou marqué d'un client **après** son envoi reste
  chez les Mac qui l'ont déjà reçu.
- Se déconnecter : **Réglages → Synchro → « Se déconnecter »** (`memoria sync leave`). Les souvenirs
  déjà reçus restent disponibles hors-ligne.

### Reporté (pas encore dans le code)
- Chiffrement (TLS, ou au moins appairage scellé par le code).
- Marques de suppression : propager un oubli, retirer un fait devenu non partageable.
- `sync rotate-key` : changer les clés du groupe après la perte ou la révocation d'un Mac.
- Relais NAS de secours, `sync verify`, découverte réseau automatique.
- Synchro de l'espace `user` entre les seuls Mac du propriétaire.
