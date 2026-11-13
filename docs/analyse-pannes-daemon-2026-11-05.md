# Le daemon cesse de répondre : import bloquant, verrou périmé, fenêtres perdues

**État au 13/11/2026 :** les 4 lots sont codés, testés et en service sur le poste. Trois causes de plus ont été trouvées pendant la recette (section « Trouvé pendant la recette »). Analyse d'origine du 05/11/2026 conservée ci-dessous.

## Résumé

Deux pannes ont rendu la mémoire inutilisable, pour deux causes différentes. L'analyse a aussi révélé une perte silencieuse de données à l'import.

| # | Problème | Effet | Fréquence |
|---|---|---|---|
| 1 | L'import relit tout le corpus dans le thread du daemon | Plus de réponse pendant 23 à plus de 40 s | À chaque import, et de pire en pire |
| 2 | Verrou périmé après un redémarrage brutal | Daemon arrêté jusqu'à une réparation à la main | À chaque redémarrage non propre, avec un pid repris |
| 3 | Fenêtre en échec marquée comme importée | Souvenirs jamais extraits, sans alerte | À chaque échec d'appel au LLM |

## Problème 1 : l'import bloque le daemon

**Symptôme :** `Memoria daemon did not answer within 30 s` sur `correct` et `recall`, alors que le daemon tourne depuis 5 jours sans redémarrage.

**Mesures sur le daemon réel, le 05/11/2026 :**

| Mesure | Résultat |
|---|---|
| Temps de réponse pendant l'import | 23 à 35 s par à-coups, 0,001 à 0,003 s entre deux ; une mesure a dépassé 40 s |
| Délai du client MCP (`DAEMON_TIMEOUT_MS`) | 30 s |
| Durée de l'import | 2 h 35 (13 h 30 à 16 h 05), les deux instances comprises |
| Cadence réelle des imports | toutes les 7 à 11 h (`StartInterval` de 6 h, Mac parfois en veille) |
| Corpus relu à chaque import | 2 105 fichiers, 5,4 Go, le plus gros 72 Mo |
| Échantillon de pile (`sample`) | décodage UTF-8, `read`, `sha256_block_armv8` |

**Mécanisme (`packages/core/src/migration/import-transcripts.ts`) :**

1. Chaque import relit chaque fichier en entier (`readFileSync`, ligne 257) et le hache, même s'il n'a pas changé.
2. L'import tourne dans le thread unique du daemon, qui sert aussi les requêtes HTTP (`packages/daemon/src/server.ts`, en-tête).
3. Un fichier déjà importé sort sans vraie attente : le `await importOneFile` de la boucle (ligne 211) ne rend pas la main au serveur. Il ne la rend qu'au prochain appel réseau, donc au prochain fichier nouveau.

Tout un lot de fichiers inchangés forme donc un seul bloc, pendant lequel aucune requête n'est servie. Le problème grandit avec le nombre de conversations.

**Reproduction hors daemon** (`readFileSync` + SHA-256 sur 218 vrais fichiers, 1 Go, sans écriture) :

| Essai | Plus long blocage |
|---|---|
| Comme aujourd'hui | 5,17 s |
| Avec `await new Promise(setImmediate)` entre deux fichiers | 0,38 s |
| `stat` seul sur les 2 105 fichiers | 14 ms au total |

## Problème 2 : verrou périmé après un redémarrage brutal

- Après un redémarrage non propre, `daemon.lock` garde l'ancien pid. Lors de la panne observée, il avait été repris par un processus système.
- `acquireLock` (`packages/daemon/src/state.ts`, ligne 109) teste seulement `isPidAlive(holder)` : le daemon reste en attente sans fin.
- Réparation manuelle actuelle : renommer `daemon.lock` et `daemon.json`. Ne jamais tuer le pid du verrou, c'est un processus système.
- Panne observée du 30/10 au 02/11/2026. Elle peut revenir.

## Problème 3 : des fenêtres en échec sont perdues

Constat à la lecture du code, pas encore reproduit.

- `extractWindow` renvoie `[]` quand l'appel au LLM échoue (`import-transcripts.ts`, ligne 397), et la boucle continue.
- En fin de fichier, `if (!sourceId) ensureSource()` enregistre quand même le hash du fichier.
- Au prochain import, le contrôle « déjà importé » saute ce fichier s'il n'a pas changé. Les fenêtres en échec ne sont jamais retentées.
- Volume : 66 échecs sur 528 appels sur 24 h (12,5 %), d'après `doctor`.

## Autres constats

