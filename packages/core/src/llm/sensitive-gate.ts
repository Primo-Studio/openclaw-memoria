/**
 * GARDE SENSIBLE au point de passage unique vers les modèles (LLM et vecteurs).
 *
 * Règle du propriétaire : paie, salaire, impôts, URSSAF, charges sociales,
 * IBAN, santé, pièces d'identité, données personnelles ne partent JAMAIS vers
 * une IA, ni en texte (LLM) ni en vecteurs. Le filtre existe déjà
 * (`triage/sensitive.ts`), mais seul le tri l'appliquait : la capture, l'import
 * des conversations, la cognition, l'indexation et le rappel envoyaient leur
 * texte sans le passer.
 *
 * Plutôt que de répéter le test dans chaque appelant (et d'en oublier un le
 * jour où un nouveau chemin apparaît), le provider lui-même est enveloppé :
 * tout ce qui passe par lui est testé AVANT l'appel, le provider interne n'est
 * jamais appelé pour un texte sensible, et l'appelant reçoit une erreur typée
 * (`SensitiveContentError`) dont le message ne contient AUCUN extrait.
 *
 * Réglage explicite, désactivé par défaut : `[llm] sensitive_gate = true` dans
 * config.toml. Absent ou false : providers rendus tels quels, comportement
 * strictement inchangé. Actif, il vaut pour TOUS les moteurs (locaux compris) :
 * même règle que le tri, un poste d'équipe n'a pas à se demander où tourne le
 * modèle choisi dans Réglages.
 *
 * Ce qui est testé : `opts.prompt` (le contenu) pour un LLM, chaque texte pour
 * les vecteurs. Jamais `opts.system` : ce sont des consignes fixes, qui peuvent
 * citer « salaire » ou « santé » comme catégories à reconnaître.
 *
 * Le secret (clé, mot de passe) n'est pas l'affaire de cette garde : le
 * Redactor l'a déjà masqué en amont.
 */
import type { MemoriaConfig } from '../config.js'
import { isSensitive } from '../triage/sensitive.js'
import {
  completeDetailed,
  embedDetailed,
  SensitiveContentError,
  type CompleteOptions,
  type CompletionResult,
  type EmbeddingProvider,
  type EmbeddingResult,
  type LlmProfile,
  type LlmProvider,
} from './provider.js'

// L'erreur vit dans provider.ts (aucune dépendance) : la cognition la reconnaît
// sans importer ce module, qui tire le filtre du tri et le stockage avec lui.
export { isSensitiveContentError, SensitiveContentError } from './provider.js'

/** Garde active ? Seul `true` l'active : une faute de frappe ne change rien au poste. */
export function sensitiveGateEnabled(config: MemoriaConfig | null | undefined): boolean {
  return config?.llm?.sensitive_gate === true
}

/**
 * État de la garde tel que `memoria doctor` et llm_health l'affichent :
 * active ou non, et les tables où une clé `sensitive_gate` est posée AILLEURS
 * que sous `[llm]`. Cas réel : la ligne ajoutée seule en fin de fichier tombe
 * dans la dernière table (`[llm.extraction]`, `[llm.embeddings]`, `[sharing]`…)
 * et n'active rien. Elle n'est pas prise en compte pour autant (une seule
 * façon d'activer la garde) : elle est signalée, pour que le poste se vérifie.
 */
export interface SensitiveGateState {
  enabled: boolean
  /** Tables où la clé est mal placée (`llm.extraction`, `(racine)`…) ; vide si aucune. */
  misplaced: string[]
}

export function sensitiveGateState(config: MemoriaConfig | null | undefined): SensitiveGateState {
  const misplaced: string[] = []
  const walk = (table: Record<string, unknown>, path: string[], depth: number): void => {
    for (const [key, value] of Object.entries(table)) {
      if (key === 'sensitive_gate' && path.join('.') !== 'llm') misplaced.push(path.length > 0 ? path.join('.') : '(racine)')
      if (depth < 3 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, [...path, key], depth + 1)
      }
    }
  }
  if (config) walk(config as Record<string, unknown>, [], 0)
  return { enabled: sensitiveGateEnabled(config), misplaced }
}

/**
 * La garde est-elle écrite dans ce texte de config.toml, même illisible ?
 * Sert quand le fichier ne se lit plus (second en-tête `[llm]` ajouté à la
 * main) : la réécriture ne doit pas la perdre. Une ligne en commentaire ne compte pas.
 */
export function rawConfigHasSensitiveGate(raw: string): boolean {
  return /^[ \t]*sensitive_gate[ \t]*=[ \t]*true\b/m.test(raw)
}

// ---------------------------------------------------------------- test sans bloquer

/**
 * Au-delà, le texte est testé par morceaux, en rendant la main entre deux
 * (règle des 200 ms). Mesuré le 19/11, motifs du montant bornés : de 25 ms
 * (prose) à 100 ms (suite de chiffres, CSV) par million de caractères, soit
 * 5 ms au plus par morceau. Avant ces bornes, une suite de chiffres coûtait un
 * temps quadratique : 0,5 s pour 20 000 caractères, 44 s pour un morceau de
 * 200 000. La coupe ne protège que si chaque motif est linéaire ; un motif
 * ajouté à `triage/sensitive.ts` garde donc ses répétitions bornées.
 */
