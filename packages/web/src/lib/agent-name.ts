/**
 * Nom d'agent affiché — UNE seule chaîne d'identité pour toute l'application.
 *
 * POURQUOI : le même agent portait deux noms. Partage affichait le nom
 * d'instance choisi à la connexion (« Koda ») avec le type en tout petit
 * dessous, pendant que le Tableau de bord, Agents, le Journal et tous les
 * sélecteurs affichaient le type (« OpenClaw »). « Koda » n'apparaissant nulle
 * part ailleurs, rien ne disait à l'utilisateur que ce n'était pas un
 * quatrième agent.
 *
 * Règle unique : « <nom d'instance> (<type>) » quand le nom apporte quelque
 * chose, le type seul sinon — jamais « Claude Code (Claude Code) ».
 *
 * Le nom d'instance ne vit que dans GET /v1/admin/scopes (assistants[]) ;
 * les écrans, eux, manipulent des AgentEntry (GET /v1/admin/agents). D'où ce
 * petit annuaire partagé, mis en cache le temps d'une navigation pour ne pas
 * refaire l'appel à chaque changement d'écran, et qui retombe silencieusement
 * sur le type quand il est illisible : un nom n'est jamais bloquant.
 */
import { useEffect, useState } from 'react'
import { getScopes, type AgentEntry } from '../api'
import { agentTypeLabel } from '../components/ui'

/** Nom affiché à partir du nom d'instance et du type — pur, testable. */
export function agentFullName(displayName: string | null | undefined, type: string): string {
  const brand = agentTypeLabel(type)
  const name = displayName?.trim()
  if (!name || name === brand) return brand
  return `${name} (${brand})`
}

/** Résout le nom affiché d'un agent depuis son entrée de /v1/admin/agents. */
export type AgentNamer = (entry: AgentEntry) => string

/** Repli sans annuaire : le type, jamais un identifiant brut. */
const TYPE_ONLY: AgentNamer = entry => agentTypeLabel(entry.assistant_type)

/** Annuaire assistant_id → nom d'instance, partagé et périmé au bout d'une minute. */
const CACHE_MS = 60_000
let cache: { at: number; names: Promise<Map<string, string>> } | null = null

function assistantNames(): Promise<Map<string, string>> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.names
  const names = getScopes()
    .then(s => new Map(s.assistants.map(a => [a.id, a.display_name])))
    .catch((err: unknown) => {
      // Un nom manquant n'est pas une panne d'écran : on oublie le cache pour
      // réessayer au prochain montage, et on retombe sur le type.
      console.warn('memoria-ui : noms d’agents illisibles', err)
      cache = null
      return new Map<string, string>()
    })
  cache = { at: now, names }
  return names
}

/**
 * Fonction de nommage prête à l'emploi. Rend d'abord le type (aucun écran
 * n'attend l'annuaire pour s'afficher), puis le nom complet dès qu'il arrive.
 */
export function useAgentNamer(): AgentNamer {
  const [namer, setNamer] = useState<AgentNamer>(() => TYPE_ONLY)
  useEffect(() => {
    let cancelled = false
    void assistantNames().then(names => {
      if (cancelled || names.size === 0) return
      setNamer(() => (entry: AgentEntry) => agentFullName(names.get(entry.instance.assistant_id), entry.assistant_type))
    })
    return () => {
      cancelled = true
    }
  }, [])
  return namer
}
