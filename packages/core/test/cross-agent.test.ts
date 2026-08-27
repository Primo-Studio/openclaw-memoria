/**
 * Mémoire PARTAGÉE entre modèles (audit 27/08) : ce que deux agents (Codex et
 * Claude Code) voient, ne voient pas, et peuvent faire sur un même souvenir.
 *
 * Chaque scénario reproduit un constat de l'audit AVANT son correctif :
 *  - partager un fait DORMANT (revue en attente) ne doit ni le perdre ni le
 *    laisser en revue orpheline ;
 *  - (autres scénarios ajoutés au fil des correctifs).
 * Fake LLM déterministe, tout en tmpdir, aucun réseau.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria, type CompleteOptions, type LlmProvider, type PairAssistantResult } from '../src/index.js'

/** LLM fake : renvoie toujours le même fait sur l'utilisateur (candidat au partage). */
class FakeExtraction implements LlmProvider {
  readonly name = 'fake'
  readonly model = 'fake'
  facts: Array<{ fact: string; category: string; confidence: number }> = [
    { fact: 'Neto Pompeu préfère le café serré', category: 'preference', confidence: 0.9 },
  ]
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  complete(_opts: CompleteOptions): Promise<string> {
    return Promise.resolve(JSON.stringify({ facts: this.facts }))
  }
}

let root: string
let m: Memoria
let llm: FakeExtraction
let codex: PairAssistantResult
let claude: PairAssistantResult

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-cross-'))
  llm = new FakeExtraction()
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: llm }, secretsVault: 'aes-vault' })
  codex = m.pairAssistant({ type: 'codex', display_name: 'Codex' })
  claude = m.pairAssistant({ type: 'claude-code', display_name: 'Claude Code' })
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

const userDb = () => m['openContent'](m.paths.sharedDb('user'))
const privateDb = (a: PairAssistantResult) => m['openContent'](m.paths.assistantDb(a.assistant_instance_id))

describe('partage d’un fait dormant (review-first)', () => {
  it('suggestIdentityFacts ne propose pas un fait encore en revue', async () => {
    m.setCaptureMode('review-first')
    const cap = await m.captureTurn({ instance: codex.assistant_instance_id, messages: [{ role: 'assistant', content: 'Neto préfère le café serré.' }] })
    expect(cap.facts_created).toBe(1)
    expect(m.listReview()).toHaveLength(1)

    // Le fait est dormant : il attend l'écran Revue, pas l'écran Partage.
    expect(m.suggestIdentityFacts(codex.assistant_instance_id)).toHaveLength(0)
  })

  it('partager un dormant = le valider : visible des deux agents, revue vidée, aucun item orphelin', async () => {
    m.setCaptureMode('review-first')
    await m.captureTurn({ instance: codex.assistant_instance_id, messages: [{ role: 'assistant', content: 'Neto préfère le café serré.' }] })
    const pending = m.listReview()
    expect(pending).toHaveLength(1)

    const res = m.shareFacts([pending[0]!.fact_id], 'user')
    expect(res.shared).toBe(1)

    // Les deux agents le retrouvent (un fait partagé mais invisible = perdu pour tous).
    expect(m.recall({ instance: claude.assistant_instance_id, query: 'café serré préfère' }).items).toHaveLength(1)
    expect(m.recall({ instance: codex.assistant_instance_id, query: 'café serré préfère' }).items).toHaveLength(1)
    expect(userDb().db.prepare('SELECT lifecycle_state FROM facts').all()).toEqual([{ lifecycle_state: 'active' }])

    // Plus rien en revue, et pas d'item `pending` pointant vers un fait parti.
    expect(m.listReview()).toHaveLength(0)
    const orphans = privateDb(codex).db.prepare("SELECT COUNT(*) AS c FROM memory_import_items WHERE status = 'pending'").get() as { c: number }
    expect(orphans.c).toBe(0)

    // Une approbation ultérieure sur l'ancien item n'a plus rien à faire (pas de faux succès).
    expect(m.reviewDecision(pending.map(p => p.id), 'accepted')).toEqual({ updated: 0 })
  })
})
