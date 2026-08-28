/**
 * Emplacements (« slots ») de la barre supérieure de la coquille.
 *
 * POURQUOI un contexte : le titre et les boutons d'action d'un écran vivent
 * visuellement dans la barre supérieure (propriété de Shell.tsx), mais leur
 * contenu appartient à l'écran. `PageHeader` (components/ui.tsx) les y
 * projette par portail — l'écran garde la main sur ses libellés et ses
 * actions, la coquille garde la main sur la mise en page. Séparé de Shell.tsx
 * pour éviter un cycle d'imports (ui.tsx ← shell-context → rien).
 */
import { createContext, useContext } from 'react'

export interface ShellSlots {
  /** Élément DOM qui reçoit le <h1> de l'écran (null tant que la barre n'est pas montée). */
  titleEl: HTMLElement | null
  /** Élément DOM qui reçoit les actions de l'écran. */
  actionsEl: HTMLElement | null
}

export const ShellSlotsContext = createContext<ShellSlots | null>(null)

/** null hors coquille (écran rendu seul, ex. onboarding) → PageHeader se rend en ligne. */
export function useShellSlots(): ShellSlots | null {
  return useContext(ShellSlotsContext)
}
