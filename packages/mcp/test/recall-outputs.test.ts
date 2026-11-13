/**
 * T30, sorties du serveur MCP : seuil par défaut, format en blocs, outil
 * memoria_brief, et preuve que l'aperçu humain du daemon montre bien le texte
 * que ces outils renvoient. Données fictives ; le seul daemon lancé vit dans
 * un répertoire temporaire, sans LLM.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RecallItem, RecallResult } from '@memoria/core'
import { DaemonClient, startDaemon, type RunningDaemon } from '@memoria/daemon'
import { ActiveContextTracker } from '../src/context.js'
import {
  BLOCKS_CHARS_PER_BUDGET_TOKEN,
  BRIEF_CUTOFF,
  BRIEF_LIMIT,
  BRIEF_TOKEN_BUDGET,
  HttpDaemonGateway,
  MCP_RECALL_CUTOFF,
  SERVER_INSTRUCTIONS,
  buildServer,
  type DaemonGateway,
  type ToolHandlers,
} from '../src/serve.js'

const fact = (over: Partial<RecallItem>): RecallItem => ({
  kind: 'fact',
  id: 'x',
  content: 'contenu',
  category: 'general',
  scope_id: 'scope-1',
  source_db: 'assistants/agent-fictif/content.sqlite',
  score: 1,
  created_at: '2026-03-01T10:00:00.000Z',
  ...over,
})

/** Rappel fictif enrichi : un thème de deux souvenirs, un souvenir isolé. */
const ENRICHED: RecallResult = {
  items: [
    fact({
      id: 'o2',
      content: 'Le portail Lumen se déploie le jeudi',
      score: 0.91234,
      created_at: '2026-03-10T08:00:00.000Z',
      origin: 'declared',
      matched_by: ['text', 'context'],
      topic: { id: 't1', name: 'Portail Lumen' },
      entities: ['Lumen', 'Brumehost'],
      status: 'replaces',
      trust: { confidence: 0.9, used_count: 2, recall_count: 5 },
    }),
    fact({
      id: 'o1',
      content: 'Le portail Lumen est hébergé chez Brumehost',
      score: 0.5,
      created_at: '2026-02-01T08:00:00.000Z',
      origin: 'extracted',
      matched_by: ['graph'],
      via_entity: 'Brumehost',
      topic: { id: 't1', name: 'Portail Lumen' },
      entities: ['Lumen', 'Brumehost'],
      links: [{ id: 'k9', excerpt: 'Brumehost ferme son centre de Port-Calme', via: 'Brumehost' }],
    }),
    fact({ id: 'k1', content: 'La borne Icare est dans le hall Persée', score: 0.4, matched_by: ['meaning'], origin: 'inferred' }),
  ],
  totalFound: 9,
  tokens: 42,
  scopes_searched: ['private:agent-fictif'],
  dropped: [{ reason: 'cutoff', count: 4 }],
}

function setup(result: RecallResult & { disabled?: boolean } = ENRICHED): { handlers: ToolHandlers; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const gateway = {
    recall: async (input: Record<string, unknown>) => {
      calls.push(input)
      return result
    },
  } as unknown as DaemonGateway
  const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
  return { handlers, calls }
}

const textOf = (res: { content: unknown[] }): string => (res.content[0] as { type: 'text'; text: string }).text

