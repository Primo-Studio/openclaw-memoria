/**
 * Régressions de l'écran Carte, sur sa logique pure (pas de rendu React) :
 * teintes de légende, course entre deux demandes de liens, fils vers des
 * points masqués, glisser jamais terminé, statut « error » du service.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryMapLinks } from '../src/api'
import {
  canStartDrag,
  dragAbandoned,
  drawableLinks,
  hoverTarget,
  latestGuard,
  legendKeys,
  linkRows,
  linksFor,
  mapBanners,
  releaseAction,
  shouldPoll,
  startPolling,
  type DragState,
} from '../src/screens/MemoryMap'

const pt = (agent: string, category = 'decision') => ({ agent, category })

function links(id: string, neighbours: string[] = [], related: string[] = []): MemoryMapLinks {
  return {
    id,
    content: `texte de ${id}`,
    category: 'decision',
    agent: 'a',
    created_at: '2026-01-01T00:00:00Z',
    recall_count: 0,
    entities: [],
    neighbours: neighbours.map(n => ({ id: n, similarity: 0.9 })),
    related: related.map(r => ({ id: r, via: 'nom' })),
  }
}

describe('legendKeys', () => {
  it('la teinte d’un agent suit son rang dans la liste COMPLÈTE, pas dans la liste affichée', () => {
    // « a » n'a aucun point placé : « b » garde quand même la teinte 1.
    const keys = legendKeys([pt('b'), pt('c'), pt('c')], ['c', 'a', 'b'], 'agent')
    expect(keys).toEqual([
      { key: 'b', slot: 1, count: 1 },
      { key: 'c', slot: 2, count: 2 },
    ])
    // Quand « a » reçoit des points, personne ne change de teinte.
    const later = legendKeys([pt('a'), pt('b'), pt('c')], ['a', 'b', 'c'], 'agent')
    expect(later.find(l => l.key === 'b')?.slot).toBe(1)
    expect(later.find(l => l.key === 'c')?.slot).toBe(2)
  })

  it('la teinte d’une catégorie est un indice fixe, même si les précédentes sont absentes', () => {
    const keys = legendKeys([pt('a', 'decision'), pt('a', 'Error'), pt('a', 'inconnue')], ['a'], 'category')
    expect(keys).toEqual([
      { key: 'decision', slot: 1, count: 1 },
      { key: 'error', slot: 4, count: 1 },
      { key: '__other__', slot: -1, count: 1 },
    ])
  })

  it('un agent sans aucun point compte pour le rang de teinte mais n’est pas affiché', () => {
    // Le moteur renvoie toutes les sources, y compris celles à zéro point.
    const keys = legendKeys([pt('z')], ['a', 'b', 'z'], 'agent')
    expect(keys).toEqual([{ key: 'z', slot: 2, count: 1 }])
  })

  it('dédoublonne les identifiants d’agents', () => {
    const keys = legendKeys([pt('shared:x'), pt('shared:x')], ['shared:x', 'shared:x'], 'agent')
    expect(keys).toEqual([{ key: 'shared:x', slot: 0, count: 2 }])
  })

  it('au-delà du nombre de teintes : le neutre', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const keys = legendKeys(ids.map(id => pt(id)), ids, 'agent')
    expect(keys.map(l => l.slot)).toEqual([0, 1, 2, 3, 4, -1])
  })
})

describe('course entre deux demandes de liens', () => {
  it('seule la dernière demande reste valable, y compris après une fermeture', () => {
    const guard = latestGuard()
    const a = guard.begin()
    const b = guard.begin()
    expect(a()).toBe(false)
    expect(b()).toBe(true)
    guard.begin() // fermeture du panneau
    expect(b()).toBe(false)
  })

  it('des liens ne valent que pour le souvenir qu’ils décrivent', () => {
    expect(linksFor(links('A'), 'B')).toBeNull()
    expect(linksFor(links('A'), null)).toBeNull()
    expect(linksFor(links('A'), 'A')?.content).toBe('texte de A')
  })
})

describe('drawableLinks', () => {
  it('aucun fil si le souvenir choisi est masqué', () => {
    expect(drawableLinks('A', links('A', ['B']), new Set(['B']))).toBeNull()
  })
  it('aucun fil vers une cible masquée ou absente', () => {
    expect(drawableLinks('A', links('A', ['B', 'C'], ['D', 'E']), new Set(['A', 'B', 'E']))).toEqual({
      neighbours: ['B'],
      related: ['E'],
    })
  })
  it('aucun fil avec les liens d’un autre souvenir', () => {
    expect(drawableLinks('B', links('A', ['C']), new Set(['A', 'B', 'C']))).toBeNull()
  })
})

describe('glisser', () => {
  const held: DragState = { pointerId: 1, x: 0, y: 0, moved: false }
  it('ne part que du bouton principal', () => {
    expect(canStartDrag({ button: 0, pointerId: 1 }, null)).toBe(true)
    expect(canStartDrag({ button: 2, pointerId: 1 }, null)).toBe(false)
    expect(canStartDrag({ button: 1, pointerId: 1 }, null)).toBe(false)
  })
  it('un second pointeur ne prend pas la main, le même pointeur peut réarmer', () => {
    expect(canStartDrag({ button: 0, pointerId: 2 }, held)).toBe(false)
    expect(canStartDrag({ button: 0, pointerId: 1 }, held)).toBe(true)
  })
  it('un glisser sans bouton enfoncé est abandonné (relâchement jamais reçu)', () => {
    expect(dragAbandoned({ pointerId: 1, buttons: 0 }, held)).toBe(true)
    expect(dragAbandoned({ pointerId: 1, buttons: 1 }, held)).toBe(false)
    expect(dragAbandoned({ pointerId: 2, buttons: 0 }, held)).toBe(false)
    expect(dragAbandoned({ pointerId: 1, buttons: 0 }, null)).toBe(false)
  })
  it('clic gauche relâché pendant que le droit reste tenu : le glisser s’arrête', () => {
    expect(dragAbandoned({ pointerId: 1, buttons: 2 }, held)).toBe(true)
    // Gauche + droit tenus : le glisser continue.
    expect(dragAbandoned({ pointerId: 1, buttons: 3 }, held)).toBe(false)
  })
  it('on ne choisit un point qu’au relâchement du bouton principal, sans déplacement', () => {
    expect(releaseAction({ pointerId: 1, button: 0 }, held)).toBe('select')
    expect(releaseAction({ pointerId: 1, button: 2 }, held)).toBe('end')
    expect(releaseAction({ pointerId: 1, button: 0 }, { ...held, moved: true })).toBe('end')
    expect(releaseAction({ pointerId: 2, button: 0 }, held)).toBe('ignore')
    expect(releaseAction({ pointerId: 1, button: 0 }, null)).toBe('ignore')
  })
})

describe('shouldPoll', () => {
  it('on redemande pendant un calcul, jamais après une erreur', () => {
    expect(shouldPoll('computing')).toBe(true)
    expect(shouldPoll('error')).toBe(false)
    expect(shouldPoll('ready')).toBe(false)
    expect(shouldPoll(undefined)).toBe(false)
  })
})

describe('startPolling', () => {
  afterEach(() => vi.useRealTimers())

  it('une demande à la fois : le délai ne repart qu’après la réponse', async () => {
    vi.useFakeTimers()
    const pending: Array<() => void> = []
    const run = vi.fn(() => new Promise<void>(resolve => pending.push(resolve)))
    const stop = startPolling(run, 3000)

    await vi.advanceTimersByTimeAsync(3000)
    expect(run).toHaveBeenCalledTimes(1)
    // Le service met 30 s à répondre : aucune autre demande ne part entre-temps.
    await vi.advanceTimersByTimeAsync(30000)
    expect(run).toHaveBeenCalledTimes(1)

    pending[0]!()
    await vi.advanceTimersByTimeAsync(2999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    stop()
  })

  it('continue après un échec, et s’arrête net à l’arrêt', async () => {
    vi.useFakeTimers()
    const run = vi.fn(() => Promise.reject(new Error('service coupé')))
    const stop = startPolling(run, 3000)
    await vi.advanceTimersByTimeAsync(6000)
    expect(run).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(30000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('une réponse arrivée après l’arrêt ne relance rien', async () => {
    vi.useFakeTimers()
    let release = (): void => {}
    const run = vi.fn(() => new Promise<void>(resolve => (release = resolve)))
    const stop = startPolling(run, 3000)
    await vi.advanceTimersByTimeAsync(3000)
    stop()
    release()
    await vi.advanceTimersByTimeAsync(30000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('mapBanners', () => {
  it('une erreur de relance s’affiche, que la carte ait des points ou non', () => {
    expect(mapBanners('service coupé', null)).toEqual([{ message: 'service coupé', retry: 'load' }])
    expect(mapBanners('service coupé', 'calcul en échec')).toEqual([
      { message: 'service coupé', retry: 'load' },
      { message: 'calcul en échec', retry: 'rebuild' },
    ])
    expect(mapBanners(null, null)).toEqual([])
  })
})

describe('survol et voisins masqués', () => {
  it('le survol ne tient que sur un point qui passe la recherche', () => {
    expect(hoverTarget('A', new Set(['A', 'B']))).toBe('A')
    expect(hoverTarget('A', new Set(['B']))).toBeNull()
    expect(hoverTarget(null, new Set(['A']))).toBeNull()
  })

  it('un voisin masqué reste listé mais non cliquable, un voisin absent est omis', () => {
    const items = [
      { id: 'A', note: '90 %' },
      { id: 'B', note: '80 %' },
      { id: 'C', note: '70 %' },
    ]
    expect(linkRows(items, new Set(['A', 'B']), new Set(['A']))).toEqual([
      { id: 'A', note: '90 %', shown: true },
      { id: 'B', note: '80 %', shown: false },
    ])
  })
})
