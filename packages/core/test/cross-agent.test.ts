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

/**
 * Écriture DIRECTE dans le scope partagé « user » (décision produit 27/08 :
 * « améliorer les souvenirs entre les modèles »). Un agent déclare un fait sur
 * l'utilisateur → tous les autres modèles le voient, sans clic de partage.
 */
describe('écriture directe dans `user`', () => {
  it('un fait posé par Codex dans `user` est rappelé par Claude, sans jamais toucher son privé', () => {
    const f = m.storeFact({ instance: codex.assistant_instance_id, scope: 'user', content: 'Néto travaille depuis Saint-Laurent-du-Maroni', category: 'identity' })
    expect(f.visibility).toBe('shared')
    const seen = m.recall({ instance: claude.assistant_instance_id, query: 'Néto travaille Saint-Laurent-du-Maroni' }).items
    expect(seen).toHaveLength(1)
    expect(seen[0]!.source_db).toBe('shared/user.sqlite')
    expect(privateDb(claude).getFact(f.id)).toBeNull()
    expect(userDb().getFact(f.id)).not.toBeNull()
  })

  it('refuse si la gouvernance a retiré can_write sur `user`', () => {
    const userScope = m.registry.getScopeByName('user')!
    m.setScopeAccess(codex.assistant_id, userScope.id, { can_write: false })
    expect(() => m.storeFact({ instance: codex.assistant_instance_id, scope: 'user', content: 'tentative' })).toThrow(/écriture refusée/)
  })

  it('migration douce : une policy user sans can_write jamais touchée à la main est ouverte au redémarrage', () => {
    const userScope = m.registry.getScopeByName('user')!
    // Codex : ancienne policy (avant la décision), jamais modifiée manuellement → ouverte.
    m.registry.setPolicy({ assistant_id: codex.assistant_id, scope_id: userScope.id, can_read: true, can_write: false, can_share: false, secret_access: 'none' })
    // Claude : l'utilisateur a EXPLICITEMENT retiré l'écriture (audité) → respecté.
    m.setScopeAccess(claude.assistant_id, userScope.id, { can_write: false })
    m.close()

    m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: llm }, secretsVault: 'aes-vault' })
    expect(m.registry.getPolicy(codex.assistant_id, userScope.id)?.can_write).toBe(true)
    expect(m.registry.getPolicy(claude.assistant_id, userScope.id)?.can_write).toBe(false)
  })

  it('écrire dans le scope privé d’un AUTRE agent est refusé (le fait serait invisible pour tous)', () => {
    expect(() =>
      m.storeFact({ instance: codex.assistant_instance_id, scope: `private:${claude.assistant_instance_id}`, content: 'intrusion' }),
    ).toThrow(/écriture refusée/)
    expect(privateDb(codex).countFacts()).toBe(0)
    expect(privateDb(claude).countFacts()).toBe(0)
  })
})

/**
 * Opérations d'un agent sur un fait PARTAGÉ (id remonté par son recall depuis
 * shared/user.sqlite). Avant : chaque méthode n'ouvrait que la DB privée →
 * false / { replacement: null } / { updated: [] } sans un mot, et la mémoire
 * partagée ne s'améliorait jamais par l'usage.
 */
describe('opérations sur un fait partagé', () => {
  const shareOne = (content = 'Néto préfère les réponses en français') => {
    const f = m.storeFact({ instance: codex.assistant_instance_id, content, category: 'preference' })
    m.shareFacts([f.id], 'user')
    return f.id
  }

  it('feedback « useful » sur un fait partagé renforce used_count dans user.sqlite', () => {
    const id = shareOne()
    const seen = m.recall({ instance: claude.assistant_instance_id, query: 'réponses français préfère' }).items
    expect(seen.map(i => i.id)).toEqual([id])
    const r = m.reinforceFacts(claude.assistant_instance_id, [id], true)
    expect(r.updated).toEqual([id])
    expect(r.domains).toEqual(['preference'])
    const row = userDb().db.prepare('SELECT used_count, relevance_weight FROM facts WHERE id = ?').get(id) as { used_count: number; relevance_weight: number }
    expect(row.used_count).toBe(1)
    expect(row.relevance_weight).toBeGreaterThan(1)
  })

  it('pin et expiry sur un fait partagé sont effectifs (et refusés sans can_write)', () => {
    const id = shareOne()
    expect(m.setPinned(claude.assistant_instance_id, id, true)).toBe(true)
    expect((userDb().db.prepare('SELECT pinned FROM facts WHERE id = ?').get(id) as { pinned: number }).pinned).toBe(1)
    expect(m.setExpiry(claude.assistant_instance_id, id, '2099-01-01T00:00:00.000Z')).toBe(true)
    expect((userDb().db.prepare('SELECT expires_at FROM facts WHERE id = ?').get(id) as { expires_at: string }).expires_at).toBe('2099-01-01T00:00:00.000Z')

    const userScope = m.registry.getScopeByName('user')!
    m.setScopeAccess(claude.assistant_id, userScope.id, { can_write: false })
    expect(() => m.setPinned(claude.assistant_instance_id, id, false)).toThrow(/écriture refusée/)
    // Un id inconnu de tous les scopes lisibles reste un simple `false` (contrat daemon).
    expect(m.setPinned(claude.assistant_instance_id, 'inexistant', true)).toBe(false)
  })

  it('corriger un fait partagé : le remplaçant vit dans user.sqlite et l’autre agent le voit', () => {
    const id = shareOne()
    const { replacement } = m.correctFact(claude.assistant_instance_id, id, 'Néto préfère les réponses en français, courtes')
    expect(replacement).not.toBeNull()
    expect(userDb().getFact(replacement!.id)).not.toBeNull()
    expect(privateDb(claude).getFact(replacement!.id)).toBeNull()
    const old = userDb().db.prepare('SELECT superseded, superseded_by FROM facts WHERE id = ?').get(id) as { superseded: number; superseded_by: string }
    expect(old).toEqual({ superseded: 1, superseded_by: replacement!.id })
    // Codex repart avec la version corrigée, pas l'ancienne.
    const seen = m.recall({ instance: codex.assistant_instance_id, query: 'réponses français préfère' }).items
    expect(seen.map(i => i.id)).toEqual([replacement!.id])
  })

  it('fusionner deux faits partagés', () => {
    const a = shareOne('Néto écrit ses commits en français')
    const b = shareOne('Néto rédige ses messages de commit en français')
    expect(m.mergeFacts(claude.assistant_instance_id, a, [b]).merged).toEqual([b])
    const row = userDb().db.prepare('SELECT superseded_by FROM facts WHERE id = ?').get(b) as { superseded_by: string }
    expect(row.superseded_by).toBe(a)
  })
})
