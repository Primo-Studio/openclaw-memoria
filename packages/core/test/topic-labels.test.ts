/**
 * LIBELLÉS DE THÈMES — ce que l'utilisateur lit dans « Thèmes ».
 *
 * Sur la mémoire réelle, les thèmes s'appelaient « Prefere Appelle Neto »,
 * « Le Memoria CLI », « Part Tarif Horaire », « Nouveau Boitier » : accents
 * perdus, article de tête gardé, chaque mot re-capitalisé (un prénom devient
 * indistinct d'un mot commun), et un extrait de phrase à la place d'un nom de
 * sujet. Les cas de ce fichier sont ces QUATRE exemples réels — entrée → sortie.
 *
 * Aucun réseau, aucun LLM : tout est heuristique, DB en tmpdir pour l'intégration.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContentStore } from '../src/storage/content.js'
import { CognitionEngine } from '../src/cognition/index.js'
import { TopicEngine, cleanTopicLabel, topicKeywordSurfaces } from '../src/cognition/topics.js'
import type { LlmProvider } from '../src/llm/provider.js'

describe('topicKeywordSurfaces (mots du fait, TELS QU’ÉCRITS)', () => {
  it('garde les accents et la casse — la normalisation ne sert qu’à comparer', () => {
    expect(topicKeywordSurfaces('Préfère qu’on l’appelle Néto.')).toEqual(['Préfère', 'appelle', 'Néto'])
    expect(topicKeywordSurfaces('Nouveau boîtier chez le client.')).toEqual(['Nouveau', 'boîtier', 'client'])
  })

  it('écarte les mots-outils qui font des noms de sujet bancals', () => {
    // « part », « chez », « depuis » : jamais le début d'un nom de sujet.
    expect(topicKeywordSurfaces('Il part du tarif horaire de 80 euros.')).not.toContain('part')
    expect(topicKeywordSurfaces('Le boîtier est chez le client depuis mardi.')).toEqual(['boîtier', 'client', 'mardi'])
  })

  it('ne répète pas deux fois le même mot', () => {
    expect(topicKeywordSurfaces('Le tarif horaire et le tarif journalier')).toEqual(['tarif', 'horaire', 'journalier'])
  })
})

describe('cleanTopicLabel (mise en forme d’un libellé)', () => {
  it('retire l’article de tête — « Le Memoria CLI » → « Memoria CLI »', () => {
    expect(cleanTopicLabel('Le Memoria CLI')).toBe('Memoria CLI')
    expect(cleanTopicLabel('Les devis GCSMS')).toBe('Devis GCSMS')
    expect(cleanTopicLabel('L’application PixConsent')).toBe('Application PixConsent')
    expect(cleanTopicLabel('The Vercel deployment')).toBe('Vercel deployment')
    expect(cleanTopicLabel('De la mairie de Saint-Laurent')).toBe('Mairie de Saint-Laurent')
  })

  it('garde une particule de NOM : « De Souza » n’est pas « Souza »', () => {
    expect(cleanTopicLabel('De Souza contrat')).toBe('De Souza contrat')
    expect(cleanTopicLabel('Du Bellay poèmes')).toBe('Du Bellay poèmes')
    expect(cleanTopicLabel('D’Artagnan mousquetaire')).toBe('D’Artagnan mousquetaire')
    // Suivie d'une minuscule, la même particule redevient un début de phrase.
    expect(cleanTopicLabel('De la mairie de Saint-Laurent')).toBe('Mairie de Saint-Laurent')
    expect(cleanTopicLabel('Du tarif horaire')).toBe('Tarif horaire')
  })

  it('retire aussi une préposition de tête — un sujet ne commence pas par « Sur »', () => {
    expect(cleanTopicLabel('Sur Hello-Primo Vercel')).toBe('Hello-Primo Vercel')
    expect(cleanTopicLabel('Au tarif horaire')).toBe('Tarif horaire')
    expect(cleanTopicLabel('En Guyane')).toBe('Guyane')
    // Deux passes au plus : préposition + article.
    expect(cleanTopicLabel('Pour le client Maroway')).toBe('Client Maroway')
    // Un mot COMPOSÉ n'est pas un mot-outil : « Sous-traitance » reste entier.
    expect(cleanTopicLabel('Sous-traitance Awara')).toBe('Sous-traitance Awara')
  })

  it('garde les sigles et la casse interne (CLI, API, MCP, RSMA, JamBoard, macOS)', () => {
    expect(cleanTopicLabel('Le serveur MCP')).toBe('Serveur MCP')
    expect(cleanTopicLabel('API Directus')).toBe('API Directus')
    expect(cleanTopicLabel('Gala RSMA 2026')).toBe('Gala RSMA 2026')
    expect(cleanTopicLabel('JamBoard TestFlight')).toBe('JamBoard TestFlight')
    expect(cleanTopicLabel('macOS Tahoe')).toBe('macOS Tahoe')
  })

  it('casse de PHRASE et non Title Case, quand le fait écrit le mot en minuscules', () => {
    // « Part Tarif Horaire » : le fait dit « tarif horaire », donc minuscules.
    expect(cleanTopicLabel('Tarif Horaire', { source: 'Il part du tarif horaire de 80 euros.' })).toBe('Tarif horaire')
    expect(cleanTopicLabel('Nouveau Boitier', { source: 'Nouveau boitier installé.' })).toBe('Nouveau boitier')
  })

  it('ne démajuscule JAMAIS un nom propre absent du fait en minuscules', () => {
    // Le fait n'écrit jamais « hélène » ni « rey » : ce sont des noms.
    expect(cleanTopicLabel('Devis Hélène Rey', { source: 'Devis envoyé à Hélène Rey pour la plénière.' })).toBe(
      'Devis Hélène Rey',
    )
    expect(cleanTopicLabel('Site Primo Studio', { source: 'Le site Primo Studio est hébergé sur Vercel.' })).toBe(
      'Site Primo Studio',
    )
  })

  it('borne la longueur : un nom de sujet, pas une phrase', () => {
    expect(cleanTopicLabel('un très long libellé de thème qui raconte toute une histoire')).toBe(
      'Très long libellé de',
    )
    expect(cleanTopicLabel('Néto préfère le café serré', { maxWords: 2 })).toBe('Néto préfère')
  })

  it('nettoie ce que rend un LLM bavard (guillemets, point final, dièse)', () => {
    expect(cleanTopicLabel('  "Le tarif horaire."  ', { source: 'tarif horaire' })).toBe('Tarif horaire')
    expect(cleanTopicLabel('# Memoria CLI')).toBe('Memoria CLI')
  })

  it('ne rend jamais une chaîne vide (repli sur l’entrée)', () => {
    expect(cleanTopicLabel('...')).toBe('...')
    expect(cleanTopicLabel('Le')).toBe('Le')
  })
})

describe('TopicEngine — les 4 libellés réels, avant → après', () => {
  let dir: string
  let store: ContentStore
  let cognition: CognitionEngine
  let topics: TopicEngine

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-topic-labels-'))
    store = new ContentStore(join(dir, 'c.sqlite'))
    cognition = new CognitionEngine({ store })
    topics = new TopicEngine({ store })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Insère un fait, peuple ses entités, le range dans un thème, rend le nom du
   * thème. `entities: false` simule le cas — courant en production — où
   * l'extraction n'a trouvé AUCUNE entité : le libellé vient alors des mots du
   * fait, et c'est là que les accents étaient perdus.
   */
  async function labelOf(text: string, opts: { entities?: boolean } = {}): Promise<string> {
    const f = store.insertFact({ fact: text, scope_id: `s-${Math.random()}` })
    if (opts.entities !== false) await cognition.processFact(f.id)
    await topics.assignFact(f.id)
    return topics.topicsForFact(f.id)[0]?.name ?? ''
  }

  it('« Prefere Appelle Neto » → le NOM, avec son accent', async () => {
    const label = await labelOf('Préfère qu’on l’appelle Néto.')
    expect(label).toBe('Néto')
  })

  it('« Part Tarif Horaire » → « Tarif horaire » (sans le mot-outil, sans Title Case)', async () => {
    const label = await labelOf('Il part du tarif horaire de 80 euros pour le développement.')
    expect(label).toBe('Tarif horaire')
  })

  it('« Nouveau Boitier » → « Nouveau boîtier » (accent rendu, casse de phrase)', async () => {
    const label = await labelOf('Nouveau boîtier installé dans le local technique.', { entities: false })
    expect(label).toBe('Nouveau boîtier')
  })

  it('« Le Memoria CLI » → le sigle intact, sans article', async () => {
    const label = await labelOf('Le CLI Memoria se lance avec la commande memoria doctor.')
    expect(label).toBe('CLI Memoria')
    expect(label).not.toMatch(/^Le /)
  })

  it('aucun libellé ne perd d’accent ni ne re-capitalise mot à mot', async () => {
    const labels = [
      await labelOf('Préfère qu’on l’appelle Néto.'),
      await labelOf('Il part du tarif horaire de 80 euros pour le développement.'),
      await labelOf('Nouveau boîtier installé dans le local technique.', { entities: false }),
    ]
    for (const label of labels) {
      // Pas d'article de tête.
      expect(label.split(' ')[0]?.toLowerCase()).not.toBe('le')
      // Pas de Title Case : au plus un mot capitalisé (le premier), sigles exceptés.
      const recapitalised = label
        .split(' ')
        .slice(1)
        .filter(w => /^\p{Lu}/u.test(w) && w !== w.toUpperCase())
      expect(recapitalised).toEqual([])
    }
    // L'accent survit au passage par les mots-clés normalisés.
    expect(labels.join(' ')).toContain('Néto')
    expect(labels.join(' ')).toContain('boîtier')
  })
})

