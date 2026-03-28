/**
 * 🧠 Memoria — Multi-layer memory plugin for OpenClaw (v3.22.2)
 * 
 * This file is the plugin entry point. It:
 *   1. Parses config from openclaw.json → MemoriaConfig
 *   2. Creates all managers (db, embedding, graph, topics, etc.)
 *   3. Registers 5 OpenClaw hooks to power recall + capture + continuous learning
 *   4. Orchestrates the post-capture pipeline (postProcessNewFacts)
 * 
 * == HOOKS (in order of a typical turn) ==
 *   message_received  → Layer 21: buffer user message, detect urgent signals
 *   before_prompt_build → RECALL: budget → search → score → inject facts into context
 *   llm_output        → Layer 21: buffer assistant response, trigger extraction if due
 *   after_tool_call   → Layer 13: real-time procedural capture from tool executions
 *   agent_end         → CAPTURE: LLM extract → selective → postProcess (embed, graph, topics...)
 *   after_compaction   → Safety net: same as agent_end but from compacted summaries
 * 
 * == 21 LAYERS ==
 *   1. SQLite + FTS5 (db.ts)          12. Fallback Chain (fallback.ts)
 *   2. Temporal Scoring (scoring.ts)   13. Procedural Memory (procedural.ts)
 *   3. Selective Memory (selective.ts) 14. Lifecycle (lifecycle.ts)
 *   4. Embeddings (embeddings.ts)      15. Feedback Loop (feedback.ts)
 *   5. Knowledge Graph (graph.ts)      16. Hebbian (hebbian.ts)
 *   6. Context Tree (context-tree.ts)  17. Identity Parser (identity-parser.ts)
 *   7. Adaptive Budget (budget.ts)     18. Expertise (expertise.ts)
 *   8. Emergent Topics (topics.ts)     19. Proactive Revision (revision.ts)
 *   9. Observations (observations.ts)  20. Behavioral Patterns (patterns.ts)
 *  10. Fact Clusters (fact-clusters.ts)21. Continuous Learning (this file, hooks)
 *  11. .md Sync (sync.ts, md-regen.ts)
 * 
 * == KEY INTERNAL FUNCTIONS ==
 *   parseConfig()          — raw JSON → typed MemoriaConfig
 *   formatRecallContext()   — facts → text block injected before prompt
 *   normalizeCategory()     — free-form category → one of 7 canonical categories
 *   postProcessNewFacts()   — 8-step pipeline after each capture batch
 *   doContinuousExtraction() — Layer 21 micro-extraction from rolling buffer
 * 
 * For the full architecture, see docs/ARCHITECTURE.md and docs/MODULES.md.
 */

import fs from "fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { MemoriaDB } from "./db.js";
import { scoreAndRank, getHotFacts, HOT_TIER_CONFIG } from "./scoring.js";
import { SelectiveMemory } from "./selective.js";
import { EmbeddingManager } from "./embeddings.js";
import { KnowledgeGraph } from "./graph.js";
import { ContextTreeBuilder } from "./context-tree.js";
import { AdaptiveBudget } from "./budget.js";
import { MdSync } from "./sync.js";
import { MdRegenManager } from "./md-regen.js";
import { FallbackChain } from "./fallback.js";
import type { FallbackProviderConfig } from "./fallback.js";
import { TopicManager } from "./topics.js";
import { OllamaEmbed, OllamaLLM } from "./providers/ollama.js";
import { OpenAICompatLLM, OpenAICompatEmbed, lmStudioLLM, lmStudioEmbed, openaiLLM, openaiEmbed, openrouterLLM, openrouterEmbed } from "./providers/openai-compat.js";
import type { EmbedProvider, LLMProvider } from "./providers/types.js";
import { EmbedFallback } from "./embed-fallback.js";
import { ObservationManager } from "./observations.js";
import { FactClusterManager } from "./fact-clusters.js";
import { FeedbackManager } from "./feedback.js";
import { AnthropicLLM } from "./providers/anthropic.js";
import { IdentityParser } from "./identity-parser.js";
import { LifecycleManager } from "./lifecycle.js";
import { RevisionManager } from "./revision.js";
import { HebbianManager } from "./hebbian.js";
import { ExpertiseManager } from "./expertise.js";
import { ProceduralMemory } from "./procedural.js";
import { PatternManager } from "./patterns.js";

// ─── Config ───

interface MemoriaConfig {
  autoRecall: boolean;
  autoCapture: boolean;
  recallLimit: number;
  captureMaxFacts: number;
  defaultAgent: string;
  contextWindow: number;
  workspacePath: string;
  syncMd: boolean;
  fallback: FallbackProviderConfig[];
  /** Continuous Learning (Layer 21) config */
  continuous?: {
    /** Extract every N turns (default 4) */
    interval?: number;
    /** Cooldown between periodic extractions in ms (default 45000) */
    cooldownMs?: number;
    /** Enable/disable (default true when autoCapture is true) */
    enabled?: boolean;
  };
  embed: {
    provider: "ollama" | "lmstudio" | "openai" | "openrouter" | "anthropic";
    baseUrl?: string;
    model: string;
    dimensions: number;
    apiKey?: string;
  };
  llm: {
    provider: "ollama" | "lmstudio" | "openai" | "openrouter" | "anthropic";
    baseUrl?: string;
    model: string;
    apiKey?: string;
    /** Per-layer overrides: each key = layer name, value = provider config */
    overrides?: Partial<Record<MemoriaLayer, LayerLLMConfig>>;
  };
}

/** Named layers that accept a per-layer LLM override */
type MemoriaLayer = "extract" | "contradiction" | "graph" | "topics" | "procedural";

interface LayerLLMConfig {
  provider: "ollama" | "lmstudio" | "openai" | "openrouter" | "anthropic";
  baseUrl?: string;
  model: string;
  apiKey?: string;
}

/** Parse raw plugin config (from openclaw.json) into typed MemoriaConfig with smart defaults. */
function parseConfig(raw: Record<string, unknown> | undefined): MemoriaConfig {
  const embed = (raw?.embed as Record<string, unknown>) || {};
  const llm = (raw?.llm as Record<string, unknown>) || {};
  return {
    autoRecall: raw?.autoRecall !== false,
    autoCapture: raw?.autoCapture !== false,
    recallLimit: (raw?.recallLimit as number) || 12,
    captureMaxFacts: (raw?.captureMaxFacts as number) || 8,
    defaultAgent: (raw?.defaultAgent as string) || "koda",
    contextWindow: (raw?.contextWindow as number) || 200000,
    workspacePath: (raw?.workspacePath as string) || process.env.HOME + "/.openclaw/workspace",
    syncMd: raw?.syncMd !== false,
    fallback: ((raw?.fallback as any[]) || []).map((f: any) => ({
      ...f,
      // Normalize: user config uses "provider", internal uses "type"
      type: f.type || f.provider || "ollama",
      name: f.name || f.provider || f.type || "ollama",
    })) as FallbackProviderConfig[],
    embed: {
      provider: (embed.provider as MemoriaConfig["embed"]["provider"]) || "ollama",
      baseUrl: embed.baseUrl as string | undefined,
      model: (embed.model as string) || "nomic-embed-text-v2-moe",
      dimensions: (embed.dimensions as number) || 768,
      apiKey: embed.apiKey as string | undefined,
    },
    llm: {
      provider: (llm.provider as MemoriaConfig["llm"]["provider"]) || "ollama",
      baseUrl: llm.baseUrl as string | undefined,
      model: (llm.model as string) || "gemma3:4b",
      apiKey: llm.apiKey as string | undefined,
      overrides: (llm.overrides as MemoriaConfig["llm"]["overrides"]) || undefined,
    },
  };
}

// ─── Provider Factory ───

/** Create an embedding provider from config. Used for the main embedder + fallback list. */
function createEmbedProvider(cfg: MemoriaConfig["embed"]): EmbedProvider {
  switch (cfg.provider) {
    case "ollama":
      return new OllamaEmbed(cfg.baseUrl || "http://localhost:11434", cfg.model, cfg.dimensions);
    case "lmstudio":
      return lmStudioEmbed(cfg.model, cfg.dimensions, cfg.baseUrl || "http://localhost:1234/v1");
    case "openai":
      return openaiEmbed(cfg.model, cfg.apiKey || "", cfg.dimensions);
    case "openrouter":
      return openrouterEmbed(cfg.model, cfg.apiKey || "", cfg.dimensions);
    default:
      return new OllamaEmbed(); // safe default
  }
}

/** Create an LLM provider from config. Used for the main chain + per-layer overrides. */
function createLLMProvider(cfg: MemoriaConfig["llm"]): LLMProvider {
  switch (cfg.provider) {
    case "ollama":
      return new OllamaLLM(cfg.baseUrl || "http://localhost:11434", cfg.model);
    case "lmstudio":
      return lmStudioLLM(cfg.model, cfg.baseUrl || "http://localhost:1234/v1");
    case "openai":
      return openaiLLM(cfg.model, cfg.apiKey || "");
    case "openrouter":
      return openrouterLLM(cfg.model, cfg.apiKey || "");
    case "anthropic":
      return new AnthropicLLM(cfg.model, cfg.apiKey || "", cfg.baseUrl);
    default:
      return new OllamaLLM(); // safe default
  }
}

// ─── Constants ───

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`;

const LLM_EXTRACT_PROMPT = `Tu es un extracteur de faits pour un système de mémoire AI.
Analyse le texte et extrais les faits qui méritent d'être retenus.

DEUX TYPES de faits:
- "semantic" = vérité durable, processus appris, configuration, règle découverte
- "episodic" = événement daté, état temporaire, action en cours, résultat observé

RÈGLE D'OR: TOUJOURS INCLURE LES DÉTAILS CONCRETS
Imagine que tu notes pour une secrétaire qui doit pouvoir tout retrouver plus tard.
❌ "Neto a eu une réunion importante" → MANQUE: avec qui? quand? sur quoi?
✅ "Neto a eu une réunion avec le client CCOG le 28/03 à 14h sur la refonte du site"
❌ "Sol a été redémarré" → MANQUE: pourquoi? quel était le problème?
✅ "Sol a été redémarré le 28/03 à 18h25 car better-sqlite3 était compilé pour la mauvaise version de Node (137 vs 141). Fix: npm rebuild"
❌ "Une réflexion excellente a été faite" → MANQUE: quelle réflexion? quel contenu?
✅ "Neto propose que la mémoire fonctionne comme un cerveau humain: ne rien supprimer, prioriser par usage, les détails éphémères (heure d'un vol) s'effacent mais l'expérience (le vol était long) reste"

