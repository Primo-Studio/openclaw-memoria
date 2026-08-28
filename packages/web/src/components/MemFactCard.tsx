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
          <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{children}</div>
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

/** Petite info textuelle dans la ligne de métadonnées (date, confiance…). */
export function MemMetaText({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('text-xs text-muted-foreground tabular-nums', className)} {...props} />
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
