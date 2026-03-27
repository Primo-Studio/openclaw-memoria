/**
 * Lifecycle Manager — Fact evolution like human memory
 * 
 * States:
 *   fresh    → new facts (< 7 days OR < 3 recalls)
 *   mature   → proven useful (3+ uses, no corrections)
 *   aged     → rarely used (> 90 days + low usage ratio)
 *   archived → forgotten (> 180 days + never used OR flagged for deletion)
 * 
 * Transitions happen automatically based on:
 *   - Time since creation
 *   - Recall count vs used count
 *   - Corrections/frustration signals
 */

import type { MemoriaDB, Fact } from "./db.js";

export const LIFECYCLE_CONFIG = {
  // Fresh → Mature
  matureMinRecalls: 3,
  matureMinUsageRatio: 0.4,  // At least 40% of recalls resulted in usage
  matureMinDays: 3,           // Can't become mature instantly

  // Mature → Aged (stale)
  agedMinDays: 90,
  agedMaxUsageRatio: 0.3,     // Used < 30% of recalls

  // Aged → Archived (forgotten)
  archivedMinDays: 180,
  archivedMaxRecalls: 1,      // Almost never recalled

  // Fresh → Aged (direct, if never used)
  freshToAgedDays: 30,
  freshToAgedMaxRecalls: 0,

  // Proactive revision trigger
  revisionRecallThreshold: 10,  // After 10 recalls of a mature fact, consider revision
};

export type LifecycleState = "fresh" | "mature" | "aged" | "archived";

export class LifecycleManager {
  constructor(private db: MemoriaDB) {}

  /**
   * Update lifecycle state for a single fact
   */
  updateLifecycle(fact: Fact, now = Date.now()): LifecycleState {
    const ageDays = (now - fact.created_at) / (1000 * 60 * 60 * 24);
    const recallCount = (fact as any).recall_count ?? 0;
    const usedCount = (fact as any).used_count ?? 0;
    const usageRatio = recallCount > 0 ? usedCount / recallCount : 0;

    let newState: LifecycleState = fact.lifecycle_state || "fresh";

    // Archived (permanent)
    if (
      ageDays > LIFECYCLE_CONFIG.archivedMinDays &&
      recallCount <= LIFECYCLE_CONFIG.archivedMaxRecalls
    ) {
      newState = "archived";
    }
    // Aged (stale but not forgotten)
    else if (
      ageDays > LIFECYCLE_CONFIG.agedMinDays &&
      usageRatio < LIFECYCLE_CONFIG.agedMaxUsageRatio
    ) {
      newState = "aged";
    }
    // Fresh → Aged shortcut (never recalled)
    else if (
      ageDays > LIFECYCLE_CONFIG.freshToAgedDays &&
      recallCount <= LIFECYCLE_CONFIG.freshToAgedMaxRecalls
    ) {
      newState = "aged";
    }
    // Mature (proven useful)
    else if (
      ageDays >= LIFECYCLE_CONFIG.matureMinDays &&
      recallCount >= LIFECYCLE_CONFIG.matureMinRecalls &&
      usageRatio >= LIFECYCLE_CONFIG.matureMinUsageRatio
    ) {
      newState = "mature";
    }
    // Fresh (default)
    else {
      newState = "fresh";
    }

    // Only update DB if state changed
    if (newState !== fact.lifecycle_state) {
      this.db.raw.prepare("UPDATE facts SET lifecycle_state = ? WHERE id = ?").run(newState, fact.id);
    }

    return newState;
  }

  /**
   * Batch update: refresh all active facts' lifecycle states
   */
  refreshAll(): { updated: number; breakdown: Record<LifecycleState, number> } {
    try {
      const facts = this.db.raw.prepare("SELECT * FROM facts WHERE superseded = 0").all() as Fact[];
      const now = Date.now();
      let updated = 0;

      const breakdown: Record<LifecycleState, number> = {
        fresh: 0,
        mature: 0,
        aged: 0,
        archived: 0,
      };

      for (const fact of facts) {
        const oldState = fact.lifecycle_state || "fresh";
        const newState = this.updateLifecycle(fact, now);
        if (oldState !== newState) updated++;
        breakdown[newState]++;
      }

      return { updated, breakdown };
    } catch (err) {
      console.error("[lifecycle] refreshAll failed:", err);
      return { updated: 0, breakdown: { fresh: 0, mature: 0, aged: 0, archived: 0 } };
    }
  }

  /**
   * Check if a mature fact needs proactive revision
   */
  needsRevision(fact: Fact): boolean {
    if (fact.lifecycle_state !== "mature") return false;
    const recallCount = (fact as any).recall_count ?? 0;
    return recallCount >= LIFECYCLE_CONFIG.revisionRecallThreshold;
  }

  /**
   * Get all facts needing revision
   */
  getFactsNeedingRevision(): Fact[] {
    const facts = this.db.raw.prepare(
      `SELECT * FROM facts 
       WHERE superseded = 0 
       AND lifecycle_state = 'mature' 
       AND recall_count >= ?
       ORDER BY recall_count DESC
       LIMIT 5`
    ).all(LIFECYCLE_CONFIG.revisionRecallThreshold) as Fact[];
    return facts;
  }

  /**
   * Archive a fact manually (e.g., after user correction/deletion request)
   */
  archiveFact(factId: string): void {
    this.db.raw.prepare("UPDATE facts SET lifecycle_state = 'archived' WHERE id = ?").run(factId);
  }

  /**
   * Get stats breakdown by lifecycle state
   */
  getStats(): Record<LifecycleState, number> {
    try {
      const rows = this.db.raw.prepare(
        `SELECT lifecycle_state, COUNT(*) as count 
         FROM facts 
         WHERE superseded = 0 
         GROUP BY lifecycle_state`
      ).all() as Array<{ lifecycle_state: LifecycleState; count: number }>;

      const stats: Record<LifecycleState, number> = {
        fresh: 0,
        mature: 0,
        aged: 0,
        archived: 0,
      };

      for (const row of rows) {
        stats[row.lifecycle_state] = row.count;
      }

      return stats;
    } catch (err) {
      console.error("[lifecycle] getStats failed:", err);
      return { fresh: 0, mature: 0, aged: 0, archived: 0 };
    }
  }
}
