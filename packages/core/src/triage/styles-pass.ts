/**
 * PASSE STYLES : la manière d'échanger du propriétaire avec ses assistants,
 * mois par mois, et comment échanger avec une personne de son équipe.
 *
 * Pourquoi une passe à part : la passe sur les messages ne garde qu'UN style
 * par lot de 12 messages, et ses messages sont déjà tous marqués faits. Sur
 * des dizaines de milliers de souvenirs triés, il n'en restait qu'une poignée.
 *
 * BRANCHEMENT
 *   Comme la passe sur les messages : `memoria.ts` n'importe jamais ce
 *   fichier. L'hôte (daemon, server.ts) appelle
 *   `memoria.registerStylesPass(runStylesPass)`, puis
 *   `memoria.triage.runStyles(opts)` appelle `runStylesPass(host, opts)` avec
 *   un `StylesHost` (le `TriageHost` de la passe sur les messages, plus la
 *   fiche Person, le parcours des faits triés et l'état par période). Mêmes
 *   refus : un seul travail de tri à la fois (`running`), pause (`paused`), pas
 *   de LLM (`no-llm`), prix inconnu (`price-unknown`) ; en plus, personne
 *   inconnue (`not-found`).
 *
 * MODE owner
 *   Entrées : les messages tapés par le propriétaire, lus par les fonctions de
 *   user-messages.ts (planSources, streamClaudeCodeTranscript,
 *   humanMessagesFromClaude ; historique Codex sur demande), nettoyés par
 *   cleanHumanText. Un même message (date et texte) lu dans deux sessions (une
 *   session reprise recopie l'historique) ne compte qu'une fois. Jamais le
 *   texte de l'assistant.
 *   Regroupement par (instance, mois civil UTC de la date du message) : un
 *   appel par mois et par instance (en pratique une instance par machine). Un
 *   mois de moins de STYLE_MONTH_MIN_MESSAGES messages est ignoré, sans état :
 *   il sera repris quand il en aura assez.
 *   Par mois, du plus récent au plus ancien :
 *     1. tout message pour lequel `host.isSensitive` est vrai (texte entier)
 *        est écarté ;
 *     2. statistiques locales sur les autres, calculées ici et données au LLM :
 *        nombre, longueur médiane, parts de messages très courts, sans
 *        ponctuation finale, avec un point d'interrogation ;
 *     3. échantillon déterministe réparti sur le mois (STYLE_SAMPLE_MAX au
 *        plus, chacun coupé à STYLE_SAMPLE_CHARS), masqué par `host.redact`
 *        juste avant l'envoi ;
 *     4. un appel LLM (plafond vérifié au pire cas AVANT : TriageBudgetError,
 *        arrêt propre, le mois n'est pas marqué) ; sortie validée à la main ;
 *     5. 6 observations au plus, chacune appuyée par 3 messages de
 *        l'échantillon au moins (numéros vérifiés par le code) ; re-masquée,
 *        écartée si sensible, si elle touche la vie privée ou un contrat, ou si
 *        elle nomme une autre fiche Person ;
 *     6. doublon (`host.findSemanticDuplicate`, exact ou par le sens), sinon
 *        fait DORMANT par `host.storePendingTriaged` : genre `style`,
 *        person_id null, auteur `owner`, auteur_source `message`, portee
 *        `user`, conversation_at = date du dernier message du mois,
 *        prompt_version `styles-v1` ;
 *     7. état du mois (`style_pass_state`, base de l'instance).
 *   Refaire un mois : jamais traité ; ou gagné au moins 50 % de messages
 *   depuis ; ou traité alors qu'il était encore ouvert, fini depuis et gagné
 *   des messages. Un mois encore ouvert sans nouveau message ne repart pas
 *   (chaque passage paierait le même appel pour la même réponse).
 *
 * MODE person (person_id d'une fiche Person existante, sinon refus)
 *   Noms cherchés : premier mot du nom affiché, plus les alias (identifiants
 *   `handle` ou `other` ; jamais un numéro ni un e-mail). Mot entier, sans
 *   accents ni casse.
 *   Sources : faits TRIÉS des bases lisibles (`host.styleSourceFacts` : genre
 *   connu hors `ephemere`, ni faux, ni sensibles, sensibilité normale, ni
 *   oubliés, ni remplacés, ni archivés, ni tirés par cette passe), qui citent
 *   un de ces noms ; rubriques `rh`, `finance`, `juridique` écartées ; filtre
 *   sensible relancé sur chaque texte. Les 250 plus récents, coupés à 300
 *   caractères, masqués avant l'envoi.
 *   Un appel (deux au-delà de STYLE_PERSON_CALL_CHARS de notes, 4 observations
 *   chacun) ; 8 observations au plus, chacune appuyée par 2 faits sources au
 *   moins ; aucun jugement sur le travail, la santé, la paie, le contrat, la
 *   vie privée (consigne au LLM ET garde du code). Tout ou rien : un arrêt ou
 *   un échec sur le second appel n'écrit rien.
 *   Écriture : genre `style`, person_id de la fiche, auteur `ia:<agent de
 *   l'instance>` (convention des faits tirés par le LLM), auteur_source `llm`,
 *   approuve_par_owner faux, portee `user`, conversation_at = date du plus
 *   récent des faits qui l'appuient. Le texte nomme la personne (le doublon
 *   exact ou par le sens ignore person_id). Ces styles ne ressortent jamais
 *   comme ceux du propriétaire : stylesForInstance sans person_id filtre
 *   `t.person_id IS NULL`.
 *   État : la personne n'est renvoyée que si ses faits sources ont augmenté
 *   de 50 % (ou `force`).
 *
 * JAMAIS RECLASSÉS
 *   Les faits passent par `storePendingTriaged` : `facts.source` vaut
 *   `user-messages`, que `reclassify` du moteur ne relit jamais (RECLASSIFY_ROW
 *   dans engine.ts) ; leur genre est connu, le repérage du moteur ne les
 *   reprend pas non plus.
 *
 * DRY-RUN
 *   Aucun appel (ni LLM, ni vecteurs), aucune écriture (ni `redact`, qui écrit
 *   au coffre, ni état) : compte ce qui partirait et rend `estimate_usd`.
 *
 * Boucle d'événements (ticket #27) : transcriptions lues en flux (fonctions de
 * user-messages.ts), retour à la boucle toutes les 10 ms de calcul ; faits
 * parcourus par fenêtres de rowid avec cession (store.ts).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { LlmTruncatedError } from '../llm/provider.js'
import { normalizeText } from '../storage/content.js'
import { sha256Hex } from '../util.js'
import { CIRCUIT_BREAKER_FAILURES, describeError } from './engine.js'
import { sensitiveMatch } from './sensitive.js'
import {
  STYLES_PROMPT_VERSION,
  TriageBudgetError,
  TriageRefusedError,
  type Auteur,
  type ConversationAtSource,
  type StylesHost,
  type StylesPassMode,
  type StylesPassOptions,
  type StylesPeriodState,
  type StylesReport,
  type TriageRow,
  type TriageStopReason,
} from './types.js'
import {
  cleanHumanText,
  clip,
  completeWithRetries,
  DEFAULT_RETRY_DELAY_MS,
  isRecord,
  normalizeKeyText,
  planSources,
  slicer,
  yieldToEventLoop,
} from './user-messages.js'

/** Version du prompt de cette passe (ligne de tri et état ; définie dans types.ts). */
export { STYLES_PROMPT_VERSION }
/** Mois ignoré en dessous de ce nombre de messages (non sensibles). */
export const STYLE_MONTH_MIN_MESSAGES = 10
/** Messages de l'échantillon d'un mois. */
export const STYLE_SAMPLE_MAX = 60
/** Caractères gardés par message de l'échantillon. */
export const STYLE_SAMPLE_CHARS = 600
export const STYLE_OWNER_MAX_OBSERVATIONS = 6
/** Messages de l'échantillon qui doivent appuyer une observation du propriétaire. */
export const STYLE_OWNER_MIN_SUPPORT = 3
/** Faits sources du mode person (les plus récents). */
export const STYLE_PERSON_MAX_SOURCES = 250
export const STYLE_PERSON_SOURCE_CHARS = 300
export const STYLE_PERSON_MAX_OBSERVATIONS = 8
/** Faits sources qui doivent appuyer une observation sur une personne. */
export const STYLE_PERSON_MIN_SUPPORT = 2
/** Au-delà de ces caractères de notes, le mode person fait deux appels. */
export const STYLE_PERSON_CALL_CHARS = 40_000
/** Une période déjà traitée repart quand ses éléments ont été multipliés par ce facteur. */
export const STYLE_REDO_GROWTH = 1.5
/** Message « très court » (statistique locale). */
export const STYLE_SHORT_CHARS = 20
/** Rubriques jamais envoyées en mode person. */
export const STYLE_EXCLUDED_RUBRIQUES: readonly string[] = ['rh', 'finance', 'juridique']
/** Sortie maximale d'un appel (quelques observations courtes). */
const MAX_OUTPUT_TOKENS = 1500
/** Sortie retenue pour le dry-run. */
const ESTIMATE_OUTPUT_TOKENS = 500

