# Changements du 28 juillet 2026

Session de travail partie de deux retours d'agents bêta (« Luna » et un second
agent), qui convergeaient sur : *« le prochain gain ne sera pas de stocker
davantage, ce sera de rappeler moins, mieux classé, non obsolète et vérifiable »*.

**16 commits, 46 fichiers, +4045 / −733 lignes. 630 tests (contre 547 au départ).**

Trois pannes ont été trouvées et réparées en chemin — aucune n'avait été
signalée, parce qu'elles se masquaient mutuellement.

---

## 1. Pannes réparées

### Extraction morte depuis dix jours

**Symptôme** : 154 entrées WAL abandonnées entre le 17 et le 28 juillet. Autant
de conversations qui n'ont jamais produit un seul souvenir.

**Cause racine, reproduite contre l'API** : sur `gpt-5-mini`,
`max_completion_tokens` couvre *aussi* les tokens de raisonnement, consommés
avant la réponse visible. Avec 1024, un tour long absorbe tout le budget :
l'API répond 200 avec un `content` **vide** et `finish_reason: length`.

| Prompt | Budget | Résultat |
|---|---|---|
| 483 tokens | 1024 | `stop` — OK |
| 3131 tokens | 1024 | `length` — **content vide**, raisonnement = 1024 |
| 3131 tokens | 4096 + `effort: low` | `stop` — 7 faits, raisonnement = 256 |

La panne était **intermittente par construction** : les tours courts passaient,
les longs échouaient. Des souvenirs continuaient d'apparaître, ce qui entretenait
l'illusion que la capture fonctionnait — alors que les conversations les plus
riches étaient précisément celles qui se perdaient.

**Correctif** : plancher de 4096 tokens sur les modèles à raisonnement et
`reasoning_effort: 'low'`. Une réponse vide lève désormais une erreur nommant
`finish_reason` et les tokens consommés.

**Vérifié en production** : 28 messages, 3 faits créés, 0 échec, 0 abandon.

### Le daemon ne journalisait rien

`memoria start` lançait le daemon avec `stdio: 'ignore'` — warnings, échecs
d'extraction et stacktraces partaient au néant. C'est ce qui a permis à la panne
ci-dessus de durer dix jours sans laisser de trace exploitable.

Désormais : `<storageRoot>/daemon.log`, en append.

### L'audit masquait la cause des échecs

L'abandon d'une entrée WAL n'enregistrait que `error.constructor.name`, donc
littéralement `error=Error`. L'intention (ne jamais journaliser de contenu de
conversation) était juste, le remède trop radical.

Désormais : message tronqué à 300 caractères et **passé par le gate secrets** —
un message de provider peut contenir une clé ou un bout de prompt.

### Recherche sémantique jamais fonctionnelle

Ollama était le **seul** fournisseur d'embeddings possible. Sur une installation
sans modèle local, le recall tournait en FTS pur. La table `embeddings` ne
contenait aucun vecteur : la recherche sémantique n'avait jamais tourné.

**Correctif** : `OpenAiEmbeddingProvider` (`text-embedding-3-small`, 1536d), avec
deux garde-fous. Ollama garde la **priorité** dès qu'il est disponible, et le
repli cloud n'est autorisé **que si l'extraction passe déjà par OpenAI** — même
fournisseur, aucun nouveau destinataire des données. Un profil `100-local` ne
verra jamais ses souvenirs partir chez un tiers.

**2074 faits réindexés**, couverture complète.

---

## 2. Qualité du rappel

### `active_context` n'était jamais envoyé

Le core sait pondérer par contexte (`scoreFact`) et **isoler durement** les faits
d'un client (`passesClientIsolation`) — mais tout est piloté par
`active_context`, que l'adaptateur OpenClaw ne transmettait pas. Les boosts
projet/client valaient donc ×1 en permanence et rien ne séparait deux clients.

Désormais transmis : `repo_path` dérivé du cwd, `projectId` / `clientOrgId` /
`orgId` depuis la config du workspace.

### Capture de l'historique complet à chaque tour

`agent_end` livre toute la conversation. La reposter à chaque tour faisait
ré-extraire les mêmes énoncés en boucle, chaque passe du LLM les reformulant un
peu — l'origine probable des « doublons à variantes » signalés.

Désormais : seul le **tour courant** (du dernier message `user` à la fin),
découpage robuste à la compaction. Un même tour signalé deux fois n'est capturé
qu'une seule fois.

### Bloc injecté

- Groupé par type — **Faits actifs** / **Procédures applicables** / **À vérifier** —
  pour qu'un épisode ponctuel ne se lise pas comme une règle permanente.
