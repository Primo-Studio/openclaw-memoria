import { describe, expect, it } from 'vitest'
import { ariaSort, nextSort } from '../src/lib/sort'

type K = 'ts' | 'actor'
const DATES: readonly K[] = ['ts']

describe('nextSort (en-têtes triables du Journal)', () => {
  it('re-cliquer la colonne active inverse le sens', () => {
    expect(nextSort<K>({ key: 'ts', dir: 'desc' }, 'ts', DATES)).toEqual({ key: 'ts', dir: 'asc' })
    expect(nextSort<K>({ key: 'ts', dir: 'asc' }, 'ts', DATES)).toEqual({ key: 'ts', dir: 'desc' })
  })

  it('une nouvelle colonne date part en « récent d’abord », une colonne texte en A→Z', () => {
    expect(nextSort<K>({ key: 'actor', dir: 'asc' }, 'ts', DATES)).toEqual({ key: 'ts', dir: 'desc' })
    expect(nextSort<K>({ key: 'ts', dir: 'desc' }, 'actor', DATES)).toEqual({ key: 'actor', dir: 'asc' })
  })

  it('aria-sort ne décrit que la colonne active', () => {
    const s = { key: 'ts' as K, dir: 'desc' as const }
    expect(ariaSort(s, 'ts')).toBe('descending')
    expect(ariaSort(s, 'actor')).toBe('none')
  })
})
