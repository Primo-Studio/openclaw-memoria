/**
 * Bouton « Actualiser » de la barre supérieure — UN seul composant pour les
 * neuf écrans qui rechargent leur contenu.
 *
 * POURQUOI : le même geste avait trois implémentations. Un bouton libellé sur
 * Tableau de bord / Partage / Système / Coffre / Journal, une icône nue sous
 * 640 px sur Revue / Révisions / Maintenance, une troisième variante écrite à
 * la main sur Agents. À 390 px l'utilisateur voyait donc tantôt « Actualiser »,
 * tantôt un carré avec une flèche : impossible d'apprendre « le bouton pour
 * rafraîchir est ici et ressemble à ça ».
 *
 * RÈGLE UNIQUE : le bouton porte un libellé, sauf sur le seul écran qui porte
 * AUSSI un bouton principal dans la même barre. Deux dérogations explicites,
 * et seulement celles-là :
 *  - `shortLabel` : le libellé long ne tient pas à 390 px (« Analyser à
 *    nouveau » → « Analyser ») ;
 *  - `compact` : Agents, où « Actualiser » + « + Connecter » réduisaient le
 *    titre de l'écran à « A… ». Le libellé reste lu par les lecteurs d'écran
 *    (aria-label) et réapparaît dès 640 px.
 */
import { RefreshCw } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

export function MemRefreshButton({
  label,
  shortLabel,
  onClick,
  disabled = false,
  spinning = false,
  compact = false,
}: {
  label: string
  /** Libellé COURT affiché sous 640 px à la place du libellé long (jamais rien). */
  shortLabel?: string
  onClick: () => void
  disabled?: boolean
  /** Rotation de l'icône pendant le rechargement. */
  spinning?: boolean
  /** Icône seule sous 640 px — réservé à l'écran qui a un bouton principal. */
  compact?: boolean
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={disabled} aria-label={label}>
      <RefreshCw className={cn(spinning && 'animate-spin')} aria-hidden="true" />
      {compact ? (
        <span className="hidden sm:inline">{label}</span>
      ) : shortLabel ? (
        <>
          <span className="sm:hidden">{shortLabel}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        <span>{label}</span>
      )}
    </Button>
  )
}
