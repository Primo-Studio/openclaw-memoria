/**
 * Procedural Memory — "how-to" knowledge that improves over time
 * 
 * Like learning a bike trick:
 * - First time: capture basic steps
 * - Retry: refine, optimize
 * - Failure: degradation score rises → find alternative path
 * 
 * Core principles:
 * - Capture successful action sequences
 * - Track success/failure rates
 * - Learn from repetition
 * - Degrade when path stops working
 * - Discover alternative routes
 */

import type { Database } from 'better-sqlite3';
import type { LLMProvider } from './fallback.js';

export interface Procedure {
  id: string;
  name: string;
  goal: string;
  steps: string[]; // ordered array of commands/actions
  success_count: number;
  failure_count: number;
  last_success_at?: number;
  last_failure_at?: number;
  last_updated_at: number;
  avg_duration_ms?: number;
  improvements: ProcedureImprovement[];
  context?: string; // when to use (trigger patterns)
  degradation_score: number; // 0.0-1.0, rises with failures
  alternative_of?: string; // ID of procedure this replaces
}

export interface ProcedureImprovement {
  timestamp: number;
  change: string; // what was improved
  reason: string; // why (e.g., "xattr fix for ClawHub CLI")
}

export interface ProcedureExecution {
  procedure_id: string;
  started_at: number;
  finished_at?: number;
  success: boolean;
  duration_ms?: number;
  notes?: string;
}

export class ProceduralMemory {
  constructor(
    private db: Database,
    private llm: LLMProvider
  ) {}

  /**
   * Extract procedure from successful tool sequence
   */
  async extractProcedure(
    toolCalls: Array<{ tool: string; args: any; result?: any }>,
    outcome: 'success' | 'failure',
    context?: string
  ): Promise<Procedure | null> {
    try {
      // Filter exec/shell tool calls
      const execCalls = toolCalls.filter(tc => 
        tc.tool === 'exec' || tc.tool === 'shell' || tc.tool === 'process'
      );

      if (execCalls.length < 2) return null; // need sequence

      // Extract commands
      const commands = execCalls
        .map(tc => tc.args?.command || tc.args?.cmd)
        .filter(Boolean);

      if (commands.length < 2) return null;

      // Ask LLM to name/describe the procedure
      const prompt = `Analyze this command sequence and extract a reusable procedure.

Commands executed:
${commands.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Outcome: ${outcome}
Context: ${context || 'general task'}

Output JSON (no markdown):
{
  "name": "Short name (e.g., 'Publish plugin to ClawHub')",
  "goal": "What this accomplishes",
  "trigger_patterns": ["when to use", "keywords that suggest this"]
}`;

      const response = await this.llm.generate(prompt);
      const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
      const meta = JSON.parse(cleaned);

      const proc: Procedure = {
        id: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: meta.name,
        goal: meta.goal,
        steps: commands,
        success_count: outcome === 'success' ? 1 : 0,
        failure_count: outcome === 'failure' ? 1 : 0,
        last_success_at: outcome === 'success' ? Date.now() : undefined,
        last_failure_at: outcome === 'failure' ? Date.now() : undefined,
        last_updated_at: Date.now(),
        improvements: [],
        context: meta.trigger_patterns?.join(', '),
        degradation_score: outcome === 'failure' ? 0.1 : 0,
      };

      this.storeProcedure(proc);
      return proc;

    } catch (err) {
      console.error('[ProceduralMemory] extraction failed:', err);
      return null;
    }
  }

  /**
   * Store procedure in DB
   */
  storeProcedure(proc: Procedure): void {
    try {
      this.db.prepare(`
        INSERT INTO procedures (
          id, name, goal, steps, success_count, failure_count,
          last_success_at, last_failure_at, last_updated_at,
          avg_duration_ms, improvements, context, degradation_score, alternative_of
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          last_success_at = excluded.last_success_at,
          last_failure_at = excluded.last_failure_at,
          last_updated_at = excluded.last_updated_at,
          avg_duration_ms = excluded.avg_duration_ms,
          improvements = excluded.improvements,
          degradation_score = excluded.degradation_score
      `).run(
        proc.id,
        proc.name,
        proc.goal,
        JSON.stringify(proc.steps),
        proc.success_count,
        proc.failure_count,
        proc.last_success_at ?? null,
        proc.last_failure_at ?? null,
        proc.last_updated_at,
        proc.avg_duration_ms ?? null,
        JSON.stringify(proc.improvements),
        proc.context ?? null,
        proc.degradation_score,
        proc.alternative_of ?? null
      );
    } catch (err) {
      console.error('[ProceduralMemory] store failed:', err);
    }
  }

