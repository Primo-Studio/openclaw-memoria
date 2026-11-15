/**
 * Plafond de dépense du tri : vérifié avant chaque appel au pire cas, usage
 * réel compté, estimation majorée sans usage, refus d'un prix inconnu,
 * dépense d'un passage interrompu reprise. Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { assertPriced, estimateTokensFromChars, TriageBudget, TriageBudgetError, TRIAGE_STATUS_SETTING } from '../src/index.js'
import { RecordingLlm, seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

const MINI = { input: 0.15, output: 0.6 }

describe('TriageBudget', () => {
  it('refuse AVANT l’appel qui pourrait dépasser (pire cas : entrée estimée + maxTokens entiers)', () => {
    const b = new TriageBudget({ budgetUsd: 0.001, llmPrice: MINI })
    // 4 000 caractères → 1 200 jetons d'entrée ; 1 000 jetons de sortie au pire : 0,00078 $.
    const r = b.reserveCompletion(4000, 1000)
    expect(() => b.reserveCompletion(4000, 1000)).toThrow(TriageBudgetError)
    b.settleCompletion(r, { input_tokens: 1000, output_tokens: 100 }, 0)
    expect(b.spentUsd).toBeCloseTo((1000 * 0.15 + 100 * 0.6) / 1e6, 10)
    expect(b.counters).toMatchObject({ tokens_in: 1000, tokens_out: 100, llm_calls: 1 })
  })

  it('usage absent : caractères / 4 majorés de 20 % ; appel en échec : l’entrée estimée est comptée', () => {
    expect(estimateTokensFromChars(400)).toBe(120)
    const b = new TriageBudget({ budgetUsd: 1, llmPrice: MINI, embeddingsPrice: { input: 0.02, output: 0 } })
    b.settleCompletion(b.reserveCompletion(400, 500), undefined, 800)
    expect(b.counters).toMatchObject({ tokens_in: 120, tokens_out: 240 })
    const before = b.spentUsd
    b.fail(b.reserveCompletion(4000, 500))
    expect(b.spentUsd - before).toBeCloseTo((1200 * 0.15) / 1e6, 10)
    b.settleEmbeddings(b.reserveEmbeddings(400), undefined)
    expect(b.counters.embed_tokens).toBe(120)
  })

  it('prix inconnu chez un fournisseur cloud : refus ; local : gratuit', () => {
    expect(() => assertPriced('openai', 'modele-inconnu-xyz', 'le LLM')).toThrow(/prix inconnu/)
    expect(assertPriced('ollama', 'n-importe', 'le LLM')).toEqual({ input: 0, output: 0 })
  })
})

describe('plafond pendant un passage', () => {
  let env: TriageEnv
  afterEach(() => env?.close())

  it('s’arrête net avant l’appel qui dépasserait, sans dépasser le plafond', async () => {
    env = setupTriage({
      llm: new RecordingLlm('openai', 'gpt-4o-mini', { usage: { input_tokens: 2500, output_tokens: 900 } }),
      embedder: null,
    })
    for (let i = 0; i < 100; i++) seedPending(env, `Le dossier ${100 + i} est rangé chez Nimbus`)
    // Pire cas d'un lot de 20 : ~2 900 jetons d'entrée et 2 600 de sortie ≈ 0,0020 $ ; réel 0,000915 $.
    // 3 appels passent (0,00275 $ dépensés) ; le 4e pourrait porter le total à 0,0047 $ : il n'est pas fait.
    const s = await env.m.triage.run({ budgetUsd: 0.004, concurrency: 1 })
    expect(s.state).toBe('budget')
    expect(env.llm.calls).toBe(3)
    expect(s.spent_usd).toBeCloseTo(3 * 0.000915, 9)
    expect(s.facts_done).toBe(60)
  })

  it('refuse de démarrer si le prix du modèle cloud est inconnu', async () => {
    env = setupTriage({ llm: new RecordingLlm('openai', 'modele-inconnu-xyz'), embedder: null })
    seedPending(env, 'Le dossier 1 est rangé chez Nimbus')
    await expect(env.m.triage.start()).rejects.toMatchObject({ code: 'price-unknown' })
    expect(env.llm.calls).toBe(0)
  })

  it('un passage mort avec le processus s’affiche interrompu, et sa dépense compte dans le plafond du suivant', async () => {
    env = setupTriage({ llm: new RecordingLlm('openai', 'gpt-4o-mini', { usage: { input_tokens: 2500, output_tokens: 900 } }), embedder: null })
    seedPending(env, 'Le dossier 1 est rangé chez Nimbus')
    env.m.registry.setSetting(
      TRIAGE_STATUS_SETTING,
      JSON.stringify({ run_id: 'run-fictif', state: 'running', spent_usd: 0.5, total_spent_usd: 0.5, budget_usd: 0.5 }),
    )
    expect(env.m.triage.status().state).toBe('interrupted')
    // Un dry-run entre-temps n'efface ni l'état ni la dépense à reprendre.
    expect((await env.m.triage.run({ dryRun: true })).estimate).not.toBeNull()
    expect(env.m.triage.status()).toMatchObject({ state: 'interrupted', spent_usd: 0.5 })
    const s = await env.m.triage.run({ budgetUsd: 0.5 })
    expect(s.state).toBe('budget')
    expect(s.run_id).toBe('run-fictif')
    expect(env.llm.calls).toBe(0)
    // Sans reprise : nouveau plafond entier.
    const fresh = await env.m.triage.run({ budgetUsd: 0.5, resume: false })
    expect(fresh.state).toBe('done')
    expect(env.llm.calls).toBe(1)
  })
})
