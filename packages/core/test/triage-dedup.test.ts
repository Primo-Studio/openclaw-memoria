/**
 * Redites du tri : garde chiffres, quantification int8, regroupement par
 * représentant, redites d'un actif (en écartant les dormants de l'index),
 * amas entre sources. Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { clusterAsync, dequantizeInt8, numberSignature, quantizeInt8, sameNumbers, upsertVector } from '../src/index.js'
import { bagOfWords, seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'

describe('garde chiffres', () => {
  it('normalise les séparateurs de milliers, les décimales et les dates', () => {
    expect(sameNumbers('Abonnement à 2 340 € par mois', 'Abonnement à 2340 € par mois')).toBe(true)
    expect(sameNumbers('Rendez-vous le 09/11', 'Rendez-vous le 9/11')).toBe(true)
    expect(sameNumbers('Remise de 2,5 %', 'Remise de 2.5 %')).toBe(true)
    expect(sameNumbers('Abonnement à 2 340 €', 'Abonnement à 2 350 €')).toBe(false)
    expect(sameNumbers('Livraison le 12/03', 'Livraison le 13/03')).toBe(false)
    expect(numberSignature('aucun nombre')).toBe('')
  })
})

describe('quantification int8', () => {
  it('l’aller-retour garde le cosinus à moins de 0,005 près', () => {
    let seed = 42
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1
    for (let k = 0; k < 20; k++) {
      const a = Float32Array.from({ length: 1536 }, rand)
      const b = Float32Array.from(a, x => x + rand() * 0.3)
      const exact = cos(a, b)
      const q = cos(dequantizeInt8(quantizeInt8(a), 1536), dequantizeInt8(quantizeInt8(b), 1536))
      expect(Math.abs(exact - q)).toBeLessThan(0.005)
    }
  })
})

function cos(a: Float32Array, b: Float32Array): number {
  let d = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return d / Math.sqrt(na * nb)
}

function unit(text: string): Float32Array {
  const v = bagOfWords(text)
  let n = 0
  for (const x of v) n += x * x
  return v.map(x => x / Math.sqrt(n))
}

describe('regroupement', () => {
  const cand = (id: string, text: string, at: string | null = null) => ({ id, text, conversation_at: at, vector: unit(text), exactKey: id })

  it('les redites rejoignent le plus complet ; une différence de chiffre n’est jamais une redite', async () => {
    const out = await clusterAsync([
      cand('a', 'La pépinière vend un abonnement de graines de saison aux jardineries de la région'),
      cand('b', 'La pépinière vend un abonnement de graines de saison aux jardineries de la région entière'),
      cand('c', 'La pépinière vend un abonnement de 12 sachets de graines aux jardineries de la région'),
      cand('d', 'La pépinière vend un abonnement de 15 sachets de graines aux jardineries de la région'),
    ])
    expect(out.get('a')).toBe('b')
    expect(out.get('b')).toBe('b')
    expect(out.get('c')).toBe('c')
    expect(out.get('d')).toBe('d')
  })

  it('rend la main à la boucle d’événements pendant le calcul', async () => {
    const many = Array.from({ length: 400 }, (_, i) => cand(`f${i}`, `Le dossier ${i} est rangé chez Nimbus avec le carnet ${i * 7}`))
    let ticks = 0
    let running = true
    const tick = (): void => {
      if (!running) return
      ticks++
      setImmediate(tick)
    }
    setImmediate(tick)
    await clusterAsync(many, { sliceMs: 0 })
    running = false
    expect(ticks).toBeGreaterThan(10)
  })
})

describe('redites pendant un passage', () => {
  let env: TriageEnv
  afterEach(() => env?.close())

  it('dans une même source : un seul envoi, les membres héritent du genre et de « dit N fois »', async () => {
    env = setupTriage()
    const path = '/fictif/session-redites.jsonl'
    const a = seedPending(env, 'La pépinière pourrait vendre un abonnement de graines de saison aux jardineries de la région', { path })
    const b = seedPending(env, 'La pépinière pourrait vendre un abonnement de graines de saison aux jardineries de la région entière', { path })
    const c = seedPending(env, 'La pépinière pourrait vendre un abonnement de 12 sachets de graines aux jardineries de la région', { path })
    await env.m.triage.run()
    const sent = env.llm.prompts.join('\n').split('\n').filter(l => l.startsWith('{"n":') && l.includes('jardineries'))
    expect(sent).toHaveLength(2)
    expect(sent.some(l => l.includes('région entière'))).toBe(true)
    expect(sent.some(l => l.includes(' 12 '))).toBe(true)
    expect(triageRow(env.db(), a)).toMatchObject({ genre: 'idee', amas_id: b, amas_size: 2 })
    expect(triageRow(env.db(), b)).toMatchObject({ genre: 'idee', amas_id: b, amas_size: 2 })
    expect(triageRow(env.db(), c)).toMatchObject({ amas_id: c, amas_size: 1 })
  })

  it('redite d’un actif : seuls les voisins ACTIFS comptent (l’index contient aussi d’anciens dormants)', async () => {
    env = setupTriage()
    const text = 'Le client Zephyrcorp règle ses factures à soixante jours par virement bancaire'
    const old = seedPending(env, `${text} et chèque`)
    // Ancien dormant vectorisé dans l'index (pollution réelle) : il ne doit jamais servir de « redite d'actif ».
    const db = env.db()
    upsertVector(db, { model: env.embedder.model, dimensions: 32 }, old, bagOfWords(`${text} et chèque`))
    db.prepare("INSERT INTO embeddings (id, owner_type, owner_id, model, dimensions, vector, created_at) VALUES ('e-old', 'fact', ?, ?, 32, ?, '2026-01-01')").run(
      old,
      env.embedder.model,
      Buffer.from(bagOfWords(`${text} et chèque`).buffer),
    )
    env.db().prepare("INSERT INTO fact_triage (fact_id, genre, triaged_at) VALUES (?, 'decision', '2026-01-01')").run(old)
    const fresh = seedPending(env, `${text} classique`)
    await env.m.triage.run()
    expect(triageRow(env.db(), fresh)!.same_as_active).toBeNull()

    // Un vrai actif proche : redite ; le même avec un autre chiffre : pas une redite.
    const active = env.m.storeFact({ instance: env.instance, content: 'Le portail Lumen est hébergé chez Brumehost depuis le printemps dernier' }).id
    await env.m.indexEmbeddings()
    await env.m.triage.run()
    const twin = seedPending(env, 'Le portail Lumen est hébergé chez Brumehost depuis le printemps dernier déjà')
    const other = seedPending(env, 'Le portail Lumen est hébergé chez Brumehost depuis le printemps dernier 2025')
    await env.m.triage.run()
    expect(triageRow(env.db(), twin)!.same_as_active).toBe(active)
    expect(triageRow(env.db(), other)!.same_as_active).toBeNull()
  })

  it('entre sources : une idée redite dans une autre session rejoint l’amas existant', async () => {
    env = setupTriage()
    const first = seedPending(env, 'On pourrait proposer une app de covoiturage pour les festivals de musique', { path: '/fictif/s1.jsonl' })
    await env.m.triage.run()
    const again = seedPending(env, 'On pourrait proposer une app de covoiturage pour les festivals de musique locaux', { path: '/fictif/s2.jsonl' })
    await env.m.triage.run()
    const rep = triageRow(env.db(), first)!.amas_id
    expect(triageRow(env.db(), again)!.amas_id).toBe(rep)
    expect(triageRow(env.db(), first)!.amas_size).toBe(2)
  })
})
