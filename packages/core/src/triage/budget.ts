/**
 * PLAFOND DE DÉPENSE du tri. Règles :
 *  - le plafond est vérifié AVANT chaque appel, au pire cas : entrée estimée
 *    (caractères / 4, majorée de 20 %) + `maxTokens` entiers en sortie. Un
 *    appel qui pourrait dépasser n'est pas fait (TriageBudgetError) ;
 *  - les appels en vol réservent leur pire cas (deux lots en parallèle ne
 *    peuvent pas dépasser à eux deux) ;
 *  - l'entrée estimée est CORRIGÉE par l'usage rendu : après chaque appel, le
 *    plus grand rapport réel / estimé observé (par type, jamais sous 1)
 *    multiplie les estimations suivantes. Sans cela, un fournisseur qui compte
 *    dix fois plus de jetons que caractères / 4 faisait dépasser le plafond.
 *    Le premier appel LLM part seul (`needsCalibration`, voir le moteur) : deux
 *    appels lancés avant tout usage réservaient sur l'estimation brute ;
 *  - après l'appel, la dépense réelle vient de l'usage rendu par le
 *    fournisseur ; usage absent : caractères / 4 majorés de 20 % (entrée et
 *    sortie) ; appel en échec : l'entrée estimée est comptée (le fournisseur
 *    a pu la facturer) ;
 *  - les vecteurs comptent aussi ;
 *  - prix inconnu chez un fournisseur cloud : refus de démarrer
 *    (`assertPriced`). Un modèle local coûte 0.
 */
import { priceFor, type ModelPrice } from '../llm/pricing.js'
import type { LlmUsage } from '../llm/provider.js'
import { TriageBudgetError, TriageRefusedError } from './types.js'

/** Plafond par défaut d'un passage (USD). */
export const DEFAULT_TRIAGE_BUDGET_USD = 5

/** Jetons estimés pour un texte, majorés de 20 % (usage absent ou estimation avant appel). */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil((chars / 4) * 1.2)
}

/** Prix d'un modèle, ou refus de démarrer si un fournisseur cloud a un prix inconnu. */
export function assertPriced(provider: string, model: string, what: string): ModelPrice {
  const price = priceFor(provider, model)
  if (!price) {
    throw new TriageRefusedError(
      'price-unknown',
      `tri refusé : prix inconnu pour ${what} ${provider}/${model}. Impossible de tenir le plafond de dépense ; choisis un modèle au tarif connu.`,
    )
  }
  return price
}

export interface BudgetReservation {
  readonly id: number
  readonly worstUsd: number
  /** Entrée retenue (estimation corrigée par le rapport réel / estimé). */
  readonly inputTokens: number
  /** Estimation brute (caractères / 4, majorée de 20 %), base du rapport réel / estimé. */
  readonly estimatedTokens: number
  readonly kind: 'llm' | 'embeddings'
}

export interface BudgetCounters {
  spent_usd: number
  tokens_in: number
  tokens_out: number
  embed_tokens: number
  llm_calls: number
  embed_calls: number
}

export class TriageBudget {
  readonly budgetUsd: number
  private spent: number
  private readonly llmPrice: ModelPrice
  private readonly embPrice: ModelPrice
  private readonly inFlight = new Map<number, BudgetReservation>()
  private nextId = 1
  /** Rapport réel / estimé de l'entrée, par type (jamais sous 1 : l'estimation est déjà majorée). */
  private readonly inputRatio = { llm: 1, embeddings: 1 }
  private llmSettled = false
  private readonly onSpend: ((spentUsd: number) => void) | null
  readonly counters: BudgetCounters

  constructor(opts: {
    budgetUsd: number
    spentUsd?: number
    llmPrice?: ModelPrice | null
    embeddingsPrice?: ModelPrice | null
    /** Après chaque dépense comptée (appel réglé ou en échec) : persistance de la dépense. */
    onSpend?: (spentUsd: number) => void
  }) {
    if (!(opts.budgetUsd >= 0)) throw new TriageRefusedError('bad-request', 'plafond de dépense invalide')
    this.budgetUsd = opts.budgetUsd
    this.spent = Math.max(0, opts.spentUsd ?? 0)
    this.llmPrice = opts.llmPrice ?? { input: 0, output: 0 }
    this.embPrice = opts.embeddingsPrice ?? { input: 0, output: 0 }
    this.onSpend = opts.onSpend ?? null
    this.counters = { spent_usd: this.spent, tokens_in: 0, tokens_out: 0, embed_tokens: 0, llm_calls: 0, embed_calls: 0 }
  }

  /**
   * Aucun appel LLM payant n'est encore revenu : le rapport réel / estimé est
   * inconnu. Le moteur fait alors partir le premier appel SEUL avant d'en
   * lancer plusieurs en parallèle.
   */
  get needsCalibration(): boolean {
    return !this.llmSettled && (this.llmPrice.input > 0 || this.llmPrice.output > 0)
  }

