# @memoria/adapter-openclaw

Plugin **OpenClaw** mince (zéro dépendance native) qui donne à OpenClaw la
mémoire **automatique** de Memoria. Il ne contient aucune logique mémoire : il
traduit deux hooks OpenClaw en appels HTTP au daemon Memoria local.

| Hook OpenClaw | Route daemon | Effet |
|---|---|---|
| `before_prompt_build` | `POST /v1/memory/recall` | **auto-recall** : injecte les souvenirs pertinents AVANT chaque tour (`prependContext`) |
| `agent_end` | `POST /v1/memory/capture_turn` | **auto-capture** : mémorise la conversation en fin de tour (fire-and-forget) |

Le MCP natif d'OpenClaw (`openclaw mcp set memoria …`) ne donne que le « pull »
(l'agent doit appeler les tools lui-même). Ces hooks ajoutent la boucle
**automatique** — la vraie proposition de valeur de Memoria.

## ⚠️ Le piège qui a tué la capture en v3.34

Depuis OpenClaw **2026.5/2026.6**, `agent_end` (et `llm_output`) sont des
*conversation hooks* **bloqués par défaut** pour les plugins non bundlés. Sans
le flag ci-dessous, **l'auto-capture est désactivée silencieusement** (warn dans
les logs, aucune erreur visible) — c'est la cause probable de la régression de
capture de Memoria v3.34. Voir `docs/v3/DIAG-OPENCLAW-2026.6.5.md`.

```jsonc
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "allow": ["memoria"],
    "entries": {
      "memoria": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },  // ← SANS ça, capture morte
        "config": { "token": "<token d'instance>", "instance": "koda" }
      }
    }
  }
}
```

## Installation (automatique)

`memoria connect --code XXXX-XXXX` sur un hôte OpenClaw fait **tout** :
1. enregistre le serveur MCP (`openclaw mcp set memoria …`) ;
2. lie ce plugin dans `~/.openclaw/extensions/memoria` ;
3. écrit `~/.openclaw/openclaw.json` avec `allowConversationAccess=true` + le
   token d'instance.

Puis : `openclaw plugins enable memoria` (si nécessaire) et redémarre OpenClaw.
Vérifier : `openclaw plugins inspect memoria` (doit montrer
`allowConversationAccess: true`) et grepper les logs pour
« blocked because non-bundled plugins must set… » (ne doit PAS apparaître).

Désinstallation : `memoria disconnect` (retire le MCP, le plugin et l'entrée de
config, laisse le reste intact).

## Configuration (`plugins.entries.memoria.config`)

| Clé | Défaut | Rôle |
|---|---|---|
| `injectionMode` | `hooks` | `hooks` = Memoria injecte son propre bloc. `corpus` = Memoria alimente la section du propriétaire du slot mémoire. Voir ci-dessous. |
| `token` | — | **Requis.** Token d'instance (pairing). Lit/écrit `/v1/memory/*`. |
| `instance` | `koda` | Étiquette d'affichage seulement (l'instance réelle est dérivée du token). |
| `daemonUrl` | auto | Vide = découverte du port via `<storageRoot>/daemon.json`. |
| `storageRoot` | `~/.memoria/data` | Pour la découverte du port. |
| `autoRecall` | `true` | Injecter la mémoire avant chaque tour. |
| `autoCapture` | `true` | Mémoriser en fin de tour. |
| `recallLimit` | `12` | Nombre max de souvenirs demandés au daemon (1–20). |
| `recallTimeoutMs` | `800` | Timeout DUR du recall (la mémoire ne retarde jamais un tour). |
| `tokenBudget` | `600` | Cap du bloc injecté, en tokens estimés. Envoyé aussi au daemon. |
| `relevanceFloor` | `0.15` | Écarte les souvenirs sous cette **fraction du meilleur score**. `0` = désactivé. |
| `showProvenance` | `true` | Affiche la date d'origine de chaque souvenir. |
| `projectId` | — | `active_context.project_id` → boost de pertinence projet. |
| `clientOrgId` | — | `active_context.client_org_id` → **isolation dure** inter-clients. |
| `orgId` | — | `active_context.org_id` → boost de pertinence organisation. |

