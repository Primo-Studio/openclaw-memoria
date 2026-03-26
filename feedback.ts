/**
 * Memoria — Feedback Loop
 * 
 * Le chaînon manquant : mesurer si les faits rappelés ont été UTILES.
 * 
 * Cycle :
 *   1. Recall injecte N faits → on stocke leurs IDs
 *   2. Agent produit une réponse → on compare
 *   3. Si un fait a contribué à la réponse → usefulness++ 
 *   4. Si un fait est ignoré systématiquement → decay accéléré
 *   5. Le scoring en tient compte au prochain recall
 *
 * "Neurons that fire together wire together" — mais aussi :
 * "Neurons that DON'T fire get pruned"
 */

import type { MemoriaDB, Fact } from "./db.js";

// ─── Config ───

export interface FeedbackConfig {
  /** Minimum keyword overlap (0-1) to consider a fact "used" in response. Default 0.25 */
  usedThreshold: number;
  /** Boost to usefulness when a fact is used. Default 1.0 */
  usedBoost: number;
  /** Penalty when recalled but not used. Default -0.1 */
  ignoredPenalty: number;
  /** After this many ignored recalls, fact gets decay penalty. Default 10 */
  ignoredDecayThreshold: number;
  /** Max usefulness score (cap). Default 20 */
  maxUsefulness: number;
  /** Min usefulness before fact gets deprioritized. Default -3 */
  minUsefulness: number;
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  usedThreshold: 0.25,
  usedBoost: 1.0,
  ignoredPenalty: -0.1,
  ignoredDecayThreshold: 10,
  maxUsefulness: 20,
  minUsefulness: -3,
};

// ─── Session state ───

export interface RecallRecord {
  factIds: string[];
  timestamp: number;
  prompt: string;
}

// ─── Feedback Manager ───

export class FeedbackManager {
  private db: MemoriaDB;
  private cfg: FeedbackConfig;

  /** Facts injected during the current recall (reset each turn) */
  private lastRecall: RecallRecord | null = null;

  constructor(db: MemoriaDB, config?: Partial<FeedbackConfig>) {
    this.cfg = { ...DEFAULT_FEEDBACK_CONFIG, ...config };
    this.db = db;
  }

  /** Called at recall time: record which facts were injected */
  recordRecall(factIds: string[], prompt: string): void {
    this.lastRecall = {
      factIds,
      timestamp: Date.now(),
      prompt,
    };
  }

  /** 
   * Called at agent_end: compare recalled facts with the response.
   * Returns stats about what was used vs ignored.
   */
  async processResponse(responseText: string): Promise<{
    used: number;
    ignored: number;
    details: Array<{ id: string; used: boolean; overlap: number }>;
  }> {
    if (!this.lastRecall || this.lastRecall.factIds.length === 0) {
      return { used: 0, ignored: 0, details: [] };
    }

    const recall = this.lastRecall;
    this.lastRecall = null; // Reset for next turn

    const responseLower = responseText.toLowerCase();
    const responseKeywords = extractKeywords(responseLower);

    const details: Array<{ id: string; used: boolean; overlap: number }> = [];
    let used = 0;
    let ignored = 0;

    for (const factId of recall.factIds) {
      const fact = this.db.getFact(factId);
      if (!fact) continue;

      const overlap = computeOverlap(fact.fact, responseLower, responseKeywords);
      const wasUsed = overlap >= this.cfg.usedThreshold;

      if (wasUsed) {
        used++;
        this.updateUsefulness(factId, this.cfg.usedBoost);
      } else {
        ignored++;
        this.updateUsefulness(factId, this.cfg.ignoredPenalty);
      }

      details.push({ id: factId, used: wasUsed, overlap });
    }

    return { used, ignored, details };
  }

  /** Update usefulness score in DB */
  private updateUsefulness(factId: string, delta: number): void {
    try {
      const raw = this.db.raw;
      
      // Get current values
      const fact = raw.prepare(
        "SELECT usefulness, recall_count, used_count FROM facts WHERE id = ?"
      ).get(factId) as { usefulness: number; recall_count: number; used_count: number } | undefined;

      if (!fact) return;

      const newUsefulness = Math.max(
        this.cfg.minUsefulness,
        Math.min(this.cfg.maxUsefulness, (fact.usefulness || 0) + delta)
      );
      const newRecallCount = (fact.recall_count || 0) + 1;
      const newUsedCount = delta > 0 ? (fact.used_count || 0) + 1 : (fact.used_count || 0);

      raw.prepare(
        "UPDATE facts SET usefulness = ?, recall_count = ?, used_count = ?, last_accessed_at = ? WHERE id = ?"
      ).run(newUsefulness, newRecallCount, newUsedCount, Date.now(), factId);
    } catch {
      // Non-critical — don't crash on feedback failure
    }
  }

  /** Get feedback stats for debugging */
  getStats(): { totalWithFeedback: number; avgUsefulness: number; mostUseful: string[]; leastUseful: string[] } {
    try {
      const raw = this.db.raw;

      const total = raw.prepare(
        "SELECT COUNT(*) as cnt FROM facts WHERE recall_count > 0 AND superseded = 0"
      ).get() as { cnt: number };

      const avg = raw.prepare(
        "SELECT AVG(usefulness) as avg FROM facts WHERE recall_count > 0 AND superseded = 0"
      ).get() as { avg: number | null };

      const best = raw.prepare(
        "SELECT id FROM facts WHERE recall_count > 0 AND superseded = 0 ORDER BY usefulness DESC LIMIT 5"
      ).all() as { id: string }[];

      const worst = raw.prepare(
        "SELECT id FROM facts WHERE recall_count > 0 AND superseded = 0 ORDER BY usefulness ASC LIMIT 5"
      ).all() as { id: string }[];

      return {
        totalWithFeedback: total.cnt,
        avgUsefulness: avg.avg ?? 0,
        mostUseful: best.map(r => r.id),
        leastUseful: worst.map(r => r.id),
      };
    } catch {
      return { totalWithFeedback: 0, avgUsefulness: 0, mostUseful: [], leastUseful: [] };
    }
  }
}

// ─── Helpers ───

/** Extract meaningful keywords from text */
function extractKeywords(text: string): Set<string> {
  return new Set(
    text.replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(w => w.length > 3) // Only words > 3 chars for meaningful overlap
  );
}

/**
 * Compute keyword overlap between a fact and a response.
 * Uses Jaccard-like metric but weighted: longer shared words count more.
 */
function computeOverlap(
  factText: string,
  responseLower: string,
  responseKeywords: Set<string>
): number {
  const factKeywords = extractKeywords(factText.toLowerCase());
  if (factKeywords.size === 0) return 0;

  let matchWeight = 0;
  let totalWeight = 0;

  for (const word of factKeywords) {
    // Weight longer words more (technical terms, proper nouns)
    const weight = Math.min(word.length / 5, 2);
    totalWeight += weight;

    if (responseKeywords.has(word) || responseLower.includes(word)) {
      matchWeight += weight;
    }
  }

  return totalWeight > 0 ? matchWeight / totalWeight : 0;
}