describe('memoria_recall : seuil et champs enrichis', () => {
  it('demande le seuil 0,3 par défaut, sans format ni voisins', async () => {
    const { handlers, calls } = setup()
    await handlers.recall({ query: 'portail' })
    expect(MCP_RECALL_CUTOFF).toBe(0.3)
    expect(calls[0]).toEqual({ query: 'portail', active_context: {}, cutoff: 0.3 })
  })

  it('cutoff: 0 de l’agent arrive au daemon (il lève le seuil par défaut)', async () => {
    const { handlers, calls } = setup()
    await handlers.recall({ query: 'portail', cutoff: 0 })
    expect(calls[0]).toMatchObject({ cutoff: 0 })
    await handlers.recall({ query: 'portail', cutoff: 0.6 })
    expect(calls[1]).toMatchObject({ cutoff: 0.6 })
  })

  it('projette why, topic, entities, status et dropped ; jamais trust ni scope_id', async () => {
    const { handlers } = setup()
    expect(JSON.parse(textOf(await handlers.recall({ query: 'portail' })))).toEqual({
      items: [
        {
          id: 'o2',
          kind: 'fact',
          content: 'Le portail Lumen se déploie le jeudi',
          category: 'general',
          date: '2026-03-10',
          score: 0.912,
          origin: 'declared',
          why: ['text', 'context'],
          topic: 'Portail Lumen',
          entities: ['Lumen', 'Brumehost'],
          status: 'replaces',
        },
        {
          id: 'o1',
          kind: 'fact',
          content: 'Le portail Lumen est hébergé chez Brumehost',
          category: 'general',
          date: '2026-02-01',
          score: 0.5,
          origin: 'extracted',
          why: ['graph:Brumehost'],
          topic: 'Portail Lumen',
          entities: ['Lumen', 'Brumehost'],
          links: [{ id: 'k9', excerpt: 'Brumehost ferme son centre de Port-Calme', via: 'Brumehost' }],
        },
        { id: 'k1', kind: 'fact', content: 'La borne Icare est dans le hall Persée', category: 'general', date: '2026-03-01', score: 0.4, origin: 'inferred', why: ['meaning'] },
      ],
      total_found: 9,
      tokens: 42,
      dropped: [{ reason: 'cutoff', count: 4 }],
    })
  })
})

describe("memoria_recall format: 'blocks'", () => {
  it('demande les blocs et les voisins, renvoie le TEXTE en blocs avec les ids', async () => {
    const { handlers, calls } = setup()
    const res = await handlers.recall({ query: 'portail', format: 'blocks', limit: 5 })
    expect(calls[0]).toEqual({ query: 'portail', active_context: {}, limit: 5, cutoff: 0.3, format: 'blocks', links: true })
    expect(res.isError).toBeUndefined()
    expect(textOf(res)).toBe(
      [
        'Memory: 2 blocks, 3 kept, 4 dropped (cutoff 4)',
        '## Portail Lumen (2) · Lumen, Brumehost',
        'now 2026-03-10 #o2 Le portail Lumen se déploie le jeudi [text+context · stated · replaces an older memory]',
        '- 2026-02-01 #o1 Le portail Lumen est hébergé chez Brumehost [graph:Brumehost · extracted · near: #k9 "Brumehost ferme son centre de Port-Calme" via Brumehost]',
        '## Other (1)',
        '- 2026-03-01 #k1 La borne Icare est dans le hall Persée [meaning · inferred]',
      ].join('\n'),
    )
  })

  it("format: 'flat' se comporte comme l'absence de format", async () => {
    const { handlers, calls } = setup()
    const flat = await handlers.recall({ query: 'portail', format: 'flat' })
    expect(calls[0]).toEqual({ query: 'portail', active_context: {}, cutoff: 0.3 })
    expect(textOf(flat)).toBe(textOf(await handlers.recall({ query: 'portail' })))
  })

  it('rien trouvé ou Memoria en pause : JSON compact, jamais un texte vide', async () => {
    const empty = setup({ items: [], totalFound: 0, tokens: 0, scopes_searched: [] })
    expect(JSON.parse(textOf(await empty.handlers.recall({ query: 'x', format: 'blocks' })))).toEqual({ items: [], total_found: 0, tokens: 0 })
    const paused = setup({ items: [], disabled: true } as unknown as RecallResult)
    expect(JSON.parse(textOf(await paused.handlers.recall({ query: 'x', format: 'blocks' })))).toEqual({
      items: [],
      total_found: 0,
      tokens: 0,
      disabled: true,
    })
  })
})

