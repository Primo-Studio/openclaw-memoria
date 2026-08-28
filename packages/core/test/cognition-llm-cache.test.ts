/**
 * Régression : les moteurs cognitifs (graphe, thèmes) sont mis en cache PAR
 * STORE. Avant le correctif, un premier appel de LECTURE (recall, listTopics —
 * llm=null) figeait le moteur sans LLM : l'extraction graphe et les libellés
 * LLM n'étaient plus jamais utilisés pour ce store — sans aucun signal
 * (« mort silencieuse », le pattern que Memoria V3 interdit).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria, type CompleteOptions, type LlmProvider } from '../src/index.js'

/** Fake qui distingue les TROIS prompts : faits, graphe d'entités, titre de thème. */
class CountingLlm implements LlmProvider {
  readonly name = 'fake'
  readonly model = 'fake-1'
  facts = 0
  graph = 0
  titles = 0
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    const sys = opts.system ?? ''
    if (sys.includes('knowledge graph')) {
      this.graph++
      return Promise.resolve('{"entities":[{"name":"Vercel","type":"tool"},{"name":"Primo","type":"company"}],"relations":[{"from":"Primo","to":"Vercel","type":"deployed_on"}]}')
    }
    if (sys.includes('Name the SUBJECT')) {
      this.titles++
      return Promise.resolve('Déploiement Primo')
    }
    this.facts++
    return Promise.resolve(JSON.stringify([{ fact: 'Néto déploie le site Primo sur Vercel', category: 'config', confidence: 0.9 }]))
  }
}

let root: string
let m: Memoria
let llm: CountingLlm

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cogcache-'))
  llm = new CountingLlm()
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: llm }, secretsVault: 'aes-vault' })
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('cache des moteurs cognitifs', () => {
  it('lire AVANT de capturer ne prive pas le store de l’extraction graphe LLM', async () => {
    const a = m.pairAssistant({ type: 'claude-code' })
    // Lectures/maintenance d'abord : ces chemins passent llm=null aux moteurs
    // (decayCognition → cognitionFor(store, null) ; listTopics → topicFor(store, null)).
    expect(m.listTopics(a.assistant_instance_id)).toEqual([])
    expect(m.decayCognition()).toEqual({ decayed: 0, pruned: 0 })
    expect(m.recall({ instance: a.assistant_instance_id, query: 'Vercel' }).items).toEqual([])

    await m.captureTurn({
      instance: a.assistant_instance_id,
      messages: [
        { role: 'user', content: 'On déploie le site sur quoi déjà ?' },
        { role: 'assistant', content: 'Sur Vercel, avec le compte dédié Primo.' },
      ],
    })
    await m.processCognition(a.assistant_instance_id)

    expect(llm.facts).toBeGreaterThan(0)
    // AVANT le correctif : graph === 0 (moteur figé en heuristique par le recall précédent).
    expect(llm.graph).toBeGreaterThan(0)
  })

  it('les entités extraites par le LLM sont bien persistées (le LLM sert vraiment)', async () => {
    const a = m.pairAssistant({ type: 'claude-code' })
    m.decayCognition() // maintenance avant capture : moteur créé avec llm=null
    await m.captureTurn({
      instance: a.assistant_instance_id,
      messages: [{ role: 'user', content: 'Le site Primo est déployé sur Vercel.' }],
    })
    await m.processCognition(a.assistant_instance_id)
    // Le recall par entité (expandEntities) retrouve le fait via « Vercel » ↔ « Primo ».
    const r = m.recall({ instance: a.assistant_instance_id, query: 'Primo' })
    expect(r.items.some(i => i.content.includes('Vercel'))).toBe(true)
  })
})
