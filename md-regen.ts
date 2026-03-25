/**
 * md-regen.ts — Phase 9: Living Markdown Files
 *
 * Problem: .md files grow indefinitely → context bloat at OpenClaw boot
 * Solution: Keep them "living" with bounded size:
 *   - Recent facts on top (last 30 days)
 *   - Archive older facts → DB only (with backlink)
 *   - Regenerate .md periodically (not append-only)
 *
 * Strategy:
 *   1. Read all facts from DB (synced_to_md = 1)
 *   2. Partition: recent (30d) vs archive (>30d)
 *   3. For each mapped .md file:
 *      - Write header + recents (reverse chrono)
 *      - Footer: "📦 N archived facts (before DATE) → see memoria.db"
 *   4. Mark all as synced_to_md = 2 (regenerated)
 *
 * Trigger: manual command or cron (weekly)
 */

import type { MemoriaDB, Fact } from "./db.js";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

export interface MdRegenConfig {
  recentDays: number;         // Facts within N days = "recent" (default: 30)
  maxFactsPerFile: number;    // Hard cap per .md file (default: 150)
  archiveNotice: boolean;     // Add archive footer (default: true)
}

const DEFAULT_CONFIG: MdRegenConfig = {
  recentDays: 30,
  maxFactsPerFile: 150,
  archiveNotice: true,
};

// Map: category → .md file path (relative to workspace)
const MD_FILE_MAP: Record<string, string> = {
  savoir: "MEMORY.md",
  outil: "TOOLS.md",
  erreur: "MEMORY.md",          // Erreurs → MEMORY.md section Erreurs
  preference: "USER.md",
  chronologie: "MEMORY.md",     // Chronologie → MEMORY.md section Chronologie
  rh: "COMPANY.md",
  client: "COMPANY.md",
};

// Section headers within files
const SECTION_HEADERS: Record<string, string> = {
  savoir: "## 🧠 Savoir",
  outil: "## 🛠 Outils",
  erreur: "## ❌ Erreurs critiques",
  preference: "## 🎯 Préférences",
  chronologie: "## 📅 Chronologie",
  rh: "## 👥 Ressources Humaines",
  client: "## 🤝 Clients",
};

export class MdRegenManager {
  private db: MemoriaDB;
  private cfg: MdRegenConfig;
  private workspacePath: string;

