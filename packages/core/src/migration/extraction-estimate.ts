/**
 * Estimation, SANS aucun appel LLM, de ce que coûterait l'extraction d'un lot
 * de fenêtres (dry-run d'un import). Ce n'est pas une facture : les tarifs
 * viennent de pricing.ts (indicatifs, datés), les jetons d'une règle simple.
 *
 * Hypothèses, mesurées sur un usage réel de l'extraction (environ 15 000
 * appels gpt-4o-mini, conversations surtout en français) :
 *  - ENTRÉE : 3,7 caractères par jeton (système + extrait), plus quelques
 *    jetons d'enveloppe par appel ;
 *  - SORTIE : elle croît avec la taille de l'extrait. Moyennes observées par
 *    tranche de caractères envoyés (système + extrait) : moins de 1 500 → 23
 *    jetons, moins de 3 000 → 136, moins de 6 000 → 395, au-delà → 623. Les
 *    tranches sont ramenées aux SEULS caractères de l'extrait (seuils moins
 *    906, la longueur du prompt des transcripts). C'est une approximation :
 *    les appels mesurés mêlaient plusieurs prompts système, celui des
 *    transcripts dominant à partir de septembre. Sans cela, un prompt système
 *    plus long (celui de ChatGPT en fait 1 635) ferait monter chaque fenêtre
 *    d'une tranche ;
 *  - PLAFOND : 1 024 jetons de sortie par appel (maxTokens de l'extraction).
 *    `output_tokens_max` donne le pire cas.
 * Non comptés : appels témoins et nouveaux essais après un échec.
 */
import { PRICING_AS_OF, priceFor } from '../llm/pricing.js'

/** Caractères par jeton en entrée (mesuré). */
export const CHARS_PER_TOKEN = 3.7
/** Jetons d'enveloppe par appel (rôles, séparateurs). */
const CALL_OVERHEAD_TOKENS = 8
/** maxTokens de l'extraction de fenêtre (import-transcripts.ts). */
export const EXTRACTION_MAX_OUTPUT_TOKENS = 1024

/** Longueur du prompt système supposée pour les appels mesurés (celui des transcripts, approximation). */
export const CALIBRATION_SYSTEM_CHARS = 906

/**
 * Sortie moyenne observée selon les caractères de l'EXTRAIT seul : les seuils
 * mesurés sur système + extrait (1 500, 3 000, 6 000), moins le prompt système
 * des appels mesurés.
 */
const OUTPUT_BY_EXCERPT: ReadonlyArray<readonly [maxChars: number, tokens: number]> = [
  [1500 - CALIBRATION_SYSTEM_CHARS, 23],
  [3000 - CALIBRATION_SYSTEM_CHARS, 136],
  [6000 - CALIBRATION_SYSTEM_CHARS, 395],
  [Number.POSITIVE_INFINITY, 623],
]

export interface ExtractionEstimate {
  /** Fenêtres comptées. */
  windows: number
  /** Caractères envoyés au total (système + extrait, par fenêtre). */
  prompt_chars: number
  input_tokens: number
  /** Sortie estimée (moyennes observées). */
  output_tokens: number
  /** Sortie au pire (plafond atteint à chaque appel). */
  output_tokens_max: number
}

export function emptyEstimate(): ExtractionEstimate {
  return { windows: 0, prompt_chars: 0, input_tokens: 0, output_tokens: 0, output_tokens_max: 0 }
}

export function estimateInputTokens(promptChars: number): number {
  return Math.ceil(promptChars / CHARS_PER_TOKEN) + CALL_OVERHEAD_TOKENS
}

/**
 * Sortie estimée d'une fenêtre. `promptChars` : caractères envoyés, système
 * compris ; `systemChars` : la part du prompt système. La tranche se lit sur
 * l'extrait seul (promptChars moins systemChars). Sans `systemChars`, le
 * prompt est supposé de la longueur des appels mesurés (CALIBRATION_SYSTEM_CHARS).
 */
export function estimateOutputTokens(promptChars: number, systemChars: number = CALIBRATION_SYSTEM_CHARS): number {
  const excerptChars = promptChars - systemChars
  for (const [maxChars, tokens] of OUTPUT_BY_EXCERPT) if (excerptChars < maxChars) return tokens
  return EXTRACTION_MAX_OUTPUT_TOKENS
}

/**
 * Ajoute une fenêtre à l'estimation : `promptChars` envoyés (système compris,
 * c'est l'entrée facturée), dont `systemChars` de prompt système (voir
 * estimateOutputTokens ; à passer dès que le prompt n'est pas celui des
 * transcripts).
 */
export function addWindowToEstimate(estimate: ExtractionEstimate, promptChars: number, systemChars?: number): void {
  estimate.windows++
  estimate.prompt_chars += promptChars
  estimate.input_tokens += estimateInputTokens(promptChars)
  estimate.output_tokens += estimateOutputTokens(promptChars, systemChars)
  estimate.output_tokens_max += EXTRACTION_MAX_OUTPUT_TOKENS
}

export interface ExtractionCost {
  provider: string
  model: string
  /** Coût estimé en USD ; null si le tarif du modèle est inconnu (jamais un zéro inventé). */
  usd: number | null
  /** Pire cas (sortie au plafond à chaque appel). */
  usd_max: number | null
  /** Date des tarifs utilisés. */
  pricing_as_of: string
}

/** Coût d'une estimation avec le modèle d'extraction configuré. Local → 0. */
export function estimateExtractionCost(estimate: ExtractionEstimate, provider: string, model: string): ExtractionCost {
  const price = priceFor(provider, model)
  const usd = (out: number): number | null =>
    price ? Math.round(((estimate.input_tokens * price.input + out * price.output) / 1_000_000) * 100) / 100 : null
  return {
    provider,
    model,
    usd: usd(estimate.output_tokens),
    usd_max: usd(estimate.output_tokens_max),
    pricing_as_of: PRICING_AS_OF,
  }
}
