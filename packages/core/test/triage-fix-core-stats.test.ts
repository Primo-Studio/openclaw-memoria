/**
 * Compteurs du tri : ceux des onglets suivent le filtre par défaut de la liste
 * (un représentant par amas, ni redite d'un actif, ni faux), et la version
 * découpée rend la main entre deux tranches avec les mêmes chiffres.
 * Données fictives uniquement.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { addStats, addStatsAsync, emptyStats } from '../src/triage/store.js'
import { seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

/** Base fictive : redites dans une source, redite d'un actif, faux, sensibles en amas. */
async function seeded(): Promise<{ ideaMember: string; twin: string; faux: string }> {
  env = setupTriage()
  const db = env.db()
  const src = { path: '/fictif/session-a.jsonl' }
  const ideaRep = seedPending(env, 'On pourrait proposer une app de covoiturage pour les festivals de musique en plein air', src)
  const ideaMember = seedPending(env, 'On pourrait proposer une app de covoiturage pour festivals de musique plein air', src)
  seedPending(env, 'Idée : un carnet de recettes partagé entre voisins, classé par saison', src)
  seedPending(env, 'L’équipe a décidé d’héberger le site vitrine chez Brumehost', src)
  const faux = seedPending(env, 'Il a décidé de retenir le prestataire fictif Nuagex pour le stockage', src)
  // Redite exacte d'un actif.
  const active = env.m.storeFact({ instance: env.instance, content: 'On pourrait proposer une app de troc de graines entre jardiniers du quartier' }).id
  const twin = seedPending(env, 'Une app de troc de graines pour le quartier, on pourrait la proposer', src)
  const hash = (db.prepare('SELECT norm_hash FROM facts WHERE id = ?').get(active) as { norm_hash: string }).norm_hash
  db.prepare('UPDATE facts SET norm_hash = ? WHERE id = ?').run(hash, twin)
  // Deux faits de paie identiques (même clé) : un amas sensible.
  // Le plus long texte représente l'amas.
  const p1 = seedPending(env, 'Le salaire brut de Paul Exemple est de 2 000 euros chaque mois.', src)
  const p2 = seedPending(env, 'Le salaire brut de Paul Exemple est de 2 000 euros par mois.', src)
  const pHash = (db.prepare('SELECT norm_hash FROM facts WHERE id = ?').get(p1) as { norm_hash: string }).norm_hash
  db.prepare('UPDATE facts SET norm_hash = ? WHERE id = ?').run(pHash, p2)
  await env.m.triage.run()
  env.m.triage.setVerdict([faux], 'faux')
  // Le jeu de données est bien celui décrit (sinon le test ne prouve rien).
  expect(triageRow(db, ideaMember)!.amas_id).toBe(ideaRep)
  expect(triageRow(db, twin)!.same_as_active).toBe(active)
  expect(triageRow(db, p2)!.amas_id).toBe(p1)
  return { ideaMember, twin, faux }
}

describe('stats du tri', () => {
  it('chaque onglet compte exactement les lignes de la liste par défaut', async () => {
    await seeded()
    const stats = env.m.triage.stats()
    for (const genre of ['idee', 'decision', 'fait', 'preference', 'style', 'process', 'lecon', 'ephemere'] as const) {
      expect(stats.by_genre[genre]?.total ?? 0, genre).toBe(env.m.triage.list({ genre }, { limit: 500 }).items.length)
    }
    expect(stats.by_genre['idee']).toEqual({ total: 3, validated: 1, pending: 2 })
    expect(stats.sensible).toBe(env.m.triage.list({ sensible: true }, { limit: 500 }).items.length)
    expect(stats.sensible).toBe(1)
    // Les redites restent comptées à part.
    expect(stats).toMatchObject({ redites: 2, same_as_active: 1, faux: 1, amas: 2 })
    expect(stats.triaged + stats.untriaged).toBe(stats.facts_total)
  })

  it('statsAsync : mêmes chiffres, en rendant la main entre deux tranches', async () => {
    await seeded()
    const db = env.db()
    const sync = emptyStats()
    addStats(db, sync)
    let yields = 0
    const sliced = emptyStats()
    await addStatsAsync(db, sliced, { sliceRows: 2, yieldFn: async () => void yields++ })
    expect(sliced).toEqual(sync)
    const rows = (db.prepare('SELECT MAX(rowid) AS m FROM fact_triage').get() as { m: number }).m
    expect(yields).toBeGreaterThanOrEqual(Math.ceil(rows / 2))
    const viaService = await env.m.triage.statsAsync({}, { sliceRows: 3 })
    expect(viaService).toEqual(env.m.triage.stats())
  })
})
