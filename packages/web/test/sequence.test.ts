/**
 * Régression : deux recherches lancées à la suite dont la PREMIÈRE répond en
 * dernier — la liste doit refléter la dernière requête (Maintenance, Mémoire).
 */
import { describe, expect, it } from 'vitest'
import { createSequence } from '../src/lib/sequence'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('createSequence — la dernière requête gagne', () => {
  it('ignore la réponse d’une requête périmée arrivée après la plus récente', async () => {
    const seq = createSequence()
    let shown: string[] | null = null
    const search = (q: string, d: { promise: Promise<string[]> }) => {
      const id = seq.next()
      return d.promise.then(list => {
        if (!seq.isCurrent(id)) return
        shown = list
      })
    }
    const first = deferred<string[]>()
    const second = deferred<string[]>()
    const p1 = search('proj', first)
    const p2 = search('projet', second)
    second.resolve(['projet A'])
    await p2
    first.resolve(['proj X', 'projet A'])
    await p1
    expect(shown).toEqual(['projet A'])
  })

  it('sans course, la réponse la plus récente est prise', () => {
    const seq = createSequence()
    const a = seq.next()
    expect(seq.isCurrent(a)).toBe(true)
    const b = seq.next()
    expect(seq.isCurrent(a)).toBe(false)
    expect(seq.isCurrent(b)).toBe(true)
  })
})