// ---------------------------------------------------------------- options et rapport

export interface StylesPassOptionsExt extends StylesPassOptions {
  /** Pause avant la reprise d'un appel en échec passager (défaut 5 000 ms). */
  retryDelayMs?: number
  /** Horloge (mois ouvert ou fini) ; pour les tests. */
  now?: () => Date
}

export interface StylesDetailReport extends StylesReport {
  /** Mode person : faits sources antérieurs à `since`. */
  sources_before_since: number
}

function emptyReport(opts: StylesPassOptions): StylesDetailReport {
  return {
    mode: opts.mode,
    person_id: opts.mode === 'person' ? (opts.person_id ?? null) : null,
    sessions_found: 0,
    sessions_read: 0,
    sessions_no_instance: 0,
    sessions_unreadable: 0,
    sessions_twin: 0,
    messages_seen: 0,
    messages_undated: 0,
    messages_before_since: 0,
    messages_repeated: 0,
    messages_sensitive: 0,
    facts_scanned: 0,
    sources_matched: 0,
    sources_excluded_rubrique: 0,
    sources_sensitive: 0,
    sources_before_since: 0,
    items_sent: 0,
    periods_found: 0,
    periods_small: 0,
    periods_known: 0,
    periods_sent: 0,
    periods_failed: 0,
    facts_created: 0,
    facts_duplicate: 0,
    observations_rejected: {},
    secrets_masked: 0,
    llm_calls: 0,
    llm_calls_estimate: 0,
    tokens_in_estimate: 0,
    spent_usd: 0,
    estimate_usd: opts.dryRun === true ? 0 : null,
    stopped: null,
    errors: [],
    max_block_ms: null,
  }
}

function bump(counts: Record<string, number>, key: string, n = 1): void {
  counts[key] = (counts[key] ?? 0) + n
}

// ---------------------------------------------------------------- mode owner : mois et statistiques

/** Message du propriétaire gardé pour un mois (texte déjà coupé ; jamais sensible). */
export interface OwnerStyleMessage {
  ts: string
  /** Texte nettoyé, coupé à STYLE_SAMPLE_CHARS. */
  text: string
  /** Longueur du texte nettoyé entier. */
  length: number
  noFinalPunct: boolean
  question: boolean
  dateSource: ConversationAtSource
}