- **Une erreur de délai ne veut pas dire échec.** Un `memoria_correct` qui a renvoyé « did not answer » a bien été appliqué une fois le blocage passé, vérifié dans la base. Un nouvel essai peut donc rejouer une écriture déjà faite.
- **Le message d'erreur renvoie vers une commande absente.** `memoria doctor` n'est pas dans le PATH sur ce poste. Commande réelle : `node packages/cli/dist/bin.js doctor`.
- **`doctor` ne détecte pas le blocage.** Il ne mesure pas la réactivité du daemon.
- **Les processus `serve` ne sont pas en cause.** Il y en a 17, tous avec un parent vivant, de 3 à 15 Mo chacun. Rien à arrêter.
- **La machine était saturée.** Charge de 27 à 133, 573 Mo libres sur 32 Go. Cela allonge les blocages sans les expliquer ; part non mesurée.

## Non prouvé

- **Cause des « fetch failed » vers OpenAI.** Le journal ne garde pas `err.cause`. Deux pistes : les délais de connexion expirent pendant les blocages, ou le VPN actif sur la machine.

## Plan de travail

### Lot 1 : l'import ne bloque plus (priorité 1)

Fichier : `packages/core/src/migration/import-transcripts.ts`.

- [x] Rendre la main entre deux fichiers : `await new Promise(setImmediate)` dans la boucle de la ligne 209.
- [x] Sauter sans lecture les fichiers inchangés : `stat` d'abord, comparaison taille + date de modification. Nouvelle table par migration additive (`packages/core/src/storage/migrations.ts`), par exemple `transcript_file_state(path, size, mtime_ms, source_hash, complete, updated_at)`. `memory_sources` ne convient pas : elle ne porte ni la taille, ni la date, ni l'état complet.
- [x] Mesurer le blocage sur le plus gros fichier (72 Mo). S'il dépasse 1 s, passer à une lecture et un hachage asynchrones. **Mesuré le 13/11 sur 75 Mo : lecture asynchrone 119 ms, hachage 157 ms, analyse 209 ms. Sous 1 s, rien de plus à faire.**
- [x] Tests : un minuteur se déclenche pendant un import de fichiers déjà connus ; un fichier inchangé n'est pas lu ; un fichier modifié est relu.

Le premier import après le correctif relira tout une fois pour remplir la table.

### Lot 2 : ne plus perdre de fenêtres (priorité 2)

Fichier : `packages/core/src/migration/import-transcripts.ts`.

- [x] Compter les fenêtres en échec par fichier. N'enregistrer le fichier comme complet que si toutes ont réussi.
- [x] Retenter au prochain import, avec un maximum de 3 essais pour borner le coût. La déduplication existante (hash et `findDuplicate`) évite les doublons.
- [x] Journaliser `err.cause` dans `extractWindow` pour trancher la cause des « fetch failed ».
- [x] Tests : une fenêtre en échec est retentée ; un fichier entièrement réussi ne l'est pas ; le maximum d'essais est respecté.
- [ ] À décider : réimporter une fois les fichiers en échec listés dans les journaux passés.

### Lot 3 : corriger le verrou (priorité 3)

Fichier : `packages/daemon/src/state.ts`.

- [x] Tenir pour périmé un verrou dont la date de modification précède le démarrage de la machine (`Date.now() - os.uptime() * 1000`, avec une marge). Méthode portable macOS et Windows.
- [x] Vérifier que `os.uptime()` compte bien la veille sur macOS. Sinon, le verrou d'un daemon vivant paraîtrait périmé et deux daemons tourneraient en même temps. **Vérifié le 13/11 : démarrage calculé identique à `sysctl kern.boottime`, sur une machine allumée depuis 13 jours avec 377 mises en veille.**
- [x] Tests dans `packages/daemon/test/lock-race.test.ts` : verrou antérieur au démarrage avec pid vivant, repris ; verrou récent avec pid vivant, refusé.

### Lot 4 : rendre les pannes visibles (priorité 4)

- [x] Mesurer le blocage avec `monitorEventLoopDelay` et l'exposer dans `GET /v1/health`.
- [x] Ajouter un avertissement dans `doctor` au-delà d'un seuil.
- [x] Corriger le message d'erreur de `packages/mcp/src/serve.ts:395` : dire que l'écriture a pu être appliquée et donner une commande qui marche.
- [x] Ajouter une surveillance `launchd` de `/v1/health`, avec notification si le daemon ne répond pas à 3 contrôles de suite.

### Trouvé pendant la recette (13/11/2026)

Les lots 1 à 4 seuls ne suffisaient pas : le premier import de recette bloquait encore le daemon 39 à 40 s. Le profil du process (`sample`) a montré trois autres causes, toutes liées à la taille de la base (67 000 faits, dont 65 836 en attente de revue).

