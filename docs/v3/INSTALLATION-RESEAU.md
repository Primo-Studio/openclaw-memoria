# Installer Memoria sur une nouvelle machine + partager la mémoire (réseau)

Guide non-technique. Objectif : installer Memoria sur une machine neuve (ex. l'iMac de Luna), la
relier à la machine « hub » (ex. le Mac Studio, toujours allumé) et partager la mémoire d'équipe.

> Tout ce qui est décrit ici existe dans le code au 27/08/2026 (écrans Réglages / Agents / Partage,
> commandes `memoria …`). L'onglet **Docs** de l'interface reprend le même contenu en 5 langues.

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

Sur le hub, dans l'interface : **Réglages → Synchro entre machines → « Faire de cette machine le
hub »**, puis redémarrer le service (le bouton l'indique, ou `memoria stop && memoria start`).

En terminal, l'équivalent : `memoria sync init-hub` puis `memoria stop && memoria start`.

## 3. Inviter une machine

Sur le hub : **Réglages → Synchro → « Inviter une machine »** → un **code** s'affiche (valable
10 min) avec l'adresse du hub. En terminal : `memoria sync invite`.

## 4. Relier la nouvelle machine au hub

Sur la nouvelle machine : **Réglages → Synchro → « Relier au hub »** → coller l'**adresse du hub**
(ex. `192.168.1.20:47600`) + le **code**. En terminal :

```sh
memoria sync join --hub 192.168.1.20:47600 --code XXXX-XXXX
```

La machine récupère alors **tout l'historique partagé** (infos sur l'utilisateur, l'entreprise, les
projets) et reste synchronisée. Pour couper un pair depuis le hub : `memoria sync revoke <machine_id>`
(terminal uniquement) ; pour quitter : **« Se déconnecter »** (`memoria sync leave`).

### Ce qui se partage — et ce qui NE se partage PAS

| Partagé entre machines | JAMAIS partagé |
|---|---|
| Scope **user** (faits sur l'utilisateur) | Mémoire **privée** de chaque agent |
| Scope **org** (entreprise, conventions) | Quarantaine de revue (`legacy_to_review`, imports) |
| Scopes **projet / client / sujets** | Télémétrie d'usage locale |
| — | **Secrets** : le coffre inter-machines existe côté moteur (chiffré GVK), mais aucun secret ne peut encore être marqué « partageable » depuis l'interface → en pratique, aucun secret ne circule |

### Qui écrit dans la mémoire partagée `user` ?
- Tes agents (Claude Code, Codex…) peuvent **déclarer directement un fait sur toi** dans `user`
  (préférence, façon de travailler) : il est visible par tous tes assistants, sur toutes les machines
  reliées. Tu le vois, le corriges ou l'oublies dans **Partage** (contenu de l'espace) ou **Mémoire**.
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

- Seules les routes `/v1/sync/*` sortent du loopback, **uniquement sur le LAN**, derrière un **token
  de pair + signature HMAC** (anti-rejeu/anti-MITM). Les routes d'administration et de mémoire restent
  strictement locales (127.0.0.1).
- Les clés (coffre de groupe GVK, clé de pairing CPK, token de pair) vivent dans le **Trousseau**
  (Keychain) / coffre chiffré AES — **jamais** dans un fichier en clair, jamais dans les logs.
- En cas d'édition concurrente du même fait sur deux machines, la dernière écriture gagne (règle
  déterministe) ; la version perdante n'est pas conservée.
- Se déconnecter : **Réglages → Synchro → « Se déconnecter »** (`memoria sync leave`). Les souvenirs
  déjà reçus restent disponibles hors-ligne.
