/**
 * Couche CONTRADICTION (couche 3, intégrée à `selective`, bucket A — spec §6.2
 * étape 4 « dedup/contradiction PAR SCOPE »).
 *
 * Objectif produit : quand un NOUVEAU fait arrive, repérer les faits DÉJÀ stockés
 * dans le MÊME scope qui parlent du MÊME sujet mais AFFIRMENT le CONTRAIRE
 * (« le port est 8080 » vs « le port est 9090 » ; « préfère X » vs « ne préfère
 * plus X »). C'est l'étape qui évite que la mémoire accumule des vérités
 * incompatibles sans que personne ne le voie.
 *
 * RÈGLE D'OR (gravée, comme patterns/bucket D) : `detectContradiction` ne
 * SUPERSÈDE RIEN, ne modifie AUCUN fait. Il ne fait que PROPOSER une liste de
 * candidats contradictoires ({existingFactId, reason, confidence}). C'est
 * l'intégrateur (engine/memoria → selective) qui décide, sur cette proposition,
 * de superseder l'ancien ou de garder les deux. Aucune mort silencieuse : si le
 * LLM optionnel échoue, on log et on retombe sur l'heuristique (on ne masque pas
 * une contradiction parce que le réseau est tombé).
 *
 * Heuristique SANS LLM (le défaut) :
 *  1. MÊME SUJET — fort recouvrement de keywords/entités entre le nouveau fait et
 *     un fait existant du scope (FTS pour pré-sélectionner, Jaccard de keywords +
 *     entités partagées pour confirmer le sujet) ;
 *  2. POLARITÉ OPPOSÉE — soit l'un nie et l'autre affirme la même chose (présence
 *     d'une négation FR/EN « ne…pas / jamais / plus / no longer » d'un seul des
 *     deux côtés), soit le MÊME attribut prend une VALEUR différente (port 8080
 *     vs 9090, « utilise X » vs « utilise Y »).
 *
 * LLM OPTIONNEL (injecté) : sur les candidats heuristiques limites, on peut
 * demander à un petit modèle de CONFIRMER (oui/non) la contradiction. Le LLM ne
 * crée jamais un candidat de zéro : il ne fait que confirmer/infirmer un candidat
 * déjà trouvé par l'heuristique (coût borné, 1 appel max par candidat ambigu).
 */
import type { ContentStore, FactRow } from '../storage/content.js'
import type { LlmProvider } from '../llm/provider.js'
import { normalizeText } from '../storage/content.js'

export interface Contradiction {
  /** Id du fait EXISTANT en contradiction avec le nouveau texte. */
  existingFactId: string
  /** Texte du fait existant (commodité pour l'UI/diff de revue). */
  existingFact: string
  /** Raison lisible (FR sobre) : pourquoi c'est jugé contradictoire. */
  reason: string
  /** Confiance ∈ [0,1] : sujet partagé × force de l'opposition. */
  confidence: number
  /** Type d'opposition détectée. */
  kind: 'negation' | 'value' | 'llm'
}

export interface DetectContradictionOptions {
  /** Nombre max de faits existants examinés (pré-sélection FTS). Défaut 20. */
  limit?: number
  /** Recouvrement de sujet minimal (Jaccard keywords) pour juger « même sujet ». Défaut 0.34. */
  minSubjectOverlap?: number
  /** Confiance minimale d'un candidat retenu. Défaut 0.5. */
  minConfidence?: number
  /** Si vrai et un LLM est fourni, confirme les candidats limites (1 appel/candidat). */
  useLlm?: boolean
}

/** Mots-outils FR/EN ignorés pour juger du « même sujet » (n'apportent pas le thème). */
const STOPWORDS = new Set([
  'pour', 'avec', 'dans', 'plus', 'mais', 'que', 'qui', 'les', 'des', 'une', 'mon', 'mes',
  'son', 'ses', 'est', 'sont', 'sur', 'par', 'pas', 'tout', 'tous', 'toujours', 'jamais',
  'cette', 'cet', 'aux', 'leur', 'the', 'and', 'for', 'with', 'this', 'that', 'have', 'has',
  'are', 'was', 'were', 'you', 'your', 'always', 'never', 'all', 'any', 'not', 'now', 'plus',
])

