/**
 * Mise en forme du rappel (T30) : blocs par thème, projection compacte et
 * rendu texte. Fonctions pures, partagées par le MCP, le daemon et l'aperçu :
 * ce que l'humain voit doit être ce que l'IA reçoit.
 *
 * Données fictives uniquement (dépôt public).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Memoria,
  buildRecallBlocks,
  compactRecall,
  formatRecallBlocks,
  type RecallItem,
  type RecallResult,
} from '../src/index.js'

function item(id: string, date: string, extra: Partial<RecallItem> = {}): RecallItem {
  return {
    kind: 'fact',
    id,
    content: `Souvenir ${id}`,
    category: 'general',
    scope_id: 'scope-1',
    source_db: 'assistants/a.db',
    score: 1,
    created_at: `${date}T10:00:00.000Z`,
    ...extra,
  }
}

const ORION = { id: 't-orion', name: 'Site Orion' }
const KESTREL = { id: 't-kestrel', name: 'Chaîne Kestrel' }

/** Ordre = score décroissant, comme le rend le moteur. */
function sample(): RecallItem[] {
  return [
    item('o2', '2026-03-10', { topic: ORION, entities: ['Orion', 'Brumehost'], matched_by: ['text'], origin: 'declared', status: 'replaces' }),
    item('k1', '2026-01-05', { topic: KESTREL, entities: ['Kestrel'], matched_by: ['text', 'meaning'], origin: 'extracted' }),
    item('o1', '2026-02-01', {
      topic: ORION,
      entities: ['Orion', 'Brumehost', 'Ardoise'],
      matched_by: ['graph', 'context'],
      via_entity: 'Brumehost',
      origin: 'extracted',
      status: 'contested',
      revision: { kind: 'contradicted', replacement_fact_id: 'o2' },
    }),
    item('x1', '2026-04-01', { matched_by: ['meaning'], origin: 'inferred' }),
    item('o3', '2026-03-20', { topic: ORION, entities: ['Orion'], matched_by: ['text'], origin: 'confirmed', status: 'expiring' }),
  ]
}

describe('buildRecallBlocks', () => {
  it('regroupe par thème, ordre du temps, état courant, reste en bloc neutre', () => {
    const blocks = buildRecallBlocks(sample())
    expect(blocks).toEqual([
      // Orion : présent chez 3 sur 3 ; Brumehost chez 2 ; Ardoise (1 seul) écartée.
      { title: 'Site Orion', topic_id: 't-orion', item_ids: ['o1', 'o2', 'o3'], latest_id: 'o3', entities: ['Orion', 'Brumehost'] },
      // k1 est seul dans son thème, x1 n'a pas de thème : bloc neutre, à la fin.
      { title: '', item_ids: ['k1', 'x1'], latest_id: 'x1', loose: true },
    ])
  })

  it('aucun thème : un seul bloc neutre ; aucun item : aucun bloc', () => {
    expect(buildRecallBlocks([item('a', '2026-01-02'), item('b', '2026-01-01')])).toEqual([
      { title: '', item_ids: ['b', 'a'], latest_id: 'a', loose: true },
    ])
    expect(buildRecallBlocks([])).toEqual([])
  })

  it('les blocs suivent le meilleur score, pas l’alphabet', () => {
    const blocks = buildRecallBlocks([
      item('k1', '2026-01-01', { topic: KESTREL }),
      item('o1', '2026-01-01', { topic: ORION }),
      item('o2', '2026-01-02', { topic: ORION }),
      item('k2', '2026-01-02', { topic: KESTREL }),
    ])
    expect(blocks.map(b => b.title)).toEqual(['Chaîne Kestrel', 'Site Orion'])
    expect(blocks.every(b => !('entities' in b) && !('loose' in b))).toBe(true)
  })
})

