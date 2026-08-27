/**
 * Les deux modes de POST /v1/memory/recall, rendus EXPLICITES :
 *  - sans provider d'embeddings, recallSemantic ≡ recall (FTS seul) ;
 *  - avec un provider (faux, injecté), la requête est embarquée et l'hybride
 *    FTS + vectoriel remonte le fait.
 * Auparavant ce chemin n'était exercé que par accident, contre le vrai Ollama
 * du poste — jamais en CI.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmbeddingProvider } from '@memoria/core'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon | null = null

afterEach(async () => {
  await daemon?.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

/** Embeddings déterministes (4 dimensions, sacs de mots) — zéro réseau. */
class FakeEmbeddings implements EmbeddingProvider {
  readonly name = 'fake'
  readonly model = 'fake-4d'
  readonly dimensions = 4
  embedded: string[] = []
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    this.embedded.push(...texts)
    return Promise.resolve(
      texts.map(t => {
        const w = t.toLowerCase()
        return Float32Array.from([w.includes('vendredi') ? 1 : 0, w.includes('studio') ? 1 : 0, w.includes('ferme') ? 1 : 0, 0.1])
      }),
    )
  }
}

async function boot(embeddings: EmbeddingProvider | null): Promise<DaemonClient> {
  root = mkdtempSync(join(tmpdir(), 'memoria-recall-modes-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null, embeddings } })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
  const agent = new DaemonClient(daemon.state, done.instance_token)
  await agent.storeFact({ content: 'Le studio ferme le vendredi après-midi' })
  await agent.storeFact({ content: 'Le devis GCSMS est parti le 24 août' })
  return agent
}

describe('POST /v1/memory/recall — modes', () => {
  it('sans embeddings : FTS seul, résultat identique à Memoria.recall()', async () => {
    const agent = await boot(null)
    const viaHttp = await agent.recall({ query: 'vendredi' })
    const instance = daemon!.memoria.listAgents()[0]!.instance.id
    const direct = daemon!.memoria.recall({ instance, query: 'vendredi' })
    expect(viaHttp.items.map(i => i.id)).toEqual(direct.items.map(i => i.id))
    expect(viaHttp.items).toHaveLength(1)
    expect(viaHttp.items[0]!.content).toContain('vendredi')
  })

  it('avec un provider d’embeddings (faux) : la requête est embarquée, l’hybride remonte le fait', async () => {
    const fake = new FakeEmbeddings()
    const agent = await boot(fake)
    await daemon!.memoria.indexEmbeddings() // les faits stockés reçoivent leur vecteur
    const before = fake.embedded.length
    expect(before).toBeGreaterThanOrEqual(2)
    const r = await agent.recall({ query: 'quand ferme le studio' })
    expect(fake.embedded.slice(before)).toEqual(['quand ferme le studio'])
    expect(r.items.some(i => i.content.includes('vendredi'))).toBe(true)
  })
})
