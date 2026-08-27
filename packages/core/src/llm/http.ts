/**
 * `fetch` borné dans le temps, commun aux providers. Un dépassement est relancé
 * en `LlmTimeoutError` qui nomme provider, modèle et durée — le DOMException
 * natif ne dit rien de tout ça. Toute autre erreur (réseau, DNS) passe
 * inchangée : elle est déjà parlante.
 */
import { LlmTimeoutError } from './provider.js'

export interface FetchLabel {
  provider: string
  model: string
  /** Ce qu'on appelait (« /chat/completions », « /api/embed ») pour le message. */
  what: string
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: FetchLabel): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      throw new LlmTimeoutError({ provider: label.provider, model: label.model, timeoutMs, what: label.what })
    }
    throw err
  }
}
