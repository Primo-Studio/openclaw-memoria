/**
 * 🧠 Memoria — Multi-layer memory plugin for OpenClaw
 * 
 * v3.2.0 — Reasoning models, dated recall, Anthropic provider, adaptive FTS, procedures
 * v3.0.0 — Semantic/Episodic memory, Observations, Procedural memory, Adaptive recall
 * 
 * Layers:
 *   1. Perception (capture) — after_tool_call (real-time) + agent_end + after_compaction hooks
 *   2. Selective Memory — dedup, contradiction, enrichment
 *   3. Embeddings — cosine similarity + hybrid search (FTS5 + cosine + temporal)
 *   4. Knowledge Graph — entity extraction, Hebbian reinforcement, BFS traversal
 *   5. Context Tree — hierarchical fact organization, query-weighted
 *   6. Adaptive Budget — dynamic recall limit based on context usage
 *   7. Sync .md — append new facts to workspace markdown files
 *   8. Topics Émergents — auto-clustering, sub-topics, decay, semantic search
 *   9. .md Vivants — bounded regeneration, archive old facts
 *  10. Fallback Chain — Ollama → OpenAI → LM Studio → FTS-only survival
 * 
 * Hooks:
 *   before_prompt_build → search facts, inject via prependContext
 *   after_tool_call → real-time procedural capture (learn on-the-fly, not end-of-session)
 *   agent_end → extract facts via LLM, store in SQLite + flush remaining procedure buffer
 *   after_compaction → extract durable facts from summaries
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
Analyse le texte et extrais les faits qui méritent d'être retenus à long terme.

TROIS TYPES de faits:
- "semantic" = vérité durable ou PROCESSUS APPRIS (comment faire X, ce qui marche, tricks, patterns)
- "episodic" = événement daté important (déploiement, bug trouvé, milestone atteint)

STOCKER — comme un cerveau humain qui apprend:
✅ Processus appris ("pour migrer SQLite WAL, utiliser VACUUM INTO au lieu de cp")
✅ Ce qui a marché ("le fallback chain a résolu les crashes quand Ollama est off")
✅ Tricks/patterns ("tsx -e ne marche pas avec les imports locaux → utiliser un fichier .ts")
✅ Leçons d'erreurs ("api.config ≠ api.pluginConfig — toutes les configs étaient ignorées")
✅ Décisions techniques ("on utilise Ollama pour l'extraction")
✅ Configurations ("fallback: ollama → lmstudio, zéro cloud")
✅ Architectures ("Memoria utilise SQLite + FTS5 + embeddings")
✅ Préférences utilisateur ("Neto veut du step-by-step")
✅ États durables ("Sol tourne Memoria v2.7.0 en local")
✅ Événements importants avec date ("25/03 — bug api.pluginConfig corrigé")
✅ RÉSULTATS DE TESTS/BENCHMARKS avec chiffres ("Benchmark LongMemEval-S: Retrieval 92% (11/12), RAG 25%, bottleneck = modèle local pas le retrieval")
✅ CONCLUSIONS tirées d'expériences ("GPT-OSS 20B est 4x plus rapide que Qwen 35B mais accuracy 0% → le problème est l'absence de RAG, pas le modèle")
✅ COMPARAISONS mesurées ("AMT retrieval 100% en 291s vs ByteRover 50% en 2297s — AMT plus rapide et plus précis")
✅ CARACTÉRISTIQUES machine/infra ("Mac Mini Sol = 64 Go RAM, Ollama + LM Studio installés")

GÉNÉRALISER — quand un pattern se répète:
🔄 Si le même type de problème arrive 2+ fois → stocker la RÈGLE GÉNÉRALE, pas juste le cas
   Exemple: "npm introuvable en SSH" + "ollama introuvable en SSH" → "Les commandes installées via brew/nvm ne sont pas dans le PATH en SSH non-interactif — utiliser source ~/.zprofile ou le chemin complet"
🔄 Si une commande marche pour un cas → généraliser: "lms server start démarre LM Studio sans GUI" (pas juste "j'ai démarré LM Studio")

NE PAS STOCKER — seulement le jetable:
❌ TODOs sans contexte ("pull X", "faire Y") — SAUF si explique POURQUOI/COMMENT
❌ Confirmations vides ("ok", "merci", "compris", "c'est fait")
❌ Narration sans résultat ("je lis le fichier", "je regarde") — MAIS stocker si un RÉSULTAT suit ("j'ai testé X → résultat Y")
❌ Évidences triviales ("Node.js est installé") sauf si c'était un problème résolu
❌ Statuts binaires sans info ("test passé ✅", "ça marche") — stocker plutôt les CHIFFRES et CONCLUSIONS
❌ MÉTA-FAITS qui parlent DU PROCESSUS de stockage lui-même ("le nouveau fait complète l'info précédente", "ce fait a été ajouté", "la migration vers Memoria inclut des liens") — stocker le CONTENU, pas le commentaire sur le contenu
❌ Faits VAGUES sans nom propre, chiffre, commande ou date concrète ("des informations supplémentaires ont été fournies", "la configuration a été mise à jour") — ÊTRE SPÉCIFIQUE : quel outil, quelle version, quelle commande, quel chiffre ?

PRIORITÉ D'EXTRACTION — ce qui compte le plus:
🥇 Apprentissages = ce qu'on a APPRIS en faisant (conclusions, règles découvertes)
🥈 Résultats mesurés = chiffres, métriques, comparaisons avant/après
🥉 Faits durables = configs, architectures, états des systèmes

QUALITÉ OBLIGATOIRE — chaque fait DOIT respecter ces critères:
⚠️ Contenir au moins UN élément concret: nom propre (Ollama, Sol, Neto), OU chiffre (2.8s, 616 faits), OU commande (clawhub install), OU version (v3.4.1), OU date (26/03)
⚠️ Être AUTONOME = compréhensible par quelqu'un qui lit ce fait seul, sans contexte
⚠️ Ne JAMAIS commencer par "Le nouveau fait..." ou "Ce fait..." ou "L'information..." — commencer par le SUJET réel

Règles:
- Chaque fait = phrase(s) complète(s) et autonome(s) (compréhensible sans contexte)
- Pour les PROCÉDURES (comment faire X): garder les étapes ensemble en UN SEUL fait (2-4 phrases OK)
  Exemple bon: "Pour migrer SQLite WAL: 1) ouvrir en readonly, 2) VACUUM INTO target, 3) fermer. Ne pas utiliser cp car ça perd les données WAL."
  Exemple mauvais: "Étape 1: ouvrir en readonly" (inutile seul)
- UN FAIT PAR ENTITÉ DISTINCTE — si le texte parle de 3 personnes/outils/projets, créer 3 faits séparés
  Exemple bon: "Alexandre gagne 6.50€/h" + "Pierre a quitté l'entreprise, son taux était 7.39€/h"
  Exemple mauvais: "Alexandre et Pierre travaillent chez Primo Studio" (trop vague, mélange les infos)
- Catégories: savoir, erreur, preference, outil, chronologie, rh, client
- type: "semantic" ou "episodic"
- confidence: 0.7 minimum
- Maximum {MAX_FACTS} faits
- Si rien de durable → {"facts": []}

Texte:
"{TEXT}"

JSON valide uniquement:
{"facts": [{"fact": "phrase", "category": "...", "type": "semantic|episodic", "confidence": 0.X}]}`;

// ─── Formatting ───

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
  const lifecycleMgr = new LifecycleManager(db);
  const revisionMgr = new RevisionManager(db, chain);
  const hebbianMgr = new HebbianManager(db);
  const expertiseMgr = new ExpertiseManager(db);
  const proceduralLlm = layerLLM("procedural");
  const proceduralMem = new ProceduralMemory(db.raw, proceduralLlm);
  proceduralMem.ensureSchema(); // migrate quality columns if missing
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
  const lifecycleStats = lifecycleMgr.getStats();

  // Hebbian + Expertise stats
  const hebbianStats = hebbianMgr.getStats();
  const expertiseStats = expertiseMgr.getStats();

  // Procedural memory stats
  const procStats = proceduralMem.getStats();

  const fbStats = feedbackMgr.getStats();
  const fbNote = fbStats.totalWithFeedback > 0 ? `, feedback: ${fbStats.totalWithFeedback} tracked (avg ${fbStats.avgUsefulness.toFixed(1)})` : "";
  const lifecycleNote = ` | lifecycle: ${lifecycleStats.fresh}f/${lifecycleStats.mature}m/${lifecycleStats.aged}a/${lifecycleStats.archived}⚰`;
  const hebbianNote = ` | graph: ${hebbianStats.strong} strong, ${hebbianStats.weak} weak`;
  const expertiseNote = ` | expertise: ${expertiseStats.expert}★★★/${expertiseStats.experienced}★★/${expertiseStats.familiar}★`;
  const procNote = procStats.total > 0 ? ` | procedures: ${procStats.healthy}✓/${procStats.degraded}⚠` : "";
  api.logger.info?.(`memoria: v${pluginVersion} registered (${stats.active} facts, ${cStats.total} clusters, ${oStats.total} observations, ${embCount} embedded, ${gStats.entities} entities, ${gStats.relations} relations, ${tStats.totalTopics} topics${fbNote}${lifecycleNote}${hebbianNote}${expertiseNote}${procNote}, fallback: ${chain.providerNames.join(" → ")})`);
  
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
  // Called by agent_end AND after_compaction to ensure ALL facts get enriched

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
              const graphEntities = kg.findEntitiesInText(prompt);
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
              const status = proc.degradation_score > 0.5 ? "⚠ degraded" 
                : proc.preferred ? "★ preferred" : "✓";
              const qualityStr = `quality: ${(proc.quality.overall * 100).toFixed(0)}%`;
              const versionStr = proc.version > 1 ? ` v${proc.version}` : '';
              const gotchaStr = proc.gotchas ? `\n  ⚠ Gotchas: ${proc.gotchas}` : '';
              procTexts.push(
                `**${proc.name}**${versionStr} ${status} (${(successRate * 100).toFixed(0)}% success, ${qualityStr}):\n` +
                proc.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
                gotchaStr
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
          const allFactsCandidates = [...hotScored, ...topFacts, ...graphFacts, ...topicFacts];
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

        // Cross-layer: track procedure recall for feedback
        // Later, agent_end will check if procedures were actually useful
        if (matchedProcedureIds.length > 0) {
          try { feedbackMgr.recordRecall(matchedProcedureIds, `proc:${prompt}`); } catch { /* non-critical */ }
        }
        try {
          // Update lifecycle state for recalled facts (fresh→mature transition)
          for (const fact of finalFacts) {
            lifecycleMgr.updateLifecycle(fact);
          }
        } catch { /* non-critical */ }

        // Proactive revision: check if any mature facts need refinement (async, non-blocking)
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

        // Check if a similar procedure already exists
        const existing = proceduralMem.search(meta.name, 3);
        const similar = existing.find(p => 
          p.name.toLowerCase() === meta.name.toLowerCase() ||
          p.goal.toLowerCase() === meta.goal.toLowerCase()
        );

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
          if ((similar.success_count + 1) % 3 === 0) {
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
          // Create new procedure
          const proc = {
            id: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            name: meta.name,
            goal: meta.goal,
            steps: commands,
            success_count: 1,
            failure_count: 0,
            last_success_at: Date.now(),
            last_updated_at: Date.now(),
            improvements: [] as any[],
            context: [...(meta.trigger_patterns || []), ...(meta.gotchas || [])].join(', '),
            degradation_score: 0,
          };

          proceduralMem.storeProcedure(proc as any);
          api.logger.info?.(`memoria: procedural ✅ NEW "${proc.name}" (${proc.steps.length} steps, real-time)`);

          // Cross-layer: enrich Knowledge Graph with procedure entities
          // "Publish to ClawHub" → entities: ClawHub, Memoria, plugin
          try {
            const procFact = `Procedure "${proc.name}": ${proc.goal}. Steps: ${commands.slice(0, 3).join('; ')}`;
            await kg.extractAndStore(`proc_${proc.id}`, procFact);
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

        // Take last 3 messages (most relevant)
        const recentTexts = texts.slice(-3).join("\n---\n");
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