describe('buildRecallBlocks : même sujet dans deux bases', () => {
  it('regroupe par NOM de thème normalisé, pas par id (propre à chaque base)', () => {
    const blocks = buildRecallBlocks([
      item('p1', '2026-02-01', { topic: { id: 't-prive', name: 'Site Orion' }, source_db: 'assistants/a.db' }),
      item('s1', '2026-03-01', { topic: { id: 't-partage', name: '  site   orion ' }, source_db: 'shared/user.db' }),
      item('é1', '2026-04-01', { topic: { id: 't-autre', name: 'Sité Orion' }, source_db: 'shared/org.db' }),
    ])
    // Un seul bloc, titre et topic_id du premier item (le mieux classé).
    expect(blocks).toEqual([{ title: 'Site Orion', topic_id: 't-prive', item_ids: ['p1', 's1', 'é1'], latest_id: 'é1' }])
  })
})

describe('compactRecall', () => {
  it('résultat sans champs nouveaux : sortie historique EXACTE', () => {
    const payload: RecallResult = {
      items: [
        {
          kind: 'fact',
          id: 'f1',
          content: 'Le portail Lumen est hébergé chez Brumehost',
          category: 'infra',
          scope_id: '3b0a7c1e-0000-4000-8000-000000000001',
          source_db: 'assistants/instance-1/content.db',
          score: 0.123456789,
          created_at: '2026-05-04T08:09:10.123Z',
          origin: 'declared',
          revision: { kind: 'contradicted', replacement_fact_id: 'f2' },
        },
      ],
      totalFound: 7,
      tokens: 42,
      scopes_searched: ['user'],
    }
    const out = compactRecall(payload)
    expect(out).toEqual({
      items: [
        {
          id: 'f1',
          kind: 'fact',
          content: 'Le portail Lumen est hébergé chez Brumehost',
          category: 'infra',
          date: '2026-05-04',
          score: 0.123,
          origin: 'declared',
          revision: { kind: 'contradicted', replacement_fact_id: 'f2' },
        },
      ],
      total_found: 7,
      tokens: 42,
    })
    // Même ordre de clés qu'avant (le JSON envoyé au modèle est identique).
    expect(JSON.stringify(out)).toBe(
      '{"items":[{"id":"f1","kind":"fact","content":"Le portail Lumen est hébergé chez Brumehost","category":"infra","date":"2026-05-04","score":0.123,"origin":"declared","revision":{"kind":"contradicted","replacement_fact_id":"f2"}}],"total_found":7,"tokens":42}',
    )
    expect(compactRecall({ items: [], totalFound: 0, tokens: 0, scopes_searched: [] })).toEqual({ items: [], total_found: 0, tokens: 0 })
    expect(compactRecall({ items: [], totalFound: 0, tokens: 0, scopes_searched: [], disabled: true })).toEqual({
      items: [],
      total_found: 0,
      tokens: 0,
      disabled: true,
    })
  })

  it('champs nouveaux : ajoutés seulement quand ils existent', () => {
    const links = [{ id: 'n1', excerpt: 'Brumehost facture au trimestre', via: 'Brumehost' }]
    const out = compactRecall({
      items: [
        item('o1', '2026-02-01', {
          topic: ORION,
          entities: ['Orion', 'Brumehost'],
          matched_by: ['graph', 'context'],
          via_entity: 'Brumehost',
          status: 'expiring',
          links,
          trust: { confidence: 0.9, used_count: 2, recall_count: 5 },
        }),
        item('x1', '2026-04-01', { matched_by: ['text'], entities: [] }),
      ],
      totalFound: 9,
      tokens: 12,
      scopes_searched: [],
      dropped: [{ reason: 'cutoff', count: 4 }],
    }) as { items: Array<Record<string, unknown>>; dropped?: unknown }

    expect(out.items[0]).toEqual({
      id: 'o1',
      kind: 'fact',
      content: 'Souvenir o1',
      category: 'general',
      date: '2026-02-01',
      score: 1,
      why: ['graph:Brumehost', 'context'],
      topic: 'Site Orion',
      entities: ['Orion', 'Brumehost'],
      status: 'expiring',
      links,
    })
    expect(out.items[1]).toEqual({ id: 'x1', kind: 'fact', content: 'Souvenir x1', category: 'general', date: '2026-04-01', score: 1, why: ['text'] })
    expect(out.dropped).toEqual([{ reason: 'cutoff', count: 4 }])
  })
})

