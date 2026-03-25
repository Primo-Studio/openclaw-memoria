# 🧠 Memoria v2.5.0 — Multi-layer Memory Plugin for OpenClaw

Brain-inspired persistent memory for AI agents. SQLite-backed, fully local, zero cloud dependency.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      MEMORIA v2.5.0                          │
│                                                             │
│  Hooks: before_prompt_build │ agent_end │ after_compaction  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  RECALL PIPELINE (before_prompt_build):                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │🔥 Hot   │→│ Hybrid   │→│ Graph    │→│ Topics   │   │
│  │ Tier     │  │ Search   │  │ Enrich   │  │ Enrich   │   │
│  │ access≥5 │  │ FTS5+cos │  │ BFS 2hop │  │ keyword  │   │
│  │ always   │  │ +scoring │  │ hebbian  │  │ +cosine  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│       ↓                                         ↓           │
│  ┌──────────┐                              ┌──────────┐    │
│  │ Context  │ ← merge all ─────────────── │ Adaptive │    │
│  │ Tree     │                              │ Budget   │    │
│  │ heuristic│                              │ 2-12     │    │
│  │ NO LLM   │                              │ facts    │    │
│  └──────────┘                              └──────────┘    │
│       ↓                                                     │
│  formatRecall() → inject into system prompt                 │
│                                                             │
│  CAPTURE PIPELINE (agent_end / after_compaction):           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Extract  │→│ Selective│→│ Store    │→│ Post-    │   │
│  │ via LLM  │  │ Filter   │  │ to DB    │  │ process  │   │
│  │(extract  │  │ dedup+   │  │          │  │ embed+   │   │
│  │ Chain)   │  │contradict│  │          │  │ graph+   │   │
│  │          │  │(contradict│  │          │  │ topics+  │   │
│  │          │  │  Chain)  │  │          │  │ sync .md │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Per-layer LLM: extract │ contradiction │ graph │ topics    │
│  Default: FallbackChain (Ollama → OpenAI → LM Studio)      │
│  Override: llm.overrides.{layer} → provider/model au choix  │
├─────────────────────────────────────────────────────────────┤
│            SQLite memoria.db (FTS5 + vectors)                │
│  Tables: facts, facts_fts, embeddings, entities,            │
│          relations, topics, fact_topics                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Layers — Détail par couche

### Layer 1: SQLite Core + FTS5 (`db.ts` ~446 lignes)
- **DB**: `~/.openclaw/workspace/memory/memoria.db` (WAL mode)
- **Tables**: `facts` (main), `facts_fts` (FTS5 virtual table), `embeddings`, `entities`, `relations`, `topics`, `fact_topics`
- **CRUD**: `storeFact()`, `getFact()`, `searchFacts()`, `recentFacts()`, `hotFacts()`, `supersedeFact()`, `enrichFact()`, `trackAccess()`
- **FTS5**: Index via triggers (INSERT/UPDATE/DELETE). Queries sanitisées (hyphens, unicode-safe)
- **LLM**: Aucun
- **Provider**: Aucun
- **Fallback**: N/A

