/**
 * Carte des souvenirs (T28) : projection 2D déterministe des embeddings, cache
 * par base, tous agents dans le même espace, fils d'un souvenir.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Memoria } from '../src/engine/memoria.js'
import { ownsWholeBuffer, projectVectors } from '../src/cognition/projection.js'
import { createSyntheticLegacyDb, importLegacyDb } from '../src/index.js'
import type { EmbeddingProvider } from '../src/llm/provider.js'

/** Trois sujets = trois directions de l'espace ; un peu de bruit déterministe autour. */
const TOPICS = ['cuisine', 'voiture', 'facture']
const DIM = 12

function vectorFor(text: string): Float32Array {
  const v = new Float32Array(DIM)
  const topic = TOPICS.findIndex(t => text.includes(t))
  if (topic >= 0) v[topic] = 1
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  for (let i = 3; i < DIM; i++) {
    h = (h * 1103515245 + 12345) >>> 0
    v[i] = ((h % 1000) / 1000 - 0.5) * 0.15
  }
  const norm = Math.hypot(...v) || 1
  return v.map(x => x / norm)
}

class TopicEmbedding implements EmbeddingProvider {
  readonly name = 'fake'
  readonly model = 'fake-topic'
  readonly dimensions = DIM
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map(vectorFor))
  }
}

describe('projectVectors', () => {
  const texts = TOPICS.flatMap(t => Array.from({ length: 20 }, (_, i) => `note ${i} sur la ${t} numéro ${i * 3}`))
  const flat = new Float32Array(texts.length * DIM)
  texts.forEach((t, i) => flat.set(vectorFor(t), i * DIM))

  it('déterministe, et borné dans [-1, 1]', () => {
    const a = projectVectors(flat, texts.length, DIM)
    const b = projectVectors(flat, texts.length, DIM)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a).toHaveLength(texts.length * 2)
    for (const v of a) {
      expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0001)
    }
  })

  it('position = sens : les souvenirs d’un même sujet sont plus proches entre eux que des autres sujets', () => {
    const coords = projectVectors(flat, texts.length, DIM)
    const centroid = (topic: number): [number, number] => {
      let x = 0
      let y = 0
      for (let i = 0; i < 20; i++) {
        x += coords[(topic * 20 + i) * 2]!
        y += coords[(topic * 20 + i) * 2 + 1]!
      }
      return [x / 20, y / 20]
    }
    const centers = TOPICS.map((_, t) => centroid(t))
    let ok = 0
    for (let i = 0; i < texts.length; i++) {
      const own = Math.floor(i / 20)
      const d = centers.map(c => Math.hypot(coords[i * 2]! - c[0], coords[i * 2 + 1]! - c[1]))
      if (d.indexOf(Math.min(...d)) === own) ok++
    }
    // Chaque point est plus près du centre de SON sujet (tolérance : 5 %).
    expect(ok).toBeGreaterThanOrEqual(texts.length * 0.95)
  })

  it('cas limites : 0, 1 et 3 points', () => {
    expect(projectVectors(new Float32Array(0), 0, DIM)).toHaveLength(0)
    expect(Array.from(projectVectors(vectorFor('cuisine'), 1, DIM))).toEqual([0, 0])
    const three = new Float32Array(3 * DIM)
    TOPICS.forEach((t, i) => three.set(vectorFor(t), i * DIM))
    const out = projectVectors(three, 3, DIM)
    expect(new Set([`${out[0]},${out[1]}`, `${out[2]},${out[3]}`, `${out[4]},${out[5]}`]).size).toBe(3)
  })
})

