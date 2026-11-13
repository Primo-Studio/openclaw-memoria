/**
 * Projection 2D des embeddings — la « carte des souvenirs » (T28).
 *
 * Position = SENS : deux faits proches sur la carte parlent de la même chose.
 * On ne dessine pas le graphe des relations (83 % de liens `related_to`
 * heuristiques : une pelote illisible), on projette les vecteurs.
 *
 * Deux étapes, toutes deux déterministes (graine fixe : la carte ne bouge pas
 * d'un calcul à l'autre sans nouvelle donnée) :
 *   1. réduction aux REDUCED_DIMS composantes principales — garde les
 *      voisinages et divise le coût du calcul suivant ;
 *   2. UMAP vers 2 dimensions.
 *
 * Le calcul est LOURD (plusieurs secondes pour quelques milliers de points) :
 * il tourne dans un worker thread, jamais dans le thread du daemon (ticket #27).
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { UMAP } from 'umap-js'

// Mesuré le 13/11/2026 sur 4 460 vecteurs réels (1 536 dimensions), part des 10
// vrais voisins de chaque souvenir encore voisins sur la carte : projection
// aléatoire à 32 dimensions 8 %, à 256 dimensions 27 %, composantes principales
// à 50 dimensions 27 %, à 100 dimensions 32 %, aucune réduction 32 % (mais 15
// fois plus de mémoire dans UMAP). 100 composantes = le plafond, à coût borné.
const REDUCED_DIMS = 100
const PCA_ITERATIONS = 5
const SEED = 20261113

/** Générateur déterministe (mulberry32) : même carte à données égales. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tirage gaussien (Box-Muller) sur un générateur uniforme. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12)
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export interface ProjectionOptions {
  /** Réduction avant UMAP : composantes principales (défaut), projection aléatoire, ou aucune. */
  reduce?: 'pca' | 'random' | 'none'
  /** Nombre de dimensions gardées avant UMAP. */
  dims?: number
}

/** Projection aléatoire gaussienne dim → k (rapide, mais déforme les voisinages). */
function randomReduce(flat: Float32Array, n: number, dim: number, k: number): number[][] {
  const random = seededRandom(SEED)
  const basis = new Float32Array(dim * k)
  for (let i = 0; i < basis.length; i++) basis[i] = gaussian(random)
  return applyBasis(flat, n, dim, k, basis, null)
}

/** Lignes de `flat` (centrées par `mean` si fourni) projetées sur `basis` (dim × k, par colonnes). */
function applyBasis(flat: Float32Array, n: number, dim: number, k: number, basis: Float32Array, mean: Float32Array | null): number[][] {
  const out: number[][] = []
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(k).fill(0)
    const base = i * dim
    for (let d = 0; d < dim; d++) {
      const v = flat[base + d]! - (mean ? mean[d]! : 0)
      if (v === 0) continue
      const b = d * k
      for (let j = 0; j < k; j++) row[j]! += v * basis[b + j]!
    }
    out.push(row)
  }
  return out
}

/**
 * Composantes principales par itération de sous-espace : garde les `k`
 * directions où les souvenirs diffèrent le plus. C'est la réduction d'usage
 * avant UMAP : elle conserve les voisinages, là où la projection aléatoire à
 * 32 dimensions les brouillait (carte en « boule » sur les données réelles).
 */
function pcaReduce(flat: Float32Array, n: number, dim: number, k: number): number[][] {
  const mean = new Float32Array(dim)
  for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) mean[d]! += flat[i * dim + d]!
  for (let d = 0; d < dim; d++) mean[d]! /= n

  const random = seededRandom(SEED)
  let basis = new Float32Array(dim * k)
  for (let i = 0; i < basis.length; i++) basis[i] = gaussian(random)
  orthonormalize(basis, dim, k)
  const y = new Float32Array(k)
  for (let iter = 0; iter < PCA_ITERATIONS; iter++) {
    // next = Xᵀ (X · basis), X centré — sans jamais former la matrice de covariance.
    const next = new Float32Array(dim * k)
    for (let i = 0; i < n; i++) {
      const base = i * dim
      y.fill(0)
      for (let d = 0; d < dim; d++) {
        const v = flat[base + d]! - mean[d]!
        const b = d * k
        for (let j = 0; j < k; j++) y[j]! += v * basis[b + j]!
      }
      for (let d = 0; d < dim; d++) {
        const v = flat[base + d]! - mean[d]!
        const b = d * k
        for (let j = 0; j < k; j++) next[b + j]! += v * y[j]!
      }
    }
    orthonormalize(next, dim, k)
    basis = next
  }
  return applyBasis(flat, n, dim, k, basis, mean)
}

