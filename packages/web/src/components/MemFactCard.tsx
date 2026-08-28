/**
 * Carte de souvenir — la brique commune des écrans Mémoire, Revue et
 * Maintenance : case de sélection (facultative), texte du souvenir LISIBLE
 * (pleine largeur, retours à la ligne), métadonnées en badges, actions à
 * droite (sous les badges sur mobile).
 *
 * POURQUOI une carte et pas une ligne de tableau : un souvenir est une phrase
 * entière, parfois longue ; tronquée dans une cellule elle devient illisible
 * pour un non-technicien. Les métadonnées sont secondaires — elles vont sous
 * le texte, pas à côté.
 */
import type { ComponentProps, ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Card, CardContent } from './ui/card'
import { Checkbox } from './ui/checkbox'

export function MemFactCard({
  selected = false,
  onSelectedChange,
  selectLabel,
  disabled = false,
  children,
  meta,
  actions,
  className,
}: {
  /** Sélection : la case n'apparaît que si `onSelectedChange` est fourni. */
  selected?: boolean
  onSelectedChange?: (selected: boolean) => void
  /** Libellé accessible de la case (« Sélectionner ce souvenir »). */
  selectLabel?: string
  disabled?: boolean
  /** Le souvenir lui-même (texte, ou zone d'édition). */
  children: ReactNode
  /** Badges et petites infos (agent, thèmes, catégorie, date…). */
  meta?: ReactNode
  /** Boutons d'action (oublier, approuver, corriger…). */
  actions?: ReactNode
  className?: string
}) {
  return (
    <Card size="sm" className={cn('transition-colors', selected && 'bg-primary/5 ring-primary/40', className)}>
      <CardContent className="flex gap-3">
        {onSelectedChange && (
          <Checkbox
            className="mt-1"
            checked={selected}
            disabled={disabled}
            aria-label={selectLabel}
            onCheckedChange={value => onSelectedChange(value === true)}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* POURQUOI le texte du souvenir coche la case : la case fait 16 px,
              sa zone tactile ~32 px — sous les 44 px visés — alors qu'on demande
              justement d'en cocher plusieurs pour fusionner. Le texte, lui, fait
              toute la largeur de la carte. Deux gardes pour ne pas cocher par
              accident : on ignore le clic parti d'un élément interactif (la zone
              d'édition « Corriger », un badge cliquable) et celui qui termine une
              sélection de texte. Le clavier passe par la case, inchangée. */}
          <div
            className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', onSelectedChange && !disabled && 'cursor-pointer')}
            onClick={
              onSelectedChange && !disabled
                ? e => {
                    if ((e.target as HTMLElement).closest('button, a, input, textarea, select, label, [role="button"]')) return
                    if (window.getSelection()?.toString()) return
                    onSelectedChange(!selected)
                  }
                : undefined
            }
          >
            {children}
          </div>
          {(meta || actions) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {meta && <div className="flex min-w-0 flex-wrap items-center gap-1.5">{meta}</div>}
              {/* `sm:ml-auto` seulement : sur mobile les pastilles prennent toute la
                  largeur, les actions passent à la ligne et un `ml-auto` les
                  envoyait flotter seules à l'extrême droite, loin du souvenir
                  auquel elles s'appliquent. `gap-3` éloigne l'action principale
                  du destructif voisin (« Approuver » / « Rejeter »). */}
              {actions && <div className="flex flex-wrap items-center gap-3 sm:ml-auto">{actions}</div>}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Badge cliquable (thème, catégorie → relance une recherche dessus). Un vrai
 * bouton : clavier, lecteur d'écran, et `title` pour dire ce que fait le clic.
 */
export function MemBadgeButton({
  variant = 'outline',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: ComponentProps<typeof Badge>['variant'] }) {
  return (
    <Badge asChild variant={variant} className={cn('cursor-pointer hover:bg-accent hover:text-accent-foreground', className)}>
      <button type="button" {...props} />
    </Badge>
  )
}

/**
 * Petite info textuelle dans la ligne de métadonnées (date, confiance…).
 *
 * POURQUOI pleine largeur sous 640 px : glissée dans le flux des pastilles, la
 * date sautait d'une ligne à l'autre d'une carte à la suivante selon le nombre
 * de thèmes, et les cartes n'avaient plus la même hauteur. Sur sa propre
 * rangée, elle se lit toujours au même endroit ; à partir de 640 px elle
 * reprend sa place à la suite des badges.
 */
export function MemMetaText({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('w-full text-xs text-muted-foreground tabular-nums sm:w-auto', className)} {...props} />
}

/** Sensibilité : rien pour « normal », un badge visible pour sensible / critique. */
export function MemSensitivityBadge({ sensitivity }: { sensitivity: string | undefined }) {
  const { t } = useT()
  if (sensitivity === 'critical') {
    return (
      <Badge variant="destructive">
        <ShieldAlert aria-hidden="true" />
        {t('fact.sensitivity.critical')}
      </Badge>
    )
  }
  if (sensitivity === 'sensitive') {
    return (
      <Badge variant="outline" className="border-transparent bg-warning/15 text-warning">
        <ShieldAlert aria-hidden="true" />
        {t('fact.sensitivity.sensitive')}
      </Badge>
    )
  }
  return null
}
