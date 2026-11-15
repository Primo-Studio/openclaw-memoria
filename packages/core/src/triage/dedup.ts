/**
 * REDITES du tri : amas de faits qui disent la même chose.
 *
 *  - Seuil : cosinus ≥ 0,92 entre vecteurs (mesuré : 4 à 17 % de redites).
 *  - GARDE CHIFFRES : deux faits proches qui diffèrent par un nombre (prix,
 *    date, quantité) sont une MISE À JOUR, jamais une redite. On compare les
 *    ensembles de nombres normalisés : « 2 340 » = « 2340 », « 09/11 » = « 9/11 ».
 *  - Regroupement GLOUTON par représentant : les faits sont pris du plus
 *    complet au moins complet (texte le plus long, puis conversation la plus
 *    récente, puis id) ; chacun rejoint le premier représentant assez proche,
 *    sinon devient représentant. Chaque membre est donc proche de SON
 *    représentant (pas d'enchaînement A~B~C où A et C n'ont rien à voir).
 *  - Calcul découpé : la boucle rend la main à la boucle d'événements toutes
 *    les `sliceMs` (ticket #27 : le daemon ne doit jamais se figer).
 *  - Vecteurs des faits en attente quantifiés en int8 (un quart de la place) :
 *    le cosinus ne dépend pas de l'échelle ; l'erreur mesurée reste très en
 *    dessous de 0,005 (voir les tests).
 */

/** Cosinus minimal entre deux redites. */
export const REDITE_THRESHOLD = 0.92

/** Ensemble des nombres d'un texte, normalisés et triés (signature comparable). */
export function numberSignature(text: string): string {
  const t = text.replace(/[   ]/g, ' ')
  const out = new Set<string>()
  // Dates courtes (14/11, 14/11/2026, 14-11-2026) : chaque partie en entier.
  const dateRe = /\b(\d{1,4})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g
  let rest = t.replace(dateRe, (_m, a: string, b: string, c: string | undefined) => {
    out.add([a, b, c].filter((x): x is string => x !== undefined).map(x => String(Number(x))).join('/'))
    return ' '
  })
  // Nombres avec séparateurs de milliers (espace ou point suivi de 3 chiffres) et décimales (virgule ou point).
  const numRe = /\d+(?:[ .]\d{3})*(?:[.,]\d+)?/g
  rest = rest.replace(numRe, m => {
    let n = m.replace(/ (?=\d{3}\b)/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '')
    n = n.replace(',', '.')
    const value = Number(n)
    out.add(Number.isFinite(value) ? String(value) : n)
    return ' '
  })
  return [...out].sort().join('|')
}

/** Vrai si deux textes portent les mêmes nombres (condition nécessaire d'une redite). */
export function sameNumbers(a: string, b: string): boolean {
  return numberSignature(a) === numberSignature(b)
}

/** Vecteur ramené à la norme 1 (copie). */
export function normalizeVector(v: ArrayLike<number>): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  const norm = Math.sqrt(sum) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm
  return out
}

/** Produit scalaire (= cosinus pour des vecteurs normés). */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** int8 : chaque composante ramenée sur [-127, 127] par le maximum absolu du vecteur. */
export function quantizeInt8(v: Float32Array): Buffer {
  let max = 0
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]!))
  const scale = max > 0 ? 127 / max : 0
  const out = new Int8Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * scale)))
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}

/** Vecteur int8 relu, normé (le cosinus ne dépend pas de l'échelle). */
export function dequantizeInt8(buf: Buffer | Uint8Array, dimensions: number): Float32Array {
  const view = new Int8Array(buf.buffer, buf.byteOffset, Math.min(dimensions, buf.byteLength))
  return normalizeVector(view)
}

/** Vecteur float32 d'`embeddings` relu, normé. */
export function float32FromBlob(buf: Buffer, dimensions: number): Float32Array {
  const copy = new Float32Array(dimensions)
  const view = new Float32Array(buf.buffer, buf.byteOffset, Math.min(dimensions, Math.floor(buf.byteLength / 4)))
  copy.set(view)
  return normalizeVector(copy)
}

export interface AmasCandidate {
  id: string
  text: string
  conversation_at: string | null
  /** Vecteur normé, ou null (texte sensible, ou pas de fournisseur de vecteurs) : redites exactes seulement. */
  vector: Float32Array | null
  /** Clé exacte (texte normalisé haché), pour les faits sans vecteur. */
  exactKey: string
}

/** Ordre de priorité du représentant : texte le plus long, puis conversation la plus récente, puis id. */
export function representativeOrder(a: AmasCandidate, b: AmasCandidate): number {
  return (
    b.text.length - a.text.length ||
    (b.conversation_at ?? '').localeCompare(a.conversation_at ?? '') ||
    a.id.localeCompare(b.id)
  )
}

export interface ClusterOptions {
  threshold?: number
  /** Temps de calcul maximal avant de rendre la main (ms). */
  sliceMs?: number
  /** Arrêt demandé : le calcul s'interrompt (rend ce qui est fait). */
  shouldStop?: () => boolean
  /** Représentants déjà établis (passage précédent) : un candidat les rejoint en priorité. */
  leaders?: AmasCandidate[]
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * Regroupe des candidats en amas. Rend, pour chaque candidat, l'id de son
 * représentant (lui-même s'il est seul ou représentant). Avec `leaders`, un
 * représentant existant peut être rendu pour un candidat.
 */
export async function clusterAsync(candidates: AmasCandidate[], opts: ClusterOptions = {}): Promise<Map<string, string>> {
  const threshold = opts.threshold ?? REDITE_THRESHOLD
  const sliceMs = opts.sliceMs ?? 10
  const leaders: Array<{ c: AmasCandidate; numbers: string }> = (opts.leaders ?? []).map(c => ({ c, numbers: numberSignature(c.text) }))
  const byExact = new Map<string, string>()
  for (const l of leaders) if (!byExact.has(l.c.exactKey)) byExact.set(l.c.exactKey, l.c.id)
  const result = new Map<string, string>()
  const ordered = [...candidates].sort(representativeOrder)
  let sliceStart = Date.now()
  for (const c of ordered) {
    if (opts.shouldStop?.()) break
    const exact = byExact.get(c.exactKey)
    if (exact !== undefined) {
      result.set(c.id, exact)
      continue
    }
    let found: string | null = null
    if (c.vector) {
      const numbers = numberSignature(c.text)
      for (const l of leaders) {
        if (!l.c.vector || l.numbers !== numbers) continue
        if (dot(c.vector, l.c.vector) >= threshold) {
          found = l.c.id
          break
        }
        if (Date.now() - sliceStart >= sliceMs) {
          await yieldToEventLoop()
          sliceStart = Date.now()
        }
      }
      if (found === null) leaders.push({ c, numbers })
    }
    const rep = found ?? c.id
    if (found === null && !c.vector) leaders.push({ c, numbers: numberSignature(c.text) })
    byExact.set(c.exactKey, byExact.get(c.exactKey) ?? rep)
    result.set(c.id, rep)
    if (Date.now() - sliceStart >= sliceMs) {
      await yieldToEventLoop()
      sliceStart = Date.now()
    }
  }
  return result
}
