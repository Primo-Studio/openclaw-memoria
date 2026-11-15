/**
 * Correctifs du tri sur les lignes : correction d'un fait jamais trié (filtre
 * sensible appliqué), reclassement qui épargne les lignes de la passe sur les
 * messages, jumeau actif exact cherché par l'index (scope_id, norm_hash).
 * Données fictives uniquement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRIAGE_PROMPT_VERSION, TriageBudget } from '../src/index.js'
import { bagOfWords, seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

describe('correction d’un fait jamais trié', () => {
  it('un fait de paie corrigé avant tout passage naît sensible : jamais validé, jamais rappelé', async () => {
    env = setupTriage()
    const id = seedPending(env, 'Le salaire de Zorba Fictif passe à 2 100 euros brut')
    expect(env.m.triage.correct({ fact_id: id, importance: 3 })).toEqual({ updated: true })
    const row = triageRow(env.db(), id)!
    expect(row.sensible).toBe(1)
    // Valeur calculée : ce n'est pas une correction de l'utilisateur.
    expect(JSON.parse(String(row.corrected_fields))).toEqual(['importance'])
    await env.m.triage.run()
    expect(env.llm.prompts.some(p => p.includes('Zorba'))).toBe(false)
    const res = env.m.triage.promote({ fact_ids: [id] })
    expect(res.skipped_sensitive).toBe(1)
    expect(env.m.recall({ instance: env.instance, query: 'salaire Zorba' }).items).toEqual([])
  })

  it('une correction qui porte `sensible` l’emporte ; un fait ordinaire naît non sensible', () => {
    env = setupTriage()
    const paie = seedPending(env, 'Le salaire de Zorba Fictif passe à 2 100 euros brut')
    expect(env.m.triage.correct({ fact_id: paie, sensible: false })).toEqual({ updated: true })
    expect(triageRow(env.db(), paie)!.sensible).toBe(0)
    expect(JSON.parse(String(triageRow(env.db(), paie)!.corrected_fields))).toEqual(['sensible'])
    const ordinaire = seedPending(env, 'Le projet fictif Lumen concerne le jardin partagé du quartier')
    expect(env.m.triage.correct({ fact_id: ordinaire, importance: 1 })).toEqual({ updated: true })
    expect(triageRow(env.db(), ordinaire)!.sensible).toBe(0)
  })
})

describe('reclassement après un changement de version de prompt', () => {
  it('une ligne de la passe sur les messages garde auteur vérifié, citation, accord et date ; une ligne du moteur est reclassée', async () => {
    env = setupTriage()
    await env.m.triage.estimate()
    const host = env.m.triage.createHost({ llm: env.llm, embeddings: env.embedder, budget: new TriageBudget({ budgetUsd: 1 }), stop: () => null })
    const text = 'On pourrait proposer une app de troc de graines entre voisins'
    const fromMessages = host.storePendingTriaged({
      instance: env.instance,
      content: text,
      triage: {
        genre: 'idee',
        sous_type: 'app',
        auteur: 'ia:claude',
        auteur_source: 'message',
        approuve_par_owner: true,
        citation: 'vas y pour le troc',
        conversation_at: '2026-03-04T10:00:00.000Z',
        conversation_at_source: 'fichier',
      },
      source: { key: 'claude-code:fictif/session.jsonl', path: '/fictif/session.jsonl' },
      vector: bagOfWords(text),
    }).fact_id
    // Une ligne du MOTEUR dont l'auteur a été vérifié dans la transcription.
    const fromEngine = seedPending(env, 'Le projet fictif Lumen concerne le jardin partagé du quartier')
    await env.m.triage.run()
    env.db().prepare("UPDATE fact_triage SET prompt_version = 'tri-v2' WHERE fact_id IN (?, ?)").run(fromMessages, fromEngine)
    env.db().prepare("UPDATE fact_triage SET auteur_source = 'message' WHERE fact_id = ?").run(fromEngine)

    // L'estimation compte les mêmes lignes que le passage.
    expect((await env.m.triage.estimate({ reclassify: true })).facts_pending).toBe(1)
    env.llm.prompts.length = 0
    await env.m.triage.run({ reclassify: true })

    const kept = triageRow(env.db(), fromMessages)!
    expect(kept).toMatchObject({
      auteur: 'ia:claude',
      auteur_source: 'message',
      approuve_par_owner: 1,
      citation: 'vas y pour le troc',
      conversation_at: '2026-03-04T10:00:00.000Z',
      conversation_at_source: 'fichier',
      prompt_version: 'tri-v2',
    })
    expect(env.llm.prompts.some(p => p.includes('troc de graines'))).toBe(false)
    expect(triageRow(env.db(), fromEngine)!.prompt_version).toBe(TRIAGE_PROMPT_VERSION)
    expect(env.llm.prompts.some(p => p.includes('jardin partagé'))).toBe(true)
  })
})

describe('jumeau actif exact', () => {
  it('cherché par l’index (scope_id, norm_hash), y compris dans un autre scope de la même base', async () => {
    env = setupTriage()
    const db = env.db()
    const active = env.m.storeFact({ instance: env.instance, content: 'Le site fictif Lumen est hébergé chez Brumehost.' }).id
    const pending = seedPending(env, 'Le site fictif Lumen est hébergé chez Brumehost depuis mars.')
    // Même texte normalisé (même clé), et l'actif dans un AUTRE scope de la même base.
    const hash = (db.prepare('SELECT norm_hash FROM facts WHERE id = ?').get(active) as { norm_hash: string }).norm_hash
    db.prepare('UPDATE facts SET norm_hash = ? WHERE id = ?').run(hash, pending)
    db.prepare("UPDATE facts SET scope_id = 'scope-fictif-b' WHERE id = ?").run(active)

    const sqls: string[] = []
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      sqls.push(sql)
      return prepare(sql)
    }) as typeof db.prepare)
    await env.m.triage.run()
    vi.mocked(db.prepare).mockRestore()

    expect(triageRow(db, pending)!.same_as_active).toBe(active)
    const twinSql = sqls.find(s => /norm_hash = \?/.test(s) && /lifecycle_state = 'active'/.test(s) && /LIMIT 1/.test(s))
    expect(twinSql).toBeDefined()
    const params = twinSql!.includes('json_each') ? [JSON.stringify(['scope-fictif-b']), hash, 'x'] : [hash, 'x']
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${twinSql}`).all(...params) as Array<{ detail: string }>).map(r => r.detail).join(' | ')
    expect(plan).toContain('idx_facts_norm_hash')
    expect(plan).not.toContain('idx_facts_lifecycle')
  })
})