describe('memoria_brief', () => {
  it('rappel large, seuil doux (0,15), avec voisins, rendu en blocs', async () => {
    const tracker = new ActiveContextTracker()
    tracker.set({ project: 'Portail Lumen' })
    const calls: Array<Record<string, unknown>> = []
    const gateway = {
      recall: async (input: Record<string, unknown>) => {
        calls.push(input)
        return ENRICHED
      },
    } as unknown as DaemonGateway
    const { handlers } = buildServer({ instanceId: 'i', tracker, connect: async () => gateway })
    const res = await handlers.brief({ subject: 'portail Lumen' })
    expect(calls).toEqual([
      {
        query: 'portail Lumen',
        active_context: { project_id: 'portail-lumen' },
        limit: 30,
        token_budget: 3000,
        cutoff: 0.15,
        links: true,
        format: 'blocks',
      },
    ])
    expect([BRIEF_LIMIT, BRIEF_TOKEN_BUDGET, BRIEF_CUTOFF]).toEqual([30, 3000, 0.15])
    const text = textOf(res)
    expect(text.split('\n')[0]).toBe('Memory: 2 blocks, 3 kept, 4 dropped (cutoff 4)')
    expect(text).toContain('now 2026-03-10 #o2 ')
    // Même texte que memoria_recall en blocs pour le même résultat.
    expect(text).toBe(textOf(await handlers.recall({ query: 'portail Lumen', format: 'blocks' })))
  })

  it('aucun souvenir : JSON compact ; daemon en erreur : isError lisible, sans exception', async () => {
    const empty = setup({ items: [], totalFound: 0, tokens: 0, scopes_searched: [] })
    expect(JSON.parse(textOf(await empty.handlers.brief({ subject: 'inconnu' })))).toEqual({ items: [], total_found: 0, tokens: 0 })

    const failing = {
      recall: async () => {
        throw new Error('fetch failed')
      },
    } as unknown as DaemonGateway
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => failing })
    const res = await handlers.brief({ subject: 'portail' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/unreachable/)
  })

  it('outil enregistré, décrit, et cité dans les instructions du serveur', () => {
    const { server } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => ({}) as DaemonGateway })
    const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools
    expect(tools['memoria_brief']?.description).toMatch(/where does this subject stand/i)
    expect(tools['memoria_recall']?.description).toMatch(/`why`/)
    expect(tools['memoria_recall']?.description).toMatch(/`dropped`/)
    expect(tools['memoria_recall']?.description).toMatch(/`cutoff: 0`/)
    expect(tools['memoria_recall']?.description).toMatch(/format: "blocks"/)
    // « expiring » = a une date d'expiration, même lointaine : la description
    // ne doit pas faire croire à l'agent que le fait est presque périmé.
    expect(tools['memoria_recall']?.description).toMatch(/"expiring" \(has an expiry date/)
    expect(tools['memoria_recall']?.description).not.toMatch(/"expiring" \([^)]*, about to lapse\)/)
    expect(SERVER_INSTRUCTIONS).toMatch(/memoria_brief/)
    expect(SERVER_INSTRUCTIONS).toMatch(/cutoff: 0/)
  })
})

