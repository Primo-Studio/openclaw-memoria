/**
 * Source UNIQUE du mode de capture (Auto / Revue d'abord / Pause) pour toute
 * la coquille.
 *
 * POURQUOI un état en module plutôt qu'un `useState` par composant : le mode
 * est désormais exposé à DEUX endroits — le segmented control en pied de barre
 * latérale (bureau) et le bouton de la barre supérieure (mobile, où la barre
 * latérale est repliée dans un tiroir). Deux composants qui liraient chacun
 * l'API afficheraient deux états, et changer le mode d'un côté laisserait
 * l'autre périmé. Ici : un seul chargement, un seul état, tout le monde s'y
 * abonne.
 *
 * Le message d'échec reste brut (`noticeRaw`) : c'est l'appelant, qui a `t()`,
 * qui l'habille.
 */
import { useSyncExternalStore } from 'react'
import { getCaptureMode, setCaptureMode, type CaptureMode } from '../api'
import { humanError } from '../components/ui'

export interface CaptureModeState {
  /** null = pas encore lu (ou illisible : voir `error`). */
  mode: CaptureMode | null
  /** Lecture impossible — le contrôle doit le DIRE, jamais disparaître. */
  error: string | null
  /** Dernier changement refusé par le service (message technique brut). */
  noticeRaw: string | null
}

let state: CaptureModeState = { mode: null, error: null, noticeRaw: null }
let loading = false
const listeners = new Set<() => void>()

function set(patch: Partial<CaptureModeState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function load() {
  if (loading) return
  loading = true
  getCaptureMode().then(
    m => {
      loading = false
      set({ mode: m, error: null })
    },
    (err: unknown) => {
      loading = false
      console.warn('memoria-ui : mode de capture illisible', err)
      set({ error: humanError(err) })
    },
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Premier abonné : on lit le mode. Les suivants réutilisent le même état.
  if (state.mode === null && state.error === null) load()
  return () => {
    listeners.delete(listener)
  }
}

export function useCaptureModeState(): CaptureModeState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

/** Relance la lecture après un échec (bouton « Réessayer »). */
export function retryCaptureMode(): void {
  set({ error: null })
  load()
}

/**
 * Changement optimiste : l'interface répond tout de suite, et si le service
 * refuse, l'état réel revient ET l'échec est dit (jamais un changement qui
 * fait semblant d'avoir marché).
 */
export function changeCaptureMode(next: CaptureMode): void {
  set({ mode: next, noticeRaw: null })
  setCaptureMode(next).catch((err: unknown) => {
    console.warn('memoria-ui : changement de mode de capture refusé', err)
    set({ noticeRaw: humanError(err) })
    getCaptureMode().then(
      m => set({ mode: m }),
      () => retryCaptureMode(),
    )
  })
}