  constructor(db: MemoriaDB, workspacePath: string, config?: Partial<MdRegenConfig>) {
    this.db = db;
    this.workspacePath = workspacePath;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Regenerate all .md files with recent facts on top, archive notice at bottom.
   * Returns: { files: number; recentFacts: number; archivedFacts: number }
   */
  regenerate(): { files: number; recentFacts: number; archivedFacts: number; errors: string[] } {
    const now = Date.now();
    const recentThreshold = now - (this.cfg.recentDays * 86400000);

    // Get all synced facts
    const allFacts = this.db.raw.prepare(
      "SELECT * FROM facts WHERE superseded = 0 AND synced_to_md > 0 ORDER BY created_at DESC"
    ).all() as Fact[];

    // Partition: recent vs archived
    const recent: Fact[] = [];
    const archived: Fact[] = [];
    for (const f of allFacts) {
      if (f.created_at >= recentThreshold) recent.push(f);
      else archived.push(f);
    }

    // Group by target file
    const fileGroups = new Map<string, Fact[]>();
    for (const f of recent) {
      const targetFile = MD_FILE_MAP[f.category] || "MEMORY.md";
      const existing = fileGroups.get(targetFile) || [];
      existing.push(f);
      fileGroups.set(targetFile, existing);
    }

    // Count archived per file too (for footer notice)
    const archivedCounts = new Map<string, number>();
    for (const f of archived) {
      const targetFile = MD_FILE_MAP[f.category] || "MEMORY.md";
      archivedCounts.set(targetFile, (archivedCounts.get(targetFile) || 0) + 1);
    }

    let filesRegenerated = 0;
    const errors: string[] = [];

    // Regenerate each file
    for (const [relPath, facts] of fileGroups.entries()) {
      const fullPath = join(this.workspacePath, relPath);

      // Safety: don't touch if file doesn't exist
      if (!existsSync(fullPath)) {
        errors.push(`${relPath} not found — skipped`);
        continue;
      }

      try {
        // Read current file to preserve non-Memoria sections
        const original = readFileSync(fullPath, "utf-8");
        const sections = this.parseFileSections(original);

        // Group facts by section (category)
        const factsBySection = new Map<string, Fact[]>();
        for (const f of facts) {
          const section = SECTION_HEADERS[f.category] || "## 🧠 Savoir";
          const existing = factsBySection.get(section) || [];
          existing.push(f);
          factsBySection.set(section, existing);
        }

        // Rebuild file: preserve non-Memoria content + regenerate Memoria sections
        let newContent = "";
        let inMemoriaSection = false;
        const memoriaSectionSet = new Set(Object.values(SECTION_HEADERS));
        const processedSections = new Set<string>();

        for (const line of original.split("\n")) {
          const trimmed = line.trim();

          // Detect section start
          if (trimmed.startsWith("##")) {
            inMemoriaSection = memoriaSectionSet.has(trimmed);

            // If entering a Memoria section, regenerate it
            if (inMemoriaSection) {
              if (!processedSections.has(trimmed)) {
                newContent += this.regenerateSection(trimmed, factsBySection.get(trimmed) || []);
                processedSections.add(trimmed);
              }
              continue; // Skip original section content
            }
          }

          // If in Memoria section, skip old lines (we're regenerating)
          if (inMemoriaSection) continue;

          // Preserve non-Memoria content
          newContent += line + "\n";
        }

        // Append sections that weren't in the original file (new categories)
        for (const [section, sectionFacts] of factsBySection.entries()) {
          if (!processedSections.has(section)) {
            newContent += "\n" + this.regenerateSection(section, sectionFacts);
          }
        }

        // Footer: archive notice
        if (this.cfg.archiveNotice) {
          const archivedCount = archivedCounts.get(relPath) || 0;
          if (archivedCount > 0) {
            const oldestDate = new Date(archived[archived.length - 1].created_at).toISOString().split("T")[0];
            newContent += `\n---\n📦 **${archivedCount} archived facts** (before ${oldestDate}) → stored in \`memoria.db\` only (not shown here to keep context light)\n`;
          }
        }

        // Write
        writeFileSync(fullPath, newContent.trim() + "\n", "utf-8");
        filesRegenerated++;
      } catch (err) {
        errors.push(`${relPath}: ${String(err)}`);
      }
    }

    // Mark all facts as regenerated (synced_to_md = 2)
    this.db.raw.prepare("UPDATE facts SET synced_to_md = 2 WHERE superseded = 0 AND synced_to_md > 0").run();

    return {
      files: filesRegenerated,
      recentFacts: recent.length,
      archivedFacts: archived.length,
      errors,
    };
  }

  /**
   * Parse file into sections (basic heuristic)
   */
  private parseFileSections(content: string): Map<string, string[]> {
    const sections = new Map<string, string[]>();
    let currentSection = "";
    const lines: string[] = [];

    for (const line of content.split("\n")) {
      if (line.trim().startsWith("##")) {
        if (currentSection) sections.set(currentSection, [...lines]);
        currentSection = line.trim();
        lines.length = 0;
      } else {
        lines.push(line);
      }
    }
    if (currentSection) sections.set(currentSection, lines);

    return sections;
  }

  /**
   * Regenerate a single section with facts
   */
  private regenerateSection(header: string, facts: Fact[]): string {
    let section = `${header}\n\n`;

    if (facts.length === 0) {
      section += "_Aucun fait récent._\n\n";
      return section;
    }

    // Limit to maxFactsPerFile (split across all sections proportionally if needed)
    const limited = facts.slice(0, Math.min(facts.length, this.cfg.maxFactsPerFile));

    // Reverse chrono (most recent first)
    limited.sort((a, b) => b.created_at - a.created_at);

    for (const f of limited) {
      const date = new Date(f.created_at).toISOString().split("T")[0];
      const conf = Math.round(f.confidence * 100);
      section += `- **[${date}]** ${f.fact}`;
      if (conf < 100) section += ` _(${conf}%)_`;
      section += "\n";
    }

    section += "\n";
    return section;
  }

  /**
   * Stats: current .md file sizes
   */
  fileSizes(): Record<string, { exists: boolean; lines: number; bytes: number }> {
    const stats: Record<string, { exists: boolean; lines: number; bytes: number }> = {};

    for (const relPath of new Set(Object.values(MD_FILE_MAP))) {
      const fullPath = join(this.workspacePath, relPath);
      if (!existsSync(fullPath)) {
        stats[relPath] = { exists: false, lines: 0, bytes: 0 };
        continue;
      }

      try {
        const content = readFileSync(fullPath, "utf-8");
        stats[relPath] = {
          exists: true,
          lines: content.split("\n").length,
          bytes: content.length,
        };
      } catch {
        stats[relPath] = { exists: false, lines: 0, bytes: 0 };
      }
    }

    return stats;
  }
}