- Plancher de pertinence **relatif** au meilleur score (le score du core est un
  produit non borné : un seuil absolu dépendrait de l'échelle).
- Budget de tokens, date d'origine affichée.
- Souvenirs **aplatis et désamorcés** avant injection : ils sont extraits de
  conversations pouvant contenir du contenu web et partaient bruts en tête de
  prompt.

### Souvenirs contestés visibles

`RevisionEngine` détecte les contradictions, mais seul `accept()` (validation
humaine) supersède. Entre les deux, le fait corrigé et sa correction restaient
tous deux actifs et remontaient ensemble, indiscernables. Sur la base réelle :
**11 propositions** que personne n'avait jamais arbitrées.

On ne supersède **rien** automatiquement — un faux positif masquerait un
souvenir valide en silence. Le souvenir contesté reste remonté, clairement
marqué `⚠ [contested by a more recent memory]`.

### Niveaux de vérité

`declared` / `extracted` / `inferred` / `confirmed`, **dérivés** des colonnes
existantes plutôt qu'ajoutés comme champ à tenir à jour. Seul `inferred` est
annoté : signaler l'ordinaire noierait le signal.

> **Limite assumée** : on ne distingue pas « dit par l'utilisateur » de « dit par
> l'assistant ». Le rôle du message d'origine n'est pas conservé sur le fait.

---

## 3. Confidentialité

### Gate de secrets étendu

La rédaction s'applique bien **avant** l'envoi au cloud (`capture.ts` étape 0).
Manquaient plusieurs familles :

- canaux d'agent : token de bot Telegram, Twilio, SendGrid, npm ;
- porteurs HTTP opaques (`Bearer` / `Basic`) — seuls les porteurs de forme JWT
  étaient attrapés ;
- codes OTP / 2FA, via un motif contextuel à liste fermée ;
- IBAN (mod-97) et cartes bancaires.

Sur les cartes, **Luhn seul ne suffit pas** : environ une suite de chiffres
aléatoire sur dix le satisfait, si bien qu'une référence interne partait au
coffre. On exige en plus un **préfixe émetteur réel**.

> Volontairement **non** masqués : e-mails, téléphones et noms de personnes.
> Memoria identifie ses interlocuteurs — les masquer casserait cette fonction.
> Cela relève d'une politique de rétention, pas de la rédaction.

### Journal de ce qui quitte la machine

Deux principes : on ne journalise **que ce qui sort** (un provider local est
renvoyé non enveloppé), et **jamais le contenu** — fournisseur, modèle, finalité,
nombre d'éléments, volume en caractères, durée, succès.

Un envoi **raté** est journalisé aussi : les données ont quitté la machine même
si la réponse n'est jamais revenue.

Sur une installation tout-local, `memoria doctor` affiche *« aucun envoi — rien
n'a quitté la machine »*.

---

## 4. Observabilité

`memoria doctor` ne donnait que chemins, tailles et garde réseau. Il expose
désormais, sans table de métriques ni migration (compteurs écrits dans
`audit_log.reason` au format `clé=valeur`) :

```
Mémoire
  faits          : 3672 actifs·archivés — 1598 supersédés
  jamais utilisés: 1832
  révisions      : 11 en attente
  extraction     : 0 message(s) en attente, 0 bloqué(s)

Activité (24 h)
  recalls / captures, derniers horodatages
  latence recall : moyenne et p95
  contexte injecté : coût moyen en tokens

Données envoyées au cloud (24 h)
  par fournisseur/modèle/finalité, volume, échecs
```

Un champ **absent** signifie « pas encore mesuré », **jamais zéro** : afficher
« 0 ms » laisserait croire à un recall instantané.

La capture n'était **pas auditée du tout** — impossible de répondre à « la
dernière capture a-t-elle réussi ? ». Elle l'est désormais.

---

## 5. Boucle d'apprentissage

`FeedbackEngine` était complet et testé — `relevance_weight` borné [0.3, 2.0],
expertise par domaine, decay des dormants — mais `reinforceFacts()` n'était
appelé par **aucune** route, aucun tool, aucun hook.

Câblé de bout en bout : route daemon, outil MCP `memoria_feedback`
(`useful` / `noise`), plus un **signal automatique** en mode corpus — un `get`
(l'agent demande le contenu complet) émet `used:true`. Sans lui, la boucle
dépendrait de la discipline des agents et resterait vide.

---

## 6. Contrôles utilisateur

| Opération | Outil MCP | Note |
|---|---|---|
| Épingler | `memoria_pin` | ×1.8 au score, **hors** du plafond de contexte, échappe au decay |
| Expirer | `memoria_set_expiry` | Invisible au recall, **jamais supprimé** |
| Corriger | `memoria_correct` | Ne réécrit **jamais** en place : supersession chaînée |
| Fusionner | route `/v1/memory/merge` | **Refuse** de fusionner vers un fait supersédé |
| Statut de capture | `memoria_capture_status` | Suivi post-timeout, sans table ajoutée |

> Un id de capture **inconnu** est réputé `done`, pas `pending` : le cleanup ne
> purge que le traité. Répondre `pending` ferait attendre indéfiniment, ou
> pousserait à re-capturer et à créer un doublon.

---

## 7. Cohabitation avec `memory-core`

Depuis OpenClaw 2026.4, le slot mémoire est **exclusif** et appartient par défaut
au plugin bundlé `memory-core`. Si Memoria injecte en plus son propre bloc, deux
systèmes écrivent dans le même prompt sans se connaître.

Nouveau réglage `injectionMode` :

- `hooks` (défaut) — Memoria injecte son bloc. Correct si
  `plugins.slots.memory = "none"`.
- `corpus` — Memoria s'enregistre via `registerMemoryCorpusSupplement` et le
  propriétaire du slot fusionne ses résultats dans **sa** section, avec **son**
  budget.

Les deux modes s'excluent, un test le verrouille. Le contrat `search`/`get` est
exactement le « index court d'abord, détail à la demande » réclamé, et
`MemoryCorpusSearchResult` porte nativement `provenanceLabel`, `sourceType`,
`updatedAt` et `citation`.

---

## 8. Langue des prompts (issue #1)

Sept prompts système étaient en français, dont trois forçaient explicitement une
sortie française (`« en français »`, verdict `« OUI »`). Sur les petits modèles,
ça provoque des fuites de mots français dans les réponses.

**Le piège évité** : traduire bêtement aurait fait *traduire les faits* à
l'extraction. Les prompts exigent donc désormais :

> *Write every fact in the SAME LANGUAGE as the conversation. Never translate it.*

Migration **v3** : catégorie `erreur` → `error`. Pas cosmétique — `category` sert
de **domaine d'expertise**, et deux orthographes = deux domaines dont les niveaux
ne se cumulent plus. 443 faits migrés, fusion des domaines gérée.

---

## 9. Dépendances

8 vulnérabilités Dependabot, toutes transitives via `@modelcontextprotocol/sdk`.

**Analyse d'exposition avant d'agir** : seul `fast-uri` (haute, via `ajv`) est
réellement atteint — `ajv` valide les schémas d'outils MCP à chaque appel.
`hono`, `@hono/node-server` et `body-parser` ne sont **jamais chargés** : le
serveur MCP n'utilise que `StdioServerTransport`.

`@hono/node-server` est **délibérément laissé** en 1.19.14 : son seul correctif
est en 2.0.5, un saut majeur sur du code jamais chargé. Forcer un changement
d'API en travers du SDK ferait courir plus de risque que la vulnérabilité.

---

## Pour les agents : ce qui change côté MCP

**Nouveaux outils** : `memoria_feedback`, `memoria_capture_status`,
`memoria_pin`, `memoria_set_expiry`, `memoria_correct`.

**Nouveaux champs dans `memoria_recall`** :

- `revision` — le souvenir est **contesté** par un plus récent, en attente
  d'arbitrage. À traiter comme douteux, préférer `replacement_fact_id`.
- `origin` — `declared` / `extracted` / `confirmed` / `inferred`. Un
  `inferred` est une **hypothèse déduite**, que personne n'a énoncée.

**Nouveau champ dans `memoria_capture_turn`** : `wal_ids`, à repasser à
`memoria_capture_status` plutôt que de re-capturer après un timeout.

---

## Reste ouvert

- **Écran web de maintenance** — corriger, fusionner et lister l'inutilisé sont
  disponibles par API et MCP ; l'interface graphique reste à construire.
- **11 révisions en attente** d'arbitrage.
- **154 messages abandonnés** avant le correctif : leur contenu est conservé en
  table WAL, un rejeu ciblé demanderait du code dédié.
- **Issue #1** fermée automatiquement par `closes #1`, sans que son auteur ait
  confirmé le correctif sur son installation (Ollama, Phi4-mini).
- **Le plugin de hooks n'est pas installé** dans la config OpenClaw locale : le
  mode corpus, l'auto-recall et l'auto-capture restent dormants.
