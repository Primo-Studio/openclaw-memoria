/**
 * Chargement des agents ANALYSABLES, partagé par les écrans « cognition »
 * (Thèmes, Récurrences, Procédures).
 *
 * POURQUOI ce hook : les trois écrans faisaient chacun le même enchaînement
 * (GET agents → filtrer les analysables → choisir le premier → état « aucun
 * agent »).
 *
 * Le SÉLECTEUR, lui, n'est plus ici : les six écrans par agent affichent le
 * même `MemAgentPicker` (components/MemAgentSelect) au même endroit et sous le
 * même libellé. Deux composants pour une seule question, c'est exactement ce
 * qui faisait chercher des yeux le contrôle à chaque changement d'onglet.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getAgents, type AgentEntry } from '../api'
import { analyzableAgents } from '../lib/agents'
import { humanError } from './ui'

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