/** Gram-Schmidt modifié sur les colonnes d'une matrice dim × k rangée par lignes. */
function orthonormalize(m: Float32Array, dim: number, k: number): void {
  for (let j = 0; j < k; j++) {
    for (let p = 0; p < j; p++) {
      let dot = 0
      for (let d = 0; d < dim; d++) dot += m[d * k + j]! * m[d * k + p]!
      for (let d = 0; d < dim; d++) m[d * k + j]! -= dot * m[d * k + p]!
    }
    let norm = 0
    for (let d = 0; d < dim; d++) norm += m[d * k + j]! ** 2
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < dim; d++) m[d * k + j]! /= norm
  }
}

/**
 * Projette `n` vecteurs de dimension `dim` (à plat dans `flat`) vers 2D.
 * Retourne [x0, y0, x1, y1, …] normalisé dans [-1, 1]. Fonction PURE et
 * synchrone : appelée dans le worker, ou directement dans les tests.
 */
export function projectVectors(flat: Float32Array, n: number, dim: number, opts: ProjectionOptions = {}): Float32Array {
  const out = new Float32Array(n * 2)
  if (n === 0) return out
  if (flat.length !== n * dim) throw new Error(`projection : ${flat.length} valeurs pour ${n} × ${dim}`)
  if (n === 1) return out // un seul point : au centre
  if (n < 4) {
    // Trop peu de points pour un voisinage : on les pose sur un cercle.
    for (let i = 0; i < n; i++) {
      out[i * 2] = Math.cos((2 * Math.PI * i) / n) * 0.5
      out[i * 2 + 1] = Math.sin((2 * Math.PI * i) / n) * 0.5
    }
    return out
  }

  // 1. Réduction dim → k.
  const k = Math.min(opts.dims ?? REDUCED_DIMS, dim, n - 1)
  const reduced =
    opts.reduce === 'none'
      ? Array.from({ length: n }, (_, i) => Array.from(flat.subarray(i * dim, (i + 1) * dim)))
      : opts.reduce === 'random'
        ? randomReduce(flat, n, dim, k)
        : pcaReduce(flat, n, dim, k)

  // 2. UMAP → 2D.
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(15, n - 1),
    minDist: 0.1,
    random: seededRandom(SEED + 1),
  })
  const embedding = umap.fit(reduced)

  // 3. Centrage + normalisation dans [-1, 1] (même échelle sur x et y).
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of embedding) {
    const x = p[0]!
    const y = p[1]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const half = Math.max(maxX - minX, maxY - minY) / 2 || 1
  for (let i = 0; i < n; i++) {
    out[i * 2] = (embedding[i]![0]! - cx) / half
    out[i * 2 + 1] = (embedding[i]![1]! - cy) / half
  }
  return out
}

/** Vrai si `flat` couvre un ArrayBuffer ordinaire en entier : transférable sans copie. */
export function ownsWholeBuffer(flat: Float32Array): boolean {
  return flat.buffer instanceof ArrayBuffer && flat.byteOffset === 0 && flat.byteLength === flat.buffer.byteLength
}

/**
 * Lance la projection hors du thread appelant. Le worker compilé
 * (`projection-worker.js`) n'existe qu'à côté du code construit ; quand on
 * tourne depuis les sources (tests), le calcul se fait en ligne.
 *
 * ATTENTION : quand `flat` occupe tout son tampon, ce tampon est TRANSFÉRÉ au
 * worker (aucune copie) et `flat` devient inutilisable pour l'appelant.
 */
export function runProjection(flat: Float32Array, n: number, dim: number): Promise<Float32Array> {
  const workerPath = fileURLToPath(new URL('./projection-worker.js', import.meta.url))
  if (!existsSync(workerPath)) return Promise.resolve(projectVectors(flat, n, dim))
  return new Promise((resolve, reject) => {
    // Un tampon ne se transfère qu'en entier. Si `flat` l'occupe tout seul, on
    // le donne tel quel au worker : une copie doublerait la mémoire pour rien
    // (plusieurs dizaines de Mo). Si c'est une vue sur un tampon plus grand ou
    // partagé, on copie pour ne pas retirer le reste à l'appelant.
    const payload = ownsWholeBuffer(flat) ? flat : new Float32Array(flat)
    // execArgv vide : le worker n'hérite pas des options du process parent
    // (certaines, comme --input-type, sont refusées dans un worker).
    const worker = new Worker(workerPath, { execArgv: [] })
    worker.once('message', (msg: { coords?: Float32Array; error?: string }) => {
      void worker.terminate()
      if (msg.coords) resolve(msg.coords)
      else reject(new Error(msg.error ?? 'projection : réponse vide du worker'))
    })
    worker.once('error', err => reject(err))
    worker.postMessage({ flat: payload, n, dim }, [payload.buffer as ArrayBuffer])
  })
}