describe('formatRecallBlocks', () => {
  const result = (): RecallResult => ({
    items: sample(),
    totalFound: 12,
    tokens: 50,
    scopes_searched: [],
    dropped: [
      { reason: 'cutoff', count: 4 },
      { reason: 'limit', count: 3 },
    ],
  })

  it('rendu complet : en-tête, blocs, état courant puis ordre du temps', () => {
    expect(formatRecallBlocks(result())).toBe(
      [
        'Memory: 2 blocks, 5 kept, 7 dropped (cutoff 4, limit 3)',
        '## Site Orion (3) · Orion, Brumehost',
        'now 2026-03-20 #o3 Souvenir o3 [text · confirmed · expiring]',
        '- 2026-02-01 #o1 Souvenir o1 [graph:Brumehost+context · extracted · contested by #o2]',
        '- 2026-03-10 #o2 Souvenir o2 [text · stated · replaces an older memory]',
        '## Other (2)',
        '- 2026-01-05 #k1 Souvenir k1 [text+meaning · extracted]',
        '- 2026-04-01 #x1 Souvenir x1 [meaning · inferred]',
      ].join('\n'),
    )
  })

  it('titre du bloc neutre traduisible, voisins rendus, rien d’écarté = pas de mention', () => {
    const text = formatRecallBlocks(
      {
        items: [
          item('a1', '2026-05-01', {
            matched_by: ['text'],
            links: [{ id: 'n1', excerpt: 'Brumehost facture au trimestre', via: 'Brumehost' }],
          }),
        ],
        totalFound: 1,
        tokens: 5,
        scopes_searched: [],
      },
      { looseTitle: 'Divers' },
    )
    expect(text).toBe(
      ['Memory: 1 block, 1 kept', '## Divers (1)', '- 2026-05-01 #a1 Souvenir a1 [text · near: #n1 "Brumehost facture au trimestre" via Brumehost]'].join('\n'),
    )
  })

  it('utilise les blocs fournis par le moteur quand ils sont là', () => {
    const r = result()
    r.blocks = [{ title: 'Tout', topic_id: 't', item_ids: ['k1', 'x1'], latest_id: 'x1' }]
    const text = formatRecallBlocks(r)
    expect(text.split('\n')[1]).toBe('## Tout (2)')
    expect(text).toContain('(+3 more not shown)')
  })

  it('aucun souvenir : texte vide (rien à injecter)', () => {
    expect(formatRecallBlocks({ items: [], totalFound: 0, tokens: 0, scopes_searched: [] })).toBe('')
  })

  it('maxChars n’est JAMAIS dépassé, et un titre ne reste pas seul', () => {
    const full = formatRecallBlocks(result())
    for (let max = 1; max <= full.length + 5; max++) {
      const text = formatRecallBlocks(result(), { maxChars: max })
      expect(text.length, `maxChars=${max}`).toBeLessThanOrEqual(max)
      const lines = text.split('\n')
      expect(lines[lines.length - 1]!.startsWith('## '), `maxChars=${max}`).toBe(false)
    }
    expect(formatRecallBlocks(result(), { maxChars: full.length })).toBe(full)
    // Budget serré : l'en-tête, le premier bloc entamé, puis l'annonce de ce qui manque.
    expect(formatRecallBlocks(result(), { maxChars: 190 })).toBe(
      [
        'Memory: 1 block, 1 of 5 kept, 7 dropped (cutoff 4, limit 3)',
        '## Site Orion (3) · Orion, Brumehost',
        'now 2026-03-20 #o3 Souvenir o3 [text · confirmed · expiring]',
        '(+4 more not shown)',
      ].join('\n'),
    )
  })

  it('l’en-tête annonce ce qui est réellement rendu, quel que soit le budget', () => {
    const full = formatRecallBlocks(result())
    for (let max = 1; max <= full.length + 5; max++) {
      const lines = formatRecallBlocks(result(), { maxChars: max }).split('\n')
      const head = /^Memory: (\d+) blocks?, (?:(\d+) of )?(\d+) kept/.exec(lines[0]!)
      if (!head) continue // en-tête lui-même tronqué : rien d'autre n'est rendu
      const titles = lines.filter(l => l.startsWith('## ')).length
      const shown = lines.filter(l => /^(now|-) /.test(l)).length
      expect(Number(head[1]), `blocs, maxChars=${max}`).toBe(titles)
      expect(Number(head[2] ?? head[3]), `souvenirs, maxChars=${max}`).toBe(shown)
      expect(Number(head[3]), `gardés, maxChars=${max}`).toBe(5)
    }
  })

  it('un souvenir ne peut pas injecter de mise en page', () => {
    const text = formatRecallBlocks({
      items: [
        item('a1', '2026-05-01', { content: '## Faux titre\n- fausse puce\n```sh\nrm -rf\n```', topic: { id: 't', name: '# Thème [piégé]\n## autre' } }),
        item('a2', '2026-05-02', { content: 'Suite normale', topic: { id: 't', name: '# Thème [piégé]\n## autre' }, entities: ['Bru[me]host\n#x'] }),
        item('a3', '2026-05-03', { content: 'Suite', topic: { id: 't', name: '# Thème [piégé]\n## autre' }, entities: ['Bru[me]host\n#x'] }),
      ],
      totalFound: 3,
      tokens: 5,
      scopes_searched: [],
    })
    const lines = text.split('\n')
    expect(lines).toHaveLength(5) // en-tête, titre, 3 souvenirs : aucun saut de ligne injecté
    expect(lines[1]).toBe('## Thème piégé autre (3) · Brumehost x')
    expect(lines.filter(l => l.startsWith('##'))).toHaveLength(1)
    expect(text).not.toContain('```')
    expect(lines[2]).toBe('now 2026-05-03 #a3 Suite')
    expect(lines[3]).toBe("- 2026-05-01 #a1 Faux titre - fausse puce '''sh rm -rf '''")
  })
})

