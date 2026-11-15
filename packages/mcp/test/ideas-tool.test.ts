/**
 * memoria_ideas et les styles d'échange de memoria_get_context.
 *  - l'outil relaie ses filtres (noms anglais → champs du daemon) et le
 *    contexte actif ; sans genre demandé, l'éphémère est exclu ;
 *  - projection compacte : seulement des faits validés, compteurs en attente
 *    sans texte, aucun champ interne ;
 *  - memoria_get_context rend les styles validés de l'interlocuteur courant
 *    (dernière personne reconnue, sinon le propriétaire) et reste rendu, sans
 *    relance, quand le daemon manque.
 * Jamais de vrai daemon ni de réseau : gateway factice. Données fictives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecallResult } from '@memoria/core'
import { ActiveContextTracker, buildServer, HttpDaemonGateway, type DaemonGateway } from '../src/index.js'

const RECALL_EMPTY: RecallResult = { items: [], totalFound: 0, tokens: 0, scopes_searched: [] }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const IDEA_ITEM = {
  id: 'f-idee',
  text: 'Une app de suivi des semis pour les jardins partagés.',
  titre: 'App de suivi des semis',
  genre: 'idee',
  sous_type: 'app',
  auteur: 'ia:claude',
  auteur_source: 'message',
  projet: 'Jardins',
  importance: 2,
  rubriques: ['app'],
  conversation_at: '2026-03-04T10:11:12.000Z',
  amas_size: 3,
  validated: true,
  source_db: 'assistants/x.db',
}

function gateway(over: Partial<DaemonGateway> = {}): DaemonGateway & { calls: Array<{ method: string; input: Record<string, unknown> }> } {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = []
  const record = (method: string, payload: unknown) => async (input: Record<string, unknown>) => {
    calls.push({ method, input })
    return payload
  }
  return {
    calls,
    recall: record('recall', RECALL_EMPTY) as DaemonGateway['recall'],
    storeFact: record('storeFact', { fact: null }),
    captureTurn: record('captureTurn', {}),
    identifyInterlocutor: record('identifyInterlocutor', {
      match: { person: { id: 'p-1', display_name: 'Camille Fictive', relation: 'collègue' }, known: [] },
    }),
    identifyOrCreateInterlocutor: record('identifyOrCreateInterlocutor', { match: null }),
    feedback: record('feedback', {}),
    captureStatus: record('captureStatus', {}),
    pin: record('pin', {}),
    expiry: record('expiry', {}),
    correct: record('correct', {}),
    ideas: record('ideas', { items: [IDEA_ITEM], pending_counts: { idee: 4, decision: 1 } }),
    styles: record('styles', {
      person_id: null,
      items: [{ id: 's-1', text: 'Écrit des messages courts, sans formule de politesse.', titre: null, conversation_at: '2026-02-01T08:00:00.000Z' }],
    }),
    ...over,
  }
}

const parse = (r: { content: unknown[] }): Record<string, unknown> => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>

describe('memoria_ideas', () => {
  it('relaie les filtres (ai → ia) et le contexte actif ; rend une projection compacte, validée, sans champ interne', async () => {
    const g = gateway()
    const tracker = new ActiveContextTracker()
    tracker.set({ project: 'jardins', client: 'client-fictif' })
    const { handlers } = buildServer({ instanceId: 'i', tracker, connect: async () => g })
    const res = await handlers.ideas({ kind: ['idee'], subtype: 'app', author: 'ai', project: 'Jardins', query: 'semis', min_importance: 2, limit: 5 })
    expect(res.isError).toBeUndefined()
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0]!.method).toBe('ideas')
    expect(g.calls[0]!.input).toMatchObject({
      genre: ['idee'],
      sous_type: 'app',
      auteur: 'ia',
      projet: 'Jardins',
      q: 'semis',
      importance_min: 2,
      limit: 5,
      active_context: { project_id: 'jardins', client_org_id: 'client-fictif' },
    })
    const out = parse(res)
    expect(out['pending_counts']).toEqual({ idee: 4, decision: 1 })
    expect(out['items']).toEqual([
      {
        id: 'f-idee',
        kind: 'idee',
        subtype: 'app',
        title: 'App de suivi des semis',
        text: IDEA_ITEM.text,
        author: 'ia:claude',
        author_source: 'message',
        project: 'Jardins',
        importance: 2,
        date: '2026-03-04',
        said: 3,
        validated: true,
      },
    ])
    expect(JSON.stringify(out)).not.toContain('source_db')
  })

  it('sans genre demandé : tous les genres sauf l’éphémère', async () => {
    const g = gateway()
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => g })
    await handlers.ideas({})
    const genres = g.calls[0]!.input['genre'] as string[]
    expect(genres).toContain('idee')
    expect(genres).toContain('decision')
    expect(genres).not.toContain('ephemere')
    await handlers.ideas({ author: 'ai:codex' })
    expect(g.calls[1]!.input['auteur']).toBe('ia:codex')
  })

  it('Memoria en pause : `disabled` est conservé (rien n’est rendu, ce n’est pas « aucune idée »)', async () => {
    const g = gateway({ ideas: async () => ({ items: [], pending_counts: {}, disabled: true }) })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => g })
    expect(parse(await handlers.ideas({}))).toEqual({ items: [], pending_counts: {}, disabled: true })
  })

  it('la gateway HTTP poste sur /v1/memory/ideas et /v1/memory/styles avec le jeton d’instance', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], pending_counts: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const http = new HttpDaemonGateway({ port: 4321 }, 'jeton-instance')
    await http.ideas({ genre: ['idee'] })
    await http.styles({ person_id: null })
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(c => c[0])).toEqual(['http://127.0.0.1:4321/v1/memory/ideas', 'http://127.0.0.1:4321/v1/memory/styles'])
    expect((calls[0]![1].headers as Record<string, string>)['authorization']).toBe('Bearer jeton-instance')
  })
})

describe('memoria_get_context : styles d’échange de l’interlocuteur', () => {
  it('par défaut le propriétaire ; après memoria_identify_interlocutor, la personne reconnue', async () => {
    const g = gateway()
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => g })
    const first = parse(await handlers.getContext())
    expect(first['interlocutor']).toEqual({ owner: true })
    expect(first['exchange_styles']).toEqual([{ id: 's-1', text: 'Écrit des messages courts, sans formule de politesse.', date: '2026-02-01' }])
    expect(g.calls.find(c => c.method === 'styles')!.input['person_id']).toBeNull()

    await handlers.identifyInterlocutor({ email: 'camille@example.com' })
    const second = parse(await handlers.getContext())
    expect(second['interlocutor']).toEqual({ person_id: 'p-1', display_name: 'Camille Fictive' })
    expect(g.calls.filter(c => c.method === 'styles').at(-1)!.input['person_id']).toBe('p-1')
  })

  it('daemon absent : le contexte local reste rendu, styles vides, UNE seule tentative de connexion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tracker = new ActiveContextTracker()
    tracker.set({ project: 'jardins' })
    const connect = vi.fn(async (): Promise<DaemonGateway> => {
      throw new TypeError('fetch failed')
    })
    const { handlers } = buildServer({ instanceId: 'i', tracker, connect })
    const res = await handlers.getContext()
    expect(res.isError).toBeUndefined()
    const out = parse(res)
    expect((out['active_context'] as Record<string, unknown>)['project_id']).toBe('jardins')
    expect(out['exchange_styles']).toEqual([])
    expect(out['exchange_styles_unavailable']).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