export interface StyleMonthStats {
  messages: number
  longueur_mediane: number
  /** Pourcentages (0 à 100). */
  part_tres_courts: number
  part_sans_ponctuation_finale: number
  part_avec_question: number
}

const FINAL_PUNCT = /[.!?…;:][\s"'»)\]]*$/u

/** Mois civil UTC (`AAAA-MM`) d'une date ISO, ou null si illisible. */
export function monthOf(ts: string): string | null {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7)
}

/** Vrai si le mois `AAAA-MM` est fini à la date `now`. */
export function monthClosed(month: string, now: Date): boolean {
  const [y, m] = month.split('-').map(Number)
  return now.getTime() >= Date.UTC(y!, m!, 1)
}

/** Statistiques locales d'un mois (sur tous ses messages non sensibles). */
export function monthStats(messages: readonly Pick<OwnerStyleMessage, 'length' | 'noFinalPunct' | 'question'>[]): StyleMonthStats {
  const n = messages.length
  const lengths = messages.map(m => m.length).sort((a, b) => a - b)
  const mid = Math.floor(n / 2)
  const median = n === 0 ? 0 : n % 2 === 1 ? lengths[mid]! : Math.round((lengths[mid - 1]! + lengths[mid]!) / 2)
  const pct = (k: number): number => (n === 0 ? 0 : Math.round((100 * k) / n))
  return {
    messages: n,
    longueur_mediane: median,
    part_tres_courts: pct(messages.filter(m => m.length < STYLE_SHORT_CHARS).length),
    part_sans_ponctuation_finale: pct(messages.filter(m => m.noFinalPunct).length),
    part_avec_question: pct(messages.filter(m => m.question).length),
  }
}

/** Échantillon déterministe réparti sur toute la liste (déjà triée) : `max` éléments au plus, à intervalles réguliers. */
export function spreadSample<T>(sorted: readonly T[], max: number): T[] {
  if (sorted.length <= max) return sorted.slice()
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(sorted[Math.floor(((i + 0.5) * sorted.length) / max)]!)
  return out
}

/**
 * Refaire une période ? Jamais traitée : oui. Sinon, si elle a gagné au moins
 * 50 % d'éléments, ou si elle était encore ouverte au dernier envoi, qu'elle
 * est finie maintenant et qu'elle a gagné des éléments.
 */
export function shouldRedo(state: StylesPeriodState | null, items: number, closedNow: boolean): boolean {
  if (!state) return true
  if (items >= Math.ceil(state.items * STYLE_REDO_GROWTH)) return true
  return !state.closed && closedNow && items > state.items
}

// ---------------------------------------------------------------- noms et gardes

