/**
 * Régression coût : processCognition ne renvoie PAS au LLM, à chaque capture,
 * les faits déjà traités (même quand le LLM n'y avait rien trouvé). Observé le
 * 27/08 en production : 10 → 112 appels gpt-4o-mini en trois minutes après une
 * seule capture, la base entière repartant au cloud à chaque tour.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria, type CompleteOptions, type LlmProvider } from '../src/index.js'

/** LLM dont on peut couper la disponibilité, qui compte ses appels graphe, et qui ne trouve RIEN. */
class GraphLlm implements LlmProvider {
  readonly name = 'openai'
  readonly model = 'gpt-4o-mini'
  available = true
  facts = 0
  graph = 0
  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available)
  }
  complete(opts: CompleteOptions): Promise<string> {
    const sys = opts.system ?? ''
    if (sys.includes('knowledge graph')) {
      this.graph++
      // Cas qui bouclait : le LLM ne trouve aucune entité → le fait restait « sans entité ».
      return Promise.resolve('{"entities":[],"relations":[]}')
    }
    if (sys.includes('topic title')) return Promise.resolve('Sujet Test')
    this.facts++
    return Promise.resolve(JSON.stringify([{ fact: `Fait numéro ${this.facts} sans nom propre`, category: 'context', confidence: 0.9 }]))
  }
}

let root: string
let m: Memoria
let llm: GraphLlm

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cogproc-'))
  llm = new GraphLlm()
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: llm }, secretsVault: 'aes-vault' })
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

async function capture(instance: string, text: string): Promise<void> {
  await m.captureTurn({ instance, messages: [{ role: 'user', content: text }] })
  await m.processCognition(instance)
}

describe('processCognition — marqueur fact_cognition', () => {
  it('un fait où le LLM ne trouve rien n’est PAS renvoyé au LLM à la capture suivante', async () => {
    const a = m.pairAssistant({ type: 'claude-code' })
    await capture(a.assistant_instance_id, 'on note ceci pour plus tard')
    const after1 = llm.graph
    expect(after1).toBeGreaterThan(0)

    await capture(a.assistant_instance_id, 'et encore autre chose à retenir')
    const after2 = llm.graph
    // Seuls les NOUVEAUX faits partent au LLM : pas de re-traitement du 1er.
    expect(after2 - after1).toBeLessThanOrEqual(llm.facts)

    // Un passage de plus sans nouveau fait : zéro appel.
    await m.processCognition(a.assistant_instance_id)
    expect(llm.graph).toBe(after2)
  })

  it('vu en heuristique (LLM indisponible) → re-tenté UNE fois quand le LLM revient, puis plus jamais', async () => {
    const a = m.pairAssistant({ type: 'claude-code' })
    llm.available = false
    await capture(a.assistant_instance_id, 'souvenir capturé pendant une panne du moteur')
    // Sans LLM disponible, l'extraction de faits ne tourne pas : on stocke directement.
    m.storeFact({ instance: a.assistant_instance_id, content: 'Fait déclaré à la main pendant la panne', category: 'context' })
    await m.processCognition(a.assistant_instance_id)
    expect(llm.graph).toBe(0)

    llm.available = true
    await m.processCognition(a.assistant_instance_id)
    const once = llm.graph
    expect(once).toBeGreaterThan(0)

    await m.processCognition(a.assistant_instance_id)
    expect(llm.graph).toBe(once)
  })
})
