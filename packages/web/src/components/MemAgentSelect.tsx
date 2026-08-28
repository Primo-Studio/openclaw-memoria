/**
 * Choix d'un agent (Select shadcn) partagé par les écrans « mémoire »
 * (Mémoire, Révisions, Maintenance).
 *
 * POURQUOI un composant : chaque écran listait les agents à sa façon — l'un
 * affichait le type brut (« claude-code »), l'autre l'identifiant de machine
 * en plus du nom. Ici un seul libellé lisible : le nom affiché de l'agent
 * (lib/agent-name, « Koda (OpenClaw) »), complété de l'identifiant de machine
 * SEULEMENT s'il faut distinguer deux agents du même type, et le suffixe
 * « (déconnecté) » quand l'écran garde les agents révoqués.
 */
import { Bot, Layers } from 'lucide-react'
import type { AgentEntry } from '../api'
import { useT } from '../i18n'
import { cn } from '../lib/utils'
import { useAgentNamer, type AgentNamer } from '../lib/agent-name'
import { MemScreenButton } from './MemScreenLink'
import { EmptyState, agentTypeLabel } from './ui'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/** Valeur spéciale « toutes les mémoires » (recherche globale). */
export const ALL_AGENTS = '__all__'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Libellé d'un agent dans la liste — lisible, et unique parmi `agents`. */
export function agentOptionLabel(entry: AgentEntry, agents: readonly AgentEntry[], t: Translate, nameOf?: AgentNamer): string {
  const sameType = agents.filter(a => a.assistant_type === entry.assistant_type).length > 1
  const base = nameOf ? nameOf(entry) : agentTypeLabel(entry.assistant_type)
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
  const nameOf = useAgentNamer()
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
            {agentOptionLabel(entry, agents, t, nameOf)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * « Choisir un agent » — UN seul emplacement, UN seul libellé, sur les six
 * écrans par agent (Mémoire, Revue de mémoire, Thèmes, Récurrences,
 * Procédures, Révisions).
 *
 * POURQUOI : le même contrôle vivait à trois endroits selon l'onglet — dans la
 * barre supérieure sur Thèmes / Récurrences / Procédures (où, à 390 px, il
 * écrasait le titre de l'écran), dans une carte « Recherche » sur Mémoire et
 * Maintenance, et nu dans la page sous un AUTRE libellé (« Agent analysé »)
 * sur Révisions. Trois emplacements, deux libellés, deux composants pour une
 * seule question.
 *
 * L'emplacement retenu est le corps de page, juste sous la phrase d'intro
 * (children de PageHeader) : c'est le seul qui tient à 390 px sans rogner le
 * titre, et c'est là qu'il était déjà confortable sur Révisions.
 */
export function MemAgentPicker({
  agents,
  value,
  onChange,
  allOption = false,
  disabled = false,
  id = 'screen-agent',
}: {
  agents: readonly AgentEntry[]
  value: string
  onChange: (instanceId: string) => void
  allOption?: boolean
  disabled?: boolean
  id?: string
}) {
  const { t } = useT()
  if (agents.length === 0) return null
  return (
    <div className="mb-4 flex flex-col gap-1.5 sm:max-w-xs">
      <Label htmlFor={id}>{t('memory.field_agent')}</Label>
      <MemAgentSelect id={id} agents={agents} value={value} onChange={onChange} allOption={allOption} disabled={disabled} />
    </div>
  )
}

/**
 * État vide « aucun agent connecté », identique sur les six écrans — avec le
 * bouton qui y remédie : la phrase disait « depuis l'onglet Agents » sans y
 * emmener.
 */
export function MemNoAgentState({ className }: { className?: string }) {
  const { t } = useT()
  return (
    <EmptyState
      icon={<Bot className="size-5" />}
      title={t('memory.no_agent_title')}
      body={t('memory.no_agent_body')}
      action={<MemScreenButton screen="agents" label={t('common.open_screen', { screen: t('nav.agents') })} />}
      className={className}
    />
  )
}
