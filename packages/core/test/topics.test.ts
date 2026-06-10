/**
 * Couche TOPICS : range les faits par thème (entité-first, 0 LLM par défaut).
 * Vérifie : faits d'un même sujet → même topic ; sans rapport → topics
 * distincts ; idempotence ; tri par importance ; onForget vide le topic.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContentStore } from '../src/storage/content.js'
import { CognitionEngine } from '../src/cognition/index.js'
import { TopicEngine } from '../src/cognition/topics.js'

let dir: string
let store: ContentStore
let cognition: CognitionEngine
let topics: TopicEngine

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-topics-'))
  store = new ContentStore(join(dir, 'c.sqlite'))
  cognition = new CognitionEngine({ store })
  topics = new TopicEngine({ store })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Insère un fait, peuple ses entités (graph), puis le range dans un topic. */
async function add(text: string, scope = 's1'): Promise<string> {
  const f = store.insertFact({ fact: text, scope_id: scope })
  await cognition.processFact(f.id) // peuple fact_entities
  await topics.assignFact(f.id)
  return f.id
}

describe('TopicEngine', () => {
  it('deux faits sur le même sujet (entités communes) → même topic', async () => {
    await add('Le déploiement du projet Vercel utilise le compte Hello-Primo')
    await add('Le projet Vercel échoue parfois quand le cache Hello-Primo est corrompu')
    const list = topics.listTopics()
    // au moins un topic regroupe les deux faits Vercel/Hello-Primo
    const vercel = list.find(t => /vercel|hello/i.test(t.name) && t.fact_count >= 2)
    expect(vercel).toBeTruthy()
  })

  it('faits sans rapport → topics distincts, label lisible', async () => {
    await add('La recette de cuisine du dimanche utilise du curcuma frais')
    await add('Le serveur Directus est derrière Cloudflare en Guyane')
    const list = topics.listTopics()
    expect(list.length).toBeGreaterThanOrEqual(2)
    // labels non vides et lisibles
    for (const t of list) expect(t.name.length).toBeGreaterThan(2)
  })

  it('idempotent : re-assigner ne duplique pas le lien', async () => {
    const id = await add('Le client Transport Rino veut des bons de livraison numériques')
    await topics.assignFact(id)
    await topics.assignFact(id)
    const tf = topics.topicsForFact(id)
    expect(tf.length).toBeGreaterThan(0)
    const links = store.db.prepare('SELECT COUNT(*) AS c FROM fact_topics WHERE fact_id = ?').get(id) as { c: number }
    expect(links.c).toBe(tf.length) // pas de doublon
  })

  it('listTopics trié par importance ; factsForTopic retourne les faits', async () => {
    await add('Le projet Memoria tourne en TypeScript sur Node')
    await add('Le projet Memoria utilise sqlite-vec pour le recall')
    await add('Le projet Memoria a un daemon local unique')
    const list = topics.listTopics()
    expect(list[0]!.importance_score).toBeGreaterThanOrEqual(list[list.length - 1]!.importance_score)
    const memoria = list.find(t => /memoria/i.test(t.name))
    if (memoria) {
      const facts = topics.factsForTopic(memoria.id)
      expect(facts.length).toBe(memoria.fact_count)
    }
  })

  it('onForget vide le topic et le supprime s’il devient vide', async () => {
    const id = await add('Sujet unique sur le serveur Scaleway de staging')
    const before = topics.topicsForFact(id)
    expect(before.length).toBeGreaterThan(0)
    const removed = topics.onForget([id])
    expect(removed).toBeGreaterThan(0)
    expect(topics.listTopics().find(t => t.id === before[0]!.id)).toBeUndefined()
  })

  it('assignPending range les faits non classés', async () => {
    const f1 = store.insertFact({ fact: 'Note sur le pipeline CI GitHub Actions', scope_id: 's1' })
    const f2 = store.insertFact({ fact: 'Le pipeline CI GitHub échoue sur Node 20', scope_id: 's1' })
    await cognition.processFact(f1.id)
    await cognition.processFact(f2.id)
    const done = await topics.assignPending()
    expect(done).toBe(2)
    expect(topics.topicsForFact(f1.id).length).toBeGreaterThan(0)
  })
})
