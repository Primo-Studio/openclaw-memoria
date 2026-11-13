/**
 * Mesure des blocages de la boucle d'événements du daemon (ticket #27).
 *
 * Le daemon sert HTTP et fait tourner ses travaux de fond (import, cognition)
 * dans UN thread. Un travail synchrone long fige tout : les agents reçoivent
 * « did not answer within 30 s » alors que le process tourne, et rien ne le
 * signalait (`doctor` répondait que tout allait bien). On expose donc le plus
 * long blocage récent dans /v1/health et dans le doctor.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { DaemonResponsiveness } from '@memoria/core'

/** Seuil d'alerte : au-delà, un appel d'agent peut dépasser son délai. */
export const LOOP_BLOCK_WARN_MS = 5_000

const SLOT_MS = 60_000
const SLOTS = 15

export interface LoopMonitor {
  snapshot(): DaemonResponsiveness
  stop(): void
}

export function startLoopMonitor(slotMs: number = SLOT_MS): LoopMonitor {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  /** Maxima des minutes écoulées, la plus récente en dernier. */
  const closed: number[] = []
  const currentMax = (): number => {
    // max est en nanosecondes ; un histogramme vide rend 0 (ou une valeur non finie).
    const ms = histogram.max / 1e6
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  }
  const timer = setInterval(() => {
    closed.push(currentMax())
    if (closed.length > SLOTS) closed.shift()
    histogram.reset()
  }, slotMs)
  timer.unref()

  return {
    snapshot: () => {
      const now = currentMax()
      const lastMinute = Math.max(now, closed.at(-1) ?? 0)
      return { max_block_ms_1m: lastMinute, max_block_ms_15m: Math.max(now, ...closed) }
    },
    stop: () => {
      clearInterval(timer)
      histogram.disable()
    },
  }
}

/** Avertissement doctor, ou null si le daemon est réactif. */
export function responsivenessWarning(r: DaemonResponsiveness): string | null {
  if (r.max_block_ms_15m < LOOP_BLOCK_WARN_MS) return null
  const s = (r.max_block_ms_15m / 1000).toFixed(1).replace('.', ',')
  return `daemon bloqué jusqu'à ${s} s sur les 15 dernières minutes — les agents coupent à 30 s (« did not answer »). Cause habituelle : un import ou un traitement de fond.`
}