describe('Memoria.memoryMap', () => {
  let root: string
  let mem: Memoria

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memoria-map-'))
    mem = Memoria.init({
      storageRoot: root,
      configPath: join(root, 'config.toml'),
      llm: { extraction: null, embeddings: new TopicEmbedding() },
      secretsVault: 'aes-vault',
    })
  })

  afterEach(() => {
    mem.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('tous les agents dans le même espace, cache relu sans recalcul, fils par le sens', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const b = mem.pairAssistant({ type: 'codex' }).assistant_instance_id
    const stored: string[] = []
    for (let i = 0; i < 12; i++) {
      const topic = TOPICS[i % 3]!
      const fact = mem.storeFact({ instance: i % 2 === 0 ? a : b, content: `Règle ${i} à propos de la ${topic}, détail ${i * 7}.` })
      stored.push(fact.id)
    }
    await mem.indexEmbeddings()

    // Carte vide + souvenirs plaçables → le calcul part tout seul.
    const first = await mem.memoryMap()
    expect(first.status).toBe('computing')
    await mem.memoryMapSettled()

    const map = await mem.memoryMap()
    expect(map.status).toBe('ready')
    expect(map.model).toBe('fake-topic')
    expect(map.points).toHaveLength(12)
    expect(map.unplaced).toBe(0)
    expect(map.agents.map(x => x.type).sort()).toEqual(['claude-code', 'codex'])
    expect(new Set(map.points.map(p => p.agent))).toEqual(new Set([a, b]))
    for (const p of map.points) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1.0001)
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1.0001)
    }

    // Les voisins d'un souvenir « cuisine » sont des souvenirs « cuisine », des deux agents.
    const links = await mem.memoryMapLinks(stored[0]!)
    expect(links?.content).toContain('cuisine')
    expect(links!.neighbours.length).toBeGreaterThanOrEqual(3)
    const byId = new Map(map.points.map(p => [p.id, p]))
    for (const n of links!.neighbours.slice(0, 3)) expect(byId.get(n.id)?.label).toContain('cuisine')
    expect(new Set(links!.neighbours.slice(0, 3).map(n => byId.get(n.id)?.agent)).size).toBe(2)

    expect(await mem.memoryMapLinks('inconnu')).toBeNull()
  })

  it('un souvenir de plus ne relance pas le calcul ; il est compté « pas encore placé »', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    for (let i = 0; i < 30; i++) mem.storeFact({ instance: a, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` })
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()

    mem.storeFact({ instance: a, content: 'Une règle de plus à propos de la voiture.' })
    await mem.indexEmbeddings()
    const map = await mem.memoryMap()
    expect(map.status).toBe('ready')
    expect(map.points).toHaveLength(30)
    expect(map.unplaced).toBe(1)

    // Recalcul demandé : le nouveau souvenir est placé.
    expect(mem.rebuildMemoryMap()).toEqual({ started: true })
    await mem.memoryMapSettled()
    const after = await mem.memoryMap()
    expect(after.points).toHaveLength(31)
    expect(after.unplaced).toBe(0)
  })

  it('souvenir dormant ou supersédé : absent de la carte', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const facts = Array.from({ length: 6 }, (_, i) => mem.storeFact({ instance: a, content: `Note ${i} sur la ${TOPICS[i % 3]} du jour ${i}.` }))
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()
    expect(mem.forget({ ids: [facts[0]!.id] }).deleted).toBe(1)
    const map = await mem.memoryMap()
    expect(map.points.map(p => p.id)).not.toContain(facts[0]!.id)
  })

  /** Base privée d'un agent, pour préparer un cas directement en SQL. */
  const dbOf = (instance: string) => mem['openContent'](mem.paths.assistantDb(instance)).db

  it('fils : un voisin remplacé ou dormant est écarté, et un fait non actif n’a pas de détail', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const facts = Array.from({ length: 12 }, (_, i) =>
      mem.storeFact({ instance: a, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` }),
    )
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()

    // Sujet « cuisine » : faits 0, 3, 6, 9. Le 3 est remplacé, le 6 mis en sommeil ;
    // leurs vecteurs restent dans l'index (ils n'en sortent qu'à l'effacement).
    const db = dbOf(a)
    db.prepare('UPDATE facts SET superseded = 1, superseded_by = ? WHERE id = ?').run(facts[9]!.id, facts[3]!.id)
    db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(facts[6]!.id)

    const map = await mem.memoryMap()
    const onMap = new Set(map.points.map(p => p.id))
    const links = await mem.memoryMapLinks(facts[0]!.id)
    const neighbours = links!.neighbours.map(n => n.id)
    expect(neighbours).not.toContain(facts[3]!.id)
    expect(neighbours).not.toContain(facts[6]!.id)
    expect(neighbours[0]).toBe(facts[9]!.id)
    // Tout fil mène à un point présent sur la carte, et il en reste 6.
    for (const id of neighbours) expect(onMap.has(id)).toBe(true)
    expect(neighbours).toHaveLength(6)

    expect(await mem.memoryMapLinks(facts[3]!.id)).toBeNull()
    expect(await mem.memoryMapLinks(facts[6]!.id)).toBeNull()
  })

  it('deux espaces partagés de même type : deux identifiants distincts', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const one = mem.storeFact({ instance: a, content: 'Note partagée sur la cuisine du premier espace.' })
    const two = mem.storeFact({ instance: a, content: 'Note partagée sur la voiture du second espace.' })
    const first = mem.registry.ensureScope('shared_topic', 'espace-un', {})
    const second = mem.registry.ensureScope('shared_topic', 'espace-deux', {})
    mem.shareFacts([one.id], first.id)
    mem.shareFacts([two.id], second.id)
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()

    const map = await mem.memoryMap()
    const shared = map.agents.filter(x => x.type === 'shared')
    expect(shared.map(x => x.id).sort()).toEqual([`shared:${first.id}`, `shared:${second.id}`].sort())
    expect(shared.map(x => x.name).sort()).toEqual(['espace-deux', 'espace-un'])
    expect(new Set(map.agents.map(x => x.id)).size).toBe(map.agents.length)
  })

  it('calcul en échec : statut « error » avec le message, pas de relance tant que rien ne change', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const b = mem.pairAssistant({ type: 'codex' }).assistant_instance_id
    // 20 souvenirs dans la base en panne : au-dessus du seuil de retard, donc
    // un calcul repartirait si rien ne le freinait.
    for (let i = 0; i < 40; i++) {
      mem.storeFact({ instance: i % 2 === 0 ? a : b, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` })
    }
    await mem.indexEmbeddings()
    // Panne durable : la base du second agent refuse l'écriture des positions.
    dbOf(b).exec("CREATE TRIGGER panne BEFORE INSERT ON fact_projection BEGIN SELECT RAISE(ABORT, 'panne simulée'); END")

    expect((await mem.memoryMap()).status).toBe('computing')
    await expect(mem.memoryMapSettled()).rejects.toThrow(/panne simulée/)

    const failed = await mem.memoryMap()
    expect(failed.status).toBe('error')
    expect(failed.error).toMatch(/panne simulée/)
    // L'échec d'une base n'empêche pas les autres d'être écrites.
    expect(failed.points).toHaveLength(20)
    expect(failed.unplaced).toBe(20)
    expect(new Set(failed.points.map(p => p.agent))).toEqual(new Set([a]))

    // Rien n'a changé : les lectures suivantes ne relancent pas le calcul,
    // même une fois tous les délais passés (seul l'état des données compte).
    const start = vi.spyOn(mem, 'rebuildMemoryMap')
    expect((await mem.memoryMap()).status).toBe('error')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + Memoria.MAP_AUTO_MIN_INTERVAL_MS + 1000)
      expect((await mem.memoryMap()).status).toBe('error')
    } finally {
      vi.useRealTimers()
    }
    expect(start).not.toHaveBeenCalled()
    start.mockRestore()

    // Le bouton garde la main : panne levée, recalcul demandé, la carte est complète.
    dbOf(b).exec('DROP TRIGGER panne')
    expect(mem.rebuildMemoryMap()).toEqual({ started: true })
    await mem.memoryMapSettled()
    const repaired = await mem.memoryMap()
    expect(repaired.status).toBe('ready')
    expect(repaired.error).toBeUndefined()
    expect(repaired.points).toHaveLength(40)
  })

  it('après un échec, de nouvelles données relancent le calcul tout seul, mais pas avant le délai minimal', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    for (let i = 0; i < 6; i++) mem.storeFact({ instance: a, content: `Note ${i} sur la ${TOPICS[i % 3]} du jour ${i}.` })
    await mem.indexEmbeddings()
    dbOf(a).exec("CREATE TRIGGER panne BEFORE INSERT ON fact_projection BEGIN SELECT RAISE(ABORT, 'panne simulée'); END")
    await mem.memoryMap()
    await expect(mem.memoryMapSettled()).rejects.toThrow()
    expect((await mem.memoryMap()).status).toBe('error')

    // Panne durable, carte vide, et l'indexation avance : pas de calcul en chaîne.
    const start = vi.spyOn(mem, 'rebuildMemoryMap')
    mem.storeFact({ instance: a, content: 'Une note de plus sur la facture.' })
    await mem.indexEmbeddings()
    expect((await mem.memoryMap()).status).toBe('error')
    mem.storeFact({ instance: a, content: 'Encore une note sur la voiture.' })
    await mem.indexEmbeddings()
    expect((await mem.memoryMap()).status).toBe('error')
    expect(start).not.toHaveBeenCalled()
    start.mockRestore()

    // Le délai passé (et la panne levée), la lecture suivante relance le calcul.
    dbOf(a).exec('DROP TRIGGER panne')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + Memoria.MAP_AUTO_MIN_INTERVAL_MS + 1000)
      expect((await mem.memoryMap()).status).toBe('computing')
    } finally {
      vi.useRealTimers()
    }
    await mem.memoryMapSettled()
    const map = await mem.memoryMap()
    expect(map.status).toBe('ready')
    expect(map.points).toHaveLength(8)
  })

  it('panne durable avec des dates mélangées : un vecteur de plus ne relance pas le calcul avant le délai', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const b = mem.pairAssistant({ type: 'codex' }).assistant_instance_id
    for (let i = 0; i < 12; i++) {
      mem.storeFact({ instance: i % 2 === 0 ? a : b, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` })
    }
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()

    // Second calcul : la base du second agent refuse l'écriture et garde ses
    // anciennes positions, donc une date plus ancienne que la première base.
    await new Promise(resolve => setTimeout(resolve, 5))
    dbOf(b).exec("CREATE TRIGGER panne BEFORE INSERT ON fact_projection BEGIN SELECT RAISE(ABORT, 'panne simulée'); END")
    mem.rebuildMemoryMap()
    await expect(mem.memoryMapSettled()).rejects.toThrow(/panne simulée/)
    const dates = [a, b].map(id => (dbOf(id).prepare('SELECT MAX(computed_at) AS t FROM fact_projection').get() as { t: string }).t)
    expect(dates[0]).not.toBe(dates[1])
    expect((await mem.memoryMap()).status).toBe('error')

    const start = vi.spyOn(mem, 'rebuildMemoryMap')
    mem.storeFact({ instance: a, content: 'Une règle de plus à propos de la voiture.' })
    await mem.indexEmbeddings()
    expect((await mem.memoryMap()).status).toBe('error')
    expect(start).not.toHaveBeenCalled()
    start.mockRestore()

    // Panne levée et délai passé : le calcul complet repart et remet tout à la même date.
    dbOf(b).exec('DROP TRIGGER panne')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + Memoria.MAP_AUTO_MIN_INTERVAL_MS + 1000)
      expect((await mem.memoryMap()).status).toBe('computing')
    } finally {
      vi.useRealTimers()
    }
    await mem.memoryMapSettled()
    const map = await mem.memoryMap()
    expect(map.status).toBe('ready')
    expect(map.points).toHaveLength(13)
  })

  it('faits remplacés à nombre égal : la carte se recalcule quand même, le délai passé', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const facts = Array.from({ length: 30 }, (_, i) =>
      mem.storeFact({ instance: a, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` }),
    )
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()

    // 25 corrections : 25 nouveaux faits, 25 anciens remplacés. Le nombre de vecteurs actifs ne bouge pas.
    const db = dbOf(a)
    for (let i = 0; i < 25; i++) {
      const next = mem.storeFact({ instance: a, content: `Version corrigée ${i} à propos de la ${TOPICS[i % 3]}, point ${i * 11}.` })
      db.prepare('UPDATE facts SET superseded = 1, superseded_by = ? WHERE id = ?').run(next.id, facts[i]!.id)
    }
    await mem.indexEmbeddings()
    const stale = await mem.memoryMap()
    expect(stale.status).toBe('ready')
    expect(stale.points).toHaveLength(5)
    expect(stale.unplaced).toBe(25)

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + Memoria.MAP_AUTO_MIN_INTERVAL_MS + 1000)
      expect((await mem.memoryMap()).status).toBe('computing')
    } finally {
      vi.useRealTimers()
    }
    await mem.memoryMapSettled()
    const map = await mem.memoryMap()
    expect(map.points).toHaveLength(30)
    expect(map.unplaced).toBe(0)
  })

  it('date de calcul dans le futur (horloge déréglée) : ne bloque pas le recalcul automatique', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    for (let i = 0; i < 30; i++) mem.storeFact({ instance: a, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` })
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()
    dbOf(a).prepare('UPDATE fact_projection SET computed_at = ?').run('2999-01-01T00:00:00.000Z')

    for (let i = 0; i < 25; i++) mem.storeFact({ instance: a, content: `Suite ${i} à propos de la ${TOPICS[i % 3]}, point ${i * 11}.` })
    await mem.indexEmbeddings()
    expect((await mem.memoryMap()).status).toBe('computing')
    await mem.memoryMapSettled()
    expect((await mem.memoryMap()).points).toHaveLength(55)
  })

  it('fils : un souvenir entouré de plus de 40 voisins dormants garde ses 6 voisins actifs', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const target = mem.storeFact({ instance: a, content: 'La règle de référence à propos de la cuisine.' })
    // Lot de quasi-doublons du même sujet, mis en sommeil : plus proches que tout le reste.
    const dormant = Array.from({ length: 50 }, (_, i) =>
      mem.storeFact({ instance: a, content: `Doublon ${i} à propos de la cuisine, variante ${i * 13}.` }),
    )
    const others = Array.from({ length: 8 }, (_, i) =>
      mem.storeFact({ instance: a, content: `Autre règle ${i} à propos de la ${i % 2 === 0 ? 'voiture' : 'facture'}, détail ${i * 7}.` }),
    )
    await mem.indexEmbeddings()
    const db = dbOf(a)
    for (const f of dormant) db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(f.id)

    const links = await mem.memoryMapLinks(target.id)
    const neighbours = links!.neighbours.map(n => n.id)
    expect(neighbours).toHaveLength(6)
    const active = new Set(others.map(f => f.id))
    for (const id of neighbours) expect(active.has(id)).toBe(true)
  })

  it('agents : toutes les sources sont listées, même sans souvenir placé (couleurs stables)', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const b = mem.pairAssistant({ type: 'codex' }).assistant_instance_id
    for (let i = 0; i < 6; i++) mem.storeFact({ instance: a, content: `Note ${i} sur la ${TOPICS[i % 3]} du jour ${i}.` })
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()

    const before = await mem.memoryMap()
    expect(before.agents.find(x => x.id === b)).toMatchObject({ type: 'codex', points: 0, unplaced: 0 })

    // Le second agent gagne son premier souvenir : la liste des agents ne change pas.
    mem.storeFact({ instance: b, content: 'Première note du second agent sur la voiture.' })
    await mem.indexEmbeddings()
    mem.rebuildMemoryMap()
    await mem.memoryMapSettled()
    const after = await mem.memoryMap()
    expect(after.agents.find(x => x.id === b)?.points).toBe(1)
    expect(after.agents.map(x => x.id)).toEqual(before.agents.map(x => x.id))
  })

  it('deux calculs mélangés (dates différentes selon la base) : un calcul complet repart', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const b = mem.pairAssistant({ type: 'codex' }).assistant_instance_id
    for (let i = 0; i < 12; i++) {
      mem.storeFact({ instance: i % 2 === 0 ? a : b, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` })
    }
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()
    expect((await mem.memoryMap()).status).toBe('ready')

    // État laissé par un calcul dont l'écriture a échoué sur la seconde base
    // avant un redémarrage : la première porte une date plus récente.
    dbOf(a).prepare('UPDATE fact_projection SET computed_at = ?').run('2099-01-01T00:00:00.000Z')
    mem['mapAttempt'] = null

    expect((await mem.memoryMap()).status).toBe('computing')
    await mem.memoryMapSettled()
    const map = await mem.memoryMap()
    expect(map.status).toBe('ready')
    const dates = [a, b].map(
      id => (dbOf(id).prepare('SELECT COUNT(DISTINCT computed_at) AS n, MAX(computed_at) AS t FROM fact_projection').get() as { n: number; t: string }),
    )
    expect(dates.map(d => d.n)).toEqual([1, 1])
    expect(dates[0]!.t).toBe(dates[1]!.t)
  })

  it('indexation en cours : pas de recalcul automatique avant le délai minimal, bouton immédiat', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    for (let i = 0; i < 30; i++) mem.storeFact({ instance: a, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` })
    await mem.indexEmbeddings()
    await mem.memoryMap()
    await mem.memoryMapSettled()

    // 25 vecteurs de plus : au-dessus du seuil de retard, mais le calcul vient de finir.
    for (let i = 0; i < 25; i++) mem.storeFact({ instance: a, content: `Suite ${i} à propos de la ${TOPICS[i % 3]}, point ${i * 11}.` })
    await mem.indexEmbeddings()
    const soon = await mem.memoryMap()
    expect(soon.status).toBe('ready')
    expect(soon.unplaced).toBe(25)

    // Le délai passé, la lecture suivante relance le calcul.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + Memoria.MAP_AUTO_MIN_INTERVAL_MS + 1000)
      expect((await mem.memoryMap()).status).toBe('computing')
    } finally {
      vi.useRealTimers()
    }
    await mem.memoryMapSettled()
    expect((await mem.memoryMap()).points).toHaveLength(55)

    // Le bouton n'attend pas le délai.
    mem.storeFact({ instance: a, content: 'Une dernière règle à propos de la voiture.' })
    await mem.indexEmbeddings()
    expect(mem.rebuildMemoryMap()).toEqual({ started: true })
    await mem.memoryMapSettled()
    expect((await mem.memoryMap()).points).toHaveLength(56)
  })

  it('vecteur avec une valeur non finie : écarté, le calcul aboutit et ne repart pas en boucle', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const facts = Array.from({ length: 12 }, (_, i) =>
      mem.storeFact({ instance: a, content: `Règle ${i} à propos de la ${TOPICS[i % 3]}, détail ${i * 7}.` }),
    )
    await mem.indexEmbeddings()
    const broken = new Float32Array(DIM).fill(0.1)
    broken[2] = Number.NaN
    dbOf(a)
      .prepare("UPDATE embeddings SET vector = ? WHERE owner_type = 'fact' AND owner_id = ?")
      .run(Buffer.from(broken.buffer), facts[4]!.id)

    await mem.memoryMap()
    await mem.memoryMapSettled()
    const map = await mem.memoryMap()
    expect(map.status).toBe('ready')
    expect(map.points).toHaveLength(11)
    expect(map.points.map(p => p.id)).not.toContain(facts[4]!.id)
    expect(map.unplaced).toBe(1)
  })

  it('carte vide et aucun vecteur plaçable : un seul calcul, pas un par lecture', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const fact = mem.storeFact({ instance: a, content: 'Une seule note sur la cuisine.' })
    await mem.indexEmbeddings()
    const broken = new Float32Array(DIM).fill(Number.NaN)
    dbOf(a).prepare("UPDATE embeddings SET vector = ? WHERE owner_type = 'fact' AND owner_id = ?").run(Buffer.from(broken.buffer), fact.id)

    expect((await mem.memoryMap()).status).toBe('computing')
    await mem.memoryMapSettled()
    const start = vi.spyOn(mem, 'rebuildMemoryMap')
    expect((await mem.memoryMap()).status).toBe('empty')
    expect((await mem.memoryMap()).status).toBe('empty')
    expect(start).not.toHaveBeenCalled()
    start.mockRestore()
  })

  it('un recalcul supprime aussi les positions d’un ancien modèle', async () => {
    const a = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const facts = Array.from({ length: 6 }, (_, i) => mem.storeFact({ instance: a, content: `Note ${i} sur la ${TOPICS[i % 3]} du jour ${i}.` }))
    await mem.indexEmbeddings()
    const db = dbOf(a)
    db.prepare("INSERT INTO fact_projection (fact_id, model, x, y, computed_at) VALUES (?, 'ancien-modele', 0, 0, '2020-01-01T00:00:00.000Z')").run(
      facts[0]!.id,
    )
    await mem.memoryMap()
    await mem.memoryMapSettled()
    const rows = db.prepare('SELECT model, COUNT(*) AS n FROM fact_projection GROUP BY model').all()
    expect(rows).toEqual([{ model: 'fake-topic', n: 6 }])
  })
})

