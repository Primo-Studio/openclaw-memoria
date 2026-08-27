/**
 * « Données envoyées au cloud » : résumé à partir du rapport de consommation
 * et raison lisible d'une ligne cloud_send du Journal. Node pur, langue par
 * défaut (fr) — les libellés sont ceux du catalogue français.
 */
import { describe, expect, it } from 'vitest'
import type { LlmUsageRow } from '../src/api'
import { humanReason, parseKeyValues, summarizeCloudSends } from '../src/lib/cloud'

function row(over: Partial<LlmUsageRow>): LlmUsageRow {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    purpose: 'extraction',
    local: false,
    calls: 1,
    failures: 0,
    items: 1,
    chars: 100,
    ms_total: 10,
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    calls_metered: 0,
    first_ts: null,
    last_ts: null,
    estimated_cost_usd: null,
    price_known: false,
    ...over,
  }
}

describe('summarizeCloudSends', () => {
  it('ignore les modèles locaux : une installation tout-local n’a rien envoyé', () => {
    const s = summarizeCloudSends([row({ provider: 'ollama', model: 'qwen', local: true, calls: 40, chars: 9000 })])
    expect(s.rows).toEqual([])
    expect(s.calls).toBe(0)
    expect(s.chars).toBe(0)
    expect(s.providers).toEqual([])
    expect(s.last_ts).toBeNull()
  })

  it('additionne les envois cloud (appels, caractères, échecs) et garde le dernier horodatage', () => {
    const s = summarizeCloudSends([
      row({ calls: 10, chars: 1000, failures: 1, last_ts: '2026-08-27T10:00:00Z' }),
      row({ purpose: 'embeddings', model: 'text-embedding-3-small', calls: 5, items: 50, chars: 500, last_ts: '2026-08-27T12:00:00Z' }),
      row({ provider: 'ollama', local: true, calls: 99, chars: 99999 }),
    ])
    expect(s.rows).toHaveLength(2)
    expect(s.calls).toBe(15)
    expect(s.chars).toBe(1500)
    expect(s.failures).toBe(1)
    expect(s.providers).toEqual(['OpenAI'])
    expect(s.last_ts).toBe('2026-08-27T12:00:00Z')
  })
})

describe('humanReason', () => {
  it('parseKeyValues lit le format clé=valeur de l’audit, séparateur « ; » compris', () => {
    expect(parseKeyValues('attempts=3; error=timeout')).toEqual({ attempts: '3', error: 'timeout' })
  })

  it('rend lisible une ligne cloud_send réelle (fournisseur, modèle, usage, volume, durée)', () => {
    const out = humanReason('cloud_send', 'provider=openai model=gpt-4o-mini purpose=extraction items=1 chars=1357 ms=1238 ok=true tokens_in=400 tokens_out=80')
    // Intl insère des espaces insécables (U+202F/U+00A0) : on compare le texte, pas les blancs.
    expect(out?.replace(/[\u202f\u00a0]/g, ' ')).toBe('OpenAI · gpt-4o-mini · extraction · ≈ 1,4 k caractères · 1,2 s')
  })

  it('signale un envoi raté : les données sont parties même sans réponse', () => {
    const out = humanReason('cloud_send', 'provider=anthropic model=claude-haiku purpose=extraction items=1 chars=200 ms=30000 ok=false')
    expect(out).toContain('Anthropic')
    expect(out).toContain('échec')
  })

  it('laisse la raison brute pour une action inconnue, et null sans raison', () => {
    expect(humanReason('store_fact', 'scope=user')).toBe('scope=user')
    expect(humanReason('cloud_send', null)).toBeNull()
  })
})