EXTRAIRE — tout ce qui a du contenu:
✅ Processus appris avec les étapes ("pour migrer SQLite WAL: VACUUM INTO au lieu de cp")
✅ Ce qui a marché ET pourquoi ("le fallback chain résout les crashes car Ollama tombe parfois")
✅ Leçons d'erreurs avec la cause ("api.config ≠ api.pluginConfig → configs ignorées")
✅ Décisions avec la raison ("on utilise qwen3.5:4b car meilleure qualité JSON, avec think:false")
✅ Configs exactes ("Memoria: recallLimit=8, extract LLM qwen3.5:4b, fallback gemma3:4b")
✅ Résultats avec chiffres ("Benchmark: retrieval 92% (11/12), RAG 25%, bottleneck = modèle local")
✅ Préférences avec contexte ("Neto veut du step-by-step, une feature à la fois avec validation")
✅ États temporaires AVEC CONTEXTE ("Sol est en train de refaire HydroTrack — blocker: API endpoint changé")
✅ Événements avec date ET détail ("28/03 — Memoria v3.13.0 live: lifecycle fresh/settled/dormant, 385f/90s/0d")
✅ Ce que quelqu'un fait en ce moment ET pourquoi ("Sol travaille sur la refonte HydroTrack depuis le 26/03, priorité car le client attend la démo")
✅ Outils internes et leur état ("Memoria v3.13.0: lifecycle humain, curseur détail 1-10, 475 facts, publié ClawHub + GitHub")
✅ Produits/MVPs et leur avancement ("Bureau module CA v1.2.0 en prod, matching auto Qonto↔projets fonctionnel")

GÉNÉRALISER — quand un pattern se répète:
🔄 Même problème 2+ fois → stocker la RÈGLE + les cas concrets
   "Les commandes brew/nvm (npm, ollama, node) ne sont pas dans le PATH en SSH non-interactif — fix: source ~/.zprofile ou chemin complet /opt/homebrew/bin/"

🔥 ERREURS ET DANGERS — PRIORITÉ MAXIMALE (comme toucher du feu):
Quand quelque chose a causé un PROBLÈME RÉEL (crash, perte de données, service mort, bug en prod, Neto qui doit intervenir physiquement):
→ Catégorie "erreur", confidence 0.95+
→ Inclure: CE QUI S'EST PASSÉ + POURQUOI c'est dangereux + CE QU'IL NE FAUT JAMAIS REFAIRE + L'ALTERNATIVE SÛRE
→ C'est comme un panneau "DANGER" : on le note dès la PREMIÈRE FOIS, pas après la 2ème brûlure
Exemples de VRAIS dangers à capter:
✅ "NE JAMAIS utiliser openclaw gateway stop via exec — tue le daemon sans le relancer, gateway reste mort. Utiliser gateway restart (SIGUSR1)." (catégorie erreur)
✅ "NE JAMAIS faire cp sur une DB SQLite en mode WAL — données perdues. Utiliser VACUUM INTO." (catégorie erreur)
✅ "NE JAMAIS push sur main sans test — régression garantie. Toujours une branche séparée." (catégorie erreur)
Signaux qu'un fait est un DANGER:
- Quelqu'un dit "ne fais plus ça", "c'est la 2ème fois", "putain", "j'ai dû aller faire X manuellement"
- Un service/outil est mort/cassé après une action
- Un rollback ou fix manuel a été nécessaire
- Le mot "jamais", "interdit", "critique", "ne pas" dans la conversation

NE PAS STOCKER:
❌ Confirmations vides ("ok", "merci", "compris")
❌ Narration pure sans résultat ("je lis le fichier", "je regarde le code")
❌ MÉTA-FAITS sur le stockage lui-même ("le nouveau fait complète l'ancien", "ce fait a été ajouté")
❌ Faits sans AUCUN élément concret ("des informations ont été fournies", "la configuration a été mise à jour")

QUALITÉ — chaque fait DOIT:
⚠️ Contenir au moins UN élément concret: nom propre, chiffre, commande, version, ou date
⚠️ Être AUTONOME = compréhensible seul, sans contexte
⚠️ Inclure le POURQUOI ou le CONTEXTE quand c'est pertinent (pas juste QUOI)
⚠️ Ne JAMAIS commencer par "Le nouveau fait..." ou "Ce fait..." → commencer par le SUJET réel

Règles:
- Phrase(s) complète(s) et autonome(s)
- Pour les PROCÉDURES: garder les étapes ensemble en UN fait (2-4 phrases OK)
- UN FAIT PAR ENTITÉ — si le texte parle de 3 sujets distincts, 3 faits séparés
- Catégories: savoir, erreur, preference, outil, chronologie, rh, client
- type: "semantic" ou "episodic"
- confidence: 0.7 minimum
- Maximum {MAX_FACTS} faits
- Si rien de concret → {"facts": []}

Texte:
"{TEXT}"

JSON valide uniquement:
{"facts": [{"fact": "phrase", "category": "...", "type": "semantic|episodic", "confidence": 0.X}]}`;

// ─── Formatting ───

/**
 * Format recalled facts + observations into the text block injected before the prompt.
 * Output goes into `event.prependContext` in the before_prompt_build hook.
 * Includes: header, observations section, per-fact lines with [category] [age] prefix, known procedures.
 */
function formatRecallContext(facts: Array<{ fact: string; category: string; confidence: number; temporalScore: number; created_at?: number; updated_at?: number; fact_type?: string }>, observationContext = ""): string {
  if (facts.length === 0 && !observationContext) return "";
  const parts: string[] = [
    "## 🧠 Memoria — Mémoire persistante",
    "Faits provenant de la mémoire long terme (source de vérité).",
    "En cas de conflit avec un résumé LCM → la mémoire persistante a priorité.",
    "Les faits les plus récents (par date) sont les plus fiables en cas de contradiction.",
    "",
  ];

  // Observations first (synthesized, higher quality)
  if (observationContext) {
    parts.push("### Observations (synthèses vivantes)");
    parts.push(observationContext);
    parts.push("");
  }

  // Individual facts with dates for Knowledge Update disambiguation
  if (facts.length > 0) {
    if (observationContext) parts.push("### Faits individuels");
    const now = Date.now();
    const lines = facts.map(f => {
      const conf = f.confidence >= 0.9 ? "" : ` (${Math.round(f.confidence * 100)}%)`;
      // Add date tag so the answering model can disambiguate updates
      let dateTag = "";
      const ts = f.updated_at || f.created_at;
      if (ts && ts > 0) {
        const d = new Date(ts);
        const ageDays = Math.floor((now - ts) / 86400000);
        if (ageDays === 0) dateTag = ` [aujourd'hui]`;
        else if (ageDays === 1) dateTag = ` [hier]`;
        else if (ageDays < 7) dateTag = ` [il y a ${ageDays}j]`;
        else dateTag = ` [${d.toISOString().slice(0, 10)}]`;
      }
      return `- [${f.category}]${dateTag} ${f.fact}${conf}`;
    });
    parts.push(...lines);
    parts.push("");
  }

  return parts.join("\n");
}

// ─── JSON Parse Helper ───

/** Safely parse JSON from LLM output. Handles markdown code fences, trailing commas, and partial JSON. */
function parseJSON(text: string): unknown {
  // Strip markdown code blocks (```json ... ``` or ``` ... ```)
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    lines.shift(); // remove opening ```json or ```
    if (lines[lines.length - 1]?.trim() === "```") lines.pop();
    cleaned = lines.join("\n").trim();
  }
  // Try to extract JSON object/array via regex
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) cleaned = match[1];
  return JSON.parse(cleaned);
}

// ─── Category Normalization ───

const VALID_CATEGORIES = new Set(["savoir", "erreur", "preference", "outil", "chronologie", "rh", "client"]);

/**
 * Normalize free-form LLM category output → one of 7 canonical categories.
 * Mapping: architecture/mécanisme → savoir, sévérité/bug → erreur, financier → client, etc.
 * Unknown categories default to "savoir".
 */
function normalizeCategory(raw: string): string {
  const lower = (raw || "savoir").toLowerCase().trim();
  if (VALID_CATEGORIES.has(lower)) return lower;
  // Common LLM variants → map to valid
  if (lower === "préférence" || lower === "préférences") return "preference";
  if (lower === "architecture" || lower === "mécanisme" || lower === "stock" || lower === "état") return "savoir";
  if (lower === "financier") return "client";
  if (lower === "sévérité" || lower === "bug") return "erreur";
  return "savoir"; // fallback: anything unknown → savoir
}

// ─── Plugin Registration ───

/**
 * Plugin entry point called by OpenClaw on load.
 * Creates all managers, registers all hooks, starts background tasks.
 * This is the only export that matters — OpenClaw calls register() on startup.
 */
