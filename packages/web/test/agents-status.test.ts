/**
 * Régression : « ✓ Un agent est connecté » ne doit PAS apparaître pour une
 * instance créée par la génération d'un code de pairing jamais utilisé.
 */
import { describe, expect, it } from 'vitest'
import type { AgentEntry } from '../src/api'
import { analyzableAgents, hasLiveAgent, isLiveAgent } from '../src/lib/agents'

function entry(over: Partial<AgentEntry['instance']> = {}, type = 'claude-code'): AgentEntry {
  return {
    assistant_type: type,
    db_path: null,
    instance: {
      id: 'inst-1',
      assistant_id: 'a-1',
      machine_id: 'mac',
      profile_id: null,
      created_at: '2026-08-27T09:00:00.000Z',
      last_seen_at: null,
      revoked_at: null,
      ...over,
    },
  }
}

describe('hasLiveAgent — porte « Terminer » de l’onboarding', () => {
  it('une instance issue d’un code de pairing jamais collé (last_seen_at null) ne compte PAS', () => {
    expect(hasLiveAgent([entry()])).toBe(false)
    expect(isLiveAgent(entry())).toBe(false)
  })

  it('une instance vue au moins une fois compte', () => {
    expect(hasLiveAgent([entry({ last_seen_at: '2026-08-27T09:01:00.000Z' })])).toBe(true)
  })

  it('une instance révoquée ne compte pas, même vue', () => {
    expect(hasLiveAgent([entry({ last_seen_at: '2026-08-27T09:01:00.000Z', revoked_at: '2026-08-27T10:00:00.000Z' })])).toBe(false)
  })

  it('liste vide → false', () => {
    expect(hasLiveAgent([])).toBe(false)
  })
})

describe('analyzableAgents — écrans par agent', () => {
  it('exclut « Autre agent (MCP) » et les révoqués', () => {
    const list = [entry({ id: 'g' }, 'generic'), entry({ id: 'r', revoked_at: 'x' }), entry({ id: 'ok' })]
    expect(analyzableAgents(list).map(e => e.instance.id)).toEqual(['ok'])
  })
})