describe('TopicEngine — libellé venu du LLM', () => {
  let dir: string
  let store: ContentStore
  let topics: TopicEngine

  /** Faux modèle : répond ce qu'on lui dit, sans réseau. */
  function stubLlm(answer: string): LlmProvider {
    return {
      name: 'stub',
      model: 'stub',
      isAvailable: async () => true,
      complete: async () => answer,
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-topic-llm-'))
    store = new ContentStore(join(dir, 'c.sqlite'))
    topics = new TopicEngine({ store })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Sans entités (aucun appel à la cognition) : le libellé heuristique tient en un mot → le LLM est sollicité. */
  async function labelWithLlm(text: string, answer: string): Promise<string> {
    topics.setLlm(stubLlm(answer))
    const f = store.insertFact({ fact: text, scope_id: `s-${Math.random()}` })
    await topics.assignFact(f.id)
    return topics.topicsForFact(f.id)[0]?.name ?? ''
  }

  it('la réponse du modèle passe par le même nettoyage : article de tête retiré', async () => {
    // « Ce tarif. » n'a qu'un mot-clé → libellé heuristique d'un seul mot → le
    // modèle est sollicité, et sa réponse est nettoyée comme le reste.
    const label = await labelWithLlm('Ce tarif.', 'Le tarif horaire du studio')
    expect(label).toBe('Tarif horaire du studio')
  })

  it('une réponse hors sujet (JSON) est REFUSÉE : on garde l’heuristique', async () => {
    const label = await labelWithLlm('Ce tarif.', '{"facts":[]}')
    expect(label).toBe('Tarif')
    expect(label).not.toContain('{')
  })
})
