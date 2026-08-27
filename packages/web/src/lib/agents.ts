/**
 * Logique pure sur la liste des agents (GET /v1/admin/agents), partagée par
 * l'onboarding, la coquille App et les écrans par agent.
 *
 * POURQUOI : POST /v1/admin/pair crée une instance AVANT que l'agent n'ait
 * jamais parlé (last_seen_at = null tant que `memoria connect --code` n'a pas
 * tourné). Compter `agents.length > 0` disait donc « un agent est connecté »
 * dès qu'on générait une commande de pairing jamais collée. La connexion
 * 1 clic, elle, termine le pairing en processus → last_seen_at renseigné.
 */
import type { AgentEntry } from '../api'

/** Agent réellement connecté : non révoqué ET vu au moins une fois. */
export function isLiveAgent(entry: AgentEntry): boolean {
  return entry.instance.revoked_at === null && entry.instance.last_seen_at !== null
}

/** Au moins un agent réellement connecté (porte « Terminer » de l'onboarding). */
export function hasLiveAgent(entries: readonly AgentEntry[]): boolean {
  return entries.some(isLiveAgent)
}

/**
 * Agents « réels » pour les écrans d'analyse (thèmes, récurrences, procédures,
 * révisions) : non révoqués et pas « Autre agent (MCP) » — ce type générique
 * n'a pas de mémoire analysable.
 */
export function analyzableAgents(entries: readonly AgentEntry[]): AgentEntry[] {
  return entries.filter(e => e.assistant_type !== 'generic' && e.instance.revoked_at === null)
}