const CHUNK_CHARS = 50_000
/** Recouvrement entre morceaux : un motif à cheval sur la coupe est vu en entier dans le suivant. */
const CHUNK_OVERLAP = 1_000
/** Tranche de calcul maximale sur un lot de textes avant de rendre la main. */
const SLICE_MS = 20

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * Texte tel que le modèle le lit, pour que la garde juge comme le tri, qui
 * teste chaque élément AVANT sa mise en forme :
 *  - les retours à la ligne échappés par JSON.stringify (`\n` écrit en deux
 *    caractères) redeviennent de vrais retours : plusieurs motifs s'arrêtent à
 *    la fin de ligne, et un message de deux lignes rendu en JSON passait sinon
 *    pour sensible alors que le message lui-même ne l'était pas (« payé la
 *    facture », puis « 200 € de port » à la ligne) ;
 *  - les marques `[secret:<type>-<empreinte>]` du Redactor sont retirées : la
 *    valeur est déjà masquée, et le nom du type (`iban`, `mot-de-passe`) ne
 *    doit pas faire refuser un texte que le filtre n'avait pas retenu.
 */
const JSON_BREAKS: Record<string, string> = { n: '\n', r: '\r', t: '\t' }

function asModelReads(text: string): string {
  return text.replace(/\\([nrt])/g, (_, c: string) => JSON_BREAKS[c]!).replace(/\[secret:[\w.-]*\]/g, ' ')
}

/** `isSensitive` sans figer la boucle d'événements sur un très long texte. */
export async function containsSensitive(text: string): Promise<boolean> {
  const t = asModelReads(text)
  if (t.length <= CHUNK_CHARS) return isSensitive(t)
  for (let from = 0; ; from += CHUNK_CHARS - CHUNK_OVERLAP) {
    if (from > 0) await yieldToEventLoop()
    if (isSensitive(t.slice(from, from + CHUNK_CHARS))) return true
    if (from + CHUNK_CHARS >= t.length) return false
  }
}

/**
 * Indices des textes sensibles d'un lot, en rendant la main dès que la
 * tranche de calcul dépasse SLICE_MS (un lot d'indexation ou de tri peut
 * compter des centaines de textes).
 */
export async function sensitiveIndexes(texts: readonly string[]): Promise<number[]> {
  const out: number[] = []
  let started = Date.now()
  for (let i = 0; i < texts.length; i++) {
    if (Date.now() - started >= SLICE_MS) {
      await yieldToEventLoop()
      started = Date.now()
    }
    if (await containsSensitive(texts[i] ?? '')) out.push(i)
  }
  return out
}

// ---------------------------------------------------------------- enveloppes

/** Marque d'un provider déjà gardé (enveloppe idempotente, lisible par les appelants). */
const GATED = Symbol.for('memoria.sensitive-gate')

/** Vrai si ce provider passe par la garde : l'appelant peut trier AVANT d'envoyer. */
export function isSensitiveGated(provider: LlmProvider | EmbeddingProvider | null | undefined): boolean {
  return provider != null && (provider as unknown as Record<symbol, unknown>)[GATED] === true
}

function mark<T extends object>(target: T): T {
  Object.defineProperty(target, GATED, { value: true, enumerable: false })
  return target
}

/** Provider d'extraction gardé : un `prompt` sensible n'atteint jamais le provider interne. */
export function gateExtraction(provider: LlmProvider): LlmProvider {
  if (isSensitiveGated(provider)) return provider
  const run = async (opts: CompleteOptions): Promise<CompletionResult> => {
    if (await containsSensitive(opts.prompt ?? '')) {
      throw new SensitiveContentError({ purpose: 'extraction', provider: provider.name, model: provider.model })
    }
    return completeDetailed(provider, opts)
  }
  return mark<LlmProvider>({
    name: provider.name,
    model: provider.model,
    isAvailable: () => provider.isAvailable(),
    completeDetailed: run,
    complete: async opts => (await run(opts)).text,
  })
}

/** Provider de vecteurs gardé : un lot qui contient UN texte sensible est refusé en entier. */
export function gateEmbeddings(provider: EmbeddingProvider): EmbeddingProvider {
  if (isSensitiveGated(provider)) return provider
  const run = async (texts: string[]): Promise<EmbeddingResult> => {
    if ((await sensitiveIndexes(texts)).length > 0) {
      throw new SensitiveContentError({ purpose: 'embeddings', provider: provider.name, model: provider.model })
    }
    return embedDetailed(provider, texts)
  }
  return mark<EmbeddingProvider>({
    name: provider.name,
    model: provider.model,
    dimensions: provider.dimensions,
    isAvailable: () => provider.isAvailable(),
    embedDetailed: run,
    embed: async texts => (await run(texts)).vectors,
  })
}

/**
 * Applique la garde à un profil résolu si elle est active ; sinon le profil
 * ressort tel quel (mêmes objets). Le moteur l'applique en DERNIER, par-dessus
 * le compteur et le journal cloud : un envoi refusé n'est ni compté ni
 * journalisé comme un envoi, puisque rien n'est parti.
 */
export function applySensitiveGate(profile: LlmProfile, enabled: boolean): LlmProfile {
  if (!enabled) return profile
  return {
    extraction: profile.extraction ? gateExtraction(profile.extraction) : null,
    embeddings: profile.embeddings ? gateEmbeddings(profile.embeddings) : null,
  }
}
