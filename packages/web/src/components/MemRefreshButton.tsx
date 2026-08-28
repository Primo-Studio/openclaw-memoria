/**
 * Bouton « Actualiser » des barres supérieures : icône + libellé sur bureau,
 * icône seule sous 640 px (le libellé reste lu par les lecteurs d'écran).
 *
 * POURQUOI : la barre supérieure de la coquille fait 390 px sur mobile, moins
 * le menu, la marque et les préférences ; un libellé long (« Erneut
 * analysieren ») y écrasait le titre de l'écran.
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
}: {
  label: string
  /**
   * Libellé COURT affiché sous 640 px à la place de l'icône seule. Sans lui, le
   * comportement historique est conservé (icône seule sur mobile) : les écrans
   * qui n'en passent pas ne changent pas d'un pixel.
   */
  shortLabel?: string
  onClick: () => void
  disabled?: boolean
  /** Rotation de l'icône pendant le rechargement. */
  spinning?: boolean
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={disabled} aria-label={label}>
      <RefreshCw className={cn(spinning && 'animate-spin')} aria-hidden="true" />
      {shortLabel && <span className="sm:hidden">{shortLabel}</span>}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
}
