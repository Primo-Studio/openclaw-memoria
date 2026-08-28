/**
 * Bloc de commande à copier (Docs) : la commande en monospace, qui se coupe
 * plutôt que de faire déborder la page sous 390 px, et un bouton « Copier »
 * avec retour visuel (CopyButton → toast). Construit localement faute de
 * primitive équivalente dans components/ui.tsx — à y remonter si un autre
 * écran en a besoin (Agents : commande de pairing ; Réglages : synchro).
 */
import { CopyButton } from './ui'
import { cn } from '../lib/utils'

export function AdmCommand({ command, className }: { command: string; className?: string }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3', className)}>
      <pre className="min-w-0 flex-1 self-center font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
        <code>{command}</code>
      </pre>
      <CopyButton text={command} variant="ghost" size="sm" className="shrink-0" />
    </div>
  )
}
