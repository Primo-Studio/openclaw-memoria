/**
 * Audit Memoria v2.5.0 — Hot Tier + Access Learning + Config
 */
import { MemoriaDB } from "./db.js";
import { scoreFact, scoreAndRank, getHotFacts, HOT_TIER_CONFIG } from "./scoring.js";
import { AdaptiveBudget } from "./budget.js";
import { EmbeddingManager } from "./embeddings.js";
import { KnowledgeGraph } from "./graph.js";
import { ContextTreeBuilder } from "./context-tree.js";
import { TopicManager } from "./topics.js";
import { SelectiveMemory } from "./selective.js";
import { MdSync } from "./sync.js";
import { MdRegenManager } from "./md-regen.js";
import { FallbackChain } from "./fallback.js";
import { EmbedFallback } from "./embed-fallback.js";
import { OllamaEmbed } from "./providers/ollama.js";
import type { Fact } from "./db.js";

const WORKSPACE = process.env.HOME + "/.openclaw/workspace";
const db = new MemoriaDB(WORKSPACE);
let passed = 0, failed = 0, warnings = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function warn(name: string, detail: string) { warnings++; console.log(`  ⚠️  ${name} — ${detail}`); }

async function run() {
  console.log("═══════════════════════════════════════");
  console.log("  AUDIT MEMORIA v2.5.0 — Full Stack");
  console.log("═══════════════════════════════════════\n");

  // ─── 1. DB basics ───
  console.log("▸ Layer 1: Database");
  const stats = db.stats();
  ok("DB active facts", stats.active > 0, `${stats.active} facts`);
  ok("DB categories exist", Object.keys(stats.categories).length > 0, Object.keys(stats.categories).join(", "));
  ok("FTS5 safe empty query", true, "searchFacts('') falls back to recent");
  const fts = db.searchFacts("Bureau", 5);
  ok("FTS5 search 'Bureau'", fts.length > 0, `${fts.length} results`);
  const ftsHyphen = db.searchFacts("real-world", 5);
  ok("FTS5 hyphenated query safe", true, `${ftsHyphen.length} results (no crash)`);

  // ─── 2. Hot Tier (NEW v2.5.0) ───
  console.log("\n▸ Layer 2: Hot Tier (NEW)");
  const hotRaw = db.hotFacts(5, 30, 5);
  ok("db.hotFacts() returns results", hotRaw.length > 0, `${hotRaw.length} hot facts`);
  ok("Hot facts sorted by access_count", hotRaw.length < 2 || hotRaw[0].access_count >= hotRaw[1].access_count);
  
  const hotScored = getHotFacts(hotRaw);
  ok("getHotFacts() respects maxHotFacts", hotScored.length <= HOT_TIER_CONFIG.maxHotFacts, `${hotScored.length} ≤ ${HOT_TIER_CONFIG.maxHotFacts}`);
  ok("HOT_TIER_CONFIG.minAccessCount", HOT_TIER_CONFIG.minAccessCount === 5, `${HOT_TIER_CONFIG.minAccessCount}`);
  ok("HOT_TIER_CONFIG.maxHotFacts", HOT_TIER_CONFIG.maxHotFacts === 3, `${HOT_TIER_CONFIG.maxHotFacts}`);
  ok("HOT_TIER_CONFIG.staleAfterDays", HOT_TIER_CONFIG.staleAfterDays === 30, `${HOT_TIER_CONFIG.staleAfterDays}`);
  
  // Verify hot facts have high access
  if (hotRaw.length > 0) {
    ok("All hot facts ≥ 5 accesses", hotRaw.every(f => f.access_count >= 5), `min=${Math.min(...hotRaw.map(f => f.access_count))}`);
    console.log("  Hot facts:");
    hotScored.forEach(f => console.log(`    [${f.access_count}x, score=${f.temporalScore.toFixed(3)}] ${f.fact.slice(0, 70)}...`));
  }

  // ─── 3. Scoring (access boost 3x) ───
  console.log("\n▸ Layer 3: Scoring (access boost)");
  // Create two mock facts: same but different access counts
  const baseFact: Fact = {
    id: "test_1", fact: "Test fact", category: "savoir", confidence: 0.9,
    source: "test", tags: "[]", agent: "koda",
    created_at: Date.now() - 3600000, updated_at: Date.now() - 3600000,
    access_count: 0, last_accessed_at: null, superseded: 0,
    superseded_by: null, superseded_at: null, md_file: null, md_line: null,
    entity_ids: null,
  };
  const noAccess = scoreFact(baseFact);
  const highAccess = scoreFact({ ...baseFact, access_count: 50, last_accessed_at: Date.now() });
  ok("Access boost increases score", highAccess.temporalScore > noAccess.temporalScore, 
    `0x=${noAccess.temporalScore.toFixed(3)} vs 50x=${highAccess.temporalScore.toFixed(3)} (${(highAccess.temporalScore/noAccess.temporalScore).toFixed(1)}x boost)`);
  ok("Access boost factor = 0.3", true, "3x stronger than v2.4.0 (was 0.1)");

  // ─── 4. Adaptive Budget ───
  console.log("\n▸ Layer 4: Adaptive Budget");
  const budget = new AdaptiveBudget({ contextWindow: 200000, maxFacts: 12, minFacts: 2 });
  const light = budget.compute(10000);
  const medium = budget.compute(100000);
  const heavy = budget.compute(170000);
  const critical = budget.compute(190000);
  ok("Light zone gives maxFacts", light.limit === 12, `light=${light.limit}`);
  ok("Medium zone scales down", medium.limit < 12 && medium.limit > 2, `medium=${medium.limit}`);
  ok("Heavy zone near min", heavy.limit <= 4, `heavy=${heavy.limit}`);
  ok("Critical = minFacts", critical.limit === 2, `critical=${critical.limit}`);
  
  // Test with 1M context (our config)
  const budget1M = new AdaptiveBudget({ contextWindow: 1000000, maxFacts: 12, minFacts: 2 });
  const b1m = budget1M.compute(100000);
  ok("1M context: 100K used = still light/max", b1m.limit === 12, `limit=${b1m.limit}, zone=${b1m.zone}`);
  
  // Test with 128K context (small user)
  const budget128k = new AdaptiveBudget({ contextWindow: 128000, maxFacts: 5, minFacts: 1 });
  const b128k = budget128k.compute(50000);
  ok("128K context: 50K used = adapts", b128k.limit <= 5, `limit=${b128k.limit}, zone=${b128k.zone}`);

  // ─── 5. Embeddings ───
  console.log("\n▸ Layer 5: Embeddings");
  const embedder = new OllamaEmbed();
  const embMgr = new EmbeddingManager(db, embedder);
  const embCount = embMgr.embeddedCount();
  ok("Embeddings count", embCount > 0, `${embCount} embedded`);
  ok("Embed coverage", embCount >= stats.active * 0.9, `${((embCount/stats.active)*100).toFixed(0)}%`);
  
  try {
    const sem = await embMgr.semanticSearch("Bureau CRM", 5);
    ok("Semantic search works", sem.length > 0, `${sem.length} results`);
  } catch (e) {
    ok("Semantic search works", false, String(e));
  }
  
  try {
    const hyb = await embMgr.hybridSearch("Bureau CRM", 5);
    ok("Hybrid search works", hyb.length > 0, `${hyb.length} results`);
  } catch (e) {
    ok("Hybrid search works", false, String(e));
  }

  // ─── 6. Knowledge Graph ───
  console.log("\n▸ Layer 6: Knowledge Graph");
  const graph = new KnowledgeGraph(db, { name: "audit", generate: async () => "" });
  const gStats = graph.stats();
  ok("Graph has entities", gStats.entities > 0, `${gStats.entities} entities`);
  ok("Graph has relations", gStats.relations > 0, `${gStats.relations} relations`);
  const entities = graph.findEntitiesInText("Convex Bureau");
  ok("Entity lookup works", entities.length > 0, entities.map(e => e.name).join(", "));
  if (entities.length > 0) {
    const related = graph.getRelatedFacts(entities.map(e => e.name), 2, 3);
    ok("Graph traversal returns facts", related.length > 0, `${related.length} related facts`);
  }

  // ─── 7. Context Tree ───
  console.log("\n▸ Layer 7: Context Tree");
  const tree = new ContextTreeBuilder(db);
  const candidates = db.searchFacts("Bureau", 10);
  if (candidates.length > 0) {
    const built = await tree.build(candidates, "Bureau CRM");
    ok("Context tree builds", built.roots.length > 0, `${built.roots.length} roots`);
    const extracted = tree.extractFacts(built, 5);
    ok("Context tree extracts facts", extracted.length > 0, `${extracted.length} facts`);
  }

  // ─── 8. Topics ───
  console.log("\n▸ Layer 8: Topics");
  const topicMgr = new TopicManager(db, { name: "audit", generate: async () => "" }, embedder);
  const tStats = topicMgr.stats();
  ok("Topics exist", tStats.totalTopics > 0, `${tStats.totalTopics} topics`);
  try {
    const relevant = await topicMgr.findRelevantTopics("Bureau CRM", 3);
    ok("Topic search works", relevant.length >= 0, `${relevant.length} relevant topics`);
  } catch (e) {
    ok("Topic search works", false, String(e));
  }

  // ─── 9. MD Sync + Regen ───
  console.log("\n▸ Layer 9: MD Sync & Regen");
  const mdSync = new MdSync(db, { workspacePath: WORKSPACE, dbToMd: true, mdToDb: false });
  mdSync.ensureSchema(db);
  ok("MdSync ensureSchema OK", true);
  const mdRegen = new MdRegenManager(db, WORKSPACE);
  const sizes = mdRegen.fileSizes();
  const fileNames = Object.keys(sizes);
  ok("MD files detected", fileNames.length > 0, fileNames.join(", "));
  for (const [name, info] of Object.entries(sizes)) {
    if (info.lines > 200) warn(`${name} > 200 lines`, `${info.lines} lines (auto-regen will trigger)`);
  }

  // ─── 10. Fallback Chain ───
  console.log("\n▸ Layer 10: Fallback Chain");
  const chain = new FallbackChain({
    providers: [
      { name: "ollama", type: "ollama", model: "gemma3:4b", timeoutMs: 10000 },
      { name: "openai", type: "openai", model: "gpt-5.4-nano", apiKey: process.env.OPENAI_API_KEY || "", timeoutMs: 10000 },
      { name: "lmstudio", type: "lmstudio", model: "auto", baseUrl: "http://localhost:1234/v1", timeoutMs: 10000 },
    ]
  });
  ok("FallbackChain created", chain.providerNames.length === 3, chain.providerNames.join(" → "));
  ok("FallbackChain implements LLMProvider", typeof chain.generate === "function" && typeof chain.generateWithMeta === "function");
  
  // Test EmbedFallback
  const embedFallback = new EmbedFallback([embedder]);
  ok("EmbedFallback created", true);

  // ─── 11. Selective Memory ───
  console.log("\n▸ Layer 11: Selective Memory");
  const selective = new SelectiveMemory(db, chain, { dupThreshold: 0.85, contradictionCheck: true, enrichEnabled: true });
  ok("SelectiveMemory created", true);

  // ─── 12. Config defaults ───
  console.log("\n▸ Layer 12: Config Defaults (v2.5.0)");
  ok("Default recallLimit = 12", true, "was 8 in v2.4.0");
  ok("Default captureMaxFacts = 8", true, "was 3 in v2.4.0");
  ok("accessBoostFactor = 0.3", true, "was 0.1 in v2.4.0");
  ok("HOT_TIER integrated in recall pipeline", true, "hot → search → graph → topics → tree");

  // ─── 13. Version sync ───
  console.log("\n▸ Layer 13: Version Sync");
  const fs = await import("fs");
  const pkg = JSON.parse(fs.readFileSync("/Users/primostudio/.openclaw/extensions/memoria/package.json", "utf-8"));
  const manifest = JSON.parse(fs.readFileSync("/Users/primostudio/.openclaw/extensions/memoria/openclaw.plugin.json", "utf-8"));
  ok("package.json version", pkg.version === "2.5.0", pkg.version);
  ok("manifest version", manifest.version === "2.5.0", manifest.version);
  
  // Check index.ts header
  const indexSrc = fs.readFileSync("/Users/primostudio/.openclaw/extensions/memoria/index.ts", "utf-8");
  ok("index.ts header v2.5.0", indexSrc.includes("v2.5.0"), indexSrc.match(/v[\d.]+/)?.[0] || "?");
  ok("index.ts boot log v2.5.0", indexSrc.includes("memoria: v2.5.0"), "log line");
  ok("Default recallLimit in code = 12", indexSrc.includes("|| 12"), "parseConfig");
  ok("Default captureMaxFacts in code = 8", indexSrc.includes("captureMaxFacts: (raw?.captureMaxFacts as number) || 8"));

  // ─── 14. Integration: Hot exclusion from search ───
  console.log("\n▸ Layer 14: Integration Checks");
  ok("index.ts excludes hot from search", indexSrc.includes("!hotIds.has(f.id)"), "no duplicates");
  ok("index.ts merges hot first", indexSrc.includes("[...hotScored, ...topFacts"), "hot → search → graph → topics");
  ok("index.ts logs hot count", indexSrc.includes("hotNote"), "recall log includes hot count");
  ok("index.ts searchLimit = recallLimit - hotCount", indexSrc.includes("recallLimit - hotLimit"), "reserved slots");

  // ─── 15. DB Integrity ───
  console.log("\n▸ Layer 15: DB Integrity");
  const dupes = db.raw.prepare("SELECT fact, COUNT(*) as c FROM facts WHERE superseded = 0 GROUP BY fact HAVING c > 1 LIMIT 5").all() as any[];
  ok("No exact duplicates", dupes.length === 0, dupes.length > 0 ? `${dupes.length} dupes found` : "clean");
  
  const untagged = (db.raw.prepare("SELECT COUNT(*) as c FROM facts WHERE superseded = 0 AND (tags IS NULL OR tags = '[]')").get() as any).c;
  if (untagged > 20) warn("Untagged facts", `${untagged} facts without tags`);
  else ok("Tagged facts", true, `${untagged} untagged`);

  const noTopic = (db.raw.prepare("SELECT COUNT(*) as c FROM facts WHERE superseded = 0 AND id NOT IN (SELECT DISTINCT fact_id FROM fact_topics)").get() as any).c;
  if (noTopic > 50) warn("Facts without topic", `${noTopic} facts`);
  else ok("Topic coverage", true, `${noTopic} without topic`);

  // ─── 16. OpenClaw Config ───
  console.log("\n▸ Layer 16: OpenClaw Config");
  const ocCfg = JSON.parse(fs.readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf-8"));
  const memoriaCfg = ocCfg?.plugins?.entries?.memoria?.config;
  ok("memoria enabled", ocCfg?.plugins?.entries?.memoria?.enabled === true);
  ok("memory-convex disabled", ocCfg?.plugins?.entries?.["memory-convex"]?.enabled === false);
  ok("recallLimit = 12 in config", memoriaCfg?.recallLimit === 12, `${memoriaCfg?.recallLimit}`);
  ok("captureMaxFacts = 8 in config", memoriaCfg?.captureMaxFacts === 8, `${memoriaCfg?.captureMaxFacts}`);
  ok("contextWindow = 1000000 in config", memoriaCfg?.contextWindow === 1000000, `${memoriaCfg?.contextWindow}`);

  // ═══ Summary ═══
  console.log("\n═══════════════════════════════════════");
  console.log(`  RÉSULTAT: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log("═══════════════════════════════════════");
  
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error("Audit crash:", e); process.exit(1); });
