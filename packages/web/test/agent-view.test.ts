/**
 * Écran « Ce que voit l'IA » : logique pure et client de l'aperçu du rappel.
 * Environnement node, AUCUN réseau (fetch stubé). Données fictives uniquement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  isOldServiceError,
  nativeRenderOf,
  normalizeRecallPreview,
  previewRecall,
  RECALL_RENDER_IDS,
  type RecallPreviewItem,
} from '../src/api'
import { NAV_GROUPS, screenFromHash } from '../src/app/nav'
import {
  bestScore,
  droppedSummary,
  estimateTokens,
  originKey,
  previewSummary,
  reasonChips,
  reasonLabel,
  renderOrder,
  renderTokens,
  scorePercent,
  statusKinds,
  toggleAgent,
  viewBlocks,
} from '../src/screens/agentViewLogic'

function item(id: string, extra: Partial<RecallPreviewItem> = {}): RecallPreviewItem {
  return { id, kind: 'fact', content: `Souvenir ${id}`, category: 'decision', score: 0.5, created_at: '2026-01-01T00:00:00Z', ...extra }
}

const ORION = { id: 't-orion', name: 'Site Orion' }
/** Traduction factice : rend la clé et ses variables, pour vérifier le choix du libellé. */
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(',')}` : key)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('navigation', () => {
  it('« agent-view » est une route, placée juste après la carte dans « Essentiel »', () => {
    expect(screenFromHash('#/agent-view')).toBe('agent-view')
    const essential = NAV_GROUPS.find(g => g.id === 'essential')!.items.map(i => i.id)
    expect(essential.indexOf('agent-view')).toBe(essential.indexOf('map') + 1)
  })
})

describe('estimation de tokens', () => {
  it('suit la règle du moteur (un token pour 3,6 caractères, arrondi au-dessus)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('a'.repeat(36))).toBe(10)
    expect(estimateTokens('a'.repeat(37))).toBe(11)
  })

  it('préfère le compte du service à l’estimation', () => {
    expect(renderTokens({ text: 'a'.repeat(36), tokens: 7 })).toBe(7)
    expect(renderTokens({ text: 'a'.repeat(36) })).toBe(10)
    expect(renderTokens(undefined)).toBe(0)
  })
})

describe('viewBlocks', () => {
  const items = [
    item('o2', { topic: ORION, created_at: '2026-03-10T00:00:00Z', score: 0.9 }),
    item('k1', { created_at: '2026-01-05T00:00:00Z', score: 0.8 }),
    item('o3', { topic: ORION, created_at: '2026-03-20T00:00:00Z', score: 0.7 }),
    item('o1', { topic: ORION, created_at: '2026-02-01T00:00:00Z', score: 0.6 }),
    item('x1', { topic: { id: 't-seul', name: 'Seul' }, created_at: '2026-04-01T00:00:00Z', score: 0.5 }),
  ]

  it('suit les blocs du moteur : état courant en tête, puis le reste dans l’ordre du temps', () => {
    const blocks = viewBlocks(items, [
      { title: 'Site Orion', topic_id: 't-orion', item_ids: ['o1', 'o2', 'o3'], latest_id: 'o3', entities: ['Orion', 'Brumehost'] },
      { title: '', item_ids: ['k1', 'x1'], latest_id: 'x1', loose: true },
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ key: 't-orion', title: 'Site Orion', loose: false, entities: ['Orion', 'Brumehost'] })
    expect(blocks[0]!.current?.id).toBe('o3')
    expect(blocks[0]!.others.map(i => i.id)).toEqual(['o1', 'o2'])
    expect(blocks[1]).toMatchObject({ loose: true, current: null })
    expect(blocks[1]!.others.map(i => i.id)).toEqual(['k1', 'x1'])
  })

  it('regroupe lui-même quand le service n’envoie pas de blocs (thème d’au moins 2 souvenirs)', () => {
    const blocks = viewBlocks(items)
    expect(blocks.map(b => b.title)).toEqual(['Site Orion', ''])
    expect(blocks[0]!.current?.id).toBe('o3')
    expect(blocks[0]!.others.map(i => i.id)).toEqual(['o1', 'o2'])
    // Le thème d'un seul souvenir rejoint le bloc sans titre, dans l'ordre du score.
    expect(blocks[1]!.others.map(i => i.id)).toEqual(['k1', 'x1'])
  })

  it('ne cache aucun souvenir : un souvenir qu’aucun bloc ne cite rejoint le bloc sans thème', () => {
    const blocks = viewBlocks(items, [{ title: 'Site Orion', topic_id: 't-orion', item_ids: ['o1', 'o3', 'fantome'], latest_id: 'o3' }])
    const shown = blocks.flatMap(b => [...(b.current ? [b.current.id] : []), ...b.others.map(i => i.id)])
    expect(shown.sort()).toEqual(['k1', 'o1', 'o2', 'o3', 'x1'])
    expect(blocks.at(-1)!.loose).toBe(true)
    expect(blocks.at(-1)!.others.map(i => i.id)).toEqual(['o2', 'k1', 'x1'])
  })

  it('ne montre pas deux fois un souvenir cité par deux blocs, et rend [] sans souvenir', () => {
    const blocks = viewBlocks(items.slice(0, 2), [
      { title: 'A', topic_id: 'a', item_ids: ['o2', 'k1'], latest_id: 'k1' },
      { title: 'B', topic_id: 'b', item_ids: ['o2'], latest_id: 'o2' },
    ])
    expect(blocks).toHaveLength(1)
    expect(viewBlocks([], [{ title: 'A', item_ids: ['o2'], latest_id: 'o2' }])).toEqual([])
  })
})

describe('raisons, origine, statut', () => {
  it('ordonne et dédoublonne les raisons, ignore les inconnues', () => {
    const chips = reasonChips({ matched_by: ['context', 'text', 'text', 'surprise' as never, 'pinned'] })
    expect(chips.map(c => c.kind)).toEqual(['pinned', 'text', 'context'])
    expect(reasonChips({})).toEqual([])
  })

  it('nomme l’entité de passage d’un voisin de graphe, seulement pour lui', () => {
    expect(reasonChips({ matched_by: ['graph', 'meaning'], via_entity: ' Brumehost ' })).toEqual([{ kind: 'meaning' }, { kind: 'graph', entity: 'Brumehost' }])
    expect(reasonLabel(t, { kind: 'graph', entity: 'Brumehost' })).toBe('agentview.why.graph_via:Brumehost')
    expect(reasonLabel(t, { kind: 'graph' })).toBe('agentview.why.graph')
    expect(reasonLabel(t, { kind: 'meaning' })).toBe('agentview.why.meaning')
  })

  it('traduit les origines connues, tait les autres', () => {
    expect(originKey('declared')).toBe('agentview.origin.declared')
    expect(originKey('confirmed')).toBe('agentview.origin.confirmed')
    expect(originKey('mystere')).toBeNull()
    expect(originKey(undefined)).toBeNull()
  })

  it('précise le motif d’une révision et ne le répète pas avec « contested »', () => {
    expect(statusKinds({ status: 'contested', revision: { kind: 'duplicate', replacement_fact_id: 'o2' } })).toEqual(['duplicate'])
    expect(statusKinds({ status: 'contested', revision: { kind: 'obsolete' } })).toEqual(['obsolete'])
    expect(statusKinds({ status: 'contested', revision: { kind: 'contradicted' } })).toEqual(['contested'])
    expect(statusKinds({ status: 'contested' })).toEqual(['contested'])
    expect(statusKinds({ status: 'expiring' })).toEqual(['expiring'])
    expect(statusKinds({ status: 'replaces' })).toEqual(['replaces'])
    expect(statusKinds({})).toEqual([])
  })
})

describe('score relatif', () => {
  it('exprime le score en part du meilleur, borné, visible dès qu’il est positif', () => {
    expect(scorePercent(0.79, 0.79)).toBe(100)
    expect(scorePercent(0.395, 0.79)).toBe(50)
    expect(scorePercent(0.001, 0.79)).toBe(2)
    expect(scorePercent(2, 1)).toBe(100)
    expect(scorePercent(0, 0.79)).toBe(0)
    expect(scorePercent(0.5, 0)).toBe(0)
    expect(bestScore([item('a', { score: 0.2 }), item('b', { score: 0.7 })])).toBe(0.7)
    expect(bestScore([])).toBe(0)
  })
})

describe('écartés et résumé', () => {
  it('compte par motif, dans un ordre fixe, sans perdre un motif inconnu', () => {
    const s = droppedSummary([
      { reason: 'limit', count: 3 },
      { reason: 'cutoff', count: 4 },
      { reason: 'nouveau', count: 1 },
      { reason: 'budget', count: 0 },
    ])
    expect(s.total).toBe(8)
    expect(s.parts).toEqual([
      { reason: 'cutoff', count: 4 },
      { reason: 'limit', count: 3 },
      { reason: 'other', count: 1 },
    ])
    expect(droppedSummary([])).toEqual({ total: 0, parts: [] })
  })

  it('résume une colonne : souvenirs, blocs, écartés, tokens du rendu natif', () => {
    const preview = normalizeRecallPreview(
      {
        result: { items: [item('o1', { topic: ORION }), item('o2', { topic: ORION }), item('k1')], dropped: [{ reason: 'cutoff', count: 4 }] },
        renderings: [
          { id: 'mcp', native: true, text: 'a'.repeat(72) },
          { id: 'openclaw', native: false, text: 'a'.repeat(360) },
        ],
      },
      { instance: 'inst-1', query: 'site Orion' },
    )
    expect(previewSummary(preview)).toEqual({ memories: 3, blocks: 2, dropped: 4, tokens: 20 })
  })

  it('agent OpenClaw : le résumé et la vue lisible lisent le rappel du rendu natif, pas celui du MCP', () => {
    const preview = normalizeRecallPreview(
      {
        agent_type: 'openclaw',
        // Racine : ce que renvoyait le rappel façon MCP (4 souvenirs, 2 écartés).
        result: { items: [item('m1'), item('m2'), item('m3'), item('m4')], dropped: [{ reason: 'cutoff', count: 2 }] },
        renderings: [
          { id: 'mcp', native: false, text: 'a'.repeat(72), tokens: 21, result: { items: [item('m1'), item('m2'), item('m3'), item('m4')], dropped: [{ reason: 'cutoff', count: 2 }] } },
          { id: 'openclaw', native: true, text: 'b'.repeat(400), tokens: 93, result: { items: [item('c1'), item('c2')], dropped: [{ reason: 'budget', count: 5 }] } },
        ],
      },
      { instance: 'inst-2', query: 'site Orion' },
    )
    expect(preview.native).toBe('openclaw')
    expect(preview.items.map(i => i.id)).toEqual(['c1', 'c2'])
    expect(preview.dropped).toEqual([{ reason: 'budget', count: 5 }])
    expect(previewSummary(preview)).toEqual({ memories: 2, blocks: 1, dropped: 5, tokens: 93 })
    // Vue brute : chaque rendu garde SON texte, SES tokens et SON résultat.
    expect(renderTokens(preview.renders.mcp, 'mcp')).toBe(21)
    expect(preview.renders.mcp?.result?.items).toHaveLength(4)
    expect(preview.renders.openclaw?.text).toBe('b'.repeat(400))
  })

  it('sans résultat par rendu (service qui n’en envoie qu’un), retombe sur celui de la racine', () => {
    const preview = normalizeRecallPreview(
      { agent_type: 'openclaw', result: { items: [item('m1')] }, renderings: [{ id: 'openclaw', native: true, text: 'x' }] },
      { instance: 'inst-2', query: 'q' },
    )
    expect(preview.items.map(i => i.id)).toEqual(['m1'])
    expect(preview.renders.openclaw?.result).toBeUndefined()
  })

  it('sans compte du service, estime le bloc OpenClaw à 4 caractères par token (sa propre règle de coupe)', () => {
    // Un bloc plein à 600 tokens fait 2 400 caractères : il ne doit pas s'afficher au-dessus de son budget.
    expect(renderTokens({ text: 'a'.repeat(2400) }, 'openclaw')).toBe(600)
    expect(renderTokens({ text: 'a'.repeat(2400) }, 'mcp')).toBe(667)
    expect(renderTokens({ text: 'a'.repeat(2400), tokens: 580 }, 'openclaw')).toBe(580)
  })

  it('en pause, le résumé garde les souvenirs de la reprise mais ne compte pas de tokens', () => {
    const preview = normalizeRecallPreview(
      { disabled: true, result: { items: [item('o1')] }, renderings: [{ id: 'mcp', native: true, text: '{"items":[],"disabled":true}', tokens: 8 }] },
      { instance: 'inst-1', query: 'q' },
    )
    expect(previewSummary(preview)).toEqual({ memories: 1, blocks: 1, dropped: 0, tokens: null })
  })

  it('propose le rendu de l’agent en premier', () => {
    expect(renderOrder('openclaw', RECALL_RENDER_IDS)).toEqual(['openclaw', 'mcp', 'blocks'])
    expect(renderOrder('mcp', RECALL_RENDER_IDS)).toEqual(['mcp', 'blocks', 'openclaw'])
  })
})

describe('sélection des agents', () => {
  const all = ['a', 'b', 'c']
  it('coche, décoche, garde l’ordre des colonnes et refuse la sélection vide', () => {
    expect(toggleAgent(['a', 'c'], 'b', all)).toEqual(['a', 'b', 'c'])
    expect(toggleAgent(['a', 'b', 'c'], 'b', all)).toEqual(['a', 'c'])
    expect(toggleAgent(['b'], 'b', all)).toEqual(['b'])
  })
})

describe('normalizeRecallPreview', () => {
  const fallback = { instance: 'inst-1', query: 'site Orion', agentType: 'openclaw' }

  it('lit la réponse du service : résultat, rendus, rendu natif, pause', () => {
    const p = normalizeRecallPreview(
      {
        instance: 'inst-9',
        agent_type: 'claude-code',
        query: 'q',
        disabled: true,
        result: {
          items: [item('o1'), { id: 42 }, null],
          blocks: [{ title: '', item_ids: ['o1'], latest_id: 'o1', loose: true }, 'bruit'],
          dropped: [{ reason: 'limit', count: 2 }, { reason: 'budget', count: 0 }, { reason: 3 }],
        },
        renderings: [
          { id: 'mcp', native: false, text: '{"items":[]}' },
          { id: 'blocks', native: true, text: 'Memory: 1 block, 1 kept', tokens: 6 },
          { id: 'inconnu', native: true, text: 'x' },
          { id: 'openclaw', native: false },
        ],
      },
      fallback,
    )
    expect(p).toMatchObject({ instance: 'inst-9', query: 'q', disabled: true, native: 'blocks' })
    expect(p.items.map(i => i.id)).toEqual(['o1'])
    expect(p.blocks).toHaveLength(1)
    expect(p.dropped).toEqual([{ reason: 'limit', count: 2 }])
    expect(p.renders).toEqual({ mcp: { text: '{"items":[]}' }, blocks: { text: 'Memory: 1 block, 1 kept', tokens: 6 } })
  })

  it('sans rendu natif déclaré, le déduit du type d’agent ; un rendu absent reste absent', () => {
    expect(nativeRenderOf('openclaw')).toBe('openclaw')
    expect(nativeRenderOf('codex')).toBe('mcp')
    expect(nativeRenderOf(undefined)).toBe('mcp')
    const p = normalizeRecallPreview({ items: [item('o1')] }, fallback)
    expect(p).toMatchObject({ instance: 'inst-1', query: 'site Orion', disabled: false, native: 'openclaw', renders: {}, dropped: [] })
    expect(p.items).toHaveLength(1)
    expect(p.blocks).toBeUndefined()
  })

  it('retire les champs mal formés d’un souvenir au lieu de laisser planter l’écran', () => {
    const p = normalizeRecallPreview(
      {
        result: {
          items: [
            { id: 'o1', content: 'Souvenir o1', links: 'pas un tableau', entities: { a: 1 }, matched_by: 'text', topic: 'Orion', trust: 'haute', score: 'fort', created_at: 12 },
            { id: 'o2', content: 'Souvenir o2', links: [{ id: 'v1', excerpt: 'Voisin', via: 'Brumehost' }, 'bruit', { id: 'v2' }], entities: ['Orion', 3], matched_by: ['text', 4] },
          ],
        },
      },
      fallback,
    )
    expect(p.items[0]).toEqual({ id: 'o1', kind: '', content: 'Souvenir o1', category: '', score: 0, created_at: '' })
    expect(p.items[1]).toMatchObject({ links: [{ id: 'v1', excerpt: 'Voisin', via: 'Brumehost' }], entities: ['Orion'], matched_by: ['text'] })
    // La logique de l'écran tourne sans exception sur ces souvenirs.
    expect(viewBlocks(p.items, p.blocks).flatMap(b => b.others.map(i => i.id))).toEqual(['o1', 'o2'])
  })

  it('refuse un bloc de thème sans titre : ses souvenirs vont dans le bloc sans thème, aucun intertitre vide', () => {
    const p = normalizeRecallPreview(
      {
        result: {
          items: [item('o1'), item('o2'), item('k1')],
          blocks: [
            { topic_id: 't-orion', item_ids: ['o1', 'o2'], latest_id: 'o2' },
            { title: '   ', item_ids: ['k1'], latest_id: 'k1' },
            { title: 'Hors sujet', item_ids: 'k1', latest_id: 'k1' },
          ],
        },
      },
      fallback,
    )
    expect(p.blocks).toEqual([])
    const blocks = viewBlocks(p.items, p.blocks)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ loose: true })
    expect(blocks[0]!.others.map(i => i.id)).toEqual(['o1', 'o2', 'k1'])
  })

  it('une réponse illisible donne un aperçu vide, pas une exception', () => {
    for (const raw of [null, 'texte', [], 12]) {
      expect(normalizeRecallPreview(raw, fallback).items).toEqual([])
    }
  })
})

describe('previewRecall', () => {
  function stub(response: { status: number; body: unknown }) {
    vi.stubGlobal('sessionStorage', { getItem: () => 'tok-admin', setItem: () => {}, removeItem: () => {} })
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchFn)
    return fetchFn
  }

  it('POST /v1/admin/recall_preview { instance, query } avec le token admin', async () => {
    const fetchFn = stub({ status: 200, body: { instance: 'inst-1', agent_type: 'codex', query: 'site Orion', result: { items: [item('o1')] }, renderings: [] } })
    const p = await previewRecall('inst-1', 'site Orion', 'codex')
    expect(p.items.map(i => i.id)).toEqual(['o1'])
    expect(p.native).toBe('mcp')
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toMatch(/\/v1\/admin\/recall_preview$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ instance: 'inst-1', query: 'site Orion' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-admin')
  })

  it('404 « route inconnue » = service plus ancien ; 404 « instance inconnue » = erreur ordinaire', async () => {
    stub({ status: 404, body: { error: 'route admin inconnue : POST /v1/admin/recall_preview' } })
    const old = await previewRecall('inst-1', 'q').catch((e: unknown) => e)
    expect(old).toBeInstanceOf(ApiError)
    expect(isOldServiceError(old)).toBe(true)

    stub({ status: 404, body: { error: 'instance inconnue : inst-1' } })
    const gone = await previewRecall('inst-1', 'q').catch((e: unknown) => e)
    expect(isOldServiceError(gone)).toBe(false)

    expect(isOldServiceError(new ApiError(500, 'panne'))).toBe(false)
    expect(isOldServiceError(new Error('réseau'))).toBe(false)
  })
})
