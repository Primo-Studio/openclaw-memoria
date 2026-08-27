/**
 * Démarrage « en attente » pour le service launchd.
 *
 * Bug d'origine : quand un daemon DIRECT (`memoria start`, app bureau, MCP)
 * tenait daemon.lock, l'instance launchd mourait en exit 1 et
 * KeepAlive/SuccessfulExit=false la relançait toutes les ~10 s, indéfiniment —
 * memoria.err.log se remplissait de « un daemon Memoria tourne déjà », et
 * `launchctl print` affichait runs = 6, 9, … Ici, sous launchd, on ATTEND
 * que le détenteur libère le verrou (memoria stop, autostart on, fin de
 * session) puis on reprend la main : le service reste « running », en
 * attente, au lieu de crash-looper. Hors launchd on échoue net, comme avant.
 */
import { DaemonLockHeldError, startDaemon, type DaemonOptions, type RunningDaemon } from './server.js'

export interface StandbyOptions {
  /** Ce process est-il supervisé par launchd ? (sinon : pas d'attente, erreur immédiate) */
  supervised: boolean
  /** Intervalle entre deux essais (défaut 2 s). */
  intervalMs?: number
  /** Borne d'attente ; absente = indéfinie (comportement service). */
  maxWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export async function startWithStandby(opts: DaemonOptions, standby: StandbyOptions): Promise<RunningDaemon> {
  const sleep = standby.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const log = standby.log ?? (m => console.error(m))
  const interval = standby.intervalMs ?? 2_000
  const deadline = standby.maxWaitMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + standby.maxWaitMs
  let announced = false
  for (;;) {
    try {
      return await startDaemon(opts)
    } catch (err) {
      if (!standby.supervised || !(err instanceof DaemonLockHeldError)) throw err
      if (Date.now() >= deadline) throw err
      if (!announced) {
        // Une seule ligne, pas une par essai : le journal doit rester lisible.
        log(
          `[memoria-daemon] verrou tenu par un autre daemon (pid ${err.holderPid ?? '?'}, probablement « memoria start ») — ` +
            'le service launchd attend sa fin au lieu de redémarrer en boucle',
        )
        announced = true
      }
      await sleep(interval)
    }
  }
}
