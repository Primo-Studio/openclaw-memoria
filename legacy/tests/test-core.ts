/**
 * Memoria Core Tests — validates DB, scoring, selective, clusters
 * Run: npx tsx tests/test-core.ts
 * 
 * These tests use SQLite in-memory and don't require LLM/Ollama.
 */

import { MemoriaDB } from "../db.js";
import { scoreFact, scoreAndRank } from "../scoring.js";
import { AdaptiveBudget } from "../budget.js";
import fs from "fs";
import path from "path";
import os from "os";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

// ─── Setup temp workspace ───
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-test-"));
const memoryDir = path.join(tmpDir, "memory");
fs.mkdirSync(memoryDir, { recursive: true });

console.log("🧪 Memoria Core Tests\n");

// ═══════════════════════════════════════
// TEST 1: Database CRUD
// ═══════════════════════════════════════
console.log("📦 DB Tests:");
const db = new MemoriaDB(tmpDir);

// Store facts
const f1 = db.storeFact({
  id: "test_1", fact: "Sol uses gemma3:4b for extraction",
  category: "outil", confidence: 0.9, source: "test",
  tags: "[]", agent: "koda", created_at: Date.now(), updated_at: Date.now(),
  fact_type: "semantic"
});
assert(f1.id === "test_1", "storeFact returns correct id");

const f2 = db.storeFact({
  id: "test_2", fact: "Alexandre earns 5.19€/h",
  category: "rh", confidence: 0.85, source: "test",
  tags: "[]", agent: "koda", created_at: Date.now(), updated_at: Date.now(),
  fact_type: "semantic"
});

const f3 = db.storeFact({
  id: "test_3", fact: "Alexandre earns 6.50€/h after raise",
  category: "rh", confidence: 0.9, source: "test",
  tags: "[]", agent: "koda", created_at: Date.now(), updated_at: Date.now(),
  fact_type: "semantic"
});

// Get
const got = db.getFact("test_1");
assert(got !== undefined && got.fact.includes("gemma3"), "getFact works");

// Search
const results = db.searchFacts("gemma3", 5);
assert(results.length >= 1, "searchFacts returns results");
assert(results[0].fact.includes("gemma3"), "searchFacts finds correct fact");

// Supersede
db.supersedeFact("test_2", "test_3");
const superseded = db.getFact("test_2");
assert(superseded!.superseded === 1, "supersedeFact marks old fact");
assert(superseded!.superseded_by === "test_3", "supersedeFact links to new fact");

// Active search excludes superseded
const activeResults = db.searchFacts("Alexandre", 5);
assert(activeResults.every(f => f.superseded === 0), "searchFacts excludes superseded");

// Stats
const stats = db.stats();
assert(stats.total === 3, "stats total correct");
assert(stats.active === 2, "stats active excludes superseded");

// Hot facts
db.trackAccess(["test_1", "test_1", "test_1", "test_1", "test_1"]);
const hot = db.hotFacts(5, 30, 5);
assert(hot.length >= 1 && hot[0].id === "test_1", "hotFacts returns frequently accessed");

// Recent facts
const recent = db.recentFacts(1, 10);
assert(recent.length >= 1, "recentFacts returns results");

// ═══════════════════════════════════════
// TEST 2: Scoring
// ═══════════════════════════════════════
console.log("\n📊 Scoring Tests:");

const nowMs = Date.now();
const freshFact = {
  id: "score_1", fact: "Fresh fact", category: "savoir", confidence: 0.9,
  source: "test", tags: "[]", agent: "koda",
  created_at: nowMs - 3600000, updated_at: nowMs - 3600000, // 1 hour ago
  access_count: 0, last_accessed_at: null,
  superseded: 0, superseded_by: null, superseded_at: null,
  md_file: null, md_line: null, entity_ids: "[]", fact_type: "semantic" as const
};

const oldFact = {
  ...freshFact,
  id: "score_2", fact: "Old fact",
  created_at: nowMs - 30 * 24 * 3600000, updated_at: nowMs - 30 * 24 * 3600000, // 30 days ago
};

const errorFact = {
  ...freshFact,
  id: "score_3", fact: "Error fact", category: "erreur",
};

