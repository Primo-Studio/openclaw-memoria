/**
 * Choix d'un agent (Select shadcn) partagé par les écrans « mémoire »
 * (Mémoire, Révisions, Maintenance).
 *
 * POURQUOI un composant : chaque écran listait les agents à sa façon — l'un
 * affichait le type brut (« claude-code »), l'autre l'identifiant de machine
 * en plus du nom. Ici un seul libellé lisible : le nom de marque, complété de
 * l'identifiant de machine SEULEMENT s'il faut distinguer deux agents du même
 * type, et le suffixe « (déconnecté) » quand l'écran garde les agents révoqués.
 */
import { Bot, Layers } from 'lucide-react'
import type { AgentEntry } from '../api'
import { useT } from '../i18n'
import { cn } from '../lib/utils'
import { agentTypeLabel } from './ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/** Valeur spéciale « toutes les mémoires » (recherche globale). */
export const ALL_AGENTS = '__all__'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Libellé d'un agent dans la liste — lisible, et unique parmi `agents`. */
export function agentOptionLabel(entry: AgentEntry, agents: readonly AgentEntry[], t: Translate): string {
  const sameType = agents.filter(a => a.assistant_type === entry.assistant_type).length > 1
  const base = agentTypeLabel(entry.assistant_type)
  const label = sameType ? `${base} — ${entry.instance.machine_id}` : base
  return entry.instance.revoked_at !== null ? label + t('memory.disconnected_suffix') : label
}

export function MemAgentSelect({
  agents,
  value,
  onChange,
  allOption = false,
  disabled = false,
  id,
  ariaLabel,
  className,
}: {
  agents: readonly AgentEntry[]
  value: string
  onChange: (instanceId: string) => void
  /** Ajoute « Toutes les mémoires » (valeur `ALL_AGENTS`) en tête de liste. */
  allOption?: boolean
  disabled?: boolean
  id?: string
  ariaLabel?: string
  className?: string
}) {
  const { t } = useT()
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn('w-full', className)}>
        <SelectValue placeholder={t('memory.field_agent')} />
      </SelectTrigger>
      <SelectContent>
        {allOption && (
          <SelectItem value={ALL_AGENTS}>
            <Layers className="text-muted-foreground" aria-hidden="true" />
            {t('memory.all_memories')}
          </SelectItem>
        )}
        {agents.map(entry => (
          <SelectItem key={entry.instance.id} value={entry.instance.id}>
            <Bot className="text-muted-foreground" aria-hidden="true" />
            {agentOptionLabel(entry, agents, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
