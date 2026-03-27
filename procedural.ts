/**
 * Procedural Memory — "how-to" knowledge that improves over time
 * 
 * Like a craftsman improving their technique:
 * - First time: capture the basic approach
 * - Each repeat: reflect — was this the best way? faster? more reliable?
 * - Compare alternatives: try method B, keep the better one
 * - Quality drives speed: master the method → execute faster next time
 * 
 * Core principles:
 * 1. Capture successful action sequences in real-time (via after_tool_call)
 * 2. Reflect after each execution — score on multiple dimensions
 * 3. Evolve: improve steps, not just count successes
 * 4. Compare alternatives: same goal, different approaches
 * 5. Quality dimensions: speed, reliability, elegance, safety
 */

import type { Database } from 'better-sqlite3';
import type { LLMProvider } from './fallback.js';

// ─── Quality dimensions ───
// Each procedure is scored on these. Like choosing a recipe:
// fast but sloppy? reliable but slow? the best one wins over time.

export interface QualityProfile {
  speed: number;        // 0-1: how fast (normalized from duration)
  reliability: number;  // 0-1: success_count / total_count
  elegance: number;     // 0-1: fewer steps = more elegant (LLM can adjust)
  safety: number;       // 0-1: no destructive commands, proper error handling
  overall: number;      // weighted composite
}

export interface Procedure {
  id: string;
  name: string;
  goal: string;
  steps: string[];
  // ── Evolution tracking ──
  version: number;                 // increments on each improvement
  evolved_from?: string;           // previous version's ID
  // ── Execution stats ──
  success_count: number;
  failure_count: number;
  last_success_at?: number;
  last_failure_at?: number;
  last_updated_at: number;
  avg_duration_ms?: number;
  best_duration_ms?: number;       // personal best
  // ── Quality ──
  quality: QualityProfile;
  // ── Context ──
  improvements: ProcedureImprovement[];
  context?: string;                // trigger patterns
  gotchas?: string;                // known pitfalls
  // ── Alternatives ──
  degradation_score: number;       // 0-1, rises with failures
  alternative_of?: string;         // ID of procedure this can replace
  preferred?: boolean;             // is this the preferred approach for its goal?
}

export interface ProcedureImprovement {
  timestamp: number;
  change: string;
  reason: string;
  quality_delta?: Partial<QualityProfile>; // how quality changed
}

export interface ReflectionResult {
  should_improve: boolean;
  suggestions: string[];
  quality_assessment: Partial<QualityProfile>;
  better_approach?: string; // "try X instead" suggestion
}

export interface ProceduralConfig {
  /** Weights for computing overall quality score (must sum to ~1.0) */
  qualityWeights: {
    reliability: number;  // default 0.35
    safety: number;       // default 0.25
    speed: number;        // default 0.25
    elegance: number;     // default 0.15
  };
  /** How much degradation increases per failure */
  degradationStep: number;   // default 0.15
  /** How much degradation heals per success */
  healingStep: number;       // default 0.20
  /** Reflect every N executions (0 = never) */
  reflectEvery: number;      // default 3
  /** Degradation threshold to mark as degraded */
  degradedThreshold: number; // default 0.5
  /** Default safety score for new procedures */
  defaultSafety: number;     // default 0.8
}

const DEFAULT_PROCEDURAL_CONFIG: ProceduralConfig = {
  qualityWeights: {
    reliability: 0.35,
    safety: 0.25,
    speed: 0.25,
    elegance: 0.15,
  },
  degradationStep: 0.15,
  healingStep: 0.20,
  reflectEvery: 3,
  degradedThreshold: 0.5,
  defaultSafety: 0.8,
};

export class ProceduralMemory {
  private cfg: ProceduralConfig;

