# Passation — sessions des 3 et 4 août 2026

> ⚠️ **État au 27/08 : voir `JOURNAL-2026-08-27.md`** (980 tests / 105 fichiers, tip `0da12f7`, build `f5109a3`, daemon launchd sur le
> MacBook Pro). Les § 3 « remarques non appliquées » (#16 `workspaceDir` — l'adaptateur envoie `ctx.cwd` ; #17 `listEmbeddingModels`
> sans appelant ; `readdirSync(assistantsDir)` ignore `shared/*`) et § 4 « pièges » restent **vrais**.

> **But** : reprendre sans contexte oral. Point de départ d'une session déclenchée par un
> `spawn npm ENOENT` sur le bouton « Mise à jour » de l'UI, qui a fait remonter cinq défauts
> distincts. Cinq PR fusionnées (#14 → #18), `memoria-v1` passée de `a5d18c2` à `e365733`.
>
> À lire avec `STATUS.md` (état global) et `TODO.md` (passation générale).

## 0. Le piège à connaître AVANT tout : il y a plusieurs machines

Une bonne partie du temps perdu vient de là. **Un constat mesuré sur une machine ne vaut pas
sur l'autre.** Les deux ont un dépôt, un daemon et une base, dans des états différents.

| | Machine A (Mac Studio) | Machine B |
|---|---|---|
| Dossier de dev | `~/Documents/BADETTER/openclaw-memoria` | `~/Documents/BADETTE_Robert/openclaw-memoria` |
| Dépôt runtime | `~/openclaw-memoria` | `~/openclaw-memoria` |
| Vecteurs en base | `text-embedding-3-small` · 1536d · 2424 | `nomic-embed-text` · 768d · 1256 |
| `orgId` OpenClaw | **non configuré** | `7155dfef-88c4-4687-8307-58bceea0bd38` |

Un brief rédigé depuis A a affirmé « la base ne contient qu'un modèle, aucune réindexation
nécessaire » ; l'agent sur B a mesuré l'inverse et cru le brief faux. Les deux mesures étaient
justes. **Toujours nommer la machine quand on rapporte une mesure.**

### Sur CHAQUE machine, deux copies du dépôt

```
~/.openclaw/extensions/memoria → ~/openclaw-memoria/packages/adapter-openclaw   (symlink)
daemon (ps aux)                → ~/openclaw-memoria/packages/daemon/dist/bin.js
```

OpenClaw et le daemon chargent **`~/openclaw-memoria`**. Le développement se fait dans
`~/Documents/…/openclaw-memoria`. Toute modification côté dev est invisible pour les agents
tant que la copie runtime n'a pas été mise à jour et reconstruite. **Arbitrage non tranché :
faut-il unifier les deux (symlink, suppression) ? À décider.**

## 1. Ce qui a été corrigé

### #14 — `spawn npm ENOENT` + un build jamais rattrapé

**Symptôme.** Bouton « Vérifier et mettre à jour » → `Échec de la mise à jour : spawn npm ENOENT`.

**Cause.** Le daemon est démarré par launchd, qui ne transmet aucun environnement de shell :

```
PATH du daemon = /usr/bin:/bin:/usr/sbin:/sbin
```

`git` s'y trouve (`/usr/bin/git`) — d'où un `git pull` qui réussit — mais **`npm` n'y est
jamais** : nvm, Homebrew et le pkg officiel l'installent tous ailleurs. `update.ts` faisait
`execFile('npm', …)`, résolution par PATH pur.

Invisible jusque-là parce que le bloc npm est conditionné par `changed` : une machine déjà à
jour répond « Déjà à jour » sans jamais toucher à npm.

**Correctif.** `resolveNpm()` trouve npm par chemin absolu :
1. sous le préfixe du node courant — `<prefix>/lib/node_modules/npm/bin/npm-cli.js` (nvm, pkg officiel) ;
2. via le shim voisin résolu par `realpath` — **Homebrew installe npm hors du Cellar**,
   `/opt/homebrew/bin/npm` étant une chaîne de symlinks vers `/opt/homebrew/lib/node_modules/…` ;
3. emplacements usuels, puis erreur explicite.

Un candidat aboutissant à un `.js` est lancé par le node du service : même runtime que le daemon.

**Second bug, découvert en vérifiant qu'un nouveau clic suffirait.** Il ne suffisait pas :

```ts
const changed = before !== after   // false : le pull avait déjà eu lieu
if (changed) { npm install; npm run build }   // sauté
→ « Déjà à jour. »                            // en vert, ok: true
```

Après un build échoué, le pull reste acquis et l'UI annonce un succès sur une installation
cassée, **sans aucune issue par l'UI**. Corrigé par `.memoria-built-sha` (gitignoré, local),
posé *après* le build seulement ; `needsRebuild()` reconstruit tant qu'il ne coïncide pas avec
HEAD. `UpdateResult.rebuilt` — et non `changed` — déclenche désormais le redémarrage.

Marqueur absent → on reconstruit une fois. Seul choix sûr : se tromper de ce côté coûte un
build, se tromper de l'autre laisse tourner du code périmé indéfiniment.

### #15 — `llm.embeddings` était déclaré mais lu nulle part

`config.ts` définissait `embeddings?: { provider?, model? }` avec le commentaire « provider
ollama uniquement en V1 ». **Aucune occurrence ailleurs dans le dépôt** : réglage mort.

Pendant ce temps `llm/index.ts` donnait la priorité à Ollama **dès qu'il répond**, quels que
soient le profil et la config. Un Ollama démarré pour un autre projet capte les embeddings et
la base accumule des vecteurs de deux modèles — non comparables, donc rappel sémantique faux.

Le réglage est désormais lu et prioritaire. **Il prime aussi sur la garde `cloudAllowed`**
(`extraction?.name === 'openai'`) : celle-ci protège d'un départ vers le cloud *subi*, pas d'un
départ *demandé*. `auditEmbeddings` journalise toujours chaque envoi.

Table `EMBEDDING_DIMENSIONS` ajoutée : les dimensions sont gravées avec chaque vecteur, épingler
`text-embedding-3-large` (3072d) en héritant du défaut 1536 aurait corrompu la base — la classe
de bug qu'on corrigeait.

`openaiKeyFile` rendu injectable dans `ResolveLlmProfileOptions`, comme `anthropicKeyFile` :
sans lui `resolveOpenAiApiKey` retombe sur le fichier de HOME et un test lancé sur une machine
configurée lisait la **vraie clé**. Même exigence que 23fc709 (trousseau).

### #16 — trois dettes de l'adaptateur OpenClaw

- **`repo_path`** : n'envoie plus que `ctx.cwd` de session. `process.cwd()` était celui du
  gateway, pas du dépôt de la conversation — un mauvais `repo_path` est pire qu'aucun, il
  booste les faits du mauvais répertoire.
- **LRU `lastTurn`** : `Map.set` sur une clé existante ne rafraîchit pas l'ordre d'insertion,
  donc le run **le plus actif** pouvait être évincé → sa signature perdue → tour recapturé →
  doublon. Corrigé par `lruSet` (delete + set).
- **`beforeExit`** : handler retiré. Il ne se déclenche ni sur `process.exit()` ni sur
  SIGTERM/SIGINT, et un fetch en vol maintient déjà la boucle d'événements — c'était un no-op
  qui prétendait garantir quelque chose. Un drain SIGTERM appelant `process.exit` casserait un
  gateway long-running : le commentaire le dit maintenant au lieu de promettre un filet absent.

### #17 — l'avertissement cross-modèle criait au loup

Le message « les vecteurs d'un autre modèle […] ne sont plus comparables » partait dès qu'on
empruntait le chemin OpenAI, **sans jamais regarder la base**. Il est maintenant conditionné à
un `SELECT DISTINCT model FROM embeddings` : silence si la base est vide ou homogène.

### #18 — `autostart on` annonçait un succès sans vérifier

**Rencontré en vrai, avec un daemon à terre pendant une minute.** `memoria autostart on` a
affiché « ✓ Lancement auto installé » alors que le service n'était pas chargé ; sortie par un
`launchctl bootstrap gui/501 <plist>` manuel.

Deux pièges combinés :
1. `bootout` et `bootstrap` enchaînés sans respirer — launchd ne libère pas le nom du service
   instantanément, le bootstrap immédiat échoue.
2. **`launchctl load -w` est un shim déprécié qui rend 0 sans rien faire** sur les macOS
   récents. Le repli « réussissait » donc toujours, aucune exception n'était levée.

Et la CLI imprimait le ✓ sans lire `s.loaded`, que `autostartStatus()` venait de calculer à
`false`.

**Le code de sortie de launchctl ne prouve rien.** `reloadService(ops)` attend le déchargement
effectif, retente, et vérifie `isLoaded()` après chaque tentative ; échec → `throw` avec la
commande de secours. `LaunchctlOps` est injectable, donc le scénario se teste sans launchd.

## 2. État vérifié au 4 août 2026

| | |
|---|---|
| `memoria-v1` | `e365733` |
| `tsc -b` | 0 erreur |
| `vitest` | **682 tests / 64 fichiers** (643/63 au départ) |
| `boot-test.mjs` | OK |
| Machine A — daemon | pid 89437, port 50544, `/v1/health` → `ok: true` |
| Machine A — les deux copies | `e365733`, reconstruites, `.memoria-built-sha` posé |

Le bouton de mise à jour a été testé de bout en bout sur A :

```json
{ "ok": true, "changed": false, "rebuilt": false,
  "log": "Already up to date.", "message": "Déjà à jour." }
```

Ce « Déjà à jour » est fiable : il vient de `rebuilt`, calculé sur le marqueur, pas du `changed`
qui mentait.

Le plist de A a été régénéré avec le `PATH` (diff limité au bloc `EnvironmentVariables`,
`ProgramArguments` intact). Sauvegarde : `fr.primo-studio.memoria.plist.bak-pre-path-20260804-081307`.

## 3. Reste à faire

### Amorçage — le bouton cassé ne peut pas livrer son propre correctif

Sur **chaque machine**, une fois, depuis le Terminal :

```sh
cd ~/openclaw-memoria && git pull && npm install && npm run build
```

Fait sur A. **À faire sur B** (état A/B **inconnu au 27/08** — seul le poste C, MacBook Pro, est aligné), où le daemon rattrapera au boot les 1256 faits nomic en les
réindexant sur le modèle actif (`server.ts` appelle `indexEmbeddings()` à chaque démarrage).

### Gateway OpenClaw jamais redémarré

Les correctifs de #16 sont sur le disque mais l'adaptateur chargé est l'ancien. Redémarrage à
faire au moment choisi — il coupe les sessions en cours.

### Configuration non appliquée sur la machine A

`~/.memoria/config.toml` contient `[llm.extraction]` (openai/gpt-5-mini) mais **pas**
`[llm.embeddings]`. Les embeddings OpenAI y arrivent donc encore par le repli `cloudAllowed`,
pas par un choix épinglé. À ajouter :

```toml
[llm.embeddings]
provider = "openai"
model = "text-embedding-3-small"
```

> **Contrainte projet** : Memoria tourne sur OpenAI, extraction et embeddings. Pas d'Ollama ni
> de LM Studio — le parc n'est pas assez puissant pour du local. Ne jamais proposer d'installer
> un modèle local comme remède.

`plugins.entries.memoria.config` dans `~/.openclaw/openclaw.json` n'a toujours ni `projectId`,
ni `clientOrgId`, ni `orgId` sur A : `scoreFact` applique boost ×1 et `passesClientIsolation`
n'isole rien. Sur B, seul `orgId` a été posé — avec 0 projet et 0 client en registry, une
organisation unique booste tout de la même façon, **l'effet est nul**. Ne pas comptabiliser
ça comme « isolation configurée ».

### Deux remarques de relecture non appliquées

- **#16 — `workspaceDir` serait plus juste que `cwd`.** Le type réel de l'hôte
  (`openclaw/dist/types-DaHgOqFX.d.ts:5108`) expose les deux : `cwd` = « Tool execution cwd »,
  `workspaceDir` = « Host workspace ». Pour identifier le projet c'est `workspaceDir` le bon
  champ ; `cwd` diffère dès qu'un outil tourne dans un sous-dossier ou un bac à sable.
  Suggéré : `ctx.workspaceDir ?? ctx.cwd`, avec `workspaceDir` ajouté à l'interface
  `HookContext` de l'adaptateur.
- **#17 — `ContentStore.listEmbeddingModels()` n'est jamais appelé.** `memoria.ts` ouvre ses
  propres connexions `DatabaseCtor` et parcourt `readdirSync(assistants)`, ce qui **ignore
  `shared/*.sqlite`** — un scope partagé hétérogène ne déclencherait aucun avertissement. Le
  bon parcours existe quatre lignes plus haut dans `indexEmbeddings()` :
  `this.registry.listDbs().filter(e => e.kind !== 'registry')`.

### Inventaire des tests manquants

`update.ts` n'avait **aucun test** — c'est ce qui a laissé passer deux bugs d'affilée, dont un
qui déclarait « Déjà à jour » sur une installation cassée. `control/autostart.ts` a fait la
démonstration du même problème le lendemain. Priorité aux modules qui touchent à
l'installation, la mise à jour, le démarrage de service et les chemins système : leurs pannes
se produisent chez l'utilisateur et jamais en CI.

Restent sans test dédié (re-daté 27/08) : `packages/mcp/src/bin.ts`, `packages/cli/src/commands/export.ts`,
`daemon/src/static.ts`. Couverts depuis : `update.ts` (`update.test.ts`, `update-command.test.ts`), `autostart.ts`
(`autostart*.test.ts`, `launchd-status`, `ensure-daemon-launchd`), `scoring.ts` (`scoring-context`, `contract`),
`sync/*` (`sync-crypto`, `sync-engine`, `sync-merge`, `sync-http`).

## 4. Pièges de diagnostic rencontrés

**`~/.memoria/data/daemon.log` est trompeur.** Sous launchd la sortie part dans
`~/Library/Logs/memoria.out.log` et `memoria.err.log`. Le fichier dans `data/` peut dater de
plusieurs semaines tout en paraissant courant. Vérifier le `mtime` avant de citer un log.

**`/v1/admin/version` lit le SHA du dépôt, pas du code chargé.** Après un rebuild sans
redémarrage, il annonce le nouveau SHA alors que le process tourne encore sur l'ancien. Croiser
avec l'heure de démarrage du process (`ps -o lstart`). **Depuis le 27/08** : `GET /v1/health` expose
`built_sha` (le vrai build, lu dans `.memoria-built-sha`), `pid` et `supervisor` — c'est lui qu'il faut lire.

**`better-sqlite3` compilé pour une autre version de Node** fait échouer massivement `npm test`
sans que ce soit lié aux modifications en cours (ABI 127 = Node 22, 137 = Node 24).
`npm rebuild better-sqlite3` avant de conclure quoi que ce soit d'un échec de suite.

**Une PR empilée ne se retarge pas toute seule** si sa base n'est pas supprimée. #17 visait
`fix/embeddings-provider-explicite` ; après fusion de #15 elle pointait encore dessus, et la
fusionner telle quelle l'aurait envoyée dans la mauvaise cible. Vérifier `baseRefName` avant
chaque fusion d'une pile.
