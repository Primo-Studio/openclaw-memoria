/**
 * Briques partagées du groupe « configuration » (Agents, Onboarding, Réglages,
 * EmbeddingsChooser) construites sur shadcn — locales à ce groupe pour ne pas
 * toucher à ui.tsx pendant la migration. Candidates à remonter dans ui.tsx :
 *  - StatusBadge : badge d'état tonal (prêt / à regarder / absent / erreur) ;
 *  - Chip : option cochable dans une liste courte (radio visuel) ;
 *  - SwitchRow : ligne « titre + explication + interrupteur » ;
 *  - CommandBlock : commande/chemin à copier, qui défile sans casser la page.
 */
import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, TriangleAlert } from 'lucide-react'
import { cn } from '../lib/utils'
import { CopyButton } from './ui'
import { Badge } from './ui/badge'
import { Label } from './ui/label'
import { Switch } from './ui/switch'

export type StatusTone = 'ok' | 'warn' | 'muted' | 'danger'

/**
 * Badge d'état lisible sans la couleur : une icône accompagne toujours la
 * teinte (daltonisme, impression). `ok` = prêt, `warn` = à configurer,
 * `muted` = non détecté / neutre, `danger` = erreur bloquante.
 */
export function StatusBadge({ tone, children, className, icon = true }: { tone: StatusTone; children: ReactNode; className?: string; icon?: boolean }) {
  const toneClass = {
    ok: 'border-success/40 bg-success/10 text-success',
    warn: 'border-warning/40 bg-warning/10 text-warning',
    muted: 'border-border bg-muted text-muted-foreground',
    danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  }[tone]
  const Icon = { ok: CircleCheck, warn: TriangleAlert, muted: CircleDashed, danger: CircleAlert }[tone]
  return (
    <Badge variant="outline" className={cn(toneClass, className)}>
      {icon && <Icon aria-hidden="true" />}
      {children}
    </Badge>
  )
}

/**
 * Option cochable (rôle radio) pour une liste courte — modèles d'un
 * fournisseur, type d'agent… L'état coché est porté par `aria-checked`, le
 * parent pose `role="radiogroup"` + `aria-label`.
 */
export function Chip({
  active,
  onClick,
  disabled = false,
  children,
  className,
  title,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-foreground hover:bg-muted',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Ligne de réglage : titre cliquable, explication, interrupteur à droite. */
export function SwitchRow({
  id,
  title,
  hint,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  id: string
  title: string
  hint?: ReactNode
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id} className="cursor-pointer">
          {title}
        </Label>
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} className="mt-0.5 shrink-0" />
    </div>
  )
}

/**
 * Commande ou chemin à recopier : monospace, passe à la ligne (un
 * non-technicien doit tout voir sans faire défiler ; le bouton Copier prend
 * le texte exact), bouton Copier facultatif à droite (sous le texte sur mobile).
 */
export function CommandBlock({ text, copyLabel, className }: { text: string; copyLabel?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-center', className)}>
      <pre className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">{text}</pre>
      {copyLabel !== undefined && <CopyButton text={text} label={copyLabel} className="shrink-0 self-start sm:self-auto" />}
    </div>
  )
}