/**
 * Marqueurs de négation FR/EN : leur présence inverse la polarité d'une assertion.
 *
 * ⚠ « plus de » seul n'y figure PAS : hors « ne … plus de », il veut dire
 * DAVANTAGE (« plus de 1 900 € », « plus de 94 €/h le week-end »), et « sans »
 * (« café sans sucre ») n'inverse pas non plus une assertion. Les compter comme
 * négations faisait proposer en contradiction des faits qui s'accordent — 3 des
 * 5 propositions live étaient de ce type. À l'inverse, « impossible » et
 * « aucun » nient bel et bien : « X est impossible » et « X ne peut pas » disent
 * la même chose et doivent avoir la MÊME polarité.
 */
const NEGATION_PATTERNS: RegExp[] = [
  /\bne\s+\w+\s+(?:pas|plus|jamais|guere|point)\b/u, // ne … pas / plus / jamais
  /\bn['’]\w+\s+(?:pas|plus|jamais|guere|point)\b/u, // n'aime plus
  /\bn['’]y\s+a\s+(?:pas|plus|jamais)\b/u, // il n'y a plus de
  /\bne\s+(?:pas|plus|jamais)\b/u,
  /\b(?:pas|jamais)\s+de\b/u, // pas de / jamais de (PAS « plus de » = davantage)
  /\bimpossible\b/u,
  /\baucune?s?\b/u,
  /\bno\s+longer\b/u,
  /\bnot\b/u,
  /\bnever\b/u,
  /\bdoesn['’]t\b/u,
  /\bdon['’]t\b/u,
  /\bisn['’]t\b/u,
]

/** Verbes/attributs porteurs d'une VALEUR (le mot suivant est la valeur affirmée). */
const ATTRIBUTE_VERBS = new Set([
  'est', 'sont', 'vaut', 'utilise', 'utilisent', 'prefere', 'prefer', 'prefers', 'is', 'are',
  'uses', 'use', 'port', 'version', 'host', 'hote', 'adresse', 'numero', 'compte', 'branche',
])

/**
 * Tokens significatifs normalisés (minuscules, sans diacritiques, > 2 car., hors
 * stopwords). Sert au recouvrement de sujet. Aligné sur queryTokens du store.
 */
export function subjectTokens(text: string): Set<string> {
  const tokens = normalizeText(text)
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
  return new Set(tokens)
}

/** Jaccard de deux ensembles (|∩| / |∪|), borné [0,1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Vrai si le texte contient une négation explicite (polarité négative). */
export function hasNegation(text: string): boolean {
  const norm = normalizeText(text)
  return NEGATION_PATTERNS.some(re => re.test(norm))
}

/** Tokens « numériques/nommés » candidats à être une VALEUR (port, version, host…). */
function valueTokens(text: string): Set<string> {
  const out = new Set<string>()
  const norm = normalizeText(text)
  // Valeurs numériques (8080, 9090, 3.14, v2…).
  for (const m of norm.matchAll(/\b\d+(?:[.:]\d+)*\b/gu)) out.add(m[0])
  return out
}

/**
 * Extrait les couples (attribut → valeur) grossiers d'un fait : pour chaque verbe
 * d'attribut connu, la valeur = token significatif qui suit. Permet de détecter
 * « le port est 8080 » vs « le port est 9090 » (même attribut `port`, valeurs ≠).
 */
function attributeValues(text: string): Map<string, Set<string>> {
  const words = normalizeText(text)
    .split(/[^\p{L}\p{N}_.:-]+/u)
    .map(w => w.trim())
    .filter(w => w.length > 0)
  const map = new Map<string, Set<string>>()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!ATTRIBUTE_VERBS.has(w)) continue
    // Cherche le prochain token « valeur » (numérique ou nom significatif).
    for (let j = i + 1; j < Math.min(words.length, i + 4); j++) {
      const cand = words[j]!
      if (STOPWORDS.has(cand) || cand.length < 2) continue
      const key = attributeKey(words, i)
      if (!map.has(key)) map.set(key, new Set())
      map.get(key)!.add(cand)
      break
    }
  }
  return map
}

/**
 * Clé d'attribut : le nom de l'attribut est le mot SIGNIFICATIF juste avant le
 * verbe (ex. « port » dans « le port est 8080 »), à défaut le verbe lui-même.
 */
function attributeKey(words: string[], verbIndex: number): string {
  for (let k = verbIndex - 1; k >= Math.max(0, verbIndex - 3); k--) {
    const w = words[k]!
    if (!STOPWORDS.has(w) && w.length > 2 && !/^\d/.test(w)) return w
  }
  return words[verbIndex]!
}

/**
 * Détecte les faits EXISTANTS du même scope qui contredisent `newFactText`.
 * NE MODIFIE RIEN — propose seulement. SQL/heuristique pur par défaut ; un LLM
 * optionnel confirme les cas limites (opt-in `useLlm`).
 */
export async function detectContradiction(
  store: ContentStore,
  newFactText: string,
  scopeId: string,
  opts: DetectContradictionOptions = {},
  llm?: LlmProvider | null,
): Promise<Contradiction[]> {
  const text = (newFactText ?? '').trim()
  if (!text) return []
  const limit = opts.limit ?? 20
  const minOverlap = opts.minSubjectOverlap ?? 0.34
  const minConfidence = opts.minConfidence ?? 0.5

  const newTokens = subjectTokens(text)
  if (newTokens.size === 0) return []
  const newHasNeg = hasNegation(text)
  const newValues = valueTokens(text)
  const newAttrs = attributeValues(text)

  // 1) Pré-sélection des faits du MÊME scope qui partagent du vocabulaire (FTS).
  //    On borne au scope (anti-fuite) et on exclut superseded.
  const hits = store.searchFacts(text, { limit, scopeIds: [scopeId] })
  const candidates: FactRow[] = hits.map(h => h.row).filter(r => r.scope_id === scopeId && r.superseded === 0)

  const out: Contradiction[] = []
  const ambiguous: Array<{ row: FactRow; overlap: number }> = []

  for (const row of candidates) {
    if (normalizeText(row.fact).trim() === normalizeText(text).trim()) continue // doublon exact = dedup, pas contradiction
    const exTokens = subjectTokens(row.fact)
    const overlap = jaccard(newTokens, exTokens)
    if (overlap < minOverlap) continue // pas le même sujet → on ne juge pas

    // 2a) Opposition par NÉGATION : un seul des deux nie la même chose.
    const exHasNeg = hasNegation(row.fact)
    if (exHasNeg !== newHasNeg) {
      // La négation ne suffit pas seule : il faut un noyau de sujet commun fort
      // (sinon « j'aime X » et « je ne fais pas Y » ne sont pas opposés).
      const confidence = round(0.4 + 0.6 * overlap)
      if (confidence >= minConfidence) {
        out.push({
          existingFactId: row.id,
          existingFact: row.fact,
          reason: `Même sujet, polarité opposée (l'un nie, l'autre affirme) : « ${truncate(row.fact)} »`,
          confidence,
          kind: 'negation',
        })
        continue
      }
      ambiguous.push({ row, overlap })
      continue
    }

    // 2b) Opposition par VALEUR : même attribut, valeur différente.
    const valueClash = attributeClash(newAttrs, attributeValues(row.fact)) || numericClash(text, row.fact, newValues, valueTokens(row.fact))
    if (valueClash) {
      const confidence = round(0.5 + 0.5 * overlap)
      if (confidence >= minConfidence) {
        out.push({
          existingFactId: row.id,
          existingFact: row.fact,
          reason: `Même sujet, valeur différente pour le même attribut : « ${truncate(row.fact)} »`,
          confidence,
          kind: 'value',
        })
        continue
      }
      ambiguous.push({ row, overlap })
    }
  }

  // 3) LLM OPTIONNEL : confirme les candidats limites (jamais en crée de zéro).
  //    Échec LLM = log + on garde la décision heuristique (pas de mort silencieuse).
  if (opts.useLlm && llm && ambiguous.length > 0) {
    let available = false
    try {
      available = await llm.isAvailable()
    } catch (err) {
      console.warn('[memoria:contradiction] LLM indisponible (isAvailable) — heuristique seule :', (err as Error).message)
    }
    if (available) {
      for (const { row, overlap } of ambiguous) {
        try {
          const verdict = await llm.complete({
            system:
              'You compare two statements. Reply ONLY "YES" if they CONTRADICT each other (same subject, incompatible conclusions), otherwise "NO".',
            prompt: `A: ${text}\nB: ${row.fact}`,
            maxTokens: 4,
            temperature: 0,
          })
          if (/\boui\b|\byes\b/i.test(verdict)) {
            out.push({
              existingFactId: row.id,
              existingFact: row.fact,
              reason: `Contradiction confirmée par le modèle (même sujet) : « ${truncate(row.fact)} »`,
              confidence: round(0.55 + 0.4 * overlap),
              kind: 'llm',
            })
          }
        } catch (err) {
          console.warn(`[memoria:contradiction] confirmation LLM en échec (fait ${row.id}) — ignoré :`, (err as Error).message)
        }
      }
    }
  }

  // Dédup par fait existant (garde la meilleure confiance), tri décroissant.
  const best = new Map<string, Contradiction>()
  for (const c of out) {
    const prev = best.get(c.existingFactId)
    if (!prev || c.confidence > prev.confidence) best.set(c.existingFactId, c)
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence)
}

/** Vrai si un attribut commun porte des valeurs différentes entre les deux faits. */
function attributeClash(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  for (const [key, valsA] of a) {
    const valsB = b.get(key)
    if (!valsB || valsB.size === 0) continue
    // Même attribut connu des deux côtés : clash si aucune valeur partagée.
    const shared = [...valsA].some(v => valsB.has(v))
    if (!shared) return true
  }
  return false
}

/**
 * Nombres d'un fait rattachés à leur ANCRE : le mot significatif qui les
 * précède (« port 8080 » → port ↦ {8080} ; « depuis 3 jours » → depuis ↦ {3}).
 * Un nombre ne veut rien dire seul : 27/03, 2026.4.9, 13/14, 17 ne sont
 * comparables que s'ils qualifient le MÊME attribut.
 */
function numberAnchors(text: string): Map<string, Set<string>> {
  const words = normalizeText(text)
    .split(/[^\p{L}\p{N}_.:/-]+/u)
    .map(w => w.trim())
    .filter(w => w.length > 0)
  const out = new Map<string, Set<string>>()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!/\d/.test(w)) continue
    const value = w.replace(/^v(?=\d)/, '') // v3.2.1 ≡ 3.2.1
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      const cand = words[k]!
      if (/\d/.test(cand) || cand.length < 3 || STOPWORDS.has(cand)) continue
      if (!out.has(cand)) out.set(cand, new Set())
      out.get(cand)!.add(value)
      break
    }
  }
  return out
}

