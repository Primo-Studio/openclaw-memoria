/**
 * Régression : un échec du premier chargement ne doit plus laisser le spinner
 * tourner indéfiniment sous la bannière d'erreur (Revue, Thèmes, Récurrences,
 * Procédures, Révisions, Maintenance, Partage).
 */
import { describe, expect, it } from 'vitest'
import { listPhase } from '../src/components/ui'

describe('listPhase', () => {
  it('items null + erreur → « failed », PAS « loading »', () => {
    expect(listPhase(null, 'Le service ne répond pas')).toBe('failed')
  })
  it('items null sans erreur → loading', () => {
    expect(listPhase(null, null)).toBe('loading')
  })
  it('liste vide → empty, liste pleine → ready (même avec une erreur d’action en cours)', () => {
    expect(listPhase([], null)).toBe('empty')
    expect(listPhase([1], 'échec d’une action')).toBe('ready')
  })
})