/** Mots d'un nom, normalisés (minuscules, sans accents). */
function normName(name: string): string {
  return normalizeText(name).replace(/\s+/g, ' ').trim()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Premier mot d'un nom affiché (« Léonie Martin » → « Léonie »). */
export function firstWord(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/** Noms cherchés d'une fiche : premier mot du nom affiché et alias, normalisés, sans doublon (2 caractères au moins). */
export function personSearchNames(person: { display_name: string; aliases: string[] }): string[] {
  const out = new Set<string>()
  const add = (raw: string): void => {
    const n = normName(raw.replace(/^@+/, ''))
    if (n.length >= 2 && /\p{L}/u.test(n)) out.add(n)
  }
  add(firstWord(person.display_name))
  for (const a of person.aliases) add(a)
  return [...out]
}

/** Test « cite un de ces noms » : mot entier, sans accents ni casse. null sans nom utilisable. */
export function nameMatcher(names: readonly string[]): ((text: string) => boolean) | null {
  const usable = names.map(normName).filter(n => n.length >= 2)
  if (usable.length === 0) return null
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${usable.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`, 'u')
  return text => re.test(normalizeText(text))
}

/** Vie privée, famille, contrat : jamais dans une observation (texte normalisé). */
const PRIVATE_THEMES: readonly RegExp[] = [
  /\bvie (privee|perso|personnelle|de famille|familiale|sentimentale)\b/,
  /\b(sa|son|ses|leur|leurs) (famille|femme|mari|epoux|epouse|conjointe?|compagne|compagnon|enfants?|fils|fille|parents?|bebe)\b/,
  /\b(couple|divorce|divorcee?|separation|religion|religieu|politique|syndica|orientation sexuelle)/,
  /\b(contrat|cdd|cdi|licencie|licenciement|rupture conventionnelle|demission|periode d'essai|sanction|avertissement disciplinaire)/,
]

/** Jugement sur le travail ou la personne : jamais en mode person. */
const JUDGEMENT_THEMES: readonly RegExp[] = [
  /\b(in)?competen/,
  /\bqualite (de son|de leur|du|de ce) travail\b/,
  /\b(travail|rendu|livrable)s? (bacle|mediocre|insuffisant|de mauvaise qualite|decevant)/,
  /\b(paresse|paresseu|faineant|negligen|incapable|mediocre|nul|nulle|lunatique|caracteriel|susceptible)/,
  /\b(performances?|productivite|rendement)\b/,
]

/** Raison d'écarter une observation sur son thème, ou null. */
function forbiddenTheme(text: string, mode: StylesPassMode): string | null {
  const t = normalizeText(text).replace(/[’‘`]/g, "'")
  if (sensitiveMatch(text) !== null) return 'sensible'
  if (PRIVATE_THEMES.some(re => re.test(t))) return 'theme'
  if (mode === 'person' && JUDGEMENT_THEMES.some(re => re.test(t))) return 'theme'
  return null
}

// ---------------------------------------------------------------- prompts

export const STYLES_OWNER_SYSTEM_V1 = `Tu lis un échantillon des messages que le propriétaire de cette mémoire a écrits LUI-MÊME à ses assistants IA pendant un mois de travail, avec des statistiques calculées sur tous ses messages du mois. Ton but : décrire SA MANIÈRE D'ÉCHANGER avec ses assistants ce mois-là.

À OBSERVER (une manière constatée, jamais une règle qu'il demande) :
- longueur et ton des messages ; dictée (fautes de transcription, absence de ponctuation, phrases enchaînées) ;
- façon de demander, de proposer une idée, de valider (« ok », « go »), de recadrer ou de corriger l'assistant ;
- langue et mélange de langues ; rythme (rafales de messages courts, longs messages dictés) ;
- signes d'agacement ou de satisfaction, et ce qui les déclenche.

RÈGLES :
- ${STYLE_OWNER_MAX_OBSERVATIONS} observations AU PLUS, chacune appuyée par AU MOINS ${STYLE_OWNER_MIN_SUPPORT} messages de l'échantillon : leurs numéros « m » dans « appuis ». Peu d'observations nettes valent mieux que beaucoup de faibles ; aucune si rien ne se voit nettement ;
- une observation décrit ce qu'il FAIT, pas ce qu'il demande : « réponds en phrases courtes » est une préférence, pas un style, ne la tire pas ;
- jamais le contenu du travail (projets, clients, chiffres), jamais le nom d'une autre personne, jamais une donnée personnelle (santé, argent, famille, adresse) ;
- texte : une phrase autonome, à la troisième personne, en français ; désigne le propriétaire par son prénom s'il est donné plus bas, sinon par « l'utilisateur » ;
- titre : 6 mots au plus.

Exemples (inventés) :
- messages « ok go », « vas y », « oui fais le » → titre « Valide d'un mot », texte « L'utilisateur valide d'un mot ou deux, sans formule, dès que la proposition lui convient. »
- longs messages sans ponctuation, avec des mots mal reconnus → titre « Dicte ses longs messages », texte « L'utilisateur dicte souvent ses messages : longues phrases enchaînées, sans ponctuation, avec des mots mal transcrits. »
- messages « non c'est pas ça », « relis ce que j'ai dit » après une réponse hors sujet → titre « Recadre sèchement le hors-sujet », texte « L'utilisateur recadre vite et sèchement l'assistant quand la réponse s'écarte de sa demande. »

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"observations":[{"titre":"...","texte":"...","appuis":[1,4,9]}]}
Sans rien de net : {"observations":[]}.`

/** Prompt système du mode owner : la consigne neutre + le prénom du propriétaire, s'il est réglé. */
export function buildStylesOwnerSystem(owner: { display_name: string | null }): string {
  const name = owner.display_name?.trim()
  return name ? `${STYLES_OWNER_SYSTEM_V1}\n\nLe propriétaire s'appelle ${name.slice(0, 80)}.` : STYLES_OWNER_SYSTEM_V1
}

/** Prompt système du mode person, pour `max` observations au plus. */
export function buildStylesPersonSystem(max: number): string {
  return `Tu lis des notes de la mémoire d'un propriétaire, écrites par lui ou par ses assistants IA, qui citent une personne avec qui il travaille. Ton but : dire COMMENT ÉCHANGER avec cette personne, pour qu'un assistant aide le propriétaire à mieux communiquer avec elle.

À OBSERVER :
- canal préféré (message écrit, vocal, appel, mail, de vive voix), moment, délai de réponse habituel ;
- ton qui marche ; format qui marche (court, détaillé, liste, exemple, capture) ;
- comment lui confier une tâche (consigne, échéance, exemple, relance) ;
- ce qui bloque ou ralentit l'échange avec elle.

STRICTEMENT INTERDIT : tout jugement sur la qualité de son travail, son caractère ou ses compétences ; sa santé, sa paie, son contrat, sa vie privée ; le contenu du travail (projets, clients, chiffres) ; le nom d'une autre personne.

RÈGLES :
- ${max} observations AU PLUS, chacune appuyée par AU MOINS ${STYLE_PERSON_MIN_SUPPORT} notes : leurs numéros « n » dans « appuis ». Aucune si rien ne se voit nettement sur l'échange lui-même ;
- texte : une phrase autonome, en français, qui nomme la personne par son prénom ;
- titre : 6 mots au plus.

Exemples (inventés, personne « Bastien ») :
- notes « Bastien a répondu sur WhatsApp en dix minutes », « relancé Bastien par mail, pas de réponse », « Bastien préfère un vocal » → titre « Joindre par messagerie ou vocal », texte « Avec Bastien, un message sur la messagerie ou un vocal obtient une réponse rapide ; le mail reste souvent sans réponse. »
- notes « Bastien a demandé un exemple avant de commencer », « avec la capture, Bastien a fait la tâche tout de suite » → titre « Confier une tâche avec exemple », texte « Avec Bastien, une tâche confiée avec un exemple ou une capture démarre tout de suite. »

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"observations":[{"titre":"...","texte":"...","appuis":[1,3]}]}
Sans rien de net : {"observations":[]}.`
}

/** Message utilisateur du mode owner : mois, statistiques, échantillon (une ligne JSON par message). */
export function renderOwnerMonth(month: string, stats: StyleMonthStats, sample: readonly { ts: string; text: string }[]): string {
  return (
    `Mois : ${month}\n` +
    `Statistiques sur tous ses messages du mois (calculées sur place) : ${JSON.stringify(stats)}\n` +
    `Échantillon (${sample.length} messages répartis sur le mois, du plus ancien au plus récent) :\n` +
    sample.map((s, i) => JSON.stringify({ m: i + 1, date: s.ts.slice(0, 10), message: s.text })).join('\n')
  )
}

/** Message utilisateur du mode person : la personne et ses notes, de la plus récente à la plus ancienne. */
export function renderPersonNotes(name: string, notes: readonly { at: string; text: string }[]): string {
  return (
    `Personne : ${name}\n` +
    `Notes (${notes.length}, de la plus récente à la plus ancienne) :\n` +
    notes.map((s, i) => JSON.stringify({ n: i + 1, date: s.at.slice(0, 10), note: s.text })).join('\n')
  )
}

// ---------------------------------------------------------------- sortie du LLM

export interface ProposedObservation {
  texte: string
  titre: string | null
  /** Numéros (à partir de 1) des éléments qui l'appuient, distincts et dans le lot. */
  appuis: number[]
}

/**
 * Lit la réponse du LLM pour un lot de `size` éléments. Sortie sans JSON
 * lisible : lève (l'appel repart une fois). Une observation sans texte, ou
 * appuyée par moins de `minSupport` éléments du lot, est écartée (comptée).
 */
export function parseStylesOutput(raw: string, size: number, minSupport: number): { items: ProposedObservation[]; rejected: Record<string, number> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('styles : réponse du LLM sans JSON')
    try {
      parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
      throw new Error('styles : réponse du LLM illisible')
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['observations'])
      ? (parsed['observations'] as unknown[])
      : isRecord(parsed) && Array.isArray(parsed['items'])
        ? (parsed['items'] as unknown[])
        : null
  if (!list) throw new Error('styles : la réponse du LLM ne contient pas de liste « observations »')
  const items: ProposedObservation[] = []
  const rejected: Record<string, number> = {}
  for (const entry of list) {
    const texte = isRecord(entry) ? clip(entry['texte'], 400) : null
    if (!isRecord(entry) || !texte || texte.length < 12) {
      bump(rejected, 'invalide')
      continue
    }
    const appuis: number[] = []
    for (const a of Array.isArray(entry['appuis']) ? entry['appuis'] : []) {
      const n = typeof a === 'number' ? a : Number(a)
      if (Number.isInteger(n) && n >= 1 && n <= size && !appuis.includes(n)) appuis.push(n)
    }
    if (appuis.length < minSupport) {
      bump(rejected, 'appuis')
      continue
    }
    items.push({ texte, titre: clip(entry['titre'], 80), appuis })
  }
  return { items, rejected }
}

// ---------------------------------------------------------------- la passe

class StopPass extends Error {
  constructor(readonly reason: TriageStopReason) {
    super(reason)
  }
}

/** Observation retenue, prête à écrire. */
interface Accepted {
  text: string
  titre: string | null
  citation: string | null
  at: string | null
  atSource: ConversationAtSource
  secrets: number
}

/** Une période à écrire : où, sous quelle clé, avec quels champs de tri. */
interface PeriodTarget {
  instance: string
  stateKey: string
  period: string
  personId: string | null
  auteur: Auteur
  auteurSource: 'message' | 'llm'
  origine: TriageRow['origine']
}

interface OwnerMonth {
  instance: string
  month: string
  messages: OwnerStyleMessage[]
}

class Pass {
  readonly report: StylesDetailReport
  private readonly dryRun: boolean
  private readonly retryDelayMs: number
  private readonly now: () => Date
  private consecutiveFailures = 0
  private vectorsOff = false
  private budgetHit = false
  private estimateUnknown = false
  private periodsDone = 0
  private periodsTotal = 0
  /** Premiers mots normalisés des autres fiches Person (garde « aucun nom de tiers »). */
  private thirdParties: string[] = []

  constructor(
    private readonly host: StylesHost,
    private readonly opts: StylesPassOptionsExt,
  ) {
    this.dryRun = opts.dryRun === true
    this.report = emptyReport(opts)
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    this.now = opts.now ?? (() => new Date())
  }

  private checkStop(): void {
    const reason = this.host.shouldStop()
    if (reason) throw new StopPass(reason)
    if (this.budgetHit) throw new StopPass('budget')
  }

  private progress(): void {
    this.opts.onProgress?.({
      periods_done: this.periodsDone,
      periods_total: this.periodsTotal,
      llm_calls: this.report.llm_calls,
      facts_created: this.report.facts_created,
      spent_usd: this.dryRun ? 0 : this.host.spentUsd(),
    })
  }

  /** Noms des autres fiches Person, sans ceux qui sont permis (le propriétaire, la personne visée). */
  private setThirdParties(allowed: readonly string[]): void {
    const ok = new Set(allowed.map(normName))
    const owner = this.host.owner.display_name ? normName(firstWord(this.host.owner.display_name)) : ''
    if (owner) ok.add(owner)
    const names = new Set<string>()
    for (const n of this.host.personNames()) {
      const w = normName(firstWord(n))
      if (w.length >= 3 && !ok.has(w)) names.add(w)
    }
    this.thirdParties = [...names]
  }

  async run(): Promise<StylesDetailReport> {
    const r = this.report
    try {
      if (this.opts.mode === 'owner') await this.owner()
      else if (this.opts.mode === 'person') await this.person()
      else throw new TriageRefusedError('bad-request', 'mode inconnu : owner ou person')
    } catch (err) {
      if (!(err instanceof StopPass)) throw err
      r.stopped = err.reason
    }
    // Plafond touché par les vecteurs de la dernière période : elle est écrite, la passe s'arrête là.
    if (this.budgetHit && r.stopped === null) r.stopped = 'budget'
    if (this.dryRun) {
      if (this.estimateUnknown) r.estimate_usd = null
      else if (r.estimate_usd !== null) r.estimate_usd = Math.round(r.estimate_usd * 10_000) / 10_000
    } else r.spent_usd = this.host.spentUsd()
    return r
  }

  // ------------------------------------------------ mode owner

  private async owner(): Promise<void> {
    const r = this.report
    this.setThirdParties([])
    const kinds = this.opts.sources && this.opts.sources.length > 0 ? this.opts.sources : ['claude-code' as const]
    const sources = await planSources(this.host, { sources: kinds }, r)
    r.sessions_found = sources.length
    const months = new Map<string, OwnerMonth>()
    const twins = new Set<string>()
    const notHuman: Record<string, number> = {}
    for (const source of sources) {
      this.checkStop()
      const instance = this.host.resolveInstanceForSource({ kind: source.kind, ...(source.path ? { path: source.path } : {}) })
      if (!instance) {
        r.sessions_no_instance++
        continue
      }
      let messages
      try {
        messages = await source.load(notHuman)
      } catch (err) {
        r.sessions_unreadable++
        r.errors.push(`${source.key} : illisible (${(err as Error).message})`)
        continue
      }
      r.sessions_read++
      const tick = slicer()
      for (const msg of messages) {
        await tick()
        const month = msg.ts ? monthOf(msg.ts) : null
        if (!msg.ts || !month) {
          r.messages_undated++
          continue
        }
        if (this.opts.since && new Date(msg.ts).toISOString() < this.opts.since) {
          r.messages_before_since++
          continue
        }
        const cleaned = cleanHumanText(msg.raw)
        if (!cleaned.text) continue
        // Même message (date et texte) déjà lu : une session reprise recopie l'historique.
        const twin = sha256Hex(`${msg.ts}\n${normalizeKeyText(msg.raw)}`)
        if (twins.has(twin)) {
          r.messages_repeated++
          continue
        }
        twins.add(twin)
        r.messages_seen++
        if (this.host.isSensitive(cleaned.text)) {
          r.messages_sensitive++
          continue
        }
        const key = `${instance}\n${month}`
        const group = months.get(key) ?? { instance, month, messages: [] }
        const text = cleaned.text
        group.messages.push({
          ts: msg.ts,
          text: text.length > STYLE_SAMPLE_CHARS ? `${text.slice(0, STYLE_SAMPLE_CHARS)}…` : text,
          length: text.length,
          noFinalPunct: !FINAL_PUNCT.test(text),
          question: text.includes('?'),
          dateSource: msg.dateSource ?? source.dateSource,
        })
        months.set(key, group)
      }
      await yieldToEventLoop()
    }
    // Du mois le plus récent au plus ancien : sous un plafond serré, les mois récents d'abord.
    const ordered = [...months.values()].sort((a, b) => b.month.localeCompare(a.month) || a.instance.localeCompare(b.instance))
    r.periods_found = ordered.length
    this.periodsTotal = ordered.length
    for (const group of ordered) {
      this.checkStop()
      await this.ownerMonth(group)
      this.periodsDone++
      this.progress()
      await yieldToEventLoop()
    }
  }

  private async ownerMonth(group: OwnerMonth): Promise<void> {
    const r = this.report
    const all = group.messages.sort((a, b) => a.ts.localeCompare(b.ts) || a.text.localeCompare(b.text))
    if (all.length < STYLE_MONTH_MIN_MESSAGES) {
      r.periods_small++
      return
    }
    const stateKey = `owner:${group.month}`
    const closed = monthClosed(group.month, this.now())
    if (!this.opts.force && !shouldRedo(this.host.stylesState(group.instance, stateKey), all.length, closed)) {
      r.periods_known++
      return
    }
    const stats = monthStats(all)
    const sample = spreadSample(all, STYLE_SAMPLE_MAX)
    const last = all[all.length - 1]!
    const system = buildStylesOwnerSystem(this.host.owner)
    if (this.dryRun) {
      this.estimate(system, renderOwnerMonth(group.month, stats, sample))
      r.items_sent += sample.length
      r.periods_sent++
      return
    }
    // Masquage juste avant l'envoi (la valeur d'un secret va au coffre).
    const sent = sample.map(m => {
      const masked = this.host.redact(m.text)
      r.secrets_masked += masked.secrets
      return { ts: m.ts, text: masked.text }
    })
    const items = await this.ask(system, renderOwnerMonth(group.month, stats, sent), sent.length, STYLE_OWNER_MIN_SUPPORT)
    if (items === null) {
      r.periods_failed++
      return
    }
    r.items_sent += sent.length
    r.periods_sent++
    const accepted = this.accept(items, STYLE_OWNER_MAX_OBSERVATIONS, 'owner', null, it => ({
      citation: clip(sent[it.appuis[0]! - 1]!.text, 160),
      at: last.ts,
      atSource: last.dateSource,
    }))
    const target: PeriodTarget = {
      instance: group.instance,
      stateKey,
      period: group.month,
      personId: null,
      auteur: 'owner',
      auteurSource: 'message',
      origine: 'session',
    }
    const created = await this.write(target, accepted)
    this.host.markStyles(group.instance, stateKey, {
      mode: 'owner',
      person_id: null,
      period: group.month,
      items: all.length,
      last_at: last.ts,
      closed,
      facts: created,
    })
  }

  // ------------------------------------------------ mode person

  private async person(): Promise<void> {
    const r = this.report
    const personId = this.opts.person_id
    if (!personId) throw new TriageRefusedError('bad-request', 'person_id requis en mode person')
    const person = this.host.person(personId)
    if (!person) throw new TriageRefusedError('not-found', `personne inconnue : ${personId}`)
    const names = personSearchNames(person)
    const match = nameMatcher(names)
    if (!match) {
      r.errors.push('styles : nom de la fiche inutilisable pour la recherche (2 lettres au moins)')
      return
    }
    const display = firstWord(person.display_name) || person.display_name.trim()
    this.setThirdParties(names)
    const instance =
      this.opts.instance ??
      this.host.resolveInstanceForSource({ kind: 'claude-code' }) ??
      this.host.resolveInstanceForSource({ kind: 'codex-history' })
    if (!instance) {
      r.errors.push('styles : aucune instance où écrire (aucun agent Claude Code ni Codex)')
      return
    }
    r.periods_found = 1
    this.periodsTotal = 1
    const scan = await this.host.styleSourceFacts({
      ...(this.opts.instance ? { instance: this.opts.instance } : {}),
      match,
      stop: () => this.host.shouldStop() !== null,
    })
    this.checkStop()
    r.facts_scanned = scan.scanned
    r.sources_matched = scan.facts.length
    const tick = slicer()
    const kept: typeof scan.facts = []
    const seen = new Set<string>()
    for (const f of scan.facts) {
      await tick()
      if (seen.has(f.id)) continue
      seen.add(f.id)
      if (this.opts.since && f.at < this.opts.since) {
        r.sources_before_since++
        continue
      }
      if (f.rubriques.some(x => STYLE_EXCLUDED_RUBRIQUES.includes(x))) {
        r.sources_excluded_rubrique++
        continue
      }
      // Filtre sensible relancé : une ligne triée avant un filtre plus large peut porter sensible = 0.
      if (this.host.isSensitive(f.text)) {
        r.sources_sensitive++
        continue
      }
      kept.push(f)
    }
    if (kept.length < STYLE_PERSON_MIN_SUPPORT) {
      r.periods_small++
      return
    }
    const stateKey = `person:${person.id}`
    if (!this.opts.force && !shouldRedo(this.host.stylesState(instance, stateKey), kept.length, true)) {
      r.periods_known++
      return
    }
    kept.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    const notes = kept.slice(0, STYLE_PERSON_MAX_SOURCES).map(f => ({
      ...f,
      text: f.text.length > STYLE_PERSON_SOURCE_CHARS ? `${f.text.slice(0, STYLE_PERSON_SOURCE_CHARS)}…` : f.text,
    }))
    const chars = notes.reduce((n, x) => n + x.text.length, 0)
    const chunks = chars > STYLE_PERSON_CALL_CHARS ? [notes.slice(0, Math.ceil(notes.length / 2)), notes.slice(Math.ceil(notes.length / 2))] : [notes]
    const perCall = Math.floor(STYLE_PERSON_MAX_OBSERVATIONS / chunks.length)
    const system = buildStylesPersonSystem(perCall)
    if (this.dryRun) {
      for (const chunk of chunks) this.estimate(system, renderPersonNotes(display, chunk))
      r.items_sent += notes.length
      r.periods_sent++
      return
    }
    // Tout ou rien : les appels d'abord, l'écriture ensuite.
    const proposed: Array<{ item: ProposedObservation; chunk: typeof notes }> = []
    for (const chunk of chunks) {
      this.checkStop()
      const sent = chunk.map(n => {
        const masked = this.host.redact(n.text)
        r.secrets_masked += masked.secrets
        return { ...n, text: masked.text }
      })
      const items = await this.ask(system, renderPersonNotes(display, sent), sent.length, STYLE_PERSON_MIN_SUPPORT)
      if (items === null) {
        r.periods_failed++
        return
      }
      r.items_sent += sent.length
      for (const item of items.slice(0, perCall)) proposed.push({ item, chunk: sent })
      if (items.length > perCall) bump(r.observations_rejected, 'surplus', items.length - perCall)
    }
    r.periods_sent++
    const byItem = new Map(proposed.map(p => [p.item, p.chunk]))
    const accepted = this.accept(
      proposed.map(p => p.item),
      STYLE_PERSON_MAX_OBSERVATIONS,
      'person',
      { display, match },
      it => {
        const support = it.appuis.map(k => byItem.get(it)![k - 1]!)
        const latest = support.reduce((a, b) => (b.at > a.at ? b : a))
        return { citation: clip(latest.text, 160), at: latest.at, atSource: latest.at_source as ConversationAtSource }
      },
    )
    const target: PeriodTarget = {
      instance,
      stateKey,
      period: 'personne',
      personId: person.id,
      auteur: `ia:${this.host.agentOf(instance)}`,
      auteurSource: 'llm',
      origine: null,
    }
    const created = await this.write(target, accepted)
    this.host.markStyles(instance, stateKey, {
      mode: 'person',
      person_id: person.id,
      period: 'personne',
      items: kept.length,
      last_at: kept[0]!.at,
      closed: true,
      facts: created,
    })
    this.periodsDone = 1
    this.progress()
  }

  // ------------------------------------------------ appel, garde, écriture

  /** Dry-run : un appel estimé (aucun envoi). */
  private estimate(system: string, prompt: string): void {
    const r = this.report
    const inputChars = system.length + prompt.length
    const cost = this.host.estimateCost(inputChars, ESTIMATE_OUTPUT_TOKENS)
    if (cost === null) this.estimateUnknown = true
    else r.estimate_usd = (r.estimate_usd ?? 0) + cost
    r.llm_calls_estimate++
    r.tokens_in_estimate += Math.ceil(inputChars / 4)
  }

  /**
   * Un appel et sa sortie validée. null : échec (appel en échec après reprise,
   * sortie coupée ou illisible deux fois) ; rien n'est écrit ni marqué pour la
   * période, reprise au passage suivant. Plafond : arrêt `budget` ; trois
   * échecs d'appel d'affilée : arrêt `circuit`.
   */
  private async ask(system: string, prompt: string, size: number, minSupport: number): Promise<ProposedObservation[] | null> {
    const r = this.report
    for (let attempt = 0; attempt < 2; attempt++) {
      this.checkStop()
      let text: string
      try {
        text = await completeWithRetries(
          this.host,
          { system, prompt, json: true, temperature: 0, maxTokens: MAX_OUTPUT_TOKENS },
          { retryDelayMs: this.retryDelayMs, onCall: () => r.llm_calls++, checkStop: () => this.checkStop() },
        )
      } catch (err) {
        if (err instanceof StopPass) throw err
        // Plafond : l'appel n'est pas parti.
        if (err instanceof TriageBudgetError) throw new StopPass('budget')
        if (err instanceof LlmTruncatedError) {
          r.errors.push('styles : sortie coupée (reprise au passage suivant)')
          return null
        }
        this.consecutiveFailures++
        r.errors.push(`styles : appel en échec (${describeError(err)})`)
        if (this.consecutiveFailures >= CIRCUIT_BREAKER_FAILURES) throw new StopPass('circuit')
        return null
      }
      this.consecutiveFailures = 0
      try {
        const parsed = parseStylesOutput(text, size, minSupport)
        for (const [k, n] of Object.entries(parsed.rejected)) bump(r.observations_rejected, k, n)
        return parsed.items
      } catch (err) {
        if (attempt === 1) {
          r.errors.push((err as Error).message)
          return null
        }
      }
    }
    return null
  }

  /**
   * Gardes du code sur les observations proposées : re-masquées, écartées si
   * sensibles, sur un thème interdit, ou si elles nomment une autre fiche
   * Person ; en mode person, le texte nomme la personne. `max` au plus.
   */
  private accept(
    items: readonly ProposedObservation[],
    max: number,
    mode: StylesPassMode,
    person: { display: string; match: (text: string) => boolean } | null,
    meta: (item: ProposedObservation) => Pick<Accepted, 'citation' | 'at' | 'atSource'>,
  ): Accepted[] {
    const r = this.report
    const tiers = nameMatcher(this.thirdParties)
    const out: Accepted[] = []
    for (const item of items) {
      if (out.length >= max) {
        bump(r.observations_rejected, 'surplus')
        continue
      }
      const masked = this.host.redact(item.texte)
      let text = masked.text
      const theme = this.host.isSensitive(text) ? 'sensible' : forbiddenTheme(text, mode)
      if (theme) {
        bump(r.observations_rejected, theme)
        continue
      }
      if (tiers?.(text)) {
        bump(r.observations_rejected, 'tiers')
        continue
      }
      // Le texte nomme la personne : le doublon (exact ou par le sens) ignore person_id.
      if (person && !person.match(text)) text = `Avec ${person.display} : ${text}`
      const m = meta(item)
      out.push({ text, titre: item.titre, citation: m.citation, at: m.at, atSource: m.atSource, secrets: masked.secrets })
    }
    return out
  }

  /** Doublons écartés, le reste écrit en faits DORMANTS. Rend le nombre de faits créés. */
  private async write(target: PeriodTarget, accepted: Accepted[]): Promise<number> {
    const r = this.report
    if (accepted.length === 0) return 0
    const vectors = new Map<number, Float32Array>()
    if (!this.vectorsOff) {
      try {
        const vecs = await this.host.embed(accepted.map(a => a.text))
        accepted.forEach((_, i) => {
          const v = vecs[i]
          if (v) vectors.set(i, v)
        })
      } catch (err) {
        // Plafond touché par les vecteurs : la période s'écrit sans eux, puis la passe s'arrête.
        if (err instanceof TriageBudgetError) this.budgetHit = true
        else {
          const message = (err as Error)?.message ?? String(err)
          if (/aucun fournisseur de vecteurs/.test(message)) this.vectorsOff = true
          r.errors.push(`styles : vecteurs indisponibles, doublons exacts seulement (${message})`)
        }
      }
    }
    let created = 0
    accepted.forEach((a, i) => {
      const vector = vectors.get(i)
      if (this.host.findSemanticDuplicate(target.instance, a.text, vector)) {
        r.facts_duplicate++
        return
      }
      const triage: Partial<Omit<TriageRow, 'fact_id' | 'triaged_at'>> = {
        genre: 'style',
        sous_type: null,
        rubriques: [],
        portee: 'user',
        person_id: target.personId,
        auteur: target.auteur,
        auteur_source: target.auteurSource,
        approuve_par_owner: false,
        durabilite: 2,
        importance: 1,
        autonome: true,
        projet: null,
        titre: a.titre,
        citation: a.citation,
        entites: [],
        conversation_at: a.at,
        conversation_at_source: a.at ? a.atSource : 'inconnu',
        origine: target.origine,
        raison: null,
        secret_found: a.secrets > 0,
        sensible: false,
        prompt_version: STYLES_PROMPT_VERSION,
      }
      const res = this.host.storePendingTriaged({
        instance: target.instance,
        content: a.text,
        category: 'preference',
        triage,
        source: {
          key: `styles:${target.stateKey}`,
          path: null,
          metadata: { kind: 'styles', mode: target.personId ? 'person' : 'owner', period: target.period, prompt: STYLES_PROMPT_VERSION },
        },
        ...(vector ? { vector } : {}),
      })
      if (!res.created) {
        r.facts_duplicate++
        return
      }
      created++
      r.facts_created++
    })
    return created
  }
}

/** La passe : voir le contrat en tête de fichier. */
export async function runStylesPass(host: StylesHost, opts: StylesPassOptions): Promise<StylesDetailReport> {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  try {
    const report = await new Pass(host, opts as StylesPassOptionsExt).run()
    report.max_block_ms = Math.round(delay.max / 1e6)
    return report
  } finally {
    delay.disable()
  }
}