  /** Multiplicateur appliqué à l'entrée estimée (LLM). Public pour les tests. */
  get llmInputRatio(): number {
    return this.inputRatio.llm
  }

  get spentUsd(): number {
    return this.spent
  }

  /** Dépense engagée : réelle + pire cas des appels en vol. */
  get committedUsd(): number {
    let reserved = 0
    for (const r of this.inFlight.values()) reserved += r.worstUsd
    return this.spent + reserved
  }

  /** Coût d'un appel LLM (USD) pour des jetons donnés. */
  llmCost(inputTokens: number, outputTokens: number): number {
    return (inputTokens * this.llmPrice.input + outputTokens * this.llmPrice.output) / 1_000_000
  }

  embeddingsCost(tokens: number): number {
    return (tokens * this.embPrice.input) / 1_000_000
  }

  /** Réserve le pire cas d'un appel LLM, ou lève TriageBudgetError sans rien réserver. */
  reserveCompletion(inputChars: number, maxTokens: number): BudgetReservation {
    const estimated = estimateTokensFromChars(inputChars)
    const inputTokens = Math.ceil(estimated * this.inputRatio.llm)
    return this.reserve('llm', inputTokens, estimated, this.llmCost(inputTokens, maxTokens))
  }

  reserveEmbeddings(chars: number): BudgetReservation {
    const estimated = estimateTokensFromChars(chars)
    const tokens = Math.ceil(estimated * this.inputRatio.embeddings)
    return this.reserve('embeddings', tokens, estimated, this.embeddingsCost(tokens))
  }

  /** Usage réel rendu : le rapport réel / estimé corrige les réservations suivantes. */
  private calibrate(kind: BudgetReservation['kind'], r: BudgetReservation, actualInput: number | undefined): void {
    if (typeof actualInput !== 'number' || !(actualInput > 0) || r.estimatedTokens <= 0) return
    this.inputRatio[kind] = Math.max(this.inputRatio[kind], actualInput / r.estimatedTokens)
  }

  private reserve(kind: BudgetReservation['kind'], inputTokens: number, estimatedTokens: number, worstUsd: number): BudgetReservation {
    if (this.committedUsd + worstUsd > this.budgetUsd + 1e-12) {
      throw new TriageBudgetError(
        `plafond de dépense atteint : ${this.spent.toFixed(4)} $ dépensés, l'appel suivant pourrait coûter ${worstUsd.toFixed(4)} $ (plafond ${this.budgetUsd} $)`,
      )
    }
    const r: BudgetReservation = { id: this.nextId++, worstUsd, inputTokens, estimatedTokens, kind }
    this.inFlight.set(r.id, r)
    return r
  }

  /** Appel LLM réussi : dépense réelle (usage du fournisseur, sinon estimation majorée). */
  settleCompletion(r: BudgetReservation, usage: LlmUsage | undefined, outputChars: number): void {
    this.inFlight.delete(r.id)
    this.calibrate('llm', r, usage?.input_tokens)
    this.llmSettled = true
    const input = usage?.input_tokens ?? r.inputTokens
    const output = usage?.output_tokens ?? estimateTokensFromChars(outputChars)
    this.counters.tokens_in += input
    this.counters.tokens_out += output
    this.counters.llm_calls++
    this.add(this.llmCost(input, output))
  }

  settleEmbeddings(r: BudgetReservation, usage: LlmUsage | undefined): void {
    this.inFlight.delete(r.id)
    this.calibrate('embeddings', r, usage?.input_tokens)
    const tokens = usage?.input_tokens ?? r.inputTokens
    this.counters.embed_tokens += tokens
    this.counters.embed_calls++
    this.add(this.embeddingsCost(tokens))
  }

  /**
   * Appel en échec : l'entrée estimée (corrigée) est comptée (prudence : le fournisseur a pu la facturer).
   * `outputBilled` (délai dépassé) : le modèle générait encore quand l'appel a été coupé, et le
   * fournisseur facture ce qu'il a produit sans le rendre ; on compte alors le pire cas réservé.
   */
  fail(r: BudgetReservation, opts: { outputBilled?: boolean } = {}): void {
    this.inFlight.delete(r.id)
    if (r.kind === 'llm') this.counters.llm_calls++
    else this.counters.embed_calls++
    if (opts.outputBilled && r.kind === 'llm') return this.add(r.worstUsd)
    this.add(r.kind === 'llm' ? this.llmCost(r.inputTokens, 0) : this.embeddingsCost(r.inputTokens))
  }

  private add(usd: number): void {
    this.spent += usd
    this.counters.spent_usd = this.spent
    if (!this.onSpend) return
    try {
      this.onSpend(this.spent)
    } catch {
      /* la persistance ne fait jamais échouer un appel déjà payé */
    }
  }
}
