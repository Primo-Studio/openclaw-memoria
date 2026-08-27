/**
 * Logique pure de l'import de souvenirs (écran Agents → modale d'import).
 *
 * POURQUOI : le daemon persiste le statut du job d'import et connaît désormais
 * l'état `interrupted` (daemon arrêté — stop, mise à jour, crash — pendant le
 * job). Le polling ne connaissait que done/error : tout autre état laissait le
 * spinner tourner sans fin, et un statut `interrupted` retrouvé au chargement
 * de l'écran n'était jamais montré. « Jamais de mort silencieuse » : ici on
 * décide, sans React, ce que chaque statut doit faire à l'écran.
 */
import type { DetectedAgent, ImportJobStatus } from '../api'

export type Translate = (key: string, vars?: Record<string, string | number>) => string

export type ImportPollOutcome =
  | { kind: 'running'; status: ImportJobStatus }
  | { kind: 'done'; status: ImportJobStatus }
  /** Échec EXPLICITE : étape « failed » + message + bouton pour relancer. */
  | { kind: 'failed'; message: string }

/** Message d'un job qui n'a pas abouti (`error` ou `interrupted`) — jamais vide. */
export function importFailureMessage(status: ImportJobStatus, t: Translate): string {
  if (status.error) return status.error
  return t(status.state === 'interrupted' ? 'agents.import.interrupted' : 'agents.import.unknownError')
}

/** Ce que le polling (1 s) doit faire d'un statut reçu pendant l'étape « running ». */
export function importPollOutcome(status: ImportJobStatus, t: Translate): ImportPollOutcome {
  switch (status.state) {
    case 'running':
      return { kind: 'running', status }
    case 'done':
      return { kind: 'done', status }
    case 'error':
    case 'interrupted':
      return { kind: 'failed', message: importFailureMessage(status, t) }
    case 'idle':
      // Un job ne redevient `idle` que si le daemon a perdu sa trace (statut
      // sur disque illisible…) : on le dit plutôt que de tourner à vide.
      return { kind: 'failed', message: t('agents.import.vanished') }
  }
}

export interface InterruptedImport {
  message: string
  /** Agent détecté dont l'instance correspond au job — null s'il n'est plus sur la machine. */
  agent: DetectedAgent | null
}

/**
 * Au chargement de l'écran : un statut `interrupted` persisté doit s'afficher
 * avec le même message que pendant le polling, et proposer de relancer sur le
 * bon agent (celui dont `already_connected` est l'instance du job).
 */
export function interruptedImport(status: ImportJobStatus, agents: readonly DetectedAgent[] | null, t: Translate): InterruptedImport | null {
  if (status.state !== 'interrupted') return null
  const agent = agents?.find(a => a.already_connected !== null && a.already_connected === status.instance_id) ?? null
  return { message: importFailureMessage(status, t), agent }
}
