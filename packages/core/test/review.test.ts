/**
 * Mode review-first (spec §13 « Import & revue », décision v2.1 #8) :
 * les faits capturés naissent DORMANTS + en file de revue ; approuver = activer,
 * rejeter = hard-delete. Rien ne sort au recall avant approbation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Memoria, type CompleteOptions, type EmbeddingProvider, type LlmProvider } from '../src/index.js'

class FakeExtraction implements LlmProvider {
  readonly name = 'fake'
  readonly model = 'fake'
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(_opts: CompleteOptions): Promise<string> {
    return Promise.resolve(JSON.stringify({ facts: [{ fact: 'Le serveur de staging tourne sur scaleway', category: 'config', confidence: 0.85 }] }))
  }
}

/** Embeddings factices : compte les textes envoyés (ce qui partirait au cloud). */
class FakeEmbeddings implements EmbeddingProvider {
  readonly name = 'fake'
  readonly model = 'fake-4d'
  readonly dimensions = 4
  sent: string[] = []
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    this.sent.push(...texts)
    return Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0, 0])))
  }
}

let root: string
let m: Memoria
let instance: string
let embeddings: FakeEmbeddings

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-review-'))
  m = Memoria.init({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: new FakeExtraction(), embeddings: (embeddings = new FakeEmbeddings()) },
    secretsVault: 'aes-vault',
  })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
  m.setCaptureMode('review-first')
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('review-first', () => {
  it('capture → fait dormant + pending ; invisible au recall ; approbation → visible', async () => {
    const cap = await m.captureTurn({
      instance,
      messages: [{ role: 'assistant', content: 'Le staging est chez Scaleway.' }],
    })
    expect(cap.mode).toBe('review-first')
    expect(cap.facts_created).toBe(1)

    // invisible tant que non approuvé
    expect(m.recall({ instance, query: 'serveur staging scaleway' }).items).toHaveLength(0)

    const pending = m.listReview()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.content).toContain('scaleway')
    expect(pending[0]!.source_type).toBe('capture-review')

    const { updated } = m.reviewDecision([pending[0]!.id], 'accepted')
    expect(updated).toBe(1)

    expect(m.recall({ instance, query: 'serveur staging scaleway' }).items).toHaveLength(1)
    expect(m.listReview()).toHaveLength(0)
  })

  it('un fait dormant n’est PAS embeddé avant revue ; l’approbation déclenche son indexation', async () => {
    await m.captureTurn({ instance, messages: [{ role: 'assistant', content: 'Le staging est chez Scaleway.' }] })
    await m.indexEmbeddings() // ce que le post-capture fait en arrière-plan
    expect(embeddings.sent).toHaveLength(0) // rien n'est parti : le fait attend sa revue
    expect(await m.embeddingsPending()).toBe(0) // et la santé ne le compte pas comme « à faire »

    const pending = m.listReview()
    m.reviewDecision([pending[0]!.id], 'accepted')
    await vi.waitFor(() => expect(embeddings.sent).toHaveLength(1))
  })

  it('rejet → hard-delete (aucune trace, même en dormant)', async () => {
    await m.captureTurn({ instance, messages: [{ role: 'assistant', content: 'Le staging est chez Scaleway.' }] })
    const pending = m.listReview()
    expect(pending).toHaveLength(1)

    m.reviewDecision([pending[0]!.id], 'rejected')

    expect(m.recall({ instance, query: 'staging scaleway', include_dormant: true }).items).toHaveLength(0)
    const store = m['openContent'](m.paths.assistantDb(instance))
    expect(store.countFacts()).toBe(0)
    expect(m.listReview()).toHaveLength(0)
  })

  it('en auto-private, pas de file de revue (capture directe active)', async () => {
    m.setCaptureMode('auto-private')
    await m.captureTurn({ instance, messages: [{ role: 'assistant', content: 'Le staging est chez Scaleway.' }] })
    expect(m.listReview()).toHaveLength(0)
    expect(m.recall({ instance, query: 'staging scaleway' }).items).toHaveLength(1)
  })
})