### `injectionMode` : qui écrit dans le prompt ?

Depuis OpenClaw 2026.4, le slot mémoire (`plugins.slots.memory`) est **exclusif**
et appartient par défaut au plugin bundlé `memory-core`. Si Memoria injecte en
plus son propre bloc via `before_prompt_build`, **deux systèmes écrivent dans le
même prompt sans se connaître** : budgets qui se marchent dessus, et un même fait
qui revient sous deux formulations.

```
plugins.slots.memory = "none"          → injectionMode: "hooks"
plugins.slots.memory = <un plugin>     → injectionMode: "corpus"   ← recommandé
```

En mode `corpus`, Memoria n'injecte plus rien : elle s'enregistre via
`registerMemoryCorpusSupplement` (entrée publique `openclaw/plugin-sdk/memory-core`),
et le propriétaire du slot fusionne ses résultats dans **sa** section unique, avec
**son** budget. Vérifier l'état avec :

```bash
openclaw config get plugins.slots.memory
```

Deux bénéfices au passage. Le contrat `search`/`get` est exactement le
« index court d'abord, détail seulement si nécessaire » : `search` ne renvoie que
des extraits, `get` ne charge le contenu complet que sur demande. Et
`MemoryCorpusSearchResult` porte nativement `provenanceLabel`, `sourceType`,
`updatedAt` et `citation` — la traçabilité par souvenir, sans format maison.

L'**auto-capture est indépendante** de ce réglage : elle reste active dans les
deux modes (elle écrit, elle n'injecte pas). Si l'hôte n'expose pas l'API de
corpus (version antérieure), l'enregistrement échoue proprement et le journalise
— il faut alors repasser en `hooks`.

### Isolation projet / client : à configurer par workspace

Le core sait déjà pondérer par contexte (`scoreFact`) et **isoler durement** les
faits d'un client (`passesClientIsolation`) — mais tout cela est piloté par
`active_context`. Le plugin dérive `repo_path` du cwd automatiquement ; en
revanche `projectId` / `clientOrgId` ne sont **pas devinables** depuis OpenClaw
et doivent être déclarés dans la config du workspace :

```jsonc
"config": { "token": "…", "projectId": "primo", "clientOrgId": "soc" }
```

Sans eux, les boosts valent ×1 et rien ne sépare deux clients dans le rappel.

## Ce que le plugin envoie au daemon

- **Recall** : `query`, `limit`, `token_budget`, `active_context`.
- **Capture** : le **tour courant uniquement** (du dernier message `user` à la
  fin), pas l'historique complet. `agent_end` livre toute la conversation :
  la reposter à chaque tour faisait ré-extraire les mêmes énoncés en boucle
  (coût quadratique, et des doublons à variantes en base). Un même tour signalé
  deux fois n'est capturé qu'une fois.

## Formatage du bloc injecté

Les souvenirs sont groupés en sections — **Faits actifs**, **Procédures
applicables**, **À vérifier** — pour qu'un épisode ponctuel ne se lise pas comme
une règle permanente. Chaque souvenir est aplati sur une ligne et ses caractères
structurants sont désamorcés : les souvenirs sont extraits automatiquement de
conversations pouvant contenir du contenu web, et doivent rester des **données**,
jamais des instructions.

## Robustesse

Tout échec (daemon arrêté, timeout, Memoria en pause) est **avalé proprement** :
un agent ne casse jamais parce que sa mémoire est indisponible. Le daemon
journalise la capture (WAL) **avant** l'extraction → un timeout d'extraction ne
perd aucune donnée (rejeu au prochain boot).

⚠️ Le WAL protège ce qui **est arrivé** au daemon. Si le process OpenClaw sort
avant la fin du POST (run one-shot), la capture serait perdue — le plugin draine
donc ses requêtes en vol sur `beforeExit`.

Les warns sont limités à **un par minute et par route** (un daemon lent en
produisait un à chaque tour, noyant le signal utile), mais **tout est compté** :
`getStats()` expose `recallOk/Fail/Empty`, `captureOk/Fail/Skipped`, les
horodatages des derniers succès et la dernière erreur — de quoi détecter une
panne silencieuse comme celle de la v3.34.
