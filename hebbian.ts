/**
 * Hebbian Learning — "Neurons that fire together, wire together"
 * 
 * Human memory strengthens connections between concepts that frequently co-occur.
 * 
 * Example:
 *   - "Bureau" + "Convex" appear together 10 times → strong relation
 *   - "Memoria" + "ClawHub" appear together 3 times → weak relation
 * 
 * Implementation:
 *   - Track entity co-occurrence in facts and graph enrichment
 *   - Boost relation weight when entities co-occur
 *   - Decay weight for unused relations
 */

import type { MemoriaDB } from "./db.js";

export const HEBBIAN_CONFIG = {
  boostAmount: 0.1,        // Increase weight by 0.1 on each co-occurrence
  maxWeight: 2.0,          // Cap weight at 2.0 (very strong)
  decayRate: 0.95,         // Multiply weight by 0.95 if not used recently
  decayThresholdDays: 30,  // Decay relations not used in 30 days
  minWeight: 0.1,          // Minimum weight before pruning
};

export interface RelationStats {
  total: number;
  strong: number;    // weight >= 1.0
  weak: number;      // weight < 0.5
  decayed: number;   // recently decayed
}

export class HebbianManager {
  constructor(private db: MemoriaDB) {}

  /**
   * Reinforce relation between two entities (co-occurrence detected)
   */
  reinforceRelation(fromEntity: string, toEntity: string, relationType: string = "co-occurs"): void {
    const now = Date.now();

    // Check if relation exists
    const existing = this.db.raw.prepare(
      "SELECT * FROM relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?"
    ).get(fromEntity, toEntity, relationType) as { weight: number; updated_at: number } | undefined;

    if (existing) {
      // Boost existing relation (capped at maxWeight)
      const newWeight = Math.min(existing.weight + HEBBIAN_CONFIG.boostAmount, HEBBIAN_CONFIG.maxWeight);
      this.db.raw.prepare(
        "UPDATE relations SET weight = ?, updated_at = ? WHERE from_entity = ? AND to_entity = ? AND relation_type = ?"
      ).run(newWeight, now, fromEntity, toEntity, relationType);
    } else {
      // Create new relation with initial weight
      this.db.raw.prepare(
        "INSERT INTO relations (from_entity, to_entity, relation_type, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(fromEntity, toEntity, relationType, HEBBIAN_CONFIG.boostAmount, now, now);
    }
  }

  /**
   * Decay relations not used recently
   */
  decayStaleRelations(): { decayed: number; pruned: number } {
    const now = Date.now();
    const cutoff = now - HEBBIAN_CONFIG.decayThresholdDays * 24 * 60 * 60 * 1000;

    // Find stale relations
    const stale = this.db.raw.prepare(
      "SELECT from_entity, to_entity, relation_type, weight FROM relations WHERE updated_at < ? AND weight > ?"
    ).all(cutoff, HEBBIAN_CONFIG.minWeight) as Array<{ from_entity: string; to_entity: string; relation_type: string; weight: number }>;

    let decayed = 0;
    let pruned = 0;

    for (const rel of stale) {
      const newWeight = rel.weight * HEBBIAN_CONFIG.decayRate;

      if (newWeight < HEBBIAN_CONFIG.minWeight) {
        // Prune very weak relations
        this.db.raw.prepare(
          "DELETE FROM relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?"
        ).run(rel.from_entity, rel.to_entity, rel.relation_type);
        pruned++;
      } else {
        // Decay weight
        this.db.raw.prepare(
          "UPDATE relations SET weight = ?, updated_at = ? WHERE from_entity = ? AND to_entity = ? AND relation_type = ?"
        ).run(newWeight, now, rel.from_entity, rel.to_entity, rel.relation_type);
        decayed++;
      }
    }

    return { decayed, pruned };
  }

  /**
   * Detect co-occurrences in a fact and reinforce
   */
  reinforceFromFact(factId: string, entities: string[]): void {
    try {
      if (entities.length < 2) return;

      // Reinforce all pairs (N×N-1)/2 relations
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          this.reinforceRelation(entities[i], entities[j], "co-occurs");
          // Bidirectional
          this.reinforceRelation(entities[j], entities[i], "co-occurs");
        }
      }
    } catch (err) {
      console.error("[hebbian] reinforceFromFact failed:", err);
    }
  }

  /**
   * Get stats on relation strengths
   */
  getStats(): RelationStats {
    try {
      const all = this.db.raw.prepare("SELECT weight FROM relations").all() as Array<{ weight: number }>;
      
      const stats: RelationStats = {
        total: all.length,
        strong: 0,
        weak: 0,
        decayed: 0,
      };

      for (const rel of all) {
        if (rel.weight >= 1.0) stats.strong++;
        else if (rel.weight < 0.5) stats.weak++;
      }

      return stats;
    } catch (err) {
      console.error("[hebbian] getStats failed:", err);
      return { total: 0, strong: 0, weak: 0, decayed: 0 };
    }
  }

  /**
   * Get strongest relations for an entity (for contextual recall)
   */
  getStrongestRelations(entity: string, limit = 5): Array<{ to_entity: string; weight: number; relation_type: string }> {
    return this.db.raw.prepare(
      `SELECT to_entity, weight, relation_type FROM relations 
       WHERE from_entity = ? 
       ORDER BY weight DESC 
       LIMIT ?`
    ).all(entity, limit) as Array<{ to_entity: string; weight: number; relation_type: string }>;
  }
}