/**
 * Clash numérique : un MÊME attribut (ancre commune) porte des nombres
 * DIFFÉRENTS des deux côtés, et les deux faits ne partagent AUCUN nombre.
 * Couvre « port 8080 » vs « port 9090 » sans verbe explicite.
 *
 * Avant, UN token textuel commun suffisait : « mise à jour le 27/03 » vs « mise à
 * jour passée en 2026.4.9 », ou « réunion 13/14 » vs « réunion de préparation
 * 13 », ressortaient en contradiction — des dates, des versions, des détails,
 * jamais le même attribut. Et un nombre partagé (« build 17 » des deux côtés)
 * dit que les faits parlent de la même chose : les nombres secondaires qui
 * diffèrent (« depuis 3 jours » / « depuis le 12 mai ») sont des précisions.
 */
function numericClash(newText: string, exText: string, newValues: Set<string>, exValues: Set<string>): boolean {
  if (newValues.size === 0 || exValues.size === 0) return false
  const sharedValue = [...newValues].some(v => exValues.has(v))
  if (sharedValue) return false
  const a = numberAnchors(newText)
  const b = numberAnchors(exText)
  for (const [anchor, valsA] of a) {
    const valsB = b.get(anchor)
    if (!valsB) continue
    if (![...valsA].some(v => valsB.has(v))) return true
  }
  return false
}

function round(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000
}

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
