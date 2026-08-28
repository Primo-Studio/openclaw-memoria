/**
 * Noms lisibles des objets techniques (agents, mémoires partagées) — partagé
 * par Partage et Journal.
 *
 * POURQUOI : le daemon ne manipule que des UUID. Le Journal affichait
 * « Agent 29e37881 » et « abcd293e » alors que les MÊMES objets portent un nom
 * ailleurs dans l'app (« Claude Code », « Sur l'utilisateur »). Pour un
 * utilisateur non technicien, l'identifiant n'est pas une information : c'est
 * du bruit sur la colonne la plus répétée de l'écran.
 *
 * Chaîne de résolution d'un acteur du journal :
 *   audit.actor_id  =  instance.id      (core/engine/memoria.ts)
 *   instance.id     →  assistant_id     (GET /v1/admin/agents)
 *   assistant_id    →  display_name     (GET /v1/admin/scopes)
 * Repli à chaque maillon manquant : le type d'agent, puis les 8 premiers
 * caractères de l'identifiant — jamais un nom inventé.
 */
import { useCallback, useEffect, useState } from 'react'
import { getAgents, getScopes, type ScopeAccess } from '../api'
import { agentFullName } from '../lib/agent-name'

export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Annuaire résolu (vide tant que le chargement n'a pas abouti : tout renvoie null). */
export interface Directory {
  /** Nom d'un agent depuis son instance (acteur du journal). */
  agentName: (instanceId: string) => string | null
  /** Libellé d'une mémoire partagée depuis son identifiant. */
  scopeName: (scopeId: string) => string | null
}

const EMPTY: Directory = { agentName: () => null, scopeName: () => null }

/**
 * Libellé d'une mémoire. `agentName` sert aux mémoires privées, dont le nom
 * technique est `private:<instance>` — dans le Journal, l'écrasante majorité
 * des lignes portent ce type de mémoire.
 */
export function scopeLabel(t: Translate, scope: ScopeAccess, agentName?: (instanceId: string) => string | null): string {
  switch (scope.type) {
    case 'user':
      return t('sharing.scope_user')
    case 'org':
      return t('sharing.scope_org')
    case 'client':
      return t('sharing.scope_client', { name: scope.name })
    case 'project':
      return t('sharing.scope_project', { name: scope.name })
    case 'shared_topic':
      return t('sharing.scope_topic', { name: scope.name })
    case 'private': {
      const instance = scope.name.startsWith('private:') ? scope.name.slice('private:'.length) : null
      const agent = instance ? (agentName?.(instance) ?? null) : null
      return agent ? t('sharing.scope_private', { agent }) : t('sharing.scope_private_unknown')
    }
    case 'legacy_to_review':
      return t('sharing.scope_legacy')
    default:
      return scope.name
  }
}

/**
 * Charge l'annuaire (agents + mémoires) en tâche de fond. Un échec n'est PAS
 * une erreur d'écran : l'appelant retombe sur l'identifiant court, l'écran
 * reste utilisable.
 */
export function useDirectory(t: Translate): Directory {
  const [dir, setDir] = useState<Directory>(EMPTY)

  const build = useCallback(async () => {
    const [agents, scopes] = await Promise.all([getAgents(), getScopes()])
    // assistant_id → nom affiché (« Claude Code », « Koda »).
    const names = new Map(scopes.assistants.map(a => [a.id, a.display_name]))
    // instance.id → nom, avec repli sur le type d'agent quand l'assistant a disparu.
    const byInstance = new Map<string, string>()
    for (const a of agents) {
      // Même chaîne d'identité que les sélecteurs et le Tableau de bord.
      byInstance.set(a.instance.id, agentFullName(names.get(a.instance.assistant_id), a.assistant_type))
    }
    const agentName = (instanceId: string) => byInstance.get(instanceId) ?? null
    const byScope = new Map<string, string>()
    for (const s of scopes.scopes) byScope.set(s.id, scopeLabel(t, s, agentName))
    setDir({ agentName, scopeName: (id: string) => byScope.get(id) ?? null })
  }, [t])

  useEffect(() => {
    void build().catch(() => setDir(EMPTY))
  }, [build])

  return dir
}
