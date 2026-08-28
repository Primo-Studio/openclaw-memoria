/**
 * Renvoi CLIQUABLE vers un autre écran.
 *
 * POURQUOI : l'application disait où aller sans y emmener. Le bloc « À
 * vérifier » du tableau de bord se terminait par « …les faits contestés
 * restent actifs (écran Révisions) » en texte brut, et les états vides
 * annonçaient « Connecte d'abord un agent depuis l'onglet Agents » sans
 * bouton. L'utilisateur devait retrouver l'onglet lui-même, dans un groupe
 * « Avancé » de onze entrées.
 *
 * La navigation passe par le hash, exactement comme la barre latérale
 * (App.tsx écoute `hashchange`) : un renvoi n'a donc besoin d'aucun
 * branchement dans la coquille, et le bouton Précédent du navigateur continue
 * de fonctionner.
 */
import { ArrowRight } from 'lucide-react'
import type { ScreenId } from '../app/nav'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

/** Ouvre un écran par son identifiant de route (même mécanisme que la barre latérale). */
export function goToScreen(id: ScreenId): void {
  window.location.hash = '#/' + id
}

/** Lien discret dans un texte (avertissement, phrase d'explication). */
export function MemScreenLink({ screen, label, className }: { screen: ScreenId; label: string; className?: string }) {
  return (
    <Button type="button" variant="link" size="sm" className={cn('h-auto p-0 align-baseline', className)} onClick={() => goToScreen(screen)}>
      {label}
      <ArrowRight aria-hidden="true" />
    </Button>
  )
}

/** Bouton d'un état vide : la seule action qui débloque l'écran. */
export function MemScreenButton({ screen, label }: { screen: ScreenId; label: string }) {
  return (
    <Button type="button" variant="outline" onClick={() => goToScreen(screen)}>
      {label}
      <ArrowRight aria-hidden="true" />
    </Button>
  )
}