export function register(api: OpenClawPluginApi): void {
  // api.pluginConfig = plugin-specific config from openclaw.json plugins.entries.memoria.config
  // api.config = global OpenClaw config (NOT what we want)
  const rawPluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const cfg = parseConfig(rawPluginConfig);

  const db = new MemoriaDB(WORKSPACE);

  // Build fallback chain: config providers → default chain
  api.logger.info?.(`[memoria] Config loaded: fallback=${cfg.fallback.length} providers, llm=${cfg.llm.provider}/${cfg.llm.model}, embed=${cfg.embed.provider}/${cfg.embed.model}`);
  const fallbackProviders: FallbackProviderConfig[] = cfg.fallback.length > 0
    ? cfg.fallback
    : [
        // Default: Ollama → OpenAI → LM Studio
        {
          name: "ollama",
          type: "ollama" as const,
          model: cfg.llm.model || "gemma3:4b",
          baseUrl: cfg.llm.provider === "ollama" ? (cfg.llm.baseUrl || "http://localhost:11434") : "http://localhost:11434",
          timeoutMs: 12000,
          embedModel: cfg.embed.model || "nomic-embed-text-v2-moe",
          embedDimensions: cfg.embed.dimensions || 768,
        },
        {
          name: "openai",
          type: "openai" as const,
          model: "gpt-5.4-nano",
          baseUrl: "https://api.openai.com/v1",
          apiKey: cfg.llm.apiKey || process.env.OPENAI_API_KEY || "",
          timeoutMs: 15000,
        },
        {
          name: "lmstudio",
          type: "lmstudio" as const,
          model: "auto",
          baseUrl: "http://localhost:1234/v1",
          timeoutMs: 12000,
        },
      ];

  const chain = new FallbackChain(
    { providers: fallbackProviders },
    { info: api.logger.info?.bind(api.logger), warn: api.logger.warn?.bind(api.logger), debug: api.logger.debug?.bind(api.logger) },
  );

  // ─── Per-layer LLM: override per layer or fallback to chain ───
  const overrides = cfg.llm.overrides || {};
  function layerLLM(layer: MemoriaLayer): LLMProvider {
    const ov = overrides[layer];
    if (!ov) return chain; // default = full fallback chain
    // Build a single-provider FallbackChain so it still has the same interface
    // but uses the user's chosen model for this specific layer
    const provCfg: FallbackProviderConfig = {
      name: `${layer}:${ov.provider}`,
      type: ov.provider,
      model: ov.model,
      baseUrl: ov.baseUrl,
      apiKey: ov.apiKey || cfg.llm.apiKey || process.env.OPENAI_API_KEY || "",
    };
    // Single provider chain = that provider, then fallback to default chain providers
    return new FallbackChain(
      { providers: [provCfg, ...fallbackProviders] },
      { info: api.logger.info?.bind(api.logger), warn: api.logger.warn?.bind(api.logger), debug: api.logger.debug?.bind(api.logger) },
    );
  }

  const extractLlm = layerLLM("extract");
  const contradictionLlm = layerLLM("contradiction");
  const graphLlm = layerLLM("graph");
  const topicsLlm = layerLLM("topics");

  // Log active overrides
  const activeOverrides = Object.keys(overrides).filter(k => overrides[k as MemoriaLayer]);
  if (activeOverrides.length > 0) {
    api.logger.info?.(`memoria: per-layer LLM overrides: ${activeOverrides.map(k => `${k}=${overrides[k as MemoriaLayer]!.provider}/${overrides[k as MemoriaLayer]!.model}`).join(", ")}`);
  }

  // Build embed fallback chain: configured provider → LM Studio → OpenAI (if keys available)
  // NOTE: moved BEFORE selective so we can pass embeddingMgr for semantic contradiction detection
  const primaryEmbed = createEmbedProvider(cfg.embed);
  const embedProviders: EmbedProvider[] = [primaryEmbed];
  // Add fallback embed providers (only if different from primary)
  if (cfg.embed.provider !== "lmstudio") {
    try { embedProviders.push(lmStudioEmbed(cfg.embed.model, cfg.embed.dimensions)); } catch { /* skip */ }
  }
  if (cfg.embed.provider !== "openai" && (cfg.embed.apiKey || cfg.llm.apiKey || process.env.OPENAI_API_KEY)) {
    try { embedProviders.push(openaiEmbed("text-embedding-3-small", cfg.embed.apiKey || cfg.llm.apiKey || process.env.OPENAI_API_KEY || "", cfg.embed.dimensions)); } catch { /* skip */ }
  }
  const embedder = embedProviders.length > 1
    ? new EmbedFallback(embedProviders, { info: api.logger.info?.bind(api.logger), warn: api.logger.warn?.bind(api.logger) })
    : primaryEmbed;
  const embeddingMgr = new EmbeddingManager(db, embedder);

  // Selective memory — now with embedder for semantic contradiction detection
  const selective = new SelectiveMemory(db, contradictionLlm, {
    dupThreshold: 0.85,
    contradictionCheck: true,
    enrichEnabled: true,
  }, embeddingMgr);

  const graph = new KnowledgeGraph(db, graphLlm);
  const treeBuilder = new ContextTreeBuilder(db);
  const topicMgr = new TopicManager(db, topicsLlm, embedder, {
    emergenceThreshold: 3,
    mergeOverlap: 0.7,
    subtopicThreshold: 5,
    scanInterval: 15,
  });
  const identityParser = new IdentityParser(cfg.workspacePath);
  const lifecycleMgr = new LifecycleManager(db, {
    freshDays: cfg.lifecycle?.freshDays ?? 15,
    settledMinAccess: cfg.lifecycle?.settledMinAccess ?? 3,
    dormantAfterDays: cfg.lifecycle?.dormantAfterDays ?? 60,
    detailCursor: cfg.lifecycle?.detailCursor ?? 5,
    revisionRecallThreshold: cfg.lifecycle?.revisionRecallThreshold ?? 10,
  });
  const revisionMgr = new RevisionManager(db, chain);
  const hebbianMgr = new HebbianManager(db);
  const expertiseMgr = new ExpertiseManager(db);
  const proceduralLlm = layerLLM("procedural");
  const proceduralMem = new ProceduralMemory(db.raw, proceduralLlm, {
    reflectEvery: cfg.procedural?.reflectEvery ?? 3,
    degradedThreshold: cfg.procedural?.degradedThreshold ?? 0.5,
    defaultSafety: cfg.procedural?.defaultSafety ?? 0.8,
    staleDays: cfg.procedural?.staleDays ?? 30,
    docCheckDays: cfg.procedural?.docCheckDays ?? 60,
  });
  proceduralMem.ensureSchema(); // migrate quality columns + doc_sources if missing

  // Pattern detection manager (Layer 20)
  const patternMgr = new PatternManager(db, extractLlm, cfg.patterns);

  // Apply staleness penalties — once per process, not per session
  // OpenClaw calls register() once per active session, but staleness is global
  const stalenessKey = '__memoria_staleness_applied';
  if (!(globalThis as any)[stalenessKey]) {
    (globalThis as any)[stalenessKey] = true;
    const stalenessResult = proceduralMem.applyStalenessPenalties();
    if (stalenessResult.updated > 0 || stalenessResult.flaggedForDocCheck > 0) {
      console.log(`[memoria] 🕰️ Staleness check: ${stalenessResult.updated} aged, ${stalenessResult.flaggedForDocCheck} flagged for doc check`);
    }
  }
  const budget = new AdaptiveBudget({
    contextWindow: cfg.contextWindow || 200000,
    maxFacts: cfg.recallLimit || 12,
    minFacts: 2,
  });
  const mdSync = new MdSync(db, {
    workspacePath: cfg.workspacePath || process.env.HOME + "/.openclaw/workspace",
    dbToMd: cfg.syncMd !== false,
    mdToDb: false, // Safety: manual .md → DB off by default
  });
  const mdRegen = new MdRegenManager(db, cfg.workspacePath || process.env.HOME + "/.openclaw/workspace", {
    recentDays: 30,
    maxFactsPerFile: 150,
    archiveNotice: true,
  });

  const observationMgr = new ObservationManager(db, chain, embedder, {
    emergenceThreshold: 3,
    matchThreshold: 0.6,
    maxRecallObservations: Math.max(Math.floor(cfg.recallLimit / 3), 2),
    maxEvidencePerObservation: 15,
  });

  const clusterMgr = new FactClusterManager(db, chain);
  const feedbackMgr = new FeedbackManager(db);

  // Cross-layer: when selective supersedes a fact, cascade to ALL layers
  selective.onSupersede = (supersededId, _newId) => {
    try {
      const parts: string[] = [];
      const obsAffected = observationMgr.onFactSuperseded(supersededId);
      if (obsAffected > 0) parts.push(`${obsAffected} obs`);
      const graphAffected = graph.onFactSuperseded(supersededId);
      if (graphAffected > 0) parts.push(`${graphAffected} graph`);
      const topicAffected = topicMgr.onFactSuperseded(supersededId);
      if (topicAffected > 0) parts.push(`${topicAffected} topics`);
      const embRemoved = embeddingMgr.onFactSuperseded(supersededId);
      if (embRemoved) parts.push("1 embed");
      if (parts.length > 0) {
        api.logger.debug?.(`memoria: supersede cascade for ${supersededId} — ${parts.join(", ")}`);
      }
    } catch { /* non-critical */ }
  };

  // Ensure sync column exists
  mdSync.ensureSchema(db);

  const stats = db.stats();
  const embCount = embeddingMgr.embeddedCount();
  const gStats = graph.stats();
  const tStats = topicMgr.stats();
  const oStats = observationMgr.stats();
  const cStats = clusterMgr.stats();
  // Read version from package.json (avoid hardcoding)
  let pluginVersion = "3.2.0";
  try {
    const pkgPath = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    pluginVersion = pkg.version || pluginVersion;
  } catch { /* fallback to hardcoded */ }
  // Refresh lifecycle states on boot
  const lifecycleRefresh = lifecycleMgr.refreshAll();

  // Re-parent orphan topics (fix topics created before hierarchy logic)
  try {
    const reparented = topicMgr.reparentExistingTopics();
    if (reparented > 0) {
      api.logger.info?.(`memoria: reparented ${reparented} orphan topics`);
    }
  } catch { /* non-critical */ }
  const lifecycleStats = lifecycleMgr.getStats();

  // Hebbian + Expertise stats
  const hebbianStats = hebbianMgr.getStats();
  const expertiseStats = expertiseMgr.getStats();

  // Procedural memory stats
  const procStats = proceduralMem.getStats();

  // Pattern detection stats
  const patStats = patternMgr.stats();

  const fbStats = feedbackMgr.getStats();
  const fbNote = fbStats.totalWithFeedback > 0 ? `, feedback: ${fbStats.totalWithFeedback} tracked (avg ${fbStats.avgUsefulness.toFixed(1)})` : "";
  const lifecycleNote = ` | lifecycle: ${lifecycleStats.fresh ?? 0}f/${lifecycleStats.settled ?? 0}s/${lifecycleStats.dormant ?? 0}d (cursor:${lifecycleMgr.detailCursor})`;
  const hebbianNote = ` | graph: ${hebbianStats.strong} strong, ${hebbianStats.weak} weak`;
  const expertiseNote = ` | expertise: ${expertiseStats.expert}★★★/${expertiseStats.experienced}★★/${expertiseStats.familiar}★`;
  const procNote = procStats.total > 0 
    ? ` | procedures: ${procStats.healthy}✓/${procStats.degraded}⚠${procStats.stale > 0 ? `/${procStats.stale}🕰️` : ''}` 
    : "";
  const patNote = patStats.total > 0 ? ` | patterns: ${patStats.total} (avg ${patStats.avgOccurrences} occ)` : "";
  const contEnabled = cfg.continuous?.enabled !== false && cfg.autoCapture;
  const contInterval = cfg.continuous?.interval ?? 4;
  const contNote = contEnabled ? ` | continuous: every ${contInterval} turns` : "";
  api.logger.info?.(`memoria: v${pluginVersion} registered (${stats.active} facts, ${cStats.total} clusters, ${oStats.total} observations, ${embCount} embedded, ${gStats.entities} entities, ${gStats.relations} relations, ${tStats.totalTopics} topics${fbNote}${lifecycleNote}${hebbianNote}${expertiseNote}${procNote}${patNote}${contNote}, fallback: ${chain.providerNames.join(" → ")})`);
  
  // Log .md file sizes
  const fileSizes = mdRegen.fileSizes();
  const totalLines = Object.values(fileSizes).reduce((sum, f) => sum + f.lines, 0);
  api.logger.info?.(`memoria: workspace .md files = ${totalLines} lines total (regen available to bound growth)`);

  // Background: embed unembedded facts on boot (non-blocking)
  const unembedded = embeddingMgr.unembeddedFacts(100);
  if (unembedded.length > 0) {
    api.logger.info?.(`memoria: ${unembedded.length} facts need embedding, starting background indexing...`);
    embeddingMgr.embedBatch(unembedded.map(f => ({ id: f.id, text: f.fact })))
      .then(n => api.logger.info?.(`memoria: background embed complete — ${n} facts indexed`))
      .catch(err => api.logger.warn?.(`memoria: background embed failed: ${String(err)}`));
  }

  // ─── Shared post-processing for newly captured facts ───
  /**
   * Post-capture pipeline — runs after every batch of new facts.
   * Called by: agent_end, after_compaction, AND doContinuousExtraction.
   * 
   * 8 steps:
   *   1. embedBatch() — vectorize unembedded facts
   *   2. graph.extractAndStore() — entities + relations from new facts
   *   3. hebbian.reinforce() — strengthen co-occurring entity relations
   *   4. topics.onFactCaptured() + scanAndEmerge() — keyword extraction, topic creation
   *   5. observations.onFactCaptured() — match/create living syntheses
   *   6. clusters.generateClusters() — entity-grouped summaries
   *   7. mdSync.syncToMd() + mdRegen — append to .md files, regenerate if > 200 lines
   *   8. patterns.detectAndConsolidate() — consolidate repeated similar facts
   *   9. Cross-layer: feedback→lifecycle, hebbian→topics hierarchy, lifecycle→patterns
   */
  async function postProcessNewFacts(source: "capture" | "compaction"): Promise<void> {
    // 1. Embed unembedded facts
    try {
      const toEmbed = embeddingMgr.unembeddedFacts(10);
      if (toEmbed.length > 0) {
        const n = await embeddingMgr.embedBatch(toEmbed.map(f => ({ id: f.id, text: f.fact })));
        if (n > 0) api.logger.info?.(`memoria: [${source}] embedded ${n} new facts`);
      }
    } catch { /* non-critical */ }

    // 2. Graph: extract entities/relations (limit to 5 to avoid LLM spam)
    try {
      const recentFacts = db.recentFacts(5);
      let totalEnt = 0, totalRel = 0;
      for (const f of recentFacts) {
        if (f.entity_ids && f.entity_ids !== "[]") continue;
        const { entities: ne, relations: nr } = await graph.extractAndStore(f.id, f.fact);
        totalEnt += ne;
        totalRel += nr;

        // Hebbian reinforcement: co-occurring entities strengthen relations
        if (f.entity_ids && f.entity_ids !== "[]") {
          const entityIds = JSON.parse(f.entity_ids) as string[];
          hebbianMgr.reinforceFromFact(f.id, entityIds);
        }
      }
      if (totalEnt > 0 || totalRel > 0) {
        api.logger.info?.(`memoria: [${source}] graph extracted ${totalEnt} entities, ${totalRel} relations`);
      }
    } catch { /* non-critical */ }

    // 3. Topics: keyword extraction + topic association
    try {
      const recentForTopics = db.recentFacts(3);
      for (const f of recentForTopics) {
        if (f.tags && f.tags !== "[]") continue;
        const { keywords, topics: topicNames } = await topicMgr.onFactCaptured(f.id, f.fact, f.category);
        if (keywords.length > 0) {
          api.logger.debug?.(`memoria: [${source}] tagged "${f.fact.slice(0, 40)}..." → [${keywords.join(", ")}]${topicNames.length > 0 ? ` → topics: ${topicNames.join(", ")}` : ""}`);
        }
      }
      if (topicMgr.shouldScan()) {
        const scanResult = await topicMgr.scanAndEmerge();
        if (scanResult.created > 0 || scanResult.merged > 0 || scanResult.subtopics > 0) {
          api.logger.info?.(`memoria: [${source}] topics scan — ${scanResult.created} created, ${scanResult.merged} merged, ${scanResult.subtopics} sub-topics`);
        }
      }
    } catch (topicErr) {
      api.logger.debug?.(`memoria: [${source}] topic tagging non-critical error: ${String(topicErr)}`);
    }

    // 4. Observations: check if new facts match or trigger new observations
    try {
      const recentForObs = db.recentFacts(3);
      let obsUpdated = 0, obsCreated = 0;
      for (const f of recentForObs) {
        const result = await observationMgr.onFactCaptured(f.id, f.fact, f.category);
        if (result.action === "updated_observation") obsUpdated++;
        if (result.action === "created_observation") obsCreated++;
      }
      if (obsUpdated > 0 || obsCreated > 0) {
        api.logger.info?.(`memoria: [${source}] observations — ${obsCreated} created, ${obsUpdated} updated`);
      }
    } catch { /* non-critical */ }

    // 5. Fact Clusters: generate/refresh thematic summaries
    try {
      const clusterResult = await clusterMgr.generateClusters();
      if (clusterResult.created > 0 || clusterResult.updated > 0) {
        api.logger.info?.(`memoria: [${source}] clusters — ${clusterResult.created} created, ${clusterResult.updated} updated, ${clusterResult.stale} stale`);
        // Embed new clusters
        const toEmbed = embeddingMgr.unembeddedFacts(5);
        if (toEmbed.length > 0) {
          await embeddingMgr.embedBatch(toEmbed.map(f => ({ id: f.id, text: f.fact })));
        }
      }
    } catch { /* non-critical */ }

    // 6. Sync new facts to .md files
    try {
      const syncResult = mdSync.syncToMd(db);
      if (syncResult.synced > 0) {
        api.logger.info?.(`memoria: [${source}] synced ${syncResult.synced} facts to .md files`);
      }
    } catch { /* non-critical */ }

    // 7. Auto md-regen: smart trigger (captures count OR stale OR file size)
    try {
      mdRegen.recordCapture();
      const regenReason = mdRegen.shouldAutoRegen();
      if (regenReason) {
        const regenResult = mdRegen.regenerate();
        api.logger.info?.(`memoria: [${source}] auto md-regen triggered (${regenReason}) — ${regenResult.files} files, ${regenResult.recentFacts} recent, ${regenResult.archivedFacts} archived`);
      }
    } catch { /* non-critical */ }

    // 8. Pattern detection: consolidate repeated similar facts
    try {
      const patternResult = await patternMgr.detectAndConsolidate();
      if (patternResult.consolidated > 0) {
        api.logger.info?.(`memoria: [${source}] patterns — ${patternResult.detected} groups found, ${patternResult.consolidated} consolidated`);
      }
    } catch { /* non-critical */ }

    // 9. Cross-layer connections (Phase 3)
    try {
      let crossUpdates = 0;

      // 9a. Feedback → lifecycle promotion
      // Facts recalled 5+ times with positive usefulness → force settled
      const highUseFacts = db.raw.prepare(
        `SELECT id, lifecycle_state, recall_count, usefulness FROM facts 
         WHERE superseded = 0 AND recall_count >= 5 AND usefulness >= 2 
         AND (lifecycle_state IS NULL OR lifecycle_state = 'fresh')`
      ).all() as Array<{ id: string; lifecycle_state: string; recall_count: number; usefulness: number }>;
      for (const f of highUseFacts) {
        db.raw.prepare("UPDATE facts SET lifecycle_state = 'settled' WHERE id = ?").run(f.id);
        crossUpdates++;
      }

      // 9b. Hebbian → topics: strong relations (weight >= 1.0) between entities
      // If both entities belong to different topics, suggest parent-child or merge
      const strongRelations = db.raw.prepare(
        `SELECT source_id, target_id, weight FROM relations WHERE weight >= 1.0 ORDER BY weight DESC LIMIT 20`
      ).all() as Array<{ source_id: string; target_id: string; weight: number }>;
      for (const rel of strongRelations) {
        // Find topics for each entity
        const fromTopics = db.raw.prepare(
          `SELECT DISTINCT t.id, t.name, t.parent_topic_id FROM topics t 
           JOIN fact_topics ft ON ft.topic_id = t.id 
           JOIN facts f ON f.id = ft.fact_id 
           WHERE f.entity_ids LIKE ? AND f.superseded = 0`
        ).all(`%${rel.source_id}%`) as Array<{ id: string; name: string; parent_topic_id: string | null }>;
        const toTopics = db.raw.prepare(
          `SELECT DISTINCT t.id, t.name, t.parent_topic_id FROM topics t 
           JOIN fact_topics ft ON ft.topic_id = t.id 
           JOIN facts f ON f.id = ft.fact_id 
           WHERE f.entity_ids LIKE ? AND f.superseded = 0`
        ).all(`%${rel.target_id}%`) as Array<{ id: string; name: string; parent_topic_id: string | null }>;

        // If one topic is smaller, make it child of the larger
        for (const ft of fromTopics) {
          for (const tt of toTopics) {
            if (ft.id === tt.id) continue;
            if (ft.parent_topic_id || tt.parent_topic_id) continue; // already has parent
            const ftCount = (db.raw.prepare("SELECT fact_count FROM topics WHERE id = ?").get(ft.id) as any)?.fact_count || 0;
            const ttCount = (db.raw.prepare("SELECT fact_count FROM topics WHERE id = ?").get(tt.id) as any)?.fact_count || 0;
            // Smaller becomes child of larger (only if ratio > 2:1)
            if (ftCount > ttCount * 2 && ttCount > 0) {
              db.raw.prepare("UPDATE topics SET parent_topic_id = ? WHERE id = ?").run(ft.id, tt.id);
              crossUpdates++;
            } else if (ttCount > ftCount * 2 && ftCount > 0) {
              db.raw.prepare("UPDATE topics SET parent_topic_id = ? WHERE id = ?").run(tt.id, ft.id);
              crossUpdates++;
            }
          }
        }
      }

      // 9c. Lifecycle → patterns: confirmed patterns (5+ occurrences) → settled
      const freshPatterns = db.raw.prepare(
        `SELECT id, tags FROM facts WHERE fact_type = 'pattern' AND superseded = 0 
         AND (lifecycle_state IS NULL OR lifecycle_state = 'fresh')`
      ).all() as Array<{ id: string; tags: string }>;
      for (const p of freshPatterns) {
        try {
          const meta = JSON.parse(p.tags || "{}");
          if (meta.occurrences && meta.occurrences.length >= 5) {
            db.raw.prepare("UPDATE facts SET lifecycle_state = 'settled' WHERE id = ?").run(p.id);
            crossUpdates++;
          }
        } catch { /* skip malformed */ }
      }

      if (crossUpdates > 0) {
        api.logger.info?.(`memoria: [${source}] cross-layer — ${crossUpdates} updates (feedback→lifecycle, hebbian→topics, lifecycle→patterns)`);
      }
    } catch { /* cross-layer non-critical */ }
  }

  // ════════════════════════════════════════════════════════════════
  // HOOK: before_prompt_build — Recall (Layer 6)
  // ════════════════════════════════════════════════════════════════

  if (cfg.autoRecall) {
    api.on("before_prompt_build", async (event, _ctx) => {
      try {
        const rawPrompt = typeof event.prompt === "string" ? event.prompt : "";
        if (!rawPrompt || rawPrompt.length < 3) return undefined;

        // Strip OpenClaw envelope metadata to get the real user message
        // The prompt contains "Conversation info (untrusted metadata)..." + JSON blocks
        // which pollute FTS search with irrelevant tokens
        let prompt = rawPrompt;
        const lastJsonEnd = rawPrompt.lastIndexOf("```\n\n");
        if (lastJsonEnd !== -1 && rawPrompt.includes("untrusted metadata")) {
          prompt = rawPrompt.slice(lastJsonEnd + 5).trim();
        }
        // Also strip Memoria injection header if re-entering
        if (prompt.startsWith("## 🧠 Memoria")) {
          const afterMemoria = prompt.indexOf("\n\n", prompt.indexOf("Conversation info"));
          if (afterMemoria !== -1) prompt = prompt.slice(afterMemoria).trim();
        }
        // Fallback: if stripping removed everything, use last 500 chars of raw
        if (!prompt || prompt.length < 3) {
          prompt = rawPrompt.slice(-500).trim();
        }

        // ── User signal detection (correction / frustration) ──
        // Analyze the user message BEFORE recall so we can penalize
        // facts from the PREVIOUS recall that led to a bad response.
        try {
          const signal = feedbackMgr.analyzeUserMessage(prompt);
          if (signal.isCorrection || signal.isFrustration) {
            const penalized = feedbackMgr.applyUserSignal(signal.penalty);
            const parts: string[] = [];
            if (signal.isCorrection) parts.push("correction detected");
            if (signal.isFrustration) parts.push("frustration detected");
            if (penalized.length > 0) {
              api.logger.info?.(`memoria: user signal (${parts.join(" + ")}) → ${penalized.length} facts penalized by ${signal.penalty}`);
            }
          }
        } catch { /* non-critical — don't block recall */ }

        // Adaptive budget: compute how many facts to inject based on context usage
        const messageCount = (event as any).messageCount || (event as any).messages?.length || 0;
        const tokenEstimate = AdaptiveBudget.estimateTokens(messageCount);
        const budgetResult = budget.compute(tokenEstimate);
        const recallLimit = budgetResult.limit;

        const penaltyLog = budget.penalty > 0 ? `, penalty -${budget.penalty}` : "";
        api.logger.debug?.(`memoria: budget ${budgetResult.zone} (${(budgetResult.usage * 100).toFixed(0)}% used${penaltyLog}) → ${recallLimit} facts`);

        // Hot tier: always-injected facts (frequently accessed, like a phone number you know by heart)
        const hotFactsRaw = db.hotFacts(HOT_TIER_CONFIG.minAccessCount, HOT_TIER_CONFIG.staleAfterDays, HOT_TIER_CONFIG.maxHotFacts);
        const hotIds = new Set(hotFactsRaw.map(f => f.id));
        const hotScored = getHotFacts(hotFactsRaw);
        const hotLimit = hotScored.length;
        const searchLimit = Math.max(recallLimit - hotLimit, 2); // Reserve slots for query-relevant facts

        // Hybrid search: FTS5 + cosine + temporal scoring
        let topFacts: Array<{ id: string; fact: string; category: string; confidence: number; temporalScore: number }>;

        if (embeddingMgr.embeddedCount() > 0) {
          const results = await embeddingMgr.hybridSearch(prompt, searchLimit, {
            ftsWeight: 0.35,
            cosineWeight: 0.45,
            temporalWeight: 0.20,
          });
          topFacts = results.filter(f => f.confidence >= 0.5 && !hotIds.has(f.id));
        } else {
          const fetchLimit = Math.min(searchLimit * 2, 20);
          const facts = db.searchFacts(prompt, fetchLimit);
          if (!facts || facts.length === 0 && hotScored.length === 0) return undefined;
          const relevant = (facts || []).filter(f => f.confidence >= 0.5 && !hotIds.has(f.id));
          const scored = scoreAndRank(relevant);
          topFacts = scored.slice(0, searchLimit);
        }

        if (topFacts.length === 0) return undefined;

        // Graph enrichment: find entities in the query, traverse graph for related facts
        let graphFacts: Fact[] = [];
        try {
          const entities = graph.findEntitiesInText(prompt);
          if (entities.length > 0) {
            const related = graph.getRelatedFacts(entities.map(e => e.name), 2, 3);
            const existingIds = new Set(topFacts.map(f => f.id));
            for (const r of related) {
              if (!existingIds.has(r.id)) {
                const fact = db.getFact(r.id);
                if (fact) graphFacts.push(fact);
              }
            }

            // Hebbian: reinforce connections between co-accessed entities
            const entityIds = entities.map(e => e.id).filter(Boolean) as string[];
            if (entityIds.length >= 2) {
              graph.hebbianReinforce(entityIds);
            }
          }
        } catch { /* graph enrichment is non-critical */ }

        // Topic enrichment: find relevant topics and add their facts
        // Pass expanded queries for broader topic matching
        const expandedQueries = embeddingMgr.expandQuery(prompt);
        let topicFacts: Fact[] = [];
        try {
          const relevantTopics = await topicMgr.findRelevantTopics(prompt, 3, expandedQueries);
          if (relevantTopics.length > 0) {
            const existingIds = new Set([...topFacts.map(f => f.id), ...graphFacts.map(f => f.id)]);
            for (const rt of relevantTopics) {
              // Get top facts from this topic that aren't already included
              for (const factText of rt.facts.slice(0, 3)) {
                // Find fact by text (not ideal but works)
                const found = db.searchFacts(factText.slice(0, 80), 1);
                if (found.length > 0 && !existingIds.has(found[0].id)) {
                  topicFacts.push(found[0]);
                  existingIds.add(found[0].id);
                }
              }
            }
            if (relevantTopics.length > 0) {
              api.logger.debug?.(`memoria: topics matched: ${relevantTopics.map(t => t.topic.name).join(", ")}`);
            }
          }
        } catch { /* topic enrichment non-critical */ }

        // Observations: synthesized multi-fact summaries (PRIORITY over individual facts)
        let observationContext = "";
        try {
          const relevantObs = await observationMgr.getRelevantObservations(prompt);
          if (relevantObs.length > 0) {
            observationContext = observationMgr.formatForRecall(relevantObs);
            api.logger.debug?.(`memoria: ${relevantObs.length} observations matched`);
          }
        } catch { /* non-critical */ }

        // Procedural memory: search for matching "how-to" procedures
        // Cross-layer: uses Graph entities to enhance search + Embeddings for semantic match
        let proceduresContext = "";
        const matchedProcedureIds: string[] = [];
        try {
          // Strategy 1: Direct text search (fast, always works)
          let procedures = proceduralMem.search(prompt, 3);

          // Strategy 2: If few results, expand via Graph entities
          // The graph knows "ClawHub" relates to "publish", "Memoria" relates to "plugin" etc.
          if (procedures.length < 2) {
            try {
              const graphEntities = graph.findEntitiesInText(prompt);
              if (graphEntities.length > 0) {
                const relatedTerms = graphEntities
                  .flatMap((e: any) => [e.name, ...(e.aliases || [])])
                  .slice(0, 5);
                for (const term of relatedTerms) {
                  const extra = proceduralMem.search(term, 2);
                  for (const p of extra) {
                    if (!procedures.find(existing => existing.id === p.id)) {
                      procedures.push(p);
                    }
                  }
                }
                if (procedures.length > 3) procedures = procedures.slice(0, 3);
              }
            } catch { /* graph expansion is non-critical */ }
          }

          if (procedures.length > 0) {
            const procTexts: string[] = [];
            for (const proc of procedures) {
              matchedProcedureIds.push(proc.id);
              const successRate = proc.success_count / Math.max(proc.success_count + proc.failure_count, 1);
              const degThreshold = cfg.procedural?.degradedThreshold ?? 0.5;
              const isStale = proceduralMem.needsDocCheck(proc);
              const isDegraded = proc.degradation_score > degThreshold;
              const status = isDegraded ? "⚠ degraded" 
                : isStale ? "🕰️ stale — verify before using"
                : proc.preferred ? "★ preferred" : "✓";
              const qualityStr = `quality: ${(proc.quality.overall * 100).toFixed(0)}%`;
              const versionStr = proc.version > 1 ? ` v${proc.version}` : '';
              const gotchaStr = proc.gotchas ? `\n  ⚠ Gotchas: ${proc.gotchas}` : '';
              const staleStr = isStale ? `\n  🕰️ Not used in a while — check docs/help before running. Doc sources: ${(proc.doc_sources || []).join(', ') || 'run --help'}` : '';
              procTexts.push(
                `**${proc.name}**${versionStr} ${status} (${(successRate * 100).toFixed(0)}% success, ${qualityStr}):\n` +
                proc.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
                gotchaStr +
                staleStr
              );
            }
            proceduresContext = `\n## 🔧 Known Procedures\n${procTexts.join('\n\n')}\n`;
            api.logger.debug?.(`memoria: ${procedures.length} procedures matched (graph-expanded)`);
          }
        } catch { /* non-critical */ }

        // Context tree: organize facts hierarchically, weight by query
        // Merge: hot tier (always first) + search + graph + topic
        let finalFacts: Fact[] = [];
        try {
          // Build set of fact IDs that are members of active (non-stale) clusters
          // These facts are represented by their cluster summary, so they get deprioritized
          // (not excluded — they can still surface if directly relevant)
          let clusteredFactIds: Set<string> = new Set();
          try {
            const clusters = db.raw.prepare(
              "SELECT tags FROM facts WHERE fact_type = 'cluster' AND superseded = 0"
            ).all() as Array<{ tags: string }>;
            for (const c of clusters) {
              try {
                const meta = JSON.parse(c.tags);
                if (!meta.stale && Array.isArray(meta.memberIds)) {
                  for (const id of meta.memberIds) clusteredFactIds.add(id);
                }
              } catch { /* bad JSON, skip */ }
            }
          } catch { /* non-critical */ }

          // Apply lifecycle multiplier + expertise boost + cluster-member deprioritization BEFORE tree building
          const allFactsCandidates = [...hotScored, ...topFacts, ...graphFacts, ...topicFacts].map(f => {
            let mult = lifecycleMgr.getRecallMultiplier(f.lifecycle_state);
            // Facts already represented by a cluster get 40% penalty
            // (the cluster summary carries their info more concisely)
            if (clusteredFactIds.has(f.id) && f.fact_type !== "cluster") {
              mult *= 0.6;
            }
            // Expertise boost: facts linked to expert-level topics get up to 1.5× score
            try {
              const factTopics = db.raw.prepare(
                "SELECT t.name FROM topics t JOIN fact_topics ft ON ft.topic_id = t.id WHERE ft.fact_id = ?"
              ).all(f.id) as Array<{ name: string }>;
              if (factTopics.length > 0) {
                const boost = expertiseMgr.applyExpertiseBoost(1.0, factTopics.map(t => t.name));
                if (boost > 1.0) mult *= boost;
              }
            } catch { /* expertise non-critical */ }
            // Pattern boost: consolidated patterns get 1.5× score
            mult *= patternMgr.applyPatternBoost(1.0, f.fact_type);
            if ((f as any).temporalScore) {
              return { ...f, temporalScore: (f as any).temporalScore * mult };
            }
            return f;
          });
          const tree = await treeBuilder.build(allFactsCandidates, prompt);
          
          // Extract facts in priority order (tree weights)
          finalFacts = treeBuilder.extractFacts(tree, recallLimit);

          // Log tree structure (debug)
          if (tree.roots.length > 0) {
            const treeView = treeBuilder.renderTree(tree, 2);
            api.logger.debug?.(`memoria tree:\n${treeView}`);
          }
        } catch {
          // Fallback: use flat list
          finalFacts = [...topFacts, ...graphFacts, ...topicFacts].slice(0, recallLimit);
        }

        if (finalFacts.length === 0 && !observationContext && !proceduresContext) return undefined;

        const context = formatRecallContext(finalFacts, observationContext) + proceduresContext;

        // Track access + feedback loop + budget learning + lifecycle update
        const ids = finalFacts.map(f => f.id);
        try { db.trackAccess(ids); } catch { /* non-critical */ }
        try { feedbackMgr.recordRecall(ids, prompt); } catch { /* non-critical */ }
        try { budget.recordRecall(recallLimit); } catch { /* non-critical */ }

        // Note: procedure feedback comes from after_tool_call (reinforcement/reflect),
        // not from recall. Unlike facts, procedures prove their worth through execution.
        try {
          // Update lifecycle state for recalled facts (fresh→settled transition)
          for (const fact of finalFacts) {
            lifecycleMgr.updateLifecycle(fact);
          }
        } catch { /* non-critical */ }

        // Proactive revision: check if any settled facts need refinement (async, non-blocking)
        setImmediate(async () => {
          try {
            const revResult = await revisionMgr.checkAndRevise();
            if (revResult.revised > 0) {
              api.logger.info?.(`memoria: proactive revision completed (${revResult.revised} refined, ${revResult.created} new facts)`);
            }
          } catch (err) {
            api.logger.debug?.(`memoria: proactive revision failed: ${String(err)}`);
          }
        });

        const hotNote = hotLimit > 0 ? `, ${hotLimit} hot` : "";
        const graphNote = graphFacts.length > 0 ? `, +${graphFacts.length} graph` : "";
        const obsNote = observationContext ? ", +obs" : "";
        api.logger.info?.(`memoria: recall injected ${finalFacts.length} facts${obsNote} (${hotNote}${graphNote}, tree+hybrid) for "${prompt.slice(0, 50)}..."`);
        return { prependContext: context };
      } catch (err) {
        api.logger.warn?.(`memoria: recall failed: ${String(err)}`);
        return undefined;
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // HOOK: message_received + llm_output — Continuous Learning (Layer 21)
  // Like a child learning while walking, not just at bedtime.
  // Captures facts in real-time as the conversation flows,
  // independent of context size, compaction, or session end.
  // ════════════════════════════════════════════════════════════════

  const continuousBuffer: Array<{ role: "user" | "assistant"; text: string; ts: number }> = [];
  let continuousTurnCount = 0;
  let lastContinuousExtraction = 0;
  let continuousExtractionInProgress = false; // guard against concurrent extractions
  const CONTINUOUS_ENABLED = cfg.continuous?.enabled !== false && cfg.autoCapture; // on by default if autoCapture
  const CONTINUOUS_COOLDOWN_MS = cfg.continuous?.cooldownMs ?? 45_000; // 45s between normal extractions
  const CONTINUOUS_MAX_BUFFER = 10; // keep last 10 exchanges
  const CONTINUOUS_NORMAL_INTERVAL = cfg.continuous?.interval ?? 4; // extract every N turns
  const CONTINUOUS_URGENT_PATTERNS = [
    // Frustration / explicit error signals
    /\bne\s+fais?\s+plus\b/i, /\bne\s+jamais\b/i, /\bputain\b/i, /\bmerde\b/i,
    /\bc'est\s+la\s+[23]\w*\s+fois\b/i, /\bj'ai\s+d[uû]\b/i,
    /\bdoublon\b/i, /\berreur\b/i, /\bcrash\b/i, /\bcassé\b/i, /\bmort\b/i,
    /\brevert\b/i, /\brollback\b/i, /\bhotfix\b/i,
    /\btu\s+as\s+pas\s+(compris|appris|retenu)\b/i,
    /\bpourquoi\s+tu\s+(refais?|recommence)\b/i,
    // English equivalents
    /\bnever\s+do\b/i, /\bdon'?t\s+ever\b/i, /\bbroke\b/i, /\bdead\b/i,
    /\bduplicate\b/i, /\bmistake\b/i,
  ];

  // Buffer user messages
  api.on("message_received", async (event, _ctx) => {
    if (!CONTINUOUS_ENABLED) return;
    try {
      if (!event.content || event.content.length < 5) return;
      // Skip heartbeat/system messages
      if (/^(HEARTBEAT|Read HEARTBEAT|NO_REPLY)/i.test(event.content)) return;

      continuousBuffer.push({
        role: "user",
        text: event.content.slice(0, 3000),
        ts: Date.now(),
      });
      if (continuousBuffer.length > CONTINUOUS_MAX_BUFFER) continuousBuffer.shift();
      continuousTurnCount++;

      // Check for urgent signals in user message — extract immediately
      const isUrgent = CONTINUOUS_URGENT_PATTERNS.some(p => p.test(event.content));
      if (isUrgent) {
        api.logger.info?.(`memoria: ⚡ continuous — urgent signal detected in user message`);
        await doContinuousExtraction("urgent");
      }
    } catch (err) {
      api.logger.debug?.(`memoria: continuous message_received error: ${String(err)}`);
    }
  });

  // Buffer assistant responses + trigger periodic extraction
  api.on("llm_output", async (event, _ctx) => {
    if (!CONTINUOUS_ENABLED) return;
    try {
      const texts = event.assistantTexts?.filter(t => t && t.length > 15) || [];
      if (texts.length === 0) return;

      const combined = texts.join("\n").slice(0, 3000);
      // Skip empty/system responses
      if (/^(HEARTBEAT_OK|NO_REPLY)$/i.test(combined.trim())) return;

      continuousBuffer.push({
        role: "assistant",
        text: combined,
        ts: Date.now(),
      });
      if (continuousBuffer.length > CONTINUOUS_MAX_BUFFER) continuousBuffer.shift();

      // Check for self-detected errors in assistant response
      const selfErrorPatterns = [
        /erreur.*j'ai\s+(fait|commis|créé)/i,
        /mon\s+erreur/i, /j'aurais\s+d[uû]/i,
        /je\s+n'aurais\s+pas\s+d[uû]/i,
        /confond[ure]/i, /par\s+erreur/i,
        /ERREUR\s+CRITIQUE/i,
      ];
      const selfError = selfErrorPatterns.some(p => p.test(combined));
      if (selfError) {
        api.logger.info?.(`memoria: ⚡ continuous — self-detected error in assistant response`);
        await doContinuousExtraction("self-error");
      }

      // Normal periodic extraction
      if (continuousTurnCount >= CONTINUOUS_NORMAL_INTERVAL) {
        const now = Date.now();
        if (now - lastContinuousExtraction > CONTINUOUS_COOLDOWN_MS) {
          await doContinuousExtraction("periodic");
        }
      }
    } catch (err) {
      api.logger.debug?.(`memoria: continuous llm_output error: ${String(err)}`);
    }
  });

  /**
   * Layer 21: Continuous Learning — micro-extraction from rolling buffer.
   * 
   * Triggers:
   *   - "periodic": every N turns (default 4), with cooldown
   *   - "urgent": immediate on user frustration/error keywords (bypasses cooldown)
   *   - "self-error": immediate on assistant self-admission phrases
   * 
   * Uses same LLM_EXTRACT_PROMPT + selective + postProcessNewFacts as agent_end.
   * Guarded by continuousExtractionInProgress lock to prevent concurrent runs.
   * Buffer is snapshot + cleared before extraction to avoid re-processing.
   */
  async function doContinuousExtraction(trigger: "periodic" | "urgent" | "self-error"): Promise<void> {
    if (continuousBuffer.length < 2) return;
    if (continuousExtractionInProgress) return; // prevent concurrent extractions

    const now = Date.now();
    // Urgent bypasses cooldown, others respect it
    if (trigger === "periodic" && now - lastContinuousExtraction < CONTINUOUS_COOLDOWN_MS) return;

    continuousExtractionInProgress = true;
    lastContinuousExtraction = now;
    continuousTurnCount = 0;

    // Snapshot and clear buffer to avoid re-processing same messages
    const snapshot = [...continuousBuffer];
    continuousBuffer.length = 0;

    // Build context from snapshot
    const context = snapshot
      .map(m => `[${m.role}]: ${m.text}`)
      .join("\n---\n");

    const urgencyHint = trigger === "urgent"
      ? "\n\n⚠️ SIGNAL D'URGENCE DÉTECTÉ — L'utilisateur exprime une frustration ou signale une erreur. PRIORITÉ MAXIMALE aux faits de catégorie 'erreur'."
      : trigger === "self-error"
      ? "\n\n⚠️ L'ASSISTANT A DÉTECTÉ SA PROPRE ERREUR — Capturer ce qui s'est mal passé, pourquoi, et ce qu'il ne faut plus faire."
      : "";

    const prompt = LLM_EXTRACT_PROMPT
      .replace("{TEXT}", context + urgencyHint)
      .replace("{MAX_FACTS}", String(Math.min(cfg.captureMaxFacts, trigger === "periodic" ? 3 : 5)));

    try {
      const result = await extractLlm.generateWithMeta(prompt, {
        maxTokens: 768,
        temperature: 0.1,
        format: "json",
        timeoutMs: 20000,
      });

      if (!result?.response) return;

      const parsed = parseJSON(result.response) as { facts?: Array<{ fact: string; category: string; type?: string; confidence: number }> };
      if (!parsed?.facts || parsed.facts.length === 0) return;

      let stored = 0, skipped = 0, enriched = 0, superseded = 0;
      for (const f of parsed.facts) {
        if (!f.fact || f.fact.length < 5) continue;
        if (f.confidence < 0.7) continue;

        const factType = (f.type === "episodic") ? "episodic" : "semantic";
        try {
          const category = normalizeCategory(f.category);
          const relevance = identityParser.calculateRelevance(f.fact, category);
          const res = await selective.processAndApply(
            f.fact, category, f.confidence, cfg.defaultAgent, factType, relevance
          );
          if (res.stored) {
            if (res.action === "enrich") enriched++;
            else if (res.action === "supersede") superseded++;
            else stored++;
          } else { skipped++; }
        } catch {
          const category = normalizeCategory(f.category);
          const relevance = identityParser.calculateRelevance(f.fact, category);
          db.storeFact({
            id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            fact: f.fact, category, confidence: f.confidence,
            source: `continuous-${trigger}`,
            tags: "[]", agent: cfg.defaultAgent,
            created_at: Date.now(), updated_at: Date.now(),
            fact_type: factType, relevance_weight: relevance,
          });
          stored++;
        }
      }

      const parts: string[] = [];
      if (stored > 0) parts.push(`${stored} new`);
      if (enriched > 0) parts.push(`${enriched} enriched`);
      if (superseded > 0) parts.push(`${superseded} superseded`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      if (parts.length > 0) {
        api.logger.info?.(`memoria: ⚡ continuous [${trigger}] — ${parts.join(", ")}`);
        // Post-process (embed, graph, topics, etc.)
        if (stored > 0 || enriched > 0) {
          await postProcessNewFacts("capture");
        }
      }
    } catch (err) {
      api.logger.debug?.(`memoria: continuous extraction failed: ${String(err)}`);
    } finally {
      continuousExtractionInProgress = false;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════════
  // HOOK: after_tool_call — Real-time procedural capture (Layer 1b)
  // Learn on-the-fly, not at end-of-session. Like a human learning
  // during the task, not when they go home at night.
  // ════════════════════════════════════════════════════════════════

  // Session buffer: accumulates tool calls until a success pattern triggers assembly
  const toolCallBuffer: Array<{
    toolName: string;
    params: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs?: number;
    timestamp: number;
  }> = [];
  // Track which procedures were already assembled to avoid duplicates
  const assembledGoals = new Set<string>();
  // Cooldown to avoid assembling too frequently
  let lastAssemblyTime = 0;
  const ASSEMBLY_COOLDOWN_MS = 60_000; // 1 minute between assemblies

  api.on("after_tool_call", async (event, _ctx) => {
    try {
      const { toolName, params, result, error, durationMs } = event;
      
      // Buffer all tool calls (keep last 30 to avoid memory leak)
      toolCallBuffer.push({
        toolName,
        params: params || {},
        result: typeof result === 'string' ? result.slice(0, 2000) : result,
        error,
        durationMs,
        timestamp: Date.now(),
      });
      if (toolCallBuffer.length > 30) toolCallBuffer.shift();

      // Only trigger assembly on exec-type tools with a successful outcome
      if (toolName !== 'exec' && toolName !== 'Edit' && toolName !== 'Write') return;
      if (error) return; // failed step — don't assemble yet

      // Check result for success keywords (publish, deploy, commit, install, etc.)
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result || '');
      const successPatterns = [
        /Published?\s/i, /✔|✅/, /success/i, /deployed/i, /created/i,
        /\[new tag\]/, /release.*created/i, /installed/i, /committed/i,
        /pushed/i, /merged/i, /completed/i, /OK\.\s/,
      ];

      const isSuccess = successPatterns.some(p => p.test(resultStr));
      if (!isSuccess) return;

      // Cooldown check
      const now = Date.now();
      if (now - lastAssemblyTime < ASSEMBLY_COOLDOWN_MS) return;

      // We have a success signal — assemble procedure from recent exec calls
      const recentExecs = toolCallBuffer
        .filter(tc => tc.toolName === 'exec' && !tc.error)
        .slice(-15); // last 15 exec calls

      if (recentExecs.length < 2) return;

      // Extract commands
      const commands = recentExecs
        .map(tc => (tc.params as any)?.command as string)
        .filter(Boolean)
        .filter(cmd => cmd.length > 5 && cmd.length < 1000);

      if (commands.length < 2) return;

      // ── FIX 1: Filter — only capture reusable procedures ──
      if (!proceduralMem.isReusableProcedure(commands)) {
        api.logger.debug?.(`memoria: procedural skipped — not reusable (${commands.length} cmds, no action pattern)`);
        return;
      }

      // Quick fingerprint to avoid duplicate assemblies
      const fingerprint = commands.slice(-3).join('|').slice(0, 200);
      if (assembledGoals.has(fingerprint)) return;

      // Assemble the procedure via LLM
      api.logger.info?.(`memoria: 🔧 real-time procedural capture — ${commands.length} commands, trigger: "${resultStr.slice(0, 80)}..."`);

      const prompt = `Analyze this successful command sequence and extract a reusable procedure.

Commands executed (in order):
${commands.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Final result (success): ${resultStr.slice(0, 500)}

Output JSON only (no markdown, no explanation):
{
  "name": "Short name (e.g., 'Publish Memoria to ClawHub')",
  "goal": "What this accomplishes in one sentence",
  "trigger_patterns": ["keyword1", "keyword2"],
  "key_steps": ["step1 description", "step2 description"],
  "gotchas": ["pitfall or workaround learned"]
}`;

      try {
        const response = await extractLlm.generateWithMeta(prompt, {
          maxTokens: 512,
          temperature: 0.1,
          format: "json",
          timeoutMs: 15000,
        });

        if (!response?.response) return;

        const cleaned = response.response.replace(/```json\n?|\n?```/g, '').trim();
        const meta = JSON.parse(cleaned);

        if (!meta.name || !meta.goal) return;

        // ── FIX 1b: Re-check name for noise patterns ──
        if (!proceduralMem.isReusableProcedure(commands, meta.name)) {
          api.logger.debug?.(`memoria: procedural skipped — LLM named it noise: "${meta.name}"`);
          return;
        }

        // ── FIX 2: Smart duplicate detection ──
        // Use findSimilarProcedure (word overlap) instead of exact match
        const similar = proceduralMem.findSimilarProcedure(meta.name, meta.goal);

        if (similar) {
          // Reinforce existing procedure
          const totalDuration = recentExecs.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
          proceduralMem.recordExecution(similar.id, true, totalDuration);
          
          // Add improvement if steps changed
          const newSteps = commands.filter(c => !similar.steps.includes(c));
          if (newSteps.length > 0) {
            proceduralMem.addImprovement(
              similar.id,
              `Updated steps: ${newSteps.slice(0, 3).join('; ')}`,
              'Real-time learning from successful execution'
            );
          }

          // ── Reflect: was this the best approach? ──
          // Only reflect every 3rd execution (avoid LLM spam)
          const reflectEvery = cfg.procedural?.reflectEvery ?? 3;
          if (reflectEvery > 0 && (similar.success_count + 1) % reflectEvery === 0) {
            try {
              const errors = recentExecs
                .filter(tc => tc.error)
                .map(tc => tc.error!);
              const reflection = await proceduralMem.reflect(similar.id, {
                durationMs: totalDuration,
                stepsTaken: commands,
                errorsEncountered: errors.length > 0 ? errors : undefined,
              });
              if (reflection?.should_improve) {
                api.logger.info?.(`memoria: procedural 🔍 reflected on "${similar.name}" — ${reflection.suggestions.slice(0, 2).join('; ')}`);
              }
            } catch { /* reflection is non-critical */ }
          }

          api.logger.info?.(`memoria: procedural ✅ reinforced "${similar.name}" (v${similar.version}, ${similar.success_count + 1} successes, quality=${similar.quality.overall})`);
        } else {
          // Create new procedure with full type compliance
          const proc: import("./procedural.js").Procedure = {
            id: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            name: meta.name,
            goal: meta.goal,
            steps: commands,
            version: 1,
            success_count: 1,
            failure_count: 0,
            last_success_at: Date.now(),
            last_updated_at: Date.now(),
            improvements: [],
            quality: {
              speed: 0.5,
              reliability: 0.5,
              elegance: Math.max(0.2, 1 - commands.length * 0.1), // fewer steps = more elegant
              safety: 0.8,
              overall: 0.5,
            },
            context: [...(meta.trigger_patterns || []), ...(meta.gotchas || [])].join(', '),
            gotchas: meta.gotchas?.join(' | '),
            degradation_score: 0,
            preferred: false,
          };

          proceduralMem.storeProcedure(proc);
          api.logger.info?.(`memoria: procedural ✅ NEW "${proc.name}" (${proc.steps.length} steps, real-time)`);

          // Cross-layer: enrich Knowledge Graph with procedure entities
          // "Publish to ClawHub" → entities: ClawHub, Memoria, plugin
          try {
            const procFact = `Procedure "${proc.name}": ${proc.goal}. Steps: ${commands.slice(0, 3).join('; ')}`;
            await graph.extractAndStore(`proc_${proc.id}`, procFact);
            api.logger.debug?.(`memoria: procedural → graph entities extracted for "${proc.name}"`);
          } catch { /* graph enrichment is non-critical */ }
        }

        assembledGoals.add(fingerprint);
        lastAssemblyTime = now;
        
        // Clear old buffer entries (keep last 5 for context)
        toolCallBuffer.splice(0, Math.max(0, toolCallBuffer.length - 5));

      } catch (llmErr) {
        api.logger.debug?.(`memoria: procedural LLM failed: ${String(llmErr)}`);
      }

    } catch (err) {
      // Non-blocking — never crash the plugin
      api.logger.debug?.(`memoria: after_tool_call error: ${String(err)}`);
    }
  });

  // HOOK: agent_end — Capture (Layer 1)
  // ════════════════════════════════════════════════════════════════

  if (cfg.autoCapture) {
    api.on("agent_end", async (event, _ctx) => {
      if (!event.success || !event.messages || event.messages.length === 0) return;

      // Track how many messages continuous already processed
      const continuousAlreadyCaptured = lastContinuousExtraction > 0;

      try {
        // ── Feedback loop: measure if recalled facts were used in responses ──
        try {
          const assistantTexts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const m = msg as Record<string, unknown>;
            if (m.role !== "assistant") continue;
            const c = m.content;
            if (typeof c === "string" && c.length > 10) assistantTexts.push(c);
            else if (Array.isArray(c)) {
              for (const part of c) {
                if (part && typeof part === "object" && (part as any).type === "text") {
                  const t = (part as any).text;
                  if (typeof t === "string" && t.length > 10) assistantTexts.push(t);
                }
              }
            }
          }
          if (assistantTexts.length > 0) {
            const responseText = assistantTexts.slice(-3).join("\n");
            const fb = await feedbackMgr.processResponse(responseText);
            if (fb.used + fb.ignored > 0) {
              api.logger.debug?.(`memoria: feedback — ${fb.used} used, ${fb.ignored} ignored (${fb.details.length} total)`);
            }
          }
        } catch { /* feedback is non-critical */ }

        // Collect user + assistant texts
        const texts: string[] = [];
        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const m = msg as Record<string, unknown>;
          const role = m.role as string;
          if (role !== "user" && role !== "assistant") continue;

          const content = m.content;
          if (typeof content === "string" && content.length > 10) {
            texts.push(content.slice(0, 3000)); // truncate for LLM
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === "object" && (part as any).type === "text") {
                const t = (part as any).text;
                if (typeof t === "string" && t.length > 10) texts.push(t.slice(0, 3000));
              }
            }
          }
        }

        if (texts.length === 0) return;

        // If continuous learning already captured during this session,
        // only extract from messages NOT yet seen (reduce duplicate LLM calls)
        const effectiveTexts = continuousAlreadyCaptured
          ? texts.slice(-1) // Only the very last message (likely not yet captured)
          : texts.slice(-3);

        if (effectiveTexts.length === 0) return;

        // Take last messages (most relevant)
        const recentTexts = effectiveTexts.join("\n---\n");
        const prompt = LLM_EXTRACT_PROMPT
          .replace("{TEXT}", recentTexts)
          .replace("{MAX_FACTS}", String(cfg.captureMaxFacts));

        const result = await extractLlm.generateWithMeta(prompt, {
          maxTokens: 1024,
          temperature: 0.1,
          format: "json",
          timeoutMs: 30000,
        });

        if (!result) {
          api.logger.debug?.("memoria: capture skipped — all LLM providers failed");
          return;
        }

        const parsed = parseJSON(result.response) as { facts?: Array<{ fact: string; category: string; type?: string; confidence: number }> };
        if (!parsed?.facts || parsed.facts.length === 0) return;

        let stored = 0;
        let skipped = 0;
        let enriched = 0;
        let superseded = 0;
        for (const f of parsed.facts) {
          if (!f.fact || f.fact.length < 5) continue;
          if (f.confidence < 0.7) continue;

          const factType = (f.type === "episodic") ? "episodic" : "semantic";

          try {
            const category = normalizeCategory(f.category);
            const relevance = identityParser.calculateRelevance(f.fact, category);
            const result = await selective.processAndApply(
              f.fact,
              category,
              f.confidence,
              cfg.defaultAgent,
              factType,
              relevance
            );
            if (result.stored) {
              if (result.action === "enrich") enriched++;
              else if (result.action === "supersede") superseded++;
              else stored++;
            } else {
              skipped++;
            }
          } catch {
            // Fallback: store directly if selective fails
            const category = normalizeCategory(f.category);
            const relevance = identityParser.calculateRelevance(f.fact, category);
            db.storeFact({
              id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              fact: f.fact,
              category,
              confidence: f.confidence,
              source: "auto-capture",
              tags: "[]",
              agent: cfg.defaultAgent,
              created_at: Date.now(),
              updated_at: Date.now(),
              fact_type: factType,
              relevance_weight: relevance,
            });
            stored++;
          }
        }

        const parts: string[] = [];
        if (stored > 0) parts.push(`${stored} new`);
        if (enriched > 0) parts.push(`${enriched} enriched`);
        if (superseded > 0) parts.push(`${superseded} superseded`);
        if (skipped > 0) parts.push(`${skipped} skipped`);
        if (parts.length > 0) {
          api.logger.info?.(`memoria: capture — ${parts.join(", ")}`);
        }

        // Post-processing: embed + graph + topics + sync
        if (stored > 0 || enriched > 0) {
          await postProcessNewFacts("capture");
        }

        // ── Procedural Memory: extract successful command sequences ──
        try {
          // DEBUG: log what we receive
          const toolCallCount = event.toolCalls?.length || 0;
          const messageCount = event.messages?.length || 0;
          api.logger.info?.(`[DEBUG] agent_end — toolCalls: ${toolCallCount}, messages: ${messageCount}`);

          // Strategy A: Try toolCalls first (if available)
          let proc: any = null;
          if (event.toolCalls && event.toolCalls.length >= 2) {
            api.logger.info?.(`[DEBUG] Trying toolCalls extraction...`);
            const lastMessage = event.messages[event.messages.length - 1];
            const lastText = typeof lastMessage === "object" && (lastMessage as any).content
              ? String((lastMessage as any).content).toLowerCase()
              : "";
            
            const successKeywords = ["success", "done", "published", "deployed", "completed", "✓", "✅"];
            const isSuccess = successKeywords.some(kw => lastText.includes(kw));

            if (isSuccess) {
              proc = await proceduralMem.extractProcedure(
                event.toolCalls as any,
                'success',
                `Session: ${event.agentId || cfg.defaultAgent}`
              );
            }
          }

          // Strategy B: Fallback to parsing messages (more robust)
          if (!proc && event.messages && event.messages.length >= 3) {
            api.logger.info?.(`[DEBUG] Trying message extraction...`);
            proc = await proceduralMem.extractFromMessages(
              event.messages as any,
              `Session: ${event.agentId || cfg.defaultAgent}`
            );
          }

          if (proc) {
            api.logger.info?.(`memoria: procedural ✅ captured "${proc.name}" (${proc.steps.length} steps)`);
          } else {
            api.logger.debug?.(`[DEBUG] No procedure extracted (toolCalls=${toolCallCount}, messages=${messageCount})`);
          }
        } catch (err) { 
          api.logger.warn?.(`[DEBUG] procedural extraction error: ${String(err)}`);
        }

      } catch (err) {
        api.logger.warn?.(`memoria: capture failed: ${String(err)}`);
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // HOOK: after_compaction — Save before loss (Layer 1)
  // ════════════════════════════════════════════════════════════════

  api.on("after_compaction", async (event, _ctx) => {
    // Budget learning: compaction happened → we may have been too aggressive
    try { budget.onCompaction(); } catch { /* non-critical */ }
    const penaltyNote = budget.penalty > 0 ? ` (compaction penalty: -${budget.penalty} facts)` : "";
    if (penaltyNote) api.logger.debug?.(`memoria: budget adjusted${penaltyNote}`);

    try {
      const summary = typeof event.summary === "string" ? event.summary : "";
      if (!summary || summary.length < 50) return;

      const prompt = LLM_EXTRACT_PROMPT
        .replace("{TEXT}", summary.slice(0, 4000))
        .replace("{MAX_FACTS}", String(cfg.captureMaxFacts)); // Same limit as agent_end

      const result = await extractLlm.generateWithMeta(prompt, {
        maxTokens: 1024,
        temperature: 0.1,
        format: "json",
        timeoutMs: 30000,
      });

      if (!result) {
        api.logger.debug?.("memoria: compaction capture skipped — all LLM providers failed");
        return;
      }

      const parsed = parseJSON(result.response) as { facts?: Array<{ fact: string; category: string; type?: string; confidence: number }> };
      if (!parsed?.facts || parsed.facts.length === 0) return;

      let stored = 0;
      let skipped = 0;
      for (const f of parsed.facts) {
        if (!f.fact || f.fact.length < 5 || f.confidence < 0.7) continue;
        const factType = (f.type === "episodic") ? "episodic" : "semantic";
        try {
          const category = normalizeCategory(f.category);
          const relevance = identityParser.calculateRelevance(f.fact, category);
          const result = await selective.processAndApply(
            f.fact, category, f.confidence, cfg.defaultAgent, factType, relevance
          );
          if (result.stored) stored++;
          else skipped++;
        } catch {
          const category = normalizeCategory(f.category);
          const relevance = identityParser.calculateRelevance(f.fact, category);
          db.storeFact({
            id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            fact: f.fact,
            category,
            confidence: f.confidence,
            source: "compaction",
            tags: "[]",
            agent: cfg.defaultAgent,
            created_at: Date.now(),
            updated_at: Date.now(),
            fact_type: factType,
            relevance_weight: relevance,
          });
          stored++;
        }
      }

      if (stored > 0 || skipped > 0) {
        api.logger.info?.(`memoria: compaction — ${stored} stored, ${skipped} skipped (dedup/noise)`);
      }

      // Enrich compaction facts: embed + graph + topics + sync (same as agent_end)
      if (stored > 0) {
        await postProcessNewFacts("compaction");
      }

      // ── Procedural Memory: extract from compaction summary ──
      try {
        // Parse summary as if it were assistant messages
        const fakeMessages = [{ role: 'assistant', content: summary }];
        const proc = await proceduralMem.extractFromMessages(
          fakeMessages as any,
          `Compaction summary: ${event.agentId || cfg.defaultAgent}`
        );
        if (proc) {
          api.logger.info?.(`memoria: procedural ✅ captured from compaction "${proc.name}" (${proc.steps.length} steps)`);
        }
      } catch (err) {
        api.logger.debug?.(`[DEBUG] procedural compaction extraction error: ${String(err)}`);
      }

    } catch (err) {
      api.logger.warn?.(`memoria: compaction capture failed: ${String(err)}`);
    }
  });
}

export default { register };