  constructor(
    private db: Database,
    private llm: LLMProvider,
    config?: Partial<ProceduralConfig>
  ) {
    this.cfg = { ...DEFAULT_PROCEDURAL_CONFIG, ...config };
    if (config?.qualityWeights) {
      this.cfg.qualityWeights = { ...DEFAULT_PROCEDURAL_CONFIG.qualityWeights, ...config.qualityWeights };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Migration: add quality columns if missing
  // ═══════════════════════════════════════════════════════

  ensureSchema(): void {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(procedures)`).all() as any[];
      const colNames = new Set(cols.map((c: any) => c.name));

      const migrations: [string, string][] = [
        ['version', 'ALTER TABLE procedures ADD COLUMN version INTEGER DEFAULT 1'],
        ['evolved_from', 'ALTER TABLE procedures ADD COLUMN evolved_from TEXT'],
        ['best_duration_ms', 'ALTER TABLE procedures ADD COLUMN best_duration_ms INTEGER'],
        ['quality_speed', 'ALTER TABLE procedures ADD COLUMN quality_speed REAL DEFAULT 0.5'],
        ['quality_reliability', 'ALTER TABLE procedures ADD COLUMN quality_reliability REAL DEFAULT 0.5'],
        ['quality_elegance', 'ALTER TABLE procedures ADD COLUMN quality_elegance REAL DEFAULT 0.5'],
        ['quality_safety', 'ALTER TABLE procedures ADD COLUMN quality_safety REAL DEFAULT 0.8'],
        ['quality_overall', 'ALTER TABLE procedures ADD COLUMN quality_overall REAL DEFAULT 0.5'],
        ['gotchas', 'ALTER TABLE procedures ADD COLUMN gotchas TEXT'],
        ['preferred', 'ALTER TABLE procedures ADD COLUMN preferred INTEGER DEFAULT 0'],
      ];

      for (const [col, sql] of migrations) {
        if (!colNames.has(col)) {
          this.db.prepare(sql).run();
        }
      }

      // FTS5 virtual table for full-text search on procedures
      try {
        this.db.prepare(`
          CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
            name, goal, context, gotchas, steps,
            content='procedures', content_rowid='rowid'
          )
        `).run();

        // Populate FTS if empty
        const ftsCount = (this.db.prepare(`SELECT COUNT(*) as c FROM procedures_fts`).get() as any)?.c || 0;
        const procCount = (this.db.prepare(`SELECT COUNT(*) as c FROM procedures`).get() as any)?.c || 0;
        if (procCount > 0 && ftsCount === 0) {
          this.rebuildFts();
        }
      } catch {
        // FTS creation can fail if table already exists with different schema — non-critical
      }
    } catch (err) {
      console.error('[ProceduralMemory] schema migration failed:', err);
    }
  }

  /** Rebuild FTS index from procedures table */
  private rebuildFts(): void {
    try {
      this.db.prepare(`DELETE FROM procedures_fts`).run();
      this.db.prepare(`
        INSERT INTO procedures_fts(name, goal, context, gotchas, steps)
        SELECT name, goal, COALESCE(context,''), COALESCE(gotchas,''), steps
        FROM procedures
      `).run();
    } catch {
      // Non-critical — LIKE fallback will work
    }
  }

  // ═══════════════════════════════════════════════════════
  // Extract + Store
  // ═══════════════════════════════════════════════════════

  /**
   * Extract procedure from successful tool sequence
   */
  async extractProcedure(
    toolCalls: Array<{ tool: string; args: any; result?: any }>,
    outcome: 'success' | 'failure',
    context?: string
  ): Promise<Procedure | null> {
    try {
      const execCalls = toolCalls.filter(tc => 
        tc.tool === 'exec' || tc.tool === 'shell' || tc.tool === 'process'
      );
      if (execCalls.length < 2) return null;

      const commands = execCalls
        .map(tc => tc.args?.command || tc.args?.cmd)
        .filter(Boolean);
      if (commands.length < 2) return null;

      const prompt = `Analyze this command sequence and extract a reusable procedure.

Commands executed:
${commands.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n')}

Outcome: ${outcome}
Context: ${context || 'general task'}

Output JSON (no markdown):
{
  "name": "Short name",
  "goal": "What this accomplishes",
  "trigger_patterns": ["when to use"],
  "gotchas": ["pitfalls learned"],
  "quality": {
    "speed": 0.7,
    "reliability": 0.8,
    "elegance": 0.6,
    "safety": 0.9
  }
}`;

      const response = await this.llm.generate(prompt);
      const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
      const meta = JSON.parse(cleaned);

      const quality = this.normalizeQuality(meta.quality);

      const proc: Procedure = {
        id: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: meta.name,
        goal: meta.goal,
        steps: commands,
        version: 1,
        success_count: outcome === 'success' ? 1 : 0,
        failure_count: outcome === 'failure' ? 1 : 0,
        last_success_at: outcome === 'success' ? Date.now() : undefined,
        last_failure_at: outcome === 'failure' ? Date.now() : undefined,
        last_updated_at: Date.now(),
        improvements: [],
        quality,
        context: meta.trigger_patterns?.join(', '),
        gotchas: meta.gotchas?.join(' | '),
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
   * Extract from messages (fallback)
   */
  async extractFromMessages(
    messages: Array<{ role: string; content: any }>,
    context?: string
  ): Promise<Procedure | null> {
    try {
      const commandPatterns = [
        /```(?:bash|sh|shell)?\n([\s\S]+?)\n```/g,
        /`([^`]+(?:clawhub|openclaw|npm|git|curl|cd|mkdir)[^`]+)`/g,
        /(?:^|\n)\$ (.+?)(?:\n|$)/g,
      ];

      const commands: string[] = [];
      let hasSuccess = false;

      for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        const text = typeof msg.content === 'string' 
          ? msg.content : JSON.stringify(msg.content);

        if (/✅|success|published|deployed|completed|done/i.test(text)) hasSuccess = true;

        for (const pattern of commandPatterns) {
          for (const match of [...text.matchAll(pattern)]) {
            const cmd = match[1]?.trim();
            if (cmd && cmd.length > 5 && cmd.length < 500 && !/^(bash|sh|shell|zsh)$/i.test(cmd)) {
              commands.push(cmd);
            }
          }
        }
      }

      if (commands.length < 2 || !hasSuccess) return null;
      const uniqueCommands = commands.filter((cmd, i) => i === 0 || cmd !== commands[i - 1]);
      if (uniqueCommands.length < 2) return null;

      return this.extractProcedure(
        uniqueCommands.map(c => ({ tool: 'exec', args: { command: c } })),
        'success',
        context
      );
    } catch (err) {
      console.error('[ProceduralMemory] extractFromMessages failed:', err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // Reflect — The brain's review mechanism
  // "Was this the best approach?"
  // ═══════════════════════════════════════════════════════

  /**
   * Reflect on a procedure after execution.
   * Like a craftsman looking at what they just built and asking
   * "how can I do this better next time?"
   */
  async reflect(
    procedureId: string,
    executionContext: {
      durationMs?: number;
      stepsTaken: string[];
      errorsEncountered?: string[];
      workaroundsUsed?: string[];
    }
  ): Promise<ReflectionResult | null> {
    try {
      const proc = this.getProcedure(procedureId);
      if (!proc) return null;

      const prompt = `You are reflecting on a procedure you just executed.

Procedure: "${proc.name}"
Goal: ${proc.goal}
Known steps: ${proc.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
Known gotchas: ${proc.gotchas || 'none'}
Current quality: speed=${proc.quality.speed.toFixed(2)}, reliability=${proc.quality.reliability.toFixed(2)}, elegance=${proc.quality.elegance.toFixed(2)}, safety=${proc.quality.safety.toFixed(2)}
Executions: ${proc.success_count} success, ${proc.failure_count} failures
Version: ${proc.version}

This execution:
- Steps actually taken: ${executionContext.stepsTaken.map((s, i) => `${i + 1}. ${s}`).join('\n')}
- Duration: ${executionContext.durationMs ? `${(executionContext.durationMs / 1000).toFixed(1)}s` : 'unknown'}
- Errors: ${executionContext.errorsEncountered?.join(', ') || 'none'}
- Workarounds: ${executionContext.workaroundsUsed?.join(', ') || 'none'}

Reflect: should the procedure be improved? What would be better?
Quality is about: speed (faster), reliability (fewer failures), elegance (fewer/cleaner steps), safety (no destructive ops).
Remember: improving quality leads to speed — a mastered method is faster to execute.

Output JSON (no markdown):
{
  "should_improve": true/false,
  "suggestions": ["concrete improvement"],
  "quality_assessment": { "speed": 0.8, "reliability": 0.9, "elegance": 0.7, "safety": 0.95 },
  "better_approach": "if there's a fundamentally better way, describe it here, else null"
}`;

      const response = await this.llm.generate(prompt);
      const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
      const result = JSON.parse(cleaned);

      // Apply the reflection
      if (result.quality_assessment) {
        const newQuality = this.normalizeQuality(result.quality_assessment);
        // Blend: 70% new assessment, 30% old (accumulated wisdom)
        proc.quality.speed = proc.quality.speed * 0.3 + newQuality.speed * 0.7;
        proc.quality.reliability = proc.quality.reliability * 0.3 + newQuality.reliability * 0.7;
        proc.quality.elegance = proc.quality.elegance * 0.3 + newQuality.elegance * 0.7;
        proc.quality.safety = proc.quality.safety * 0.3 + newQuality.safety * 0.7;
        proc.quality.overall = this.computeOverall(proc.quality);
      }

      if (result.should_improve && result.suggestions?.length > 0) {
        // Evolve the procedure
        proc.version++;
        proc.improvements.push({
          timestamp: Date.now(),
          change: result.suggestions.join('; '),
          reason: 'Post-execution reflection',
          quality_delta: result.quality_assessment,
        });

        // If steps changed significantly, update them
        if (executionContext.stepsTaken.length > 0 && 
            executionContext.stepsTaken.length !== proc.steps.length) {
          proc.steps = executionContext.stepsTaken;
        }

        // Add gotchas from workarounds
        if (executionContext.workaroundsUsed?.length) {
          const newGotchas = executionContext.workaroundsUsed.join(' | ');
          proc.gotchas = proc.gotchas 
            ? `${proc.gotchas} | ${newGotchas}` 
            : newGotchas;
        }
      }

      proc.last_updated_at = Date.now();
      this.storeProcedure(proc);

      return result as ReflectionResult;
    } catch (err) {
      console.error('[ProceduralMemory] reflect failed:', err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // Compare alternatives — same goal, different approaches
  // ═══════════════════════════════════════════════════════

  /**
   * Find alternative procedures for the same goal.
   * Returns them ranked by overall quality.
   */
  getAlternatives(procedureId: string): Procedure[] {
    try {
      const proc = this.getProcedure(procedureId);
      if (!proc) return [];

      // Find procedures with similar goals
      const rows = this.db.prepare(`
        SELECT * FROM procedures
        WHERE id != ? AND (
          goal LIKE ? OR
          name LIKE ? OR
          alternative_of = ? OR
          id = ?
        )
        ORDER BY quality_overall DESC
      `).all(
        procedureId,
        `%${proc.goal.split(' ').slice(0, 3).join('%')}%`,
        `%${proc.name.split(' ').slice(0, 2).join('%')}%`,
        procedureId,
        proc.alternative_of || 'NONE'
      ) as any[];

      return rows.map(r => this.rowToProcedure(r));
    } catch (err) {
      console.error('[ProceduralMemory] getAlternatives failed:', err);
      return [];
    }
  }

  /**
   * Mark one procedure as preferred over another for the same goal.
   */
  setPreferred(procedureId: string): void {
    try {
      const proc = this.getProcedure(procedureId);
      if (!proc) return;

      // Unprefer alternatives
      const alternatives = this.getAlternatives(procedureId);
      for (const alt of alternatives) {
        this.db.prepare(`UPDATE procedures SET preferred = 0 WHERE id = ?`).run(alt.id);
      }

      // Set this one as preferred
      this.db.prepare(`UPDATE procedures SET preferred = 1 WHERE id = ?`).run(procedureId);
    } catch (err) {
      console.error('[ProceduralMemory] setPreferred failed:', err);
    }
  }

  // ═══════════════════════════════════════════════════════
  // CRUD + Search
  // ═══════════════════════════════════════════════════════

  storeProcedure(proc: Procedure): void {
    try {
      this.db.prepare(`
        INSERT INTO procedures (
          id, name, goal, steps, version, evolved_from,
          success_count, failure_count,
          last_success_at, last_failure_at, last_updated_at,
          avg_duration_ms, best_duration_ms,
          quality_speed, quality_reliability, quality_elegance, quality_safety, quality_overall,
          improvements, context, gotchas, degradation_score, alternative_of, preferred
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          goal = excluded.goal,
          steps = excluded.steps,
          version = excluded.version,
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          last_success_at = excluded.last_success_at,
          last_failure_at = excluded.last_failure_at,
          last_updated_at = excluded.last_updated_at,
          avg_duration_ms = excluded.avg_duration_ms,
          best_duration_ms = excluded.best_duration_ms,
          quality_speed = excluded.quality_speed,
          quality_reliability = excluded.quality_reliability,
          quality_elegance = excluded.quality_elegance,
          quality_safety = excluded.quality_safety,
          quality_overall = excluded.quality_overall,
          improvements = excluded.improvements,
          context = excluded.context,
          gotchas = excluded.gotchas,
          degradation_score = excluded.degradation_score,
          preferred = excluded.preferred
      `).run(
        proc.id,
        proc.name,
        proc.goal,
        JSON.stringify(proc.steps),
        proc.version || 1,
        proc.evolved_from ?? null,
        proc.success_count,
        proc.failure_count,
        proc.last_success_at ?? null,
        proc.last_failure_at ?? null,
        proc.last_updated_at,
        proc.avg_duration_ms ?? null,
        proc.best_duration_ms ?? null,
        proc.quality.speed,
        proc.quality.reliability,
        proc.quality.elegance,
        proc.quality.safety,
        proc.quality.overall,
        JSON.stringify(proc.improvements),
        proc.context ?? null,
        proc.gotchas ?? null,
        proc.degradation_score,
        proc.alternative_of ?? null,
        proc.preferred ? 1 : 0
      );

      // Update FTS index
      try {
        const row = this.db.prepare(`SELECT rowid FROM procedures WHERE id = ?`).get(proc.id) as any;
        if (row) {
          // Delete old FTS entry then insert new
          this.db.prepare(`DELETE FROM procedures_fts WHERE rowid = ?`).run(row.rowid);
          this.db.prepare(`
            INSERT INTO procedures_fts(rowid, name, goal, context, gotchas, steps)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            row.rowid,
            proc.name,
            proc.goal,
            proc.context ?? '',
            proc.gotchas ?? '',
            JSON.stringify(proc.steps)
          );
        }
      } catch {
        // FTS sync is non-critical
      }
    } catch (err) {
      console.error('[ProceduralMemory] store failed:', err);
    }
  }

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
        proc.degradation_score = Math.max(0, proc.degradation_score - this.cfg.healingStep);
        const total = proc.success_count + proc.failure_count;
        proc.quality.reliability = proc.success_count / total;
      } else {
        proc.failure_count++;
        proc.last_failure_at = now;
        proc.degradation_score = Math.min(1.0, proc.degradation_score + this.cfg.degradationStep);
        const total = proc.success_count + proc.failure_count;
        proc.quality.reliability = proc.success_count / total;
      }

      // Update duration stats
      if (durationMs) {
        const totalRuns = proc.success_count + proc.failure_count;
        const prevAvg = proc.avg_duration_ms ?? durationMs;
        proc.avg_duration_ms = Math.round((prevAvg * (totalRuns - 1) + durationMs) / totalRuns);
        
        // Track personal best
        if (!proc.best_duration_ms || durationMs < proc.best_duration_ms) {
          proc.best_duration_ms = durationMs;
          // Speed improves when we beat our best
          proc.quality.speed = Math.min(1.0, proc.quality.speed + 0.05);
        }
      }

      proc.quality.overall = this.computeOverall(proc.quality);
      proc.last_updated_at = now;
      this.storeProcedure(proc);

    } catch (err) {
      console.error('[ProceduralMemory] recordExecution failed:', err);
    }
  }

  addImprovement(
    procedureId: string,
    change: string,
    reason: string
  ): void {
    try {
      const proc = this.getProcedure(procedureId);
      if (!proc) return;

      proc.version++;
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

  search(query: string, limit = 5): Procedure[] {
    try {
      // Strategy 1: FTS5 full-text search (fast, ranked)
      let rows: any[] = [];
      try {
        // Sanitize query for FTS5: remove special chars, keep words
        const ftsQuery = query
          .replace(/[^\w\s\-]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2)
          .map(w => `"${w}"`)
          .join(' OR ');

        if (ftsQuery.length > 0) {
          rows = this.db.prepare(`
            SELECT p.*, rank
            FROM procedures p
            JOIN procedures_fts fts ON p.rowid = fts.rowid
            WHERE procedures_fts MATCH ?
            ORDER BY
              p.preferred DESC,
              rank,
              p.quality_overall DESC,
              p.degradation_score ASC
            LIMIT ?
          `).all(ftsQuery, limit) as any[];
        }
      } catch {
        // FTS not available or query syntax error — fall through to LIKE
      }

      // Strategy 2: LIKE fallback (always works, slower)
      if (rows.length === 0) {
        const likeTerm = `%${query}%`;
        rows = this.db.prepare(`
          SELECT * FROM procedures
          WHERE 
            name LIKE ? OR
            goal LIKE ? OR
            context LIKE ? OR
            gotchas LIKE ? OR
            steps LIKE ?
          ORDER BY
            preferred DESC,
            quality_overall DESC,
            degradation_score ASC,
            last_success_at DESC
          LIMIT ?
        `).all(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm, limit) as any[];
      }

      return rows.map(r => this.rowToProcedure(r));
    } catch (err) {
      console.error('[ProceduralMemory] search failed:', err);
      return [];
    }
  }

  getProcedure(id: string): Procedure | null {
    try {
      const row = this.db.prepare(`SELECT * FROM procedures WHERE id = ?`).get(id) as any;
      return row ? this.rowToProcedure(row) : null;
    } catch (err) {
      console.error('[ProceduralMemory] getProcedure failed:', err);
      return null;
    }
  }

  getAllProcedures(): Procedure[] {
    try {
      return (this.db.prepare(`
        SELECT * FROM procedures ORDER BY quality_overall DESC, last_updated_at DESC
      `).all() as any[]).map(r => this.rowToProcedure(r));
    } catch (err) {
      console.error('[ProceduralMemory] getAllProcedures failed:', err);
      return [];
    }
  }

  getStats() {
    try {
      if (!this.db || typeof this.db.prepare !== 'function') {
        return { total: 0, degraded: 0, healthy: 0, avgQuality: 0, preferred: 0 };
      }
      
      const total = (this.db.prepare(`SELECT COUNT(*) as c FROM procedures`).get() as any)?.c || 0;
      const degraded = (this.db.prepare(`SELECT COUNT(*) as c FROM procedures WHERE degradation_score > ?`).get(this.cfg.degradedThreshold) as any)?.c || 0;
      const healthy = (this.db.prepare(`SELECT COUNT(*) as c FROM procedures WHERE degradation_score < ?`).get(this.cfg.degradedThreshold * 0.6) as any)?.c || 0;
      const avgQ = (this.db.prepare(`SELECT AVG(quality_overall) as q FROM procedures`).get() as any)?.q || 0;
      const pref = (this.db.prepare(`SELECT COUNT(*) as c FROM procedures WHERE preferred = 1`).get() as any)?.c || 0;

      return {
        total,
        degraded,
        healthy,
        avgQuality: Math.round(avgQ * 100) / 100,
        preferred: pref,
      };
    } catch (err) {
      console.error('[ProceduralMemory] getStats failed:', err);
      return { total: 0, degraded: 0, healthy: 0, avgQuality: 0, preferred: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Quality helpers
  // ═══════════════════════════════════════════════════════

  private normalizeQuality(raw: any): QualityProfile {
    const speed = Math.max(0, Math.min(1, Number(raw?.speed) || 0.5));
    const reliability = Math.max(0, Math.min(1, Number(raw?.reliability) || 0.5));
    const elegance = Math.max(0, Math.min(1, Number(raw?.elegance) || 0.5));
    const safety = Math.max(0, Math.min(1, Number(raw?.safety) || this.cfg.defaultSafety));
    return {
      speed,
      reliability,
      elegance,
      safety,
      overall: this.computeOverall({ speed, reliability, elegance, safety, overall: 0 }),
    };
  }

  private computeOverall(q: QualityProfile): number {
    const w = this.cfg.qualityWeights;
    return Math.round((
      q.reliability * w.reliability +
      q.safety * w.safety +
      q.speed * w.speed +
      q.elegance * w.elegance
    ) * 100) / 100;
  }

  private rowToProcedure(row: any): Procedure {
    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      steps: JSON.parse(row.steps || '[]'),
      version: row.version || 1,
      evolved_from: row.evolved_from,
      success_count: row.success_count,
      failure_count: row.failure_count,
      last_success_at: row.last_success_at,
      last_failure_at: row.last_failure_at,
      last_updated_at: row.last_updated_at,
      avg_duration_ms: row.avg_duration_ms,
      best_duration_ms: row.best_duration_ms,
      improvements: JSON.parse(row.improvements || '[]'),
      quality: {
        speed: row.quality_speed ?? 0.5,
        reliability: row.quality_reliability ?? 0.5,
        elegance: row.quality_elegance ?? 0.5,
        safety: row.quality_safety ?? 0.8,
        overall: row.quality_overall ?? 0.5,
      },
      context: row.context,
      gotchas: row.gotchas,
      degradation_score: row.degradation_score,
      alternative_of: row.alternative_of,
      preferred: !!row.preferred,
    };
  }
}