  /**
   * Record procedure execution outcome
   */
  recordExecution(
    procedureId: string,
    success: boolean,
    durationMs?: number,
    notes?: string
  ): void {
    try {
      const proc = this.getProcedure(procedureId);
      if (!proc) return;

      const now = Date.now();

      if (success) {
        proc.success_count++;
        proc.last_success_at = now;
        proc.degradation_score = Math.max(0, proc.degradation_score - 0.2); // heal on success
      } else {
        proc.failure_count++;
        proc.last_failure_at = now;
        proc.degradation_score = Math.min(1.0, proc.degradation_score + 0.15); // degrade on failure
      }

      // Update avg duration
      if (durationMs) {
        const totalRuns = proc.success_count + proc.failure_count;
        const prevAvg = proc.avg_duration_ms ?? durationMs;
        proc.avg_duration_ms = Math.round((prevAvg * (totalRuns - 1) + durationMs) / totalRuns);
      }

      proc.last_updated_at = now;
      this.storeProcedure(proc);

    } catch (err) {
      console.error('[ProceduralMemory] recordExecution failed:', err);
    }
  }

  /**
   * Improve procedure (add variant)
   */
  addImprovement(
    procedureId: string,
    change: string,
    reason: string
  ): void {
    try {
      const proc = this.getProcedure(procedureId);
      if (!proc) return;

      proc.improvements.push({
        timestamp: Date.now(),
        change,
        reason,
      });

      proc.last_updated_at = Date.now();
      this.storeProcedure(proc);

    } catch (err) {
      console.error('[ProceduralMemory] addImprovement failed:', err);
    }
  }

  /**
   * Find procedures matching query/goal
   */
  search(query: string, limit = 5): Procedure[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM procedures
        WHERE 
          name LIKE ? OR
          goal LIKE ? OR
          context LIKE ?
        ORDER BY
          degradation_score ASC,
          (success_count * 1.0 / NULLIF(success_count + failure_count, 0)) DESC,
          last_success_at DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];

      return rows.map(this.rowToProcedure);
    } catch (err) {
      console.error('[ProceduralMemory] search failed:', err);
      return [];
    }
  }

  /**
   * Get procedure by ID
   */
  getProcedure(id: string): Procedure | null {
    try {
      const row = this.db.prepare(`SELECT * FROM procedures WHERE id = ?`).get(id) as any;
      return row ? this.rowToProcedure(row) : null;
    } catch (err) {
      console.error('[ProceduralMemory] getProcedure failed:', err);
      return null;
    }
  }

  /**
   * Get all procedures (for stats/export)
   */
  getAllProcedures(): Procedure[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM procedures
        ORDER BY last_updated_at DESC
      `).all() as any[];

      return rows.map(this.rowToProcedure);
    } catch (err) {
      console.error('[ProceduralMemory] getAllProcedures failed:', err);
      return [];
    }
  }

  /**
   * Stats
   */
  getStats() {
    try {
      const total = this.db.prepare(`SELECT COUNT(*) as count FROM procedures`).get() as any;
      const degraded = this.db.prepare(`SELECT COUNT(*) as count FROM procedures WHERE degradation_score > 0.5`).get() as any;
      const healthy = this.db.prepare(`SELECT COUNT(*) as count FROM procedures WHERE degradation_score < 0.3`).get() as any;

      return {
        total: total.count,
        degraded: degraded.count,
        healthy: healthy.count,
      };
    } catch (err) {
      console.error('[ProceduralMemory] getStats failed:', err);
      return { total: 0, degraded: 0, healthy: 0 };
    }
  }

  // Helper: row → Procedure
  private rowToProcedure(row: any): Procedure {
    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      steps: JSON.parse(row.steps || '[]'),
      success_count: row.success_count,
      failure_count: row.failure_count,
      last_success_at: row.last_success_at,
      last_failure_at: row.last_failure_at,
      last_updated_at: row.last_updated_at,
      avg_duration_ms: row.avg_duration_ms,
      improvements: JSON.parse(row.improvements || '[]'),
      context: row.context,
      degradation_score: row.degradation_score,
      alternative_of: row.alternative_of,
    };
  }
}
