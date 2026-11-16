/**
 * Espace d'équipe côté MCP : `scope: "org"` relayé au daemon, fait stocké
 * rendu `org` (jamais `user`), refus de l'espace d'équipe expliqués avec leur
 * raison, fait rappelé depuis `org` rendu `org` en JSON compact et en blocs.
 * Jamais de vrai daemon ni de réseau : gateway factice. Données fictives.
 */
import { describe, expect, it } from 'vitest'
import type { RecallResult } from '@memoria/core'
import { ActiveContextTracker, buildServer, compactStoredFact, DaemonHttpError, type DaemonGateway } from '../src/index.js'

function gateway(over: Partial<DaemonGateway> = {}): DaemonGateway & { calls: Array<{ method: string; input: Record<string, unknown> }> } {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = []
  const base = {
    calls,
    recall: async (input: Record<string, unknown>) => {
      calls.push({ method: 'recall', input })
      return RECALL
    },
    storeFact: async (input: Record<string, unknown>) => {
      calls.push({ method: 'storeFact', input })
      return { fact: { id: 'f-org', fact: 'Les masters sortent en ProRes', category: 'process', visibility: 'shared' } }
    },
  }
  return { ...base, ...over } as unknown as DaemonGateway & { calls: typeof calls }
}

const RECALL: RecallResult = {
  items: [
    {
      kind: 'fact',
      id: 'f-org',
      content: 'Les masters sortent en ProRes',
      category: 'process',
      scope_id: 's-org',
      source_db: 'shared/companies/x.sqlite',
      score: 0.9,
      created_at: '2026-11-01T10:00:00.000Z',
      scope_type: 'org',
    },
    {
      kind: 'fact',
      id: 'f-user',
      content: 'Le propriétaire préfère les réponses courtes',
      category: 'preference',
      scope_id: 's-user',
      source_db: 'shared/user.sqlite',
      score: 0.8,
      created_at: '2026-11-02T10:00:00.000Z',
    },
  ],
  totalFound: 2,
  tokens: 20,
  scopes_searched: [],
}

const text = (res: { content: unknown[] }): string => (res.content[0] as { type: 'text'; text: string }).text

describe('memoria_store_fact vers l’espace d’équipe', () => {
  it('relaie scope « org » au daemon et rend le fait stocké comme `org`', async () => {
    const g = gateway()
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => g })
    const res = await handlers.storeFact({ content: 'Les masters sortent en ProRes', scope: 'org' })
    expect(g.calls[0]!.input['scope']).toBe('org')
    expect(JSON.parse(text(res))).toMatchObject({ stored: true, scope: 'org' })
  })

  it('compactStoredFact : un fait partagé reste `user` sans scope demandé, `org` quand c’est l’espace d’équipe', () => {
    const payload = { fact: { id: 'f', fact: 'x', visibility: 'shared' } }
    expect(compactStoredFact(payload)['scope']).toBe('user')
    expect(compactStoredFact(payload, 'user')['scope']).toBe('user')
    expect(compactStoredFact(payload, 'org')['scope']).toBe('org')
    expect(compactStoredFact({ fact: { id: 'f', fact: 'x', visibility: 'private' } }, 'org')['scope']).toBe('private')
  })

  it('un refus de l’espace d’équipe garde sa raison et ne parle pas du scope « user »', async () => {
    const g = gateway({
      storeFact: async () => {
        throw new DaemonHttpError('/v1/memory/store_fact', 403, "écriture refusée dans l'espace d'équipe (org) : le fait contient un secret ; rien n'a été écrit, ni le fait ni le secret")
      },
    })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => g })
    const res = await handlers.storeFact({ content: 'La clé est quelque part', scope: 'org' })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/team space \("org"\)/)
    expect(text(res)).toMatch(/contient un secret/)
    expect(text(res)).toMatch(/omit scope/)
    expect(text(res)).not.toMatch(/"user" scope|revoked|memoria doctor/)
  })
})

describe('épingler ou corriger un fait d’équipe en lecture seule', () => {
  it('le refus parle de l’espace d’équipe, jamais du scope « user »', async () => {
    const g = gateway({
      pin: async () => {
        throw new DaemonHttpError('/v1/memory/pin', 403, "écriture refusée dans l'espace d'équipe (org) : cet agent lit l'espace d'équipe sans can_write ; il n'y modifie rien")
      },
    })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => g })
    const res = await handlers.pin({ fact_id: 'f-org', pinned: true })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/team space \("org"\)/)
    expect(text(res)).not.toMatch(/"user" scope/)
  })
})

describe('rappel : un fait de l’espace d’équipe est rendu `org`', () => {
  it('JSON compact : `scope: "org"` sur le fait d’équipe seulement', async () => {
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway() })
    const items = (JSON.parse(text(await handlers.recall({ query: 'masters' }))) as { items: Array<Record<string, unknown>> }).items
    expect(items.find(i => i['id'] === 'f-org')!['scope']).toBe('org')
    expect('scope' in items.find(i => i['id'] === 'f-user')!).toBe(false)
  })

  it('format en blocs : « team space (org) » dans les crochets du fait d’équipe', async () => {
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway() })
    const rendered = text(await handlers.recall({ query: 'masters', format: 'blocks' }))
    const orgLine = rendered.split('\n').find(l => l.includes('#f-org'))!
    const userLine = rendered.split('\n').find(l => l.includes('#f-user'))!
    expect(orgLine).toContain('team space (org)')
    expect(userLine).not.toContain('team space')
  })
})
