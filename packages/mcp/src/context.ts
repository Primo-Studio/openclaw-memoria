/**
 * ActiveContextTracker — contexte actif du process MCP (spec §5/§11, « hybride »).
 * Priorité : déclaré par l'agent (memoria_set_context) > auto-détection repo (.git).
 * État en mémoire du process : un serveur MCP = un agent = un contexte.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ActiveContext } from '@memoria/core'

export interface SetContextInput {
  project?: string
  client?: string
  org?: string
  repo_path?: string
}

export interface DetectedRepo {
  repo_path: string
  topic: string
}

/**
 * Normalise un identifiant de projet/client/org déclaré en texte libre vers un
 * slug stable : minuscules, sans accents, mots séparés par « - ».
 *
 * Le core compare ces identifiants par ÉGALITÉ STRICTE (passesClientIsolation,
 * boost projet) : Koda configuré avec « Maroway » et Claude qui déclare
 * « maroway » gravaient deux client_org_id différents, et chacun était aveugle
 * aux souvenirs de l'autre. Tant que le daemon ne résout pas les noms contre
 * son registre, ce slug commun est ce qui fait converger les agents.
 * Un UUID (minuscules + tirets) traverse inchangé. Vide → null (= effacer).
 *
 * ⚠ Même fonction dans packages/adapter-openclaw/src/index.ts (le plugin
 * n'a aucune dépendance par conception) — modifier les deux ensemble.
 */
export function normalizeContextId(raw: string): string | null {
  const slug = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || null
}

export class ActiveContextTracker {
  private readonly explicit: ActiveContext = {}
  private readonly detected: ActiveContext = {}

  /**
   * Déclaration explicite par l'agent ; chaîne vide = effacer le champ.
   * Les identifiants sont normalisés (voir normalizeContextId) ; repo_path est
   * un chemin, il reste tel quel.
   */
  set(input: SetContextInput): ActiveContext {
    if (input.project !== undefined) this.explicit.project_id = normalizeContextId(input.project)
    if (input.client !== undefined) this.explicit.client_org_id = normalizeContextId(input.client)
    if (input.org !== undefined) this.explicit.org_id = normalizeContextId(input.org)
    if (input.repo_path !== undefined) this.explicit.repo_path = input.repo_path || null
    return this.current()
  }

  /**
   * Remonte depuis `cwd` jusqu'à un `.git` (dossier OU fichier — les worktrees
   * utilisent un fichier). Le nom du dossier sert d'étiquette projet (topic).
   */
  autoDetect(cwd: string = process.cwd()): DetectedRepo | null {
    let dir = resolve(cwd)
    for (;;) {
      if (existsSync(join(dir, '.git'))) {
        const found: DetectedRepo = { repo_path: dir, topic: basename(dir) }
        this.detected.repo_path = found.repo_path
        this.detected.topic = found.topic
        return found
      }
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  /** Contexte effectif : auto-détection comme socle, valeurs explicites par-dessus. */
  current(): ActiveContext {
    const merged: ActiveContext = { ...this.detected }
    for (const [key, value] of Object.entries(this.explicit) as Array<
      [keyof ActiveContext, string | null | undefined]
    >) {
      if (value !== undefined) merged[key] = value
    }
    return merged
  }
}
