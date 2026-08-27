/**
 * Expertise : « maîtrise » affichée par le Dashboard/Agents (topDomains).
 * Un seul bootstrapExpertise mettait TOUS les thèmes ≥ 3 faits à 1.0
 * (« expert confirmé ») : delta = log1p(fact_count) ≥ 1.39 dans une
 * saturation `prev + delta × (1 − prev)`. Information fausse pour
 * l'utilisateur, et chaque nouveau bootstrap regonflait encore.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/index.js'

let root: string
let m: Memoria
let instance: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-expertise-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('bootstrapExpertise', () => {
  it('amorce un niveau modeste (< 0.5), idempotent, sans jamais écraser un niveau gagné par l’usage', () => {
    // Un thème de 4 faits, semé directement : c'est l'amorce d'expertise qui
    // est testée, pas le regroupement heuristique des thèmes.
    const store = m['openContent'](m.paths.assistantDb(instance))
    store.db
      .prepare("INSERT INTO topics (id, name, importance_score, keywords, created_at, fact_count) VALUES ('t-vercel', 'Déploiement Vercel', 1, '[]', ?, 4)")
      .run(new Date().toISOString())
    expect(m.listTopics(instance, 3)).toHaveLength(1)

    const r1 = m.bootstrapExpertise(instance)
    expect(r1.domains).toBeGreaterThanOrEqual(1)
    const top = m.topExpertise(instance)
    expect(top.length).toBeGreaterThanOrEqual(1)
    for (const d of top) expect(d.level).toBeLessThan(0.5)

    // Idempotent : un second bootstrap (chaque boot) ne regonfle pas.
    m.bootstrapExpertise(instance)
    expect(m.topExpertise(instance).map(d => d.level)).toEqual(top.map(d => d.level))

    // Un niveau gagné par l'usage réel reste au-dessus de l'amorce.
    const id = m.storeFact({ instance, content: 'Fait utile', category: top[0]!.domain }).id
    for (let i = 0; i < 6; i++) m.reinforceFacts(instance, [id], true)
    const earned = m.topExpertise(instance).find(d => d.domain === top[0]!.domain)!.level
    m.bootstrapExpertise(instance)
    expect(m.topExpertise(instance).find(d => d.domain === top[0]!.domain)!.level).toBe(earned)
  })
})
