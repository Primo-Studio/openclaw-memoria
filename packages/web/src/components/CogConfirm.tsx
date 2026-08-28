/**
 * Bouton à confirmation (AlertDialog) pour les écrans cognition.
 *
 * POURQUOI un composant local : `ConfirmButton` (ui.tsx) ne rend qu'un bouton
 * texte. Ici on a besoin d'une icône devant le libellé, d'une variante
 * « icône seule » (retirer un identifiant dans une puce, avec le libellé en
 * aria-label) et d'un `data-testid` pour piloter les captures. Même contrat
 * sinon : titre = libellé, description facultative, action de confirmation
 * en style destructif, jamais de double-clic armé.
 */
import type { ReactNode } from 'react'
import type { VariantProps } from 'class-variance-authority'
import { useT } from '../i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog'
import { Button, type buttonVariants } from './ui/button'

export function CogConfirmButton({
  label,
  icon,
  iconOnly = false,
  title,
  description,
  confirmLabel,
  onConfirm,
  disabled = false,
  variant = 'outline',
  size = 'sm',
  className,
  testId,
}: {
  /** Libellé du bouton (et aria-label si `iconOnly`). */
  label: string
  icon?: ReactNode
  iconOnly?: boolean
  /** Titre de la boîte (défaut : le libellé du bouton). */
  title?: string
  /** Explication (défaut : « action immédiate, irréversible »). */
  description?: string
  confirmLabel?: string
  onConfirm: () => void
  disabled?: boolean
  variant?: VariantProps<typeof buttonVariants>['variant']
  size?: VariantProps<typeof buttonVariants>['size']
  className?: string
  testId?: string
}) {
  const { t } = useT()
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          disabled={disabled}
          aria-label={iconOnly ? label : undefined}
          data-testid={testId}
        >
          {icon}
          {!iconOnly && label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? label}</AlertDialogTitle>
          <AlertDialogDescription>{description ?? t('confirm.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel ?? t('common.confirm_action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