describe('format blocks dans le moteur', () => {
  it('blocks émis seulement sur demande, items toujours complets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memoria-blocks-'))
    const m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
    try {
      const instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
      const a = m.storeFact({ instance, content: 'Le déploiement Brumehost utilise le compte Solstice' })
      const b = m.storeFact({ instance, content: 'Brumehost échoue quand le cache Solstice est corrompu' })
      const c = m.storeFact({ instance, content: 'Le déploiement des tentes commence à six heures' })
      await m.processCognition(instance)

      const q = { instance, query: 'déploiement Brumehost Solstice', preview: true }
      const flat = m.recall(q)
      expect(flat).not.toHaveProperty('blocks')
      expect(m.recall({ ...q, format: 'flat' })).not.toHaveProperty('blocks')

      const res = m.recall({ ...q, format: 'blocks' })
      // Le score dépend de l'instant (récence) : on compare tout le reste.
      const stable = (items: RecallItem[]) => items.map(({ score: _score, ...rest }) => rest)
      expect(stable(res.items)).toEqual(stable(flat.items))
      const themed = res.blocks!.find(b => !b.loose)!
      expect(themed.title).toBe(res.items.find(i => i.id === a.id)!.topic!.name)
      expect([...themed.item_ids].sort()).toEqual([a.id, b.id].sort())
      expect(themed.entities).toEqual(expect.arrayContaining(['Brumehost', 'Solstice']))
      const loose = res.blocks!.find(b => b.loose)!
      expect(loose).toEqual({ title: '', item_ids: [c.id], latest_id: c.id, loose: true })
      // Chaque souvenir est dans un bloc et un seul.
      expect(res.blocks!.flatMap(b => b.item_ids).sort()).toEqual(res.items.map(i => i.id).sort())

      const text = formatRecallBlocks(res)
      expect(text.split('\n')[0]).toBe('Memory: 2 blocks, 3 kept')
      expect(text).toContain(`## ${themed.title} (2)`)
      expect(text).toContain('## Other (1)')
    } finally {
      m.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
