/**
 * « Affiner les libellés (IA) » — le SEUL chemin qui renomme des thèmes déjà
 * en base (bouton de l'écran Thèmes, ou option `auto_themes_ai`).
 *
 * Son prompt imposait « Title Case » — une convention anglaise qui n'existe pas
 * en français — et sa réponse ne passait par AUCUN nettoyage : l'affinage
 * pouvait donc réintroduire exactement les libellés qu'on vient de corriger
 * (« Le Tarif Horaire »). On vérifie ici qu'il produit la même forme que les
 * thèmes créés automatiquement, et qu'une réponse hors sujet ne renomme rien.
 *
 * Faux modèle injecté, aucun réseau, stockage en tmpdir.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria, type CompleteOptions, type LlmProvider } from '../src/index.js'

/** Faux modèle : pas d'entité (le libellé passe par les mots-clés), réponse d'affinage pilotée. */
class RefineLlm implements LlmProvider {
  readonly name = 'fake'
  readonly model = 'fake-1'
  constructor(private answer: string) {}
  setAnswer(answer: string): void {
    this.answer = answer
  }
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    const sys = opts.system ?? ''
    if (sys.includes('Name the SUBJECT shared by these memories')) return Promise.resolve(this.answer)
    if (sys.includes('Name the SUBJECT of this memory')) return Promise.resolve('')
    if (sys.includes('knowledge graph')) return Promise.resolve('{"entities":[],"relations":[]}')
    return Promise.resolve('[]')
  }
}

let root: string
let m: Memoria
let llm: RefineLlm
let instance: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-refine-'))
  llm = new RefineLlm('Les Tarifs Du Studio')
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: llm }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
  m.storeFact({ instance, content: 'Le tarif horaire du studio est de 80 euros', category: 'config' })
  m.storeFact({ instance, content: 'Le tarif horaire des devis reste à 80 euros', category: 'config' })
  await m.processCognition(instance)
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('refineTopicLabels', () => {
  it('regroupe bien les deux faits sous un thème avant affinage', () => {
    const topics = m.listTopics(instance)
    expect(topics.length).toBe(1)
    expect(topics[0]!.fact_count).toBe(2)
    // Le libellé heuristique est déjà propre : accents, casse de phrase.
    expect(topics[0]!.name).toBe('Tarif horaire')
  })

  it('la réponse du modèle est nettoyée comme le reste : sans article, en casse de phrase', async () => {
    const res = await m.refineTopicLabels(instance)
    expect(res.refined).toBe(1)
    // « Les Tarifs Du Studio » → article retiré, mots écrits en minuscules dans
    // les faits redescendus en minuscules.
    expect(m.listTopics(instance)[0]!.name).toBe('Tarifs du studio')
  })

  it('le renommage met aussi à jour le slug — sinon deux thèmes homonymes plus tard', async () => {
    await m.refineTopicLabels(instance)
    const db = (m as unknown as { registry: { dbForInstance(i: string): { path: string } } }).registry.dbForInstance(instance)!
    const store = (m as unknown as { openContent(p: string): { db: import('better-sqlite3').Database } }).openContent(db.path)
    const row = store.db.prepare('SELECT name, slug FROM topics').get() as { name: string; slug: string }
    expect(row.name).toBe('Tarifs du studio')
    expect(row.slug).toBe('tarifs-du-studio')
  })

  it('une réponse hors sujet (JSON) ne renomme RIEN', async () => {
    llm.setAnswer('{"topics":[]}')
    const res = await m.refineTopicLabels(instance)
    expect(res.refined).toBe(0)
    expect(m.listTopics(instance)[0]!.name).toBe('Tarif horaire')
  })

  it('un titre identique au nom actuel ne compte pas comme un renommage', async () => {
    llm.setAnswer('Le tarif horaire')
    const res = await m.refineTopicLabels(instance)
    expect(res.refined).toBe(0)
    expect(m.listTopics(instance)[0]!.name).toBe('Tarif horaire')
  })
})
