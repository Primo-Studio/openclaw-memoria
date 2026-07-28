/**
 * Niveaux de vérité (retours bêta) : « éviter qu'une hypothèse ou une ancienne
 * erreur devienne une instruction durable ».
 *
 * Le niveau est DÉRIVÉ des colonnes existantes — ces tests fixent les règles de
 * dérivation sur les valeurs réellement présentes en base (`auto-capture`,
 * `cluster:*`, `pattern:*`), pas sur des valeurs théoriques.
 */
import { describe, expect, it } from 'vitest'
import { factOrigin, needsCaution, originLabel } from '../src/index.js'

const row = (over: Partial<Parameters<typeof factOrigin>[0]> = {}) => ({
  source: 'auto-capture',
  fact_type: 'semantic',
  used_count: 0,
  relevance_weight: 1,
  ...over,
})

describe('factOrigin', () => {
  it('posé explicitement → declared', () => {
    expect(factOrigin(row({ source: 'manual' }))).toBe('declared')
    expect(factOrigin(row({ source: 'capture' }))).toBe('declared')
    expect(factOrigin(row({ source: 'import' }))).toBe('declared')
  })

  it('extrait d’une conversation → extracted', () => {
    expect(factOrigin(row({ source: 'auto-capture' }))).toBe('extracted')
  })

  it('produit par une couche cognitive → inferred (personne ne l’a dit)', () => {
    expect(factOrigin(row({ source: 'cluster:ollama', fact_type: 'cluster' }))).toBe('inferred')
    expect(factOrigin(row({ source: 'pattern:behavior', fact_type: 'pattern' }))).toBe('inferred')
    expect(factOrigin(row({ source: 'auto-capture', fact_type: 'cluster' }))).toBe('inferred')
  })

  it('confirmé par l’usage réel → confirmed, y compris s’il était déduit', () => {
    // reinforce(used:true) est la SEULE voie vers relevance_weight > 1.
    expect(factOrigin(row({ used_count: 3, relevance_weight: 1.5 }))).toBe('confirmed')
    expect(factOrigin(row({ source: 'cluster:x', fact_type: 'cluster', used_count: 2, relevance_weight: 1.25 }))).toBe('confirmed')
  })

  it('un usage SANS renforcement ne confirme rien', () => {
    // used_count peut monter sans que le feedback ait validé quoi que ce soit.
    expect(factOrigin(row({ used_count: 5, relevance_weight: 1 }))).toBe('extracted')
    expect(factOrigin(row({ used_count: 0, relevance_weight: 1.8 }))).toBe('extracted')
  })

  it('declared reste declared — déjà au niveau le plus haut', () => {
    expect(factOrigin(row({ source: 'manual', used_count: 9, relevance_weight: 2 }))).toBe('declared')
  })
})

describe('lecture par l’agent', () => {
  it('seul le déduit appelle à la prudence', () => {
    expect(needsCaution('inferred')).toBe(true)
    expect(needsCaution('declared')).toBe(false)
    expect(needsCaution('extracted')).toBe(false)
    expect(needsCaution('confirmed')).toBe(false)
  })

  it('les étiquettes sont en anglais (issue #1) et explicites', () => {
    expect(originLabel('inferred')).toMatch(/inferred/)
    expect(originLabel('declared')).toMatch(/stated/)
    expect(originLabel('confirmed')).toMatch(/confirmed/)
  })
})
