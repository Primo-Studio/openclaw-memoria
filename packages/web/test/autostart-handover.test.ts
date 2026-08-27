/**
 * Bascule « Lancer au démarrage » : quand le daemon répond `handover: true`
 * il va s'arrêter et être relancé — la page ne doit PAS afficher une erreur
 * réseau, mais une note calme, la case dans son état cible, puis resonder.
 */
import { describe, expect, it } from 'vitest'
import { ApiError, type AutostartChange } from '../src/api'
import {
  HANDOVER_MAX_PROBES,
  afterHandoverProbeFailed,
  planAutostartChange,
  supervisorNoteKey,
} from '../src/lib/autostart'

function change(over: Partial<AutostartChange> = {}, installed = false): AutostartChange {
  return {
    autostart: { supported: true, installed, loaded: installed, plistPath: '/x/fr.primo-studio.memoria.plist' },
    handover: false,
    ...over,
  }
}

describe('planAutostartChange — après la réponse de POST /v1/admin/autostart', () => {
  it('sans passation : on affiche le statut renvoyé tel quel', () => {
    const plan = planAutostartChange(change({ handover: false }, true), true)
    expect(plan.restarting).toBe(false)
    expect(plan.autostart.installed).toBe(true)
  })

  it('passation « on » : note launchd + case cochée même si le statut renvoyé est encore « non installé »', () => {
    const plan = planAutostartChange(change({ handover: true, mode: 'on' }, false), true)
    expect(plan).toMatchObject({ restarting: true, mode: 'on', noteKey: 'settings.control.handoverOn' })
    expect(plan.autostart.installed).toBe(true)
  })

  it('passation « off » : note « en direct » + case décochée', () => {
    const plan = planAutostartChange(change({ handover: true, mode: 'off' }, true), false)
    expect(plan).toMatchObject({ restarting: true, mode: 'off', noteKey: 'settings.control.handoverOff' })
    expect(plan.autostart.installed).toBe(false)
  })

  it('`mode` absent (daemon antérieur) : déduit du sens demandé', () => {
    expect(planAutostartChange(change({ handover: true }), true)).toMatchObject({ mode: 'on' })
    expect(planAutostartChange(change({ handover: true }), false)).toMatchObject({ mode: 'off' })
  })
})

describe('afterHandoverProbeFailed — sondes GET /v1/admin/control après la passation', () => {
  it('réseau muet : on resonde tant qu’on n’a pas épuisé les sondes', () => {
    expect(afterHandoverProbeFailed(new TypeError('Failed to fetch'), 1)).toEqual({ kind: 'retry' })
    expect(afterHandoverProbeFailed(new TypeError('Failed to fetch'), HANDOVER_MAX_PROBES - 1)).toEqual({ kind: 'retry' })
  })

  it('dernière sonde muette : on rend la main avec la note « ne répond pas encore »', () => {
    expect(afterHandoverProbeFailed(new TypeError('Failed to fetch'), HANDOVER_MAX_PROBES)).toEqual({
      kind: 'gave-up',
      noteKey: 'settings.control.handoverStillDown',
    })
  })

  it('401 : le daemon est revenu avec une nouvelle clé → « relance memoria ui », dès la première sonde', () => {
    expect(afterHandoverProbeFailed(new ApiError(401, 'token admin requis'), 1)).toEqual({
      kind: 'token-changed',
      noteKey: 'settings.control.handoverTokenChanged',
    })
  })

  it('une erreur HTTP autre (500) n’est pas une clé périmée : on resonde puis on abandonne', () => {
    expect(afterHandoverProbeFailed(new ApiError(500, 'boum'), 1)).toEqual({ kind: 'retry' })
    expect(afterHandoverProbeFailed(new ApiError(500, 'boum'), HANDOVER_MAX_PROBES).kind).toBe('gave-up')
  })
})

describe('supervisorNoteKey — « supervisé par launchd » dans Réglages', () => {
  it('daemon lancé par launchd', () => {
    expect(supervisorNoteKey({ supervisor: 'launchd' })).toBe('settings.control.supervisedLaunchd')
  })
  it('daemon lancé en direct', () => {
    expect(supervisorNoteKey({ supervisor: null })).toBe('settings.control.supervisedDirect')
  })
  it('daemon antérieur (champ absent) : rien plutôt qu’inventer', () => {
    expect(supervisorNoteKey({})).toBeNull()
  })
})