describe('texte en blocs : plafonné selon le budget (annotations et voisins compris)', () => {
  /** 30 souvenirs courts (dans le budget du moteur) chargés de voisins `near:`. */
  const HEAVY: RecallResult = {
    items: Array.from({ length: 30 }, (_, i) =>
      fact({
        id: `h${i}`,
        content: `Souvenir fictif ${i} sur le portail Lumen`,
        score: 30 - i,
        matched_by: ['text', 'graph'],
        via_entity: 'Brumehost',
        origin: 'extracted',
        links: [1, 2, 3].map(n => ({ id: `v${i}-${n}`, excerpt: `Voisin fictif ${n} du souvenir ${i}, assez long pour peser dans la ligne rendue`.padEnd(120, ' x'), via: 'Brumehost' })),
      }),
    ),
    totalFound: 30,
    tokens: 400,
    scopes_searched: ['private:agent-fictif'],
  }

  it('memoria_brief ne dépasse pas 6 caractères par token de son budget', async () => {
    const { handlers } = setup(HEAVY)
    const text = textOf(await handlers.brief({ subject: 'portail Lumen' }))
    expect(BLOCKS_CHARS_PER_BUDGET_TOKEN).toBe(6)
    expect(text.length).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET * 6)
    expect(text).toMatch(/^Memory: /)
  })

  it("memoria_recall format: 'blocks' suit le budget demandé, sinon celui par défaut du daemon (1500)", async () => {
    const { handlers } = setup(HEAVY)
    const lines = (t: string): number => t.split('\n').filter(l => /^(now|-) /.test(l)).length
    const byDefault = textOf(await handlers.recall({ query: 'portail Lumen', format: 'blocks' }))
    expect(byDefault.length).toBeLessThanOrEqual(1500 * 6)
    const tight = textOf(await handlers.recall({ query: 'portail Lumen', format: 'blocks', token_budget: 200 }))
    expect(tight.length).toBeLessThanOrEqual(200 * 6)
    expect(lines(tight)).toBeGreaterThan(0)
    expect(lines(tight)).toBeLessThan(lines(byDefault))
    // Sans plafond, les 30 lignes sortaient toutes, quel que soit le budget.
    expect(lines(byDefault)).toBeLessThan(30)
  })
})

describe('memoria_brief ne renforce pas le bruit (bout en bout)', () => {
  let root: string
  let daemon: RunningDaemon | null = null

  afterEach(async () => {
    await daemon?.close()
    daemon = null
    rmSync(root, { recursive: true, force: true })
  })

  it('un voisin de graphe à faible score n’est ni renvoyé ni compté comme rappelé', async () => {
    root = mkdtempSync(join(tmpdir(), 'memoria-mcp-brief-'))
    daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null, embeddings: null } })
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('claude-code')
    const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
    const agent = new DaemonClient(daemon.state, done.instance_token)
    const instance = done.assistant_instance_id
    // Quatre réponses directes, dont une cite le service Kestrel ; deux
    // souvenirs qui ne partagent QUE cette entité avec le sujet.
    await agent.storeFact({ content: 'Le chantier Zephyr dépend du service Kestrel' })
    await agent.storeFact({ content: 'Le chantier Zephyr Zephyr démarre en mars sur le site Zephyr' })
    await agent.storeFact({ content: 'Le chantier Zephyr est suivi par la cellule Borée' })
    await agent.storeFact({ content: 'Le chantier Zephyr a un budget de quarante jours' })
    await agent.storeFact({ content: 'Kestrel tourne sur la machine Halcyon' })
    await agent.storeFact({ content: 'Kestrel est sauvegardé chaque nuit vers le coffre Nimbus' })
    await daemon.memoria.processCognition(instance)

    const look = (): RecallResult => daemon!.memoria.recall({ instance, query: 'chantier Zephyr', limit: 30, preview: true })
    const neighbours = (r: RecallResult): RecallItem[] => r.items.filter(i => i.matched_by?.includes('graph') && !i.matched_by.includes('text'))
    const before = look()
    // Le jeu produit bien des voisins de graphe sous 15 % du meilleur score,
    // sinon le test ne prouverait rien.
    expect(neighbours(before).length).toBeGreaterThanOrEqual(1)
    for (const n of neighbours(before)) expect(n.score).toBeLessThan(0.15 * before.items[0]!.score)
    expect(before.items.every(i => i.trust!.recall_count === 0)).toBe(true)

    const state = daemon.state
    const { handlers } = buildServer({
      instanceId: instance,
      tracker: new ActiveContextTracker(),
      connect: async () => new HttpDaemonGateway(state, done.instance_token),
    })
    for (let i = 0; i < 3; i++) {
      const text = textOf(await handlers.brief({ subject: 'chantier Zephyr' }))
      expect(text).toMatch(/^Memory: /)
      for (const n of neighbours(before)) expect(text).not.toContain(`\n- ${n.created_at!.slice(0, 10)} #${n.id} `)
    }

    const after = look()
    for (const n of neighbours(after)) expect(n.trust!.recall_count, n.content).toBe(0)
    // Les réponses directes, elles, ont bien été comptées.
    expect(after.items.find(i => i.id === before.items[0]!.id)!.trust!.recall_count).toBe(3)
  })
})

