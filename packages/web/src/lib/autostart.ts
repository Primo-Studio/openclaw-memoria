/**
 * Logique pure de la bascule « Lancer au démarrage » (Réglages → Contrôle).
 *
 * POURQUOI : POST /v1/admin/autostart peut répondre `handover: true` — le
 * daemon va S'ARRÊTER puis être relancé (par launchd en mode `on`, en direct
 * en mode `off`). Pendant quelques secondes la page ne joint plus rien, et le
 * nouveau daemon régénère sa clé d'accès (admin_token) : le token de la page
 * peut donc être périmé au retour. Avant, l'écran affichait une erreur réseau
 * brute comme si la bascule avait échoué. Ici on décide quoi afficher, quel
 * état montrer et quand resonder — sans React, pour pouvoir le tester.
 */
import { ApiError, type AutostartChange, type AutostartStatus, type ControlState } from '../api'

/** Délai avant la première sonde après une passation : arrêt + relance + verrou ≈ 10 s. */
export const HANDOVER_WAIT_MS = 10_000
/** Ensuite on resonde quelques fois : un redémarrage peut prendre plus long que prévu. */
export const HANDOVER_RETRY_EVERY_MS = 2_000
export const HANDOVER_MAX_PROBES = 5

export type HandoverNoteKey = 'settings.control.handoverOn' | 'settings.control.handoverOff'

export type AutostartPlan =
  | { restarting: false; autostart: AutostartStatus }
  | { restarting: true; mode: 'on' | 'off'; noteKey: HandoverNoteKey; autostart: AutostartStatus }

/**
 * Que montrer juste après la réponse du daemon.
 * `requested` = la valeur que l'utilisateur vient de cocher : le statut renvoyé
 * pendant une passation est celui d'AVANT (la CLI détachée n'a pas encore
 * installé/retiré le service), on affiche donc la cible plutôt qu'un
 * retour en arrière de la case pendant 10 s.
 */
export function planAutostartChange(res: AutostartChange, requested: boolean): AutostartPlan {
  if (!res.handover) return { restarting: false, autostart: res.autostart }
  // `mode` absent (daemon antérieur) : on déduit du sens demandé.
  const mode: 'on' | 'off' = res.mode ?? (requested ? 'on' : 'off')
  return {
    restarting: true,
    mode,
    noteKey: mode === 'on' ? 'settings.control.handoverOn' : 'settings.control.handoverOff',
    autostart: { ...res.autostart, installed: mode === 'on' },
  }
}

export type HandoverProbeFailure =
  /** Réseau encore muet : on resonde après HANDOVER_RETRY_EVERY_MS. */
  | { kind: 'retry' }
  /** Le daemon est revenu mais notre clé est périmée : seul « memoria ui » peut rouvrir la page. */
  | { kind: 'token-changed'; noteKey: 'settings.control.handoverTokenChanged' }
  /** Toujours rien après toutes les sondes : on rend la main sans crier. */
  | { kind: 'gave-up'; noteKey: 'settings.control.handoverStillDown' }

/** Suite à donner quand une sonde GET /v1/admin/control échoue (`probe` = numéro de la sonde, 1…n). */
export function afterHandoverProbeFailed(err: unknown, probe: number): HandoverProbeFailure {
  // 401/403 = un daemon RÉPOND mais refuse notre token → il a redémarré avec une nouvelle clé.
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return { kind: 'token-changed', noteKey: 'settings.control.handoverTokenChanged' }
  }
  if (probe >= HANDOVER_MAX_PROBES) return { kind: 'gave-up', noteKey: 'settings.control.handoverStillDown' }
  return { kind: 'retry' }
}

export type SupervisorNoteKey = 'settings.control.supervisedLaunchd' | 'settings.control.supervisedDirect'

/** « Supervisé par launchd » / « Lancé en direct » — null si le daemon ne dit rien (version antérieure). */
export function supervisorNoteKey(state: Pick<ControlState, 'supervisor'>): SupervisorNoteKey | null {
  if (state.supervisor === undefined) return null
  return state.supervisor === 'launchd' ? 'settings.control.supervisedLaunchd' : 'settings.control.supervisedDirect'
}
