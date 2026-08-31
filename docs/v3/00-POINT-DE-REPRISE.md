# Point de reprise — Memoria

> **À lire en premier** après une pause. Mis à jour le **31 août 2026**.
> Détail des sessions : [`JOURNAL-2026-08-27.md`](JOURNAL-2026-08-27.md), [`JOURNAL-2026-08-28.md`](JOURNAL-2026-08-28.md).
> Ce qui reste à faire, classé : [`TODO.md`](TODO.md). Installer/mettre à jour ailleurs : [`INSTALLER-ET-METTRE-A-JOUR.md`](INSTALLER-ET-METTRE-A-JOUR.md).

## 1. Où on en est

| | |
|---|---|
| Branche vivante | `memoria-v1` — tip **`372e9af`**, tout est poussé sur GitHub |
| Tests | **1 094 verts** (122 fichiers) · build TS + Vite verts · `cargo test` 19 verts |
| Daemon | tourne **sous launchd** sur ce build (`GET /v1/health` expose `pid`, `supervisor`, `built_sha`) |
| Interface | refondue sur **shadcn/ui** — 16 écrans, thème clair/sombre, contrastes mesurés (AA) |
| Dépôt | **PUBLIC** (Apache 2.0) — code, tests, démo et docs **anonymisés** |

En trois jours : suivi de la consommation par modèle, icône « M » de barre d'état, service launchd fiabilisé,
audit multi-agents (127 constats) puis vérification fonctionnelle (118 constats) implémentés, refonte
complète de l'interface, et mise en ordre du dépôt public.

## 2. Ce qui tourne pendant la pause

- **Le daemon reste actif** (service launchd) : il continue de capturer et d'indexer. C'est voulu — c'est ce
  qui alimente la mémoire des agents.
- **L'import automatique tourne toutes les 6 h** (`fr.primo-studio.memoria.autoimport`) et **coûte de
  l'argent** : ≈ **0,16 $ par 24 h** en ce moment (gpt-4o-mini, rattrapage d'historique). En régime normal,
  sans gros import, c'est nettement moins.
  Pour l'arrêter : `launchctl bootout gui/$(id -u)/fr.primo-studio.memoria.autoimport`.
  Pour tout mettre en pause sans rien désinstaller : `memoria disable` (puis `memoria enable`).
- **Après un `memoria stop`, le service ne repart pas seul** avant le prochain login : relancer avec
  `memoria start`.

## 3. Les décisions qui attendent Néto

Rien ne bouge sur ces points sans son accord — chacun engage de l'argent, un compte ou un nom public.

| # | Décision | Ce qui est prêt | Ce qui manque |
|---|---|---|---|
| 1 | **Version et tag** | La version actuelle est stable et documentée | Le versionnage est **incohérent** : dernier tag `v4.0.0`, mais tous les `package.json` disent `0.1.0`. Il faut trancher (repartir en `0.x` ? assumer `4.x` ?) **avant** toute publication |
| 2 | **Notarisation de l'app macOS** | Certificat Developer ID présent, app signée, build reproductible | La soumission à Apple (`xcrun notarytool`) — sans elle, l'app ne s'ouvre pas sur un autre Mac |
| 3 | **Publication npm** | Paquets durcis, `npm pack --dry-run` propre | Le scope `@memoria` appartient à un tiers → créer une organisation npm et renommer partout |
| 4 | **Réécriture de l'historique git** | L'état actuel du dépôt est anonymisé | Les **anciens commits** gardent des noms de tiers et des montants réels, et un *fork* existe déjà. `git filter-repo` + push forcé casserait les clones existants |
| 5 | **Grok** | — | Introuvable dans l'installation. Deux voies : via **OpenRouter** (`x-ai/grok-…`, marche déjà, simple changement de modèle) ou une **clé API xAI** (petit développement) |
| 6 | **Ré-extraction des corrélations** | ~4 200 souvenirs actifs, outil de nettoyage des libellés prêt | ≈ **0,30 $** d'appels pour remplacer les 96 % de relations heuristiques par de vraies relations |

## 4. À faire au retour, dans cet ordre

1. **Valider le démarrage automatique sur une machine d'essai** (VM ou second compte macOS) : c'est le seul
   maillon du parcours d'installation qui n'a **pas pu être testé** ici — l'essayer sur ce Mac aurait arrêté
   le daemon de production. À faire **avant** d'installer chez quelqu'un d'autre.
2. **Relancer la gateway OpenClaw** : à l'arrêt depuis le 24/08, donc l'agent de messagerie ne mémorise ni
   ne rappelle rien.
3. **Arbitrer les 5 révisions en attente** (écran Révisions — il montre désormais les deux souvenirs en
   conflit, on peut trancher en connaissance de cause).
4. **Re-mesurer la latence de recall à froid** : le doctor signale un p95 à 1 597 ms, mesuré pendant une
   réindexation — le chiffre est probablement faussé.
5. Puis les points 1 à 6 du tableau ci-dessus, selon les décisions prises.

## 5. Les réflexes à ne pas perdre

- **Le dépôt est public** : jamais de nom de client, de montant, d'adresse ou de contact réel dans le code,
  les tests, les données de démonstration ou les documents. Le jeu de démo (`scripts/ui-preview.mjs`) est
  entièrement fictif — le garder ainsi.
- **Après un `memoria stop`, toujours `memoria start`** (le service launchd ne redémarre pas seul).
- **Fusion de catalogues de traduction** : toujours dédoublonner ensuite, sinon le build Vite échoue sur
  « Duplicate key ».
- **Aperçu de l'interface sans toucher à la vraie mémoire** : `npm run ui:preview` (données fictives,
  faux moteur, aucun appel payant), `--screenshot <dossier>` pour les captures.
- **Vérifier avant d'affirmer** : `memoria doctor` (bilan complet, dont le moteur d'IA et le coût),
  `GET /v1/health` (quel build tourne réellement).
