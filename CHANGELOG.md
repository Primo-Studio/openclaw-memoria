# Changelog

## [2.6.0] - 2026-03-25
### Added
- **`install.sh`** — One-line installer: checks prerequisites, pulls Ollama models, clones repo, installs deps. Usage: `curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash`
- **Auto-migration cortex→memoria** — If `memoria.db` doesn't exist but `cortex.db` does, auto-copies it. Zero manual migration needed.

### Fixed
- **Schema too strict** — `additionalProperties` changed from `false` to `true` everywhere. Unknown config keys no longer crash the gateway.
- **`syncMd` type** — Was rejecting `{ enabled: true }` objects. Now only accepts boolean as documented, and schema makes it clear.
- **`embed.dims` vs `embed.dimensions`** — Schema now documents `dimensions` clearly with defaults shown.
- **`fallback[].type` vs `fallback[].provider`** — Schema field is `provider`, not `type`.
- **`llm.default` doesn't exist** — Schema clearly shows `llm.provider` + `llm.model` at top level.
- **DB constructor confusion** — `MemoriaDB()` takes workspace root, not DB path. Documented + auto-migration handles legacy DB name.

### Changed
- **Smart defaults everywhere** — `{ "memoria": { "enabled": true } }` is now a valid minimal config. Defaults: Ollama + gemma3:4b + nomic-embed-text-v2-moe + 768 dims + recall 12 + capture 8.
- Schema defaults added to all fields for documentation.
- INSTALL.md rewritten with config minimale, bugs connus, et providers table.

## [2.5.0] - 2026-03-25
### Added
- **Hot Tier**: facts accessed ≥5 times = always injected in recall, like a phone number you know by heart. New `getHotFacts()` in scoring, `hotFacts()` in DB.
- **Access-based learning**: `accessBoostFactor` tripled (0.1 → 0.3) — frequently used facts score much higher, mimicking human memory retention through repetition.
- **Configurable defaults raised**: `captureMaxFacts` 3→8, `recallLimit` 8→12, `maxFacts` 10→12. Users with smaller context windows can lower these in config.

### Changed
- Recall pipeline now: hot tier (always first) → hybrid search → graph → topics → context tree → budget limit
- Hot facts excluded from search results to avoid duplicates
- `searchLimit` = `recallLimit - hotCount` so hot facts don't eat into query-relevant slots

## [2.4.0] - 2026-03-25
### Added
- **Embed Fallback** (`embed-fallback.ts`): `EmbedFallback` wraps multiple `EmbedProvider`s with automatic retry (Ollama → LM Studio → OpenAI). If primary embed fails, tries next provider.
- **Post-processing function** `postProcessNewFacts()`: shared between `agent_end` and `after_compaction` hooks — embed, graph extract, topic tag, sync .md, auto md-regen.
- **Auto md-regen**: triggers automatically when any .md file exceeds 200 lines after capture. Bounded regeneration (30d recent, 150 max/file).

### Fixed
- **after_compaction incomplete** ✅: compaction-rescued facts now get full enrichment (embed + graph + topics + sync + regen) — same pipeline as agent_end.
- **Embed no fallback** ✅: EmbedFallback chains configured embed provider → LM Studio → OpenAI (if API key available).
- **md-regen manual only** ✅: now auto-triggered in postProcessNewFacts when file size threshold exceeded.

### Changed
- Post-processing code extracted from agent_end into reusable `postProcessNewFacts()` function
- Log messages now include `[capture]` or `[compaction]` source label

## [2.3.0] - 2026-03-25
### Added
- **Per-layer LLM config**: each layer (extract, contradiction, graph, topics, contextTree) can use a different model/provider
- `llm.overrides` config section with per-layer `{ provider, model, baseUrl?, apiKey? }`
- Override chains include the user's chosen model as primary, then fallback to the default chain
- Boot log shows active overrides when configured
- JSON Schema `$defs/layerLlm` in manifest for validation

### Changed
- `FallbackChain` now implements `LLMProvider` interface directly (`generate()` → string, `generateWithMeta()` → metadata)
- All modules receive FallbackChain (full fallback) instead of `chain.primaryLLM` (Ollama-only)
- `selective` uses `contradictionLlm`, `graph` uses `graphLlm`, `topics` uses `topicsLlm`, `contextTree` uses `contextTreeLlm`, extract uses `extractLlm`

### Fixed
- Fallback gap: selective, graph, topics, context-tree had NO fallback (Ollama-only). Now all have full chain.

## [2.2.0] - 2026-03-25
### Added
- Phase 9: `.md Vivants` — bounded markdown regeneration (recent 30d, max 150/file, archive notice)
- `MdRegenManager` class with configurable regen settings
- Boot-time .md file size logging

## [2.1.0] - 2026-03-25
### Added
- Phase 8: `Topics Émergents` — auto-clustering from keyword patterns
- `TopicManager` class with keyword extraction, emergence scanning, sub-topics
- Topic embeddings (mean of fact embeddings, cosine search)
- Topic enrichment in recall pipeline (after graph, before context tree)
- Bootstrap script for initial tagging (389/438 facts tagged → 94 topics)
- `topics` + `fact_topics` tables in SQLite schema

## [2.0.0] - 2026-03-25
### Added
- Phase 10: `Fallback Chain` — graceful LLM degradation (Ollama → OpenAI → LM Studio → FTS-only)
- `FallbackChain` class with round-robin retry and configurable providers

## [1.0.0] - 2026-03-25
### Added
- Phase 7: `Budget Adaptatif` — dynamic recall limit based on context usage (light/medium/heavy/critical zones)
- Phase 7: `Sync .md` — auto-append new facts to mapped workspace markdown files
- `AdaptiveBudget` class with configurable thresholds
- `MdSync` class with dedup (first 60 chars check)

## [0.5.0] - 2026-03-25
### Added
- Phase 6: `Context Tree` — hierarchical fact organization with query-weighted scoring
- `ContextTreeBuilder` class with category clustering and sub-clustering

## [0.4.0] - 2026-03-25
### Added
- Phase 5: `Knowledge Graph + Hebbian Learning` — entity extraction, relation storage, BFS traversal
- `KnowledgeGraph` class with graph extraction prompts and Hebbian reinforcement
- Partial/fuzzy entity matching

## [0.3.0] - 2026-03-25
### Added
- Phase 4: `Embeddings + Hybrid Search` — cosine similarity with local Ollama embeddings
- `EmbeddingManager` class with batch embedding, hybrid search (FTS + cosine + temporal)

### Fixed
- FTS5 query sanitization (hyphenated terms crash)

## [0.2.0] - 2026-03-25
### Added
- Phase 2: `Mémoire Sélective` — dedup (Levenshtein + Jaccard), contradiction check via LLM, importance threshold, enrichment/merge
- `SelectiveMemory` class with configurable thresholds

## [0.1.0] - 2026-03-25
### Added
- Phase 1: Core SQLite + FTS5, temporal scoring, perception hooks
- `MemoriaDB` class, migration from facts.json (423 facts)
- Provider abstraction (Ollama, OpenAI-compat, LM Studio)