describe('aperçu humain du daemon = ce que les outils renvoient (bout en bout)', () => {
  let root: string
  let daemon: RunningDaemon | null = null

  afterEach(async () => {
    await daemon?.close()
    daemon = null
    rmSync(root, { recursive: true, force: true })
  })

  it('rendus « mcp » et « blocks » de /v1/admin/recall_preview, au caractère près', async () => {
    root = mkdtempSync(join(tmpdir(), 'memoria-mcp-preview-'))
    daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null, embeddings: null } })
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('claude-code')
    const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
    const agent = new DaemonClient(daemon.state, done.instance_token)
    for (const lieu of ['Atrium', 'Belvédère', 'Cellier', 'Dortoir', 'Entrepôt', 'Fournil']) {
      await agent.storeFact({ content: `Le registre ${lieu} est tenu par le service Quartz` })
    }
    await agent.storeFact({ content: 'Le registre Quartz Opaline Opaline est archivé chaque trimestre sous la référence Opaline' })
    await daemon.memoria.processCognition(done.assistant_instance_id)

    const state = daemon.state
    const { handlers } = buildServer({
      instanceId: done.assistant_instance_id,
      // Sans dépôt détecté : l'aperçu est demandé sans contexte actif.
      tracker: new ActiveContextTracker(),
      connect: async () => new HttpDaemonGateway(state, done.instance_token),
    })
    const preview = async (extra: Record<string, unknown> = {}): Promise<Record<'mcp' | 'blocks', string>> => {
      const res = await fetch(`http://127.0.0.1:${state.port}/v1/admin/recall_preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${state.admin_token}` },
        body: JSON.stringify({ instance: done.assistant_instance_id, query: 'registre Opaline', ...extra }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { renderings: Array<{ id: string; text: string }> }
      return Object.fromEntries(body.renderings.map(r => [r.id, r.text])) as Record<'mcp' | 'blocks', string>
    }

    // L'aperçu d'abord : il ne modifie rien, l'outil voit donc le même état.
    const before = await preview()
    const flat = textOf(await handlers.recall({ query: 'registre Opaline' }))
    expect(before.mcp).toBe(flat)
    // Le seuil par défaut a bien joué des deux côtés.
    expect((JSON.parse(flat) as { dropped?: Array<{ reason: string }> }).dropped?.some(d => d.reason === 'cutoff')).toBe(true)

    // Le rappel précédent a compté : on reprend un aperçu sur l'état courant.
    const again = await preview()
    expect(again.blocks).toBe(textOf(await handlers.recall({ query: 'registre Opaline', format: 'blocks' })))
    expect(again.blocks).toMatch(/^Memory: /)

    // Budget serré : le plafond du texte en blocs est le même des deux côtés.
    const tight = await preview({ token_budget: 100, cutoff: 0 })
    expect(tight.blocks.length).toBeLessThanOrEqual(100 * BLOCKS_CHARS_PER_BUDGET_TOKEN)
    expect(tight.blocks).toBe(textOf(await handlers.recall({ query: 'registre Opaline', format: 'blocks', token_budget: 100, cutoff: 0 })))
  })
})