### Layer 2: Temporal Scoring + Hot Tier (`scoring.ts`)
- **Rôle**: Score chaque fait par fraîcheur + catégorie + fréquence d'accès
- **Formule**: `score = confidence × decayFactor × recencyBoost × accessBoost × freshnessBoost × stalePenalty`
  - Decay exponentiel: demi-vie par catégorie (erreur=∞, savoir/preference=90j, outil=30j, chronologie=14j)
  - Access boost: **`0.3 × log(accessCount + 1)`** — un fait accédé 50x score 2.2x plus (v2.5.0: 3x plus fort qu'avant)
  - Recency boost: <24h = ×1.3, <7j = ×1.1
  - Freshness bonus: mis à jour <48h = ×1.2
  - Stale penalty: >90j + faible confiance = ×0.7
- **Hot Tier** (NEW v2.5.0): faits accédés ≥5x = **toujours injectés** en recall, comme un numéro de téléphone appris par cœur
  - `getHotFacts()` → top 3 par access_count (configurable: `minAccessCount`, `maxHotFacts`, `staleAfterDays`)
  - Hot facts exclus du search normal pour éviter les doublons
  - Slots réservés : `searchLimit = recallLimit - hotCount`
- **API**: `scoreAndRank(facts)`, `scoreFact(fact)`, `getHotFacts(facts, config)`
- **LLM**: Aucun
- **Provider**: Aucun
- **Fallback**: N/A

### Layer 3: Selective Memory (`selective.ts` ~361 lignes)
- **Rôle**: Filtre avant stockage — dedup, contradiction, enrichment
- **Pipeline**:
  1. Longueur < 10 chars → skip (too_short)
  2. Noise patterns (salutations, confirmations) → skip
  3. Importance scoring (mots-clés techniques, catégorie) → threshold
  4. FTS5 candidates → Levenshtein > 0.85 → skip (duplicate)
  5. FTS5 candidates → Jaccard keyword overlap → skip (duplicate)
  6. Si similaire mais pas identique → **LLM contradiction check** → supersede/enrich
- **API**: `process(fact, category, confidence)`, `processAndApply(...)`
- **LLM**: ✅ Contradiction check uniquement
- **Provider**: `this.llm` = `contradictionLlm` (configurable via `llm.overrides.contradiction`)
- **Fallback**: Override provider → puis chain par défaut (Ollama → OpenAI → LM Studio)
- **Safety**: try/catch → si LLM fail, le fait est stocké quand même (conservative)

### Layer 4: Embeddings + Hybrid Search (`embeddings.ts` ~247 lignes)
- **Rôle**: Vecteurs + recherche sémantique
- **Modèle embed**: configurable, défaut `nomic-embed-text-v2-moe` (768 dims)
- **Stockage**: Table `embeddings` (fact_id, vector BLOB, model, dimensions, created_at)
- **Hybrid search**: FTS5 score (60%) + cosine similarity (40%) + temporal scoring → merged ranking
- **API**: `hybridSearch(query, limit)`, `embedFact(factId)`, `embedAllMissing()`, `embedBatch()`, `embeddedCount()`
- **LLM**: Aucun
- **Provider**: `this.provider` = `EmbedProvider` (configuré via `embed.provider`)
  - Ollama: POST `/api/embed` (`OllamaEmbed`)
  - LM Studio: POST `/embeddings` (`lmStudioEmbed`)
  - OpenAI: POST `/embeddings` (`openaiEmbed`)
  - OpenRouter: POST `/embeddings` (`openrouterEmbed`)
- **Fallback embed**: Aucun (single provider). Si embed fail → fait stocké sans vecteur

### Layer 5: Knowledge Graph + Hebbian (`graph.ts` ~390 lignes)
- **Rôle**: Entités extraites, relations pondérées, traversal BFS
- **Extraction**: LLM parse le fait → extrait entités (nom, type) + relations (source, target, relation)
- **Hebbian**: Co-accès renforce les poids des relations (weight += 0.1 par co-recall)
- **Traversal**: `getRelatedFacts(entityNames, maxHops=2, maxFacts=10)` — BFS, fuzzy entity matching
- **Tables**: `entities` (id, name, type, attributes), `relations` (source_id, target_id, relation, weight, context)
- **API**: `extractAndStore(factId, factText)`, `getRelatedFacts()`, `findEntitiesInText()`, `hebbianReinforce()`, `stats()`
- **LLM**: ✅ Extraction entités/relations (1 appel par fait capturé)
- **Provider**: `this.llm` = `graphLlm` (configurable via `llm.overrides.graph`)
- **Fallback**: Override provider → puis chain par défaut
- **Safety**: try/catch → si LLM fail, le fait est stocké mais pas indexé dans le graph

### Layer 6: Context Tree (`context-tree.ts` ~340 lignes)
- **Rôle**: Organise les faits candidats en arbre hiérarchique, pondère par query
- **Algorithme**:
  1. Cluster faits par catégorie
  2. Sous-cluster par mots-clés si > 5 faits
  3. Pondérer chaque branche par overlap query ↔ labels
  4. Retourner les faits triés par poids de branche
- **Extraction keywords**: ⚠️ **Heuristique locale** (regex + patterns), PAS de LLM
- **API**: `build(facts, query)` → `ContextTree`, `extractFacts(tree, limit)`, `renderTree(tree, depth)`
- **LLM**: ❌ Aucun — extraction keywords = regex/heuristique locale
- **Provider**: Aucun
- **Fallback**: N/A

### Layer 7: Adaptive Budget (`budget.ts` ~121 lignes)
- **Rôle**: Limite dynamique du nombre de faits injectés selon l'espace contexte
- **Courbe quadratique** (v2.3.0):
  - Light (< 30%): 10 faits max
  - Medium (30-70%): 10 → 4 (courbe t² — lent au début, rapide à la fin)
  - Heavy (70-85%): 4 → 2
  - Critical (> 85%): 2 faits (minimum)
- **Config**: contextWindow (200K défaut, nous=1M), maxFacts=12 (défaut), minFacts=2, thresholds configurables
- **API**: `compute(messagesTokenEstimate, systemTokenEstimate)` → `BudgetResult { limit, usage, zone }`
- **LLM**: Aucun
- **Provider**: Aucun
- **Fallback**: N/A

### Layer 8: Topics Émergents (`topics.ts` ~688 lignes)
- **Rôle**: Clustering automatique de faits par keywords partagés
- **Processus**:
  1. **LLM** extrait 3-5 keywords par fait → stockés dans `facts.tags` (JSON array)
  2. Scan orphans: si ≥ 3 faits partagent un keyword → créer topic
  3. Si ≥ 5 faits partagent un keyword spécifique dans un topic → créer subtopic
  4. Topics avec > 70% overlap → fusionner
  5. Topic embedding = moyenne des embeddings des faits membres (via `this.embedder`)
  6. **LLM** nomme chaque topic (prompt → 1-3 mots)
- **Tables**: `topics` (id, name, keywords, parent_id, score, embedding), `fact_topics` (fact_id, topic_id)
- **Scoring**: score = fact_count × (1 + recency_boost), decay si inactif > 30j
- **API**: `findRelevantTopics(query, limit)`, `onFactCaptured(factId, factText, category)`, `scanAndEmerge()`, `stats()`
- **LLM**: ✅ 2 usages — keyword extraction + topic naming
- **Provider**: `this.llm` = `topicsLlm` (configurable via `llm.overrides.topics`) + `this.embedder` (config `embed`)
- **Fallback**: Override provider → puis chain par défaut
- **Safety**: try/catch → si LLM fail, fait non taggé (reste orphelin jusqu'au prochain scan)

### Layer 9: .md Sync + Regen (`sync.ts` ~258 lignes, `md-regen.ts` ~277 lignes)

**Sync** (`sync.ts`):
- Après capture, append nouveaux faits aux fichiers .md du workspace
- Mapping catégorie → fichier :

  | Catégorie | Fichier cible |
  |-----------|---------------|
  | savoir, erreur, chronologie | MEMORY.md |
  | outil | TOOLS.md |
  | preference | USER.md |
  | client, rh | COMPANY.md |

- Dedup: vérifie si les 60 premiers chars du fait existent déjà dans le fichier
- Colonne `synced_to_md` en DB pour tracker
- Ne crée PAS de fichier s'il n'existe pas (`existsSync` guard)

**Regen** (`md-regen.ts`):
- Régénération bornée des fichiers .md
- Garde seulement les faits récents (30j par défaut), max 150 faits/fichier
- Archive les vieux → DB only + footer "faits archivés dans memoria.db"
- Préserve les sections non-Memoria du fichier
- ⚠️ **Pas encore auto-trigger** — manuel uniquement

- **LLM**: Aucun
- **Provider**: Aucun
- **Fallback**: N/A

### Layer 10: EmbedFallback (`embed-fallback.ts` ~62 lignes)
- **Rôle**: Chaîne de providers embed avec retry automatique
- **Interface**: `EmbedFallback implements EmbedProvider` — transparente pour EmbeddingManager
- **API publique**:
  - `embed(text)` → `number[]` (throw si tous échouent)
  - `embedBatch(texts)` → `number[][]` (throw si tous échouent)
  - `dimensions` → premier provider dimensions
  - `name` → "embed-fallback(ollama→lmstudio→openai)"
  - `providerNames` → noms dans l'ordre
- **Ordre par défaut** (v2.4.0): Ollama (nomic-embed-text-v2-moe) → LM Studio → OpenAI (text-embedding-3-small, si clé dispo)
- **Timeout**: hérité de chaque provider
- **Build**: créé dans `index.ts` si plusieurs providers disponibles, sinon single provider direct

### Layer 11: Fallback Chain + Per-layer LLM (`fallback.ts` ~246 lignes)
- **Rôle**: Chaîne de providers LLM avec retry automatique + config par couche
- **Interface**: `FallbackChain implements LLMProvider` — les modules ne voient pas la différence
- **API publique**:
  - `generate(prompt, options)` → `string` (interface LLMProvider, throw si tous échouent)
  - `generateWithMeta(prompt, options)` → `FallbackResult | null` (provider, timing, fallbacks)
  - `getEmbedProvider()` → premier EmbedProvider disponible
  - `primaryLLM` → première instance LLM (accès direct si nécessaire)
  - `providerNames` → noms des providers dans l'ordre
- **Ordre par défaut**: Ollama (gemma3:4b) → OpenAI (gpt-5.4-nano) → LM Studio (auto)
- **Timeout**: configurable par provider (défaut 12-15s), global defaultTimeoutMs=15s
- **Per-layer override**: chaque couche reçoit une FallbackChain dont le primary est l'override, suivi de la chain par défaut :
  - Si override échoue → tombe sur Ollama → OpenAI → LM Studio
  - Si pas d'override → chain par défaut directement

### Providers (`providers/` — 3 fichiers, ~215 lignes total)

**Interfaces** (`types.ts` ~30 lignes):
```typescript
interface LLMProvider {
  generate(prompt, options?) → Promise<string>
  readonly name: string
}
interface EmbedProvider {
  embed(text) → Promise<number[]>
  embedBatch(texts) → Promise<number[][]>
  readonly dimensions: number
  readonly name: string
}
```

**Ollama** (`ollama.ts` ~76 lignes):
- `OllamaLLM`: POST `{baseUrl}/api/generate` → `response` field
- `OllamaEmbed`: POST `{baseUrl}/api/embed` → `embeddings[0]` field
- Défaut: `http://localhost:11434`

**OpenAI-compatible** (`openai-compat.ts` ~109 lignes):
- `OpenAICompatLLM`: POST `{baseUrl}/chat/completions` → `choices[0].message.content`
- `OpenAICompatEmbed`: POST `{baseUrl}/embeddings` → `data[0].embedding`
- Factory functions: `openaiLLM()`, `lmStudioLLM()`, `openrouterLLM()`, `openaiEmbed()`, `lmStudioEmbed()`, `openrouterEmbed()`

---

## Configuration complète

```json
{
  "autoRecall": true,
  "autoCapture": true,
  "recallLimit": 12,
  "captureMaxFacts": 8,
  "defaultAgent": "koda",
  "contextWindow": 200000,
  "workspacePath": "~/.openclaw/workspace",
  "syncMd": true,

  "llm": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "gemma3:4b",
    "apiKey": "",
    "overrides": {
      "extract":       { "provider": "ollama", "model": "gemma3:4b" },
      "contradiction": { "provider": "openai", "model": "gpt-5.4-nano", "apiKey": "sk-..." },
      "graph":         { "provider": "ollama", "model": "gemma3:4b" },
      "topics":        { "provider": "lmstudio", "model": "glm-4.7-flash" },
    }
  },

  "embed": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "nomic-embed-text-v2-moe",
    "dimensions": 768,
    "apiKey": ""
  },

  "fallback": [
    { "name": "ollama",   "type": "ollama",   "model": "gemma3:4b",     "baseUrl": "http://localhost:11434", "timeoutMs": 12000, "embedModel": "nomic-embed-text-v2-moe", "embedDimensions": 768 },
    { "name": "openai",   "type": "openai",   "model": "gpt-5.4-nano",  "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "timeoutMs": 15000 },
    { "name": "lmstudio", "type": "lmstudio", "model": "auto",          "baseUrl": "http://localhost:1234/v1", "timeoutMs": 12000 }
  ],

  "topics": {
    "emergenceThreshold": 3,
    "mergeOverlap": 0.7,
    "subtopicThreshold": 5,
    "decayDays": 30,
    "scanInterval": 15
  },

  "mdRegen": {
    "recentDays": 30,
    "maxFactsPerFile": 150,
    "archiveNotice": true
  }
}
```

**Notes config** :
- `llm.overrides` est **optionnel** — si absent, toutes les couches utilisent la FallbackChain par défaut
- `fallback` array est **optionnel** — si absent, la chain par défaut est construite depuis `llm` + OpenAI + LM Studio
- `apiKey` dans un override hérite de `llm.apiKey` puis `OPENAI_API_KEY` env si absent
- **EmbedFallback auto** (v2.4.0): si `embed.*` configuré + LM Studio/OpenAI disponibles → fallback chain automatique (Ollama → LM Studio → OpenAI si clé). Sinon single provider

---

## Variables d'environnement

| Variable | Où utilisée | Défaut |
|----------|-------------|--------|
| `OPENCLAW_WORKSPACE` | `index.ts`, `migrate.ts` — path workspace | `~/.openclaw/workspace` |
| `HOME` | Fallback workspace dans `index.ts`, `sync.ts` | système |
| `OPENAI_API_KEY` | `index.ts` — clé OpenAI pour fallback chain | aucun |

---

## Catégories valides (7)

| Catégorie | Mapping .md | Normalisations acceptées |
|-----------|-------------|--------------------------|
| `savoir` | MEMORY.md | architecture, mécanisme, stock, état → savoir |
| `erreur` | MEMORY.md | sévérité, bug → erreur |
| `outil` | TOOLS.md | — |
| `preference` | USER.md | préférence, préférences → preference |
| `chronologie` | MEMORY.md | — |
| `rh` | COMPANY.md | — |
| `client` | COMPANY.md | financier → client |

Toute catégorie inconnue → `savoir` (via `normalizeCategory()` dans `index.ts`).

---

## Hooks OpenClaw — Détail des appels

### `before_prompt_build` (Recall)
```
1. budget.compute() → détermine le nombre max de faits
2. embeddingMgr.hybridSearch(query) → FTS5 + cosine + scoring
3. scoreAndRank(results) → tri temporal
4. graph.findEntitiesInText(query) → entités mentionnées
5. graph.getRelatedFacts(entities) → BFS 2 hops
6. graph.hebbianReinforce(entityIds) → renforce les poids
7. topicMgr.findRelevantTopics(query) → topics par keyword + cosine
8. treeBuilder.build(allCandidates, query) → arbre hiérarchique
9. treeBuilder.extractFacts(tree, limit) → sélection finale
10. formatRecallContext(facts) → texte injecté en prependContext
```
**LLM utilisé dans ce hook**: Aucun (tout est FTS5/cosine/heuristique)

### `agent_end` (Capture)
```
1. extractLlm.generateWithMeta(prompt) → extraction JSON de faits    [LLM: extractLlm]
2. normalizeCategory(f.category) → catégorie validée
3. selective.processAndApply(fact) → dedup + contradiction           [LLM: contradictionLlm]
4. postProcessNewFacts("capture") → voir ci-dessous
```

### `after_compaction` (Rescue)
```
1. extractLlm.generateWithMeta(summaries) → extraction              [LLM: extractLlm]
2. selective.processAndApply(fact) → dedup + contradiction           [LLM: contradictionLlm]
3. postProcessNewFacts("compaction") → voir ci-dessous
```

### `postProcessNewFacts(source)` — Pipeline enrichment (v2.4.0)
Fonction partagée appelée par `agent_end` ET `after_compaction`. Garantit que **tous** les faits (capture normale + compaction rescue) sont enrichis de la même manière.

```
1. embeddingMgr.embedBatch(unembedded) → vectorisation              [EMBED: embedder → EmbedFallback]
2. graph.extractAndStore(recentFacts) → entités/relations (max 5)   [LLM: graphLlm]
3. topicMgr.onFactCaptured(recentFacts) → keywords + association    [LLM: topicsLlm]
4. topicMgr.scanAndEmerge() → émergence si seuil atteint            [LLM: topicsLlm]
5. mdSync.syncToMd(db) → append nouveaux faits aux .md
6. mdRegen.regenerate() → auto si fichier > 200 lignes (borne 30j/150 faits)
```
Tous les steps sont `try/catch` → échec non-critique → continue.

---

## Matrice LLM × Couches (v2.4.0)

| Couche | Variable index.ts | Config override | LLM appelé | Quand | try/catch |
|--------|-------------------|-----------------|------------|-------|-----------|
| Extract (faits) | `extractLlm` | `llm.overrides.extract` | `generateWithMeta()` | agent_end, after_compaction | ✅ |
| Contradiction | `contradictionLlm` | `llm.overrides.contradiction` | `generate()` via selective | agent_end, after_compaction, postProcess | ✅ |
| Graph (entités) | `graphLlm` | `llm.overrides.graph` | `generate()` via graph | postProcess (agent_end + compaction) | ✅ |
| Topics (keywords) | `topicsLlm` | `llm.overrides.topics` | `generate()` via topics | postProcess (agent_end + compaction) | ✅ |
| Context Tree | — | — | ❌ Heuristique locale | — | N/A |
| Embed | `embedder` (EmbedFallback) | `embed.*` | embed()/embedBatch() | postProcess + boot background | ✅ |

**Sans override** : toutes les couches utilisent la FallbackChain par défaut (Ollama → OpenAI → LM Studio).
**Avec override** : le provider choisi est essayé en premier, puis fallback sur la chain complète.

---

## Problèmes connus

1. ~~**context-tree LLM mort**~~ ✅ FIXÉ (020cfa5): paramètre LLM retiré, override `contextTree` supprimé
2. ~~**md-regen pas auto**~~ ✅ FIXÉ (500a9ec, v2.4.0): auto-trigger après capture si fichier .md > 200 lignes
3. ~~**after_compaction incomplet**~~ ✅ FIXÉ (500a9ec, v2.4.0): faits compaction = full enrichment via `postProcessNewFacts()`
4. ~~**Embed no fallback**~~ ✅ FIXÉ (500a9ec, v2.4.0): `EmbedFallback` chain (Ollama → LM Studio → OpenAI)
5. **~19 faits non taggés** — facts orphelins résistants au retag (JSON cassé côté LLM)
6. **~125 faits sans topic** — à absorber par les prochains `scanAndEmerge()`
7. **Catégorie "connaissance" legacy** — ~1 fait avec catégorie non normalisée (devrait être "savoir")

---

## Fichiers

| Fichier | Lignes | Rôle | LLM | Provider |
|---------|--------|------|-----|----------|
| `index.ts` | 723 | Plugin entry, hooks, postProcessNewFacts | extractLlm (generateWithMeta) | — |
| `topics.ts` | 688 | Topics émergents, keywords | topicsLlm (generate ×2) | + embedder |
| `db.ts` | 446 | SQLite CRUD + FTS5 | ❌ | ❌ |
| `graph.ts` | 390 | Knowledge graph + Hebbian | graphLlm (generate) | — |
| `selective.ts` | 361 | Dedup + contradiction | contradictionLlm (generate) | — |
| `context-tree.ts` | 336 | Arbre hiérarchique | ❌ | ❌ |
| `md-regen.ts` | 277 | .md regeneration bornée | ❌ | ❌ |
| `sync.ts` | 258 | DB → .md sync | ❌ | ❌ |
| `embeddings.ts` | 247 | Vecteurs + hybrid search | ❌ | embedder (embed/embedBatch) |
| `fallback.ts` | 246 | FallbackChain (implements LLMProvider) | toutes instances LLM | tous providers |
| `budget.ts` | 121 | Budget adaptatif | ❌ | ❌ |
| `scoring.ts` | ~130 | Temporal decay + hot tier scoring | ❌ | ❌ |
| `bootstrap-topics.ts` | 88 | Script one-shot tagging initial | — | — |
| `migrate.ts` | 79 | Migration facts.json → SQLite | ❌ | ❌ |
| `retag-orphans.ts` | ~80 | Script retag faits orphelins | via chain | — |
| `embed-fallback.ts` | 62 | EmbedFallback (implements EmbedProvider) | ❌ | multi embed providers |
| `providers/openai-compat.ts` | 109 | OpenAI/LMStudio/OpenRouter | — | HTTP fetch |
| `providers/ollama.ts` | 76 | Ollama LLM + Embed | — | HTTP fetch |
| `providers/types.ts` | 30 | Interfaces LLMProvider + EmbedProvider | — | — |
| **Total** | **~4900** | | | |

---

## Stats actuelles (25/03/2026 — v2.5.0)

| Métrique | Valeur |
|----------|--------|
| Faits actifs | 590 |
| Faits taggés | ~571 (96.8%) |
| Embeddings | 591 (100%, EmbedFallback actif) |
| Entités | 297 |
| Relations | 186 |
| Topics | 110 |
| Catégories | 8 (7 normalisées + connaissance legacy) |
| Hot facts (access ≥ 5) | 5 (top: 216x accès) |
| Taille DB | ~2.2 MB |
| Lignes code | ~4900 |
| Fichiers TS | 20 |