const scored1 = scoreFact(freshFact);
const scored2 = scoreFact(oldFact);
assert(scored1.temporalScore > scored2.temporalScore, "Fresh fact scores higher than old");

const scoredError = scoreFact(errorFact);
assert(scoredError.temporalScore >= scored1.temporalScore * 0.9, "Error facts are immune to decay");

// Episodic decays faster
const episodicFact = { ...oldFact, id: "score_4", fact_type: "episodic" as const };
const scoredEpisodic = scoreFact(episodicFact);
assert(scoredEpisodic.temporalScore < scored2.temporalScore, "Episodic decays faster than semantic");

// Cluster boost
const clusterFact = { ...freshFact, id: "score_5", fact_type: "cluster" as any };
const scoredCluster = scoreFact(clusterFact);
assert(scoredCluster.temporalScore > scored1.temporalScore, "Cluster facts get scoring boost");

// scoreAndRank
const ranked = scoreAndRank([oldFact, freshFact]);
assert(ranked[0].id === "score_1", "scoreAndRank puts fresh first");

// ═══════════════════════════════════════
// TEST 3: Adaptive Budget
// ═══════════════════════════════════════
console.log("\n📐 Budget Tests:");

const budget = new AdaptiveBudget({ contextWindow: 200000, maxFacts: 12, minFacts: 2 });

const light = budget.compute(10000);
assert(light.zone === "light" && light.limit >= 8, "Light context → high fact count");

const heavy = budget.compute(150000);
assert(heavy.zone === "heavy" && heavy.limit <= 4, "Heavy context → low fact count");

const empty = budget.compute(0);
assert(empty.limit >= 10, "Empty context → max facts");

// ═══════════════════════════════════════
// TEST 4: Entity extraction (fact-clusters helpers)
// ═══════════════════════════════════════
console.log("\n🧩 Cluster Entity Tests:");

// Store facts with known entities
db.storeFact({
  id: "ent_1", fact: "Sol runs Ollama with gemma3:4b",
  category: "outil", confidence: 0.9, source: "test",
  tags: "[]", agent: "koda", created_at: Date.now(), updated_at: Date.now(),
  fact_type: "semantic"
});
db.storeFact({
  id: "ent_2", fact: "Sol has nomic-embed-text-v2-moe installed",
  category: "outil", confidence: 0.9, source: "test",
  tags: "[]", agent: "koda", created_at: Date.now(), updated_at: Date.now(),
  fact_type: "semantic"
});
db.storeFact({
  id: "ent_3", fact: "Sol is a Mac Mini available 24/7",
  category: "outil", confidence: 0.9, source: "test",
  tags: "[]", agent: "koda", created_at: Date.now(), updated_at: Date.now(),
  fact_type: "semantic"
});

// Verify the facts are stored and searchable
const solFacts = db.searchFacts("Sol", 10);
assert(solFacts.length >= 3, "Sol facts stored and searchable via FTS");

// Verify cluster type can be stored
db.storeFact({
  id: "cluster_test_1",
  fact: "Sol (Mac Mini): machine dev 24/7, Ollama gemma3:4b + nomic-embed, disponible en permanence",
  category: "outil", confidence: 0.85, source: "cluster:sol",
  tags: JSON.stringify({ memberIds: ["ent_1", "ent_2", "ent_3"], entityName: "Sol", generatedAt: Date.now(), stale: false }),
  agent: "memoria", created_at: Date.now(), updated_at: Date.now(),
  fact_type: "cluster" as any,
});

const clusterSearch = db.searchFacts("Sol Mac Mini", 10);
const hasCluster = clusterSearch.some(f => (f as any).fact_type === "cluster" || f.source?.startsWith("cluster:"));
assert(hasCluster, "Cluster fact searchable via FTS");

// ═══════════════════════════════════════
// TEST 5: DB migration + fact_type column
// ═══════════════════════════════════════
console.log("\n🔄 Migration Tests:");

// fact_type column should exist (added by migration)
const cols = db.raw.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
assert(cols.some(c => c.name === "fact_type"), "fact_type column exists after migration");

// ═══════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════
console.log(`\n${"=".repeat(50)}`);
console.log(`🧪 Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log(`${"=".repeat(50)}`);

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
