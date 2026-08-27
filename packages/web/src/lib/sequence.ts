/**
 * Garde anti-course « la dernière requête gagne ».
 *
 * POURQUOI : une recherche par frappe (ou deux clics rapides) lance plusieurs
 * appels réseau ; rien ne garantit qu'ils reviennent dans l'ordre. Sans
 * jeton, la réponse de « proj » arrivée APRÈS celle de « projet » écrasait la
 * liste avec un résultat plus ancien que le champ de saisie.
 *
 * Usage : `const id = seq.next()` avant l'appel, `if (!seq.isCurrent(id)) return`
 * à la réception (succès comme échec).
 */
export interface Sequence {
  next(): number
  isCurrent(id: number): boolean
}

export function createSequence(): Sequence {
  let current = 0
  return {
    next() {
      current += 1
      return current
    },
    isCurrent(id) {
      return id === current
    },
  }
}
