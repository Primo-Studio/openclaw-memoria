/**
 * Sélecteur d'agent des écrans « cognition » (Thèmes, Récurrences, Procédures)
 * + le hook qui charge la liste des agents analysables.
 *
 * POURQUOI un composant partagé : les trois écrans faisaient chacun le même
 * enchaînement (GET agents → filtrer les analysables → choisir le premier →
 * état « aucun agent »), avec un <select> natif nu dans l'en-tête. Ici, un
 * seul Select shadcn (clavier, lecteur d'écran) projeté dans la barre
 * supérieure via PageHeader, et une seule logique de chargement.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { ApiError, getAgents, type AgentEntry } from '../api'
import { useT } from '../i18n'
import { analyzableAgents } from '../lib/agents'
import { agentTypeLabel, humanError } from './ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export interface AnalyzableAgents {
  agents: AgentEntry[]
  /** Identifiant de l'instance sélectionnée ('' tant que rien n'est chargé). */
  instance: string
  setInstance: (id: string) => void
  /** Liste reçue mais AUCUN agent analysable (ex. seul « Autre agent (MCP) »). */
  noAgent: boolean
  /** Erreur de chargement de la liste (lisible), null sinon. */
  error: string | null
  /** Relance le chargement des agents (et, via `tick`, ce qui en dépend). */
  retry: () => void
  /** Compteur incrémenté à chaque « Réessayer » : à mettre dans les deps des chargements dépendants. */
  tick: number
}

/**
 * Agents analysables + instance courante. Le premier agent est sélectionné
 * d'office ; `noAgent` permet un état vide explicite au lieu d'un spinner
 * sans fin.
 */
export function useAnalyzableAgents(): AnalyzableAgents {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState('')
  const [noAgent, setNoAgent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    getAgents()
      .then(all => {
        if (cancelled) return
        setError(null)
        const real = analyzableAgents(all)
        setAgents(real)
        setNoAgent(real.length === 0)
        // On garde la sélection courante si elle existe encore, sinon le premier.
        setInstance(cur => (real.some(a => a.instance.id === cur) ? cur : (real[0]?.instance.id ?? '')))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.warn('memoria-ui : liste des agents illisible', err)
        setError(err instanceof ApiError ? err.message : humanError(err))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  const retry = useCallback(() => {
    setError(null)
    setTick(n => n + 1)
  }, [])

  return { agents, instance, setInstance, noAgent, error, retry, tick }
}

/** Select shadcn des agents ; masqué tant que la liste est vide. */
export function CogAgentSelect({
  agents,
  value,
  onChange,
  disabled = false,
}: {
  agents: readonly AgentEntry[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const { t } = useT()
  if (agents.length === 0) return null
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      {/* Sous 640 px la barre supérieure est pleine (menu, marque, titre, actions) :
          l'icône disparaît pour laisser le titre de l'écran lisible. */}
      <SelectTrigger size="sm" aria-label={t('cog.agent_select_aria')} className="max-w-32 sm:max-w-40">
        <Bot className="hidden text-muted-foreground sm:block" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {agents.map(a => (
          <SelectItem key={a.instance.id} value={a.instance.id}>
            {agentTypeLabel(a.assistant_type)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