describe('runProjection : transfert du tampon', () => {
  it('un tableau qui occupe tout son tampon se transfère sans copie, une vue non', () => {
    const whole = new Float32Array(8)
    expect(ownsWholeBuffer(whole)).toBe(true)
    expect(ownsWholeBuffer(whole.subarray(2, 6))).toBe(false)
    expect(ownsWholeBuffer(new Float32Array(whole.buffer, 0, 4))).toBe(false)
  })
})

describe('insertions directes de faits : norm_hash posé à l’arrivée', () => {
  let root: string
  let mem: Memoria

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memoria-hash-'))
    mem = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
  })

  afterEach(() => {
    mem.close()
    rmSync(root, { recursive: true, force: true })
  })

  const missing = (path: string): number =>
    (mem['openContent'](path).db.prepare('SELECT COUNT(*) AS n FROM facts WHERE norm_hash IS NULL').get() as { n: number }).n

  it('adoptLegacyInto : une ligne sans hash en quarantaine arrive avec son hash', () => {
    const agent = mem.pairAssistant({ type: 'openclaw' }).assistant_instance_id
    const legacyPath = join(root, 'legacy.db')
    createSyntheticLegacyDb(legacyPath, { factCount: 10, procedureCount: 0 })
    importLegacyDb({ legacyPath, memoria: mem })
    const quarantine = mem.registry.dbForScope(mem.registry.getScopeByName('legacy_to_review')!.id)!.path
    mem['openContent'](quarantine).db.exec('UPDATE facts SET norm_hash = NULL')
    expect(missing(quarantine)).toBeGreaterThan(0)

    const adopted = mem.adoptLegacyInto(agent)
    expect(adopted.facts).toBeGreaterThan(0)
    expect(missing(mem.paths.assistantDb(agent))).toBe(0)
  })

  it('shareFacts : une ligne sans hash arrive avec son hash dans la base partagée', () => {
    const agent = mem.pairAssistant({ type: 'openclaw' }).assistant_instance_id
    const fact = mem.storeFact({ instance: agent, content: 'Le site est déployé sur un hébergeur statique.' })
    mem['openContent'](mem.paths.assistantDb(agent)).db.prepare('UPDATE facts SET norm_hash = NULL WHERE id = ?').run(fact.id)
    expect(mem.shareFacts([fact.id], 'user').shared).toBe(1)
    const userDb = mem.registry.dbForScope(mem.registry.getScopeByName('user')!.id)!.path
    expect(missing(userDb)).toBe(0)
  })
})
