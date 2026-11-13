/**
 * Worker thread de la projection 2D (voir projection.ts). Reçoit les vecteurs à
 * plat, renvoie les coordonnées. Aucun accès aux bases : uniquement du calcul.
 */
import { parentPort } from 'node:worker_threads'
import { projectVectors } from './projection.js'

parentPort?.on('message', (msg: { flat: Float32Array; n: number; dim: number }) => {
  try {
    const coords = projectVectors(msg.flat, msg.n, msg.dim)
    parentPort!.postMessage({ coords }, [coords.buffer as ArrayBuffer])
  } catch (err) {
    parentPort!.postMessage({ error: (err as Error).message })
  }
})