| # | Cause | Mesure | Correctif |
|---|---|---|---|
| 5 | `findDuplicate` relisait tout le scope (`SELECT *`) pour chaque fait candidat | 39 à 40 s de blocage par fenêtre | Colonne `facts.norm_hash` indexée (migration 6) : doublon exact par index. 50 ms au lieu d'un balayage |
| 6 | Tout fichier modifié repartait au LLM en entier (20 dernières fenêtres), et le LLM reformule à chaque passage | 65 836 faits en attente de revue en deux semaines, imports de 2 h 35 | Table `transcript_window_state` (migration 7) : une fenêtre n'est extraite qu'une fois |
| 7 | `runAll` réparait l'index vectoriel (relecture de 34 Mo) après chaque fait stocké, avec un cache SQLite de 2 Mo | 937 échantillons sur 16 754 en lecture disque, pointes de 3 à 4 s | Réparation au premier passage puis toutes les 10 min au plus ; `cache_size` à 32 Mo |
| 8 | L'import préchargeait le texte de tous les faits du scope pour sa dédup | 3 s de blocage à froid au début de chaque import | Recherche par l'index `norm_hash`, plus aucun préchargement |

Autres corrections faites au passage :

- [x] Course au verrou : le fichier existe vide entre sa création et l'écriture du pid ; un concurrent le prenait pour périmé (test « OK / OK » sous charge). Un verrou vide est relu 200 ms avant d'être déclaré illisible.
- [x] La main est rendue aussi entre deux faits d'une même fenêtre.

Reste à décider :

- [ ] **File de revue : 65 836 faits en attente** dans l'instance Claude Code. Ce sont en grande partie des redites produites par la cause 6. À trier ou purger par lot, avec l'accord de l'utilisateur.
- [ ] Le WAL de la base atteint 44 Mo : vérifier que les checkpoints aboutissent.
- [ ] Même balayage possible côté capture (`capture.ts:282`) : couvert par l'index, mais pas mesuré.

### Fin du chantier

- [x] Compter les souvenirs avant et après : aucun fait perdu (les totaux n'ont fait que monter avec l'import de recette).
- [x] Construire, redémarrer le daemon, faire la recette ci-dessous.

## Critères de recette

Recette du 13/11/2026 sur le daemon réel, pendant un import de 1 624 fichiers, une sonde `/v1/health` par seconde, machine chargée (charge 8 à 12, une vingtaine de sessions ouvertes) :

| Mesure | Avant | Après |
|---|---|---|
| Temps de réponse pendant l'import | 36 à 45 s | médiane 0,002 s ; 95 % sous 0,7 s ; 99 % sous 1,6 s ; maximum 2,6 s (433 sondes) |
| 255 fichiers déjà connus | relus et hachés en entier | écartés en moins de 10 s, sans lecture |
| Blocage au début d'un import | environ 3 s | 0,02 s |

- [~] Pendant un import complet, `/v1/health` répond toujours en moins de 2 s. **Presque** : 432 sondes sur 433 sous 2 s, une à 2,6 s. Lancer la suite de tests pendant la mesure la fausse (une pointe à 6 s venait de là).
- [x] Aucune erreur « did not answer » pendant cet import.
- [~] Un second import sans rien de nouveau se termine en moins d'une minute. **Mesuré le 13/11 : premier import complet 22 min 47 s (2 h 35 avant), second import 4 min 35 s.** Le second n'est pas « sans rien de nouveau » : les conversations ouvertes continuent de grandir et 5 fichiers incomplets sont retentés. Les fichiers inchangés, eux, passent en quelques secondes.
- [ ] **Reste à expliquer : deux non-réponses de plus de 10 s relevées par la surveillance pendant le premier import complet (12 h 16 et 12 h 30).** La première coïncide avec un lancement de la suite de tests ; la seconde n'est pas expliquée (piste : checkpoint du WAL, passé de 44 Mo à 4 Mo entre-temps).
- [x] Un verrou périmé simulé est repris sans intervention, en moins de 5 s (test `lock-race.test.ts`).
- [x] Une fenêtre en échec est retentée à l'import suivant (test `transcripts.test.ts`).
- [x] Un daemon arrêté déclenche une notification (test `watchdog.test.ts` ; service installé sur le poste).
- [x] La suite de tests passe (1 129 tests) et le nombre de souvenirs n'a pas baissé.

## Retour arrière

Revenir au commit précédent et reconstruire. La migration est additive : la nouvelle table peut rester en place sans gêner l'ancien code.

## Hors périmètre

- Déplacer l'import dans un processus séparé : à reconsidérer seulement si les critères de recette ne sont pas atteints.
- Pid repris sans redémarrage de la machine : cas rare, `launchd` relance le daemon en quelques secondes.
