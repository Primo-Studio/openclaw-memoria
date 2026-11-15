/**
 * Correctifs du plafond de dépense : estimation d'entrée corrigée par l'usage
 * réel (premier appel seul, puis rapport réel / estimé), dépense persistée
 * après chaque appel (reprise exacte après une coupure). Données fictives.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Memoria, TRIAGE_STATUS_SETTING, TriageBudget } from '../src/index.js'
import { RecordingLlm, seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

const MINI = { input: 0.15, output: 0.6 }

let env: TriageEnv
afterEach(() => {
  env?.close()
  vi.restoreAllMocks()
})

describe('TriageBudget : rapport réel / estimé', () => {
  it('un usage dix fois l’estimation multiplie les réservations suivantes ; jamais sous 1', () => {
    const b = new TriageBudget({ budgetUsd: 1, llmPrice: MINI })
    expect(b.needsCalibration).toBe(true)
    const first = b.reserveCompletion(4000, 100) // 1 200 jetons estimés
    expect(first.inputTokens).toBe(1200)
    b.settleCompletion(first, { input_tokens: 12_000, output_tokens: 10 }, 0)
    expect(b.needsCalibration).toBe(false)
    expect(b.llmInputRatio).toBeCloseTo(10, 6)
    const second = b.reserveCompletion(4000, 100)
    expect(second.inputTokens).toBe(12_000)
    expect(second.worstUsd).toBeCloseTo((12_000 * 0.15 + 100 * 0.6) / 1e6, 12)
    // Un usage plus faible ne baisse pas le rapport (plafond tenu au pire cas observé).
    b.settleCompletion(second, { input_tokens: 600, output_tokens: 10 }, 0)
    expect(b.llmInputRatio).toBeCloseTo(10, 6)
    // Appel en échec : l'entrée corrigée est comptée.
    const before = b.spentUsd
    b.fail(b.reserveCompletion(4000, 100))
    expect(b.spentUsd - before).toBeCloseTo((12_000 * 0.15) / 1e6, 12)
    // Un usage inférieur à l'estimation ne descend jamais sous 1.
    const c = new TriageBudget({ budgetUsd: 1, llmPrice: MINI })
    c.settleCompletion(c.reserveCompletion(4000, 100), { input_tokens: 10, output_tokens: 1 }, 0)
    expect(c.llmInputRatio).toBe(1)
    expect(c.reserveCompletion(4000, 100).inputTokens).toBe(1200)
  })

  it('modèle local (gratuit) : aucun calibrage demandé', () => {
    expect(new TriageBudget({ budgetUsd: 1 }).needsCalibration).toBe(false)
  })

  it('passage : usage réel bien au-dessus de l’estimation, deux lots en parallèle : le plafond tient', async () => {
    const llm = new RecordingLlm('openai', 'gpt-4o-mini', { usage: { input_tokens: 40_000, output_tokens: 500 } })
    env = setupTriage({ llm, embedder: null })
    for (let i = 0; i < 300; i++) seedPending(env, `Le projet fictif numéro ${i} concerne le jardin partagé ${i * 7}`)
    const s = await env.m.triage.run({ budgetUsd: 0.01, concurrency: 2 })
    expect(s.state).toBe('budget')
    expect(s.llm_calls).toBeGreaterThanOrEqual(1)
    expect(s.spent_usd).toBeLessThanOrEqual(0.01)
  })
})

describe('dépense persistée après chaque appel', () => {
  it('processus coupé deux appels après le départ (moins d’une seconde) : la reprise compte toute la dépense', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release: (() => void) | null = null
    const usage = { input_tokens: 1000, output_tokens: 300 }
    const llm = new RecordingLlm('openai', 'gpt-4o-mini', {
      usage,
      onCall: async call => {
        if (call === 3) await new Promise<void>(r => (release = r))
      },
    })
    env = setupTriage({ llm, embedder: null })
    for (let i = 0; i < 100; i++) seedPending(env, `Le projet fictif numéro ${i} concerne le jardin partagé ${i * 7}`)
    const started = await env.m.triage.start({ concurrency: 1, budgetUsd: 1 })
    // Le 3e appel est en vol : les deux premiers sont réglés, en bien moins d'une seconde.
    for (let k = 0; k < 400 && !release; k++) await new Promise(r => setTimeout(r, 5))
    expect(release).not.toBeNull()
    const perCall = (usage.input_tokens * MINI.input + usage.output_tokens * MINI.output) / 1e6
    // L'état complet n'est écrit qu'une fois par seconde : il ne compte encore que le 1er appel.
    expect(JSON.parse(env.m.registry.getSetting(TRIAGE_STATUS_SETTING)!).spent_usd).toBeCloseTo(perCall, 12)
    env.m.close()
    release!()
    await new Promise(r => setTimeout(r, 50))

    const m2 = Memoria.init({
      storageRoot: join(env.root, 'data'),
      configPath: join(env.root, 'config.toml'),
      llm: { extraction: new RecordingLlm('openai', 'gpt-4o-mini', { usage }), embeddings: null },
      secretsVault: 'aes-vault',
    })
    try {
      const st = m2.triage.status()
      expect(st.state).toBe('interrupted')
      expect(st.run_id).toBe(started.run_id)
      expect(st.spent_usd).toBeCloseTo(2 * perCall, 12)
      expect(st.total_spent_usd).toBeCloseTo(2 * perCall, 12)
      // La reprise part de cette dépense.
      m2.triage.retryDelayMs = 0
      const s2 = await m2.triage.run({ budgetUsd: 1 })
      expect(s2.run_id).toBe(started.run_id)
      expect(s2.spent_usd).toBeCloseTo(2 * perCall + s2.llm_calls * perCall, 12)
    } finally {
      m2.close()
    }
    ;(env as unknown as { m: { close(): void } }).m = { close() {} }
  })
})
