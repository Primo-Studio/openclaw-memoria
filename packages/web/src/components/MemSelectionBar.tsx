/**
 * Barre d'actions de sélection, COLLANTE sous la barre supérieure : elle
 * suit le défilement pour que « 3 sélectionnés · Oublier » reste visible
 * même quand les cases cochées sont sorties de l'écran.
 *
 * POURQUOI dire le nombre : la sélection nourrit des actions de masse
 * (oublier, fusionner, approuver). L'utilisateur doit toujours voir combien
 * d'éléments vont être touchés, et pouvoir tout décocher d'un clic.
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

export function MemSelectionBar({
  count,
  onClear,
  hint,
  children,
  className,
}: {
  count: number
  onClear: () => void
  /** Explication sous les boutons (ex. règle de fusion) — lisible AVANT de cliquer. */
  hint?: ReactNode
  /** Boutons d'action sur la sélection. */
  children: ReactNode
  className?: string
}) {
  const { t } = useT()
  if (count === 0) return null
  const label = count > 1 ? t('selection.count_plural', { count }) : t('selection.count', { count })
  return (
    <div
      role="region"
      aria-label={label}
      // top-16 = hauteur de la barre supérieure (h-14) + une petite marge.
      className={cn(
        'sticky top-16 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-background/95 px-3 py-2 shadow-md backdrop-blur supports-backdrop-filter:bg-background/85',
        className,
      )}
    >
      <span className="text-sm font-medium tabular-nums">{label}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        <X aria-hidden="true" />
        {t('selection.clear')}
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
      {hint && <p className="basis-full text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
