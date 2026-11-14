/**
 * Importeur de transcripts d'agents (spec §7.2) :
 *   fichiers Claude Code / Codex → tours → fenêtres → extraction LLM (1 appel /
 *   fenêtre) → dédup → faits en QUARANTAINE (dormant + memory_import_items
 *   'pending') dans la mémoire PRIVÉE de l'instance → écran Revue.
 *
 * Garanties (alignées sur import-legacy.ts et le mode review-first de memoria.ts) :
 *  - IDEMPOTENCE par sha256 du contenu du fichier (memory_sources.source_hash,
 *    source_type='transcript') : ré-importer le même fichier = 0 nouveau ;
 *  - NE BLOQUE PAS le thread appelant (ticket #27) : un fichier inchangé
 *    (taille + date, table transcript_file_state) est écarté par un `stat`,
 *    sans lecture ; la lecture est asynchrone ; la main est rendue entre deux
 *    fichiers. Le daemon continue de répondre pendant un import ;
 *  - UNE FENÊTRE N'EST EXTRAITE QU'UNE FOIS (table transcript_window_state) :
 *    quand une conversation grandit, seules ses nouvelles fenêtres partent au
 *    LLM, pas tout le fichier ;
 *  - AUCUNE FENÊTRE PERDUE : un fichier dont une fenêtre a échoué à
 *    l'extraction reste « incomplet » et ses fenêtres en échec sont retentées
 *    aux imports suivants. L'état « incomplet » est écrit AVANT la première
 *    extraction : un import arrêté en cours de fichier reprend au passage
 *    suivant ;
 *  - ESSAIS COMPTÉS PAR FENÊTRE : quand une fenêtre échoue, un appel témoin
 *    minuscule dit qui est en cause. Le témoin passe : c'est la fenêtre (trop
 *    longue, refusée, réponse coupée ou illisible), elle prend un essai et est
 *    abandonnée après MAX_FILE_ATTEMPTS. Le témoin échoue aussi : c'est une
 *    panne générale (réseau, quota, clé, modèle qui ne rend pas de JSON), aucun
 *    essai ; après LLM_CIRCUIT_BREAKER_FAILURES échecs d'affilée le run cesse
 *    d'appeler le LLM et laisse les fichiers restants intacts. Garde-fou : une
 *    fenêtre en échec pendant MAX_OUTAGE_ATTEMPTS imports, même classés
 *    « panne », est abandonnée : rien n'est rejoué sans fin. Les fenêtres
 *    seulement reportées (plafond, coupe-circuit) ne prennent jamais d'essai ;
 *  - LE PLAFOND NE CACHE RIEN : maxWindowsPerFile s'applique aux fenêtres PAS
 *    ENCORE extraites ; sur un fichier déjà suivi, l'excédent est reporté au
 *    passage suivant (seul le premier import d'un gros fichier ignore, en le
 *    disant, ses fenêtres les plus anciennes) ;
 *  - CONVERSATION EN COURS : la dernière fenêtre, encore incomplète, d'un
 *    fichier déjà suivi et modifié depuis peu attend que le fichier soit au
 *    repos (tailQuietMs), pour ne pas être extraite à chaque tour ajouté ;
 *  - PROVENANCE : chaque fait retenu pointe vers sa memory_sources (chemin + hash)
 *    via memory_import_items ;
 *  - QUARANTAINE : le fait naît `dormant` (invisible au recall) + 'pending' —
 *    seule l'approbation par lot (Memoria.reviewDecision) l'active ;
 *  - DÉDUP : hash de contenu normalisé EN MÉMOIRE (dans le run) ET contre la DB
 *    privée (findDuplicate) — pas de doublon inter-fenêtres ni avec l'existant ;
 *  - SANS LLM (extraction null / indisponible) : 0 fait, note 'no-llm', AUCUNE
 *    invention, AUCUNE écriture de fait ;
 *  - une fenêtre dont l'extraction échoue ne bloque pas le fichier : l'erreur va
 *    dans report.errors + console.warn (avec sa cause), on continue ;
 *  - dryRun : parse + compte ce qu'un vrai import enverrait, AUCUNE écriture ;
 *  - sinceDate : un passage qui a écarté des tours ne scelle jamais le fichier
 *    « complet » : un import ultérieur, sans date ou avec une date plus
 *    ancienne, le reprend (les fenêtres déjà extraites restent sautées) ;
 *  - UNITÉS DÉJÀ PARSÉES (export ChatGPT, `units`) : même chaîne qu'un
 *    fichier, mais une conversation = une unité à clé stable (`chatgpt:<id>`),
 *    hash = contenu retenu. Une unité inchangée (même hash) est sautée sans
 *    rien relire ; pas de plafond qui ignore le début d'une conversation (le
 *    surplus est reporté, jamais perdu) ; pas d'attente de « conversation en
 *    cours » (un export est un instantané) ;
 *  - SECRETS MASQUÉS AVANT LE LLM (gate dur §9, comme la capture) : le texte
 *    envoyé pour chaque fenêtre, quel que soit le format, passe par le même
 *    Redactor que la capture ; une clé devient `[secret:<nom>]` et sa valeur
 *    part au coffre (vrai import seulement). Le hash de fenêtre, lui, est
 *    calculé sur le texte brut, comme avant : masquer ne relance rien ;
 *  - AUTEUR DES TOURS (Claude Code) : seul ce que l'humain a tapé est présenté
 *    au LLM comme `[user]` (messages en file d'attente compris) ; les
 *    notifications, résumés de compaction, contenus injectés, messages d'autres
 *    sessions et consignes d'un agent parent sont étiquetés, ou réduits à leur
 *    étiquette. Même règle : le hash de fenêtre reste celui du découpage brut.
 *
 * NB : ce module n'écrit JAMAIS un fait actif. La promotion vers `active` passe
 * exclusivement par la revue gouvernée (Memoria.reviewDecision).
 */
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { ContentStore } from '../storage/content.js'
import { findDuplicate } from '../engine/selective.js'
import { parseFactArray } from '../engine/capture.js'
import { RegexRedactor } from '../secrets/redaction.js'
import { factNormHash, newId, nowISO, sha256Hex } from '../util.js'
import {
  detectTranscriptFormat,
  parseTranscript,
  type TranscriptFormat,
  type Turn,
  type TurnSource,
} from './transcript-parsers.js'
import { addWindowToEstimate, emptyEstimate, type ExtractionEstimate } from './extraction-estimate.js'
import type { LlmProvider } from '../llm/provider.js'
import type { DetectedSecret, Redactor } from '../secrets/types.js'
import type { Fact, StoreFactInput } from '../types.js'

/**
 * Surface minimale du moteur dont l'importeur a besoin (Memoria la satisfait).
 * Découplage volontaire : l'import ne dépend pas de la classe concrète, et on
 * n'a pas à modifier engine/memoria.ts pour le câbler (helper externe).
 */
export interface ImportTranscriptsMemoria {
  /** Fait déjà connu dans un scope PARTAGÉ lisible par l'instance (dédup inter-agents, cf. capture). */
  findKnownDuplicate(instanceId: string, factText: string, opts?: { includePrivate?: boolean }): unknown | null
  /** storeFact gouverné (audite 'store_fact'). On le rend ensuite dormant + pending. */
  storeFact(input: StoreFactInput): Fact
  paths: { assistantDb(instanceId: string): string }
  registry: { getScopeByName(name: string): { id: string } | null }
}

/**
 * Conversation déjà parsée, importée comme un fichier (export ChatGPT). Sa clé
 * tient lieu de chemin dans transcript_file_state et memory_sources : elle
 * doit être STABLE d'un export à l'autre (jamais un chemin temporaire).
 */
export interface TranscriptUnit {
  /** Clé stable (`chatgpt:<id de conversation>`). */
  key: string
  /** Libellé court des notes (titre de la conversation). */
  label: string
  /** Format consigné dans la provenance (`chatgpt`). */
  format: string
  /** Tours retenus, dans l'ordre. */
  turns: Turn[]
  /** Hash du contenu retenu : idempotence (index UNIQUE de memory_sources), préfixé par le format. */
  sourceHash: string
  /** Taille notée dans l'état (caractères retenus). */
  size: number
  /** Date notée dans l'état (dernière mise à jour de la conversation, ms). */
  mtimeMs: number
  /** Provenance ajoutée aux métadonnées de la source (titre, dates…). */
  metadata?: Record<string, unknown>
  /** Contexte placé avant chaque extrait envoyé au LLM. Hors hash de fenêtre : un titre renommé ne relance rien. */
  context?: string
}

export interface ImportTranscriptsInput {
  /** Chemins absolus des fichiers de transcript à importer. */
  files: string[]
  /** Conversations déjà parsées (export ChatGPT), traitées après les fichiers. */
  units?: TranscriptUnit[]
  memoria: ImportTranscriptsMemoria
  /**
   * assistant_instance_id cible (scope privé). null : seulement en dry-run,
   * quand l'instance n'existe pas encore. Rien n'est alors connu : tout compte
   * comme nouveau, et rien n'est créé.
   */
  instanceId: string | null
  /** Prompt système d'extraction (défaut : conversations avec un assistant de code). */
  systemPrompt?: string
  /** LLM d'extraction. null/indisponible → 0 fait + note 'no-llm' (pas d'invention). */
  extraction: LlmProvider | null
  /** Ne garder que les tours à/après cette date ISO (filtre les vieilles convs). */
  sinceDate?: string
  /** Garde-fou anti-explosion : nb max de fenêtres envoyées au LLM par fichier et par import (défaut 20). */
  maxWindowsPerFile?: number
  /**
   * Délai de repos (ms) d'une conversation en cours : la dernière fenêtre,
   * encore incomplète, d'un fichier DÉJÀ suivi n'est extraite que si le
   * fichier n'a pas été modifié depuis ce délai. Défaut 30 min ; 0 = jamais
   * différée.
   */
  tailQuietMs?: number
  /** Parse + compte sans AUCUNE écriture. */
  dryRun?: boolean
  /**
   * Gate dur secrets appliqué au texte de chaque fenêtre AVANT l'envoi au LLM
   * (le même que la capture : passer celui du moteur). Absent : un
   * RegexRedactor neuf, jamais d'envoi en clair faute de câblage.
   */
  redactor?: Redactor
  /**
   * Coffre des secrets masqués (vrai import seulement, jamais en dry-run), pour
   * qu'un `[secret:<nom>]` repris dans un fait pointe vers une valeur. Absent :
   * la valeur est seulement retirée du texte, elle n'est conservée nulle part.
   */
  secretSink?: (secret: DetectedSecret) => void
  /**
   * Progression (job d'import du daemon, CLI) : appelé après CHAQUE fichier,
   * y compris ceux ignorés/en échec. Une exception du callback est loggée,
   * jamais avalée, et n'interrompt pas l'import.
   */
  onProgress?: (progress: ImportTranscriptsProgress) => void
}

export interface ImportTranscriptsProgress {
  filesDone: number
  filesTotal: number
  factsImported: number
}

export interface ImportTranscriptsReport {
  files_read: number
  files_skipped_already_imported: number
  /** Fichiers dont il reste des fenêtres à extraire (en échec, ou reportées par le plafond ou le coupe-circuit) : repris au prochain import. */
  files_incomplete: number
  /** Fenêtres réellement envoyées au LLM (en dry-run / sans LLM : celles qu'un vrai import enverrait). */
  windows: number
  /** Fenêtres déjà extraites lors d'un import précédent : aucun appel LLM. */
  windows_skipped_known: number
  /**
   * Fenêtres de `windows` dont le texte contenait au moins un secret (clé,
   * jeton, mot de passe), masqué avant l'envoi au LLM. En dry-run : celles
   * qu'un vrai import enverrait.
   */
  windows_with_secrets: number
  facts_extracted: number
  facts_quarantined: number
  facts_skipped_duplicates: number
  /** Tours retenus (après le filtre de date) dans les fichiers et unités lus. */
  turns: number
  /**
   * Dry-run seulement : volume des fenêtres comptées dans `windows`, et jetons
   * estimés (aucun appel LLM). Voir extraction-estimate.ts pour les hypothèses.
   */
  estimate?: ExtractionEstimate
  errors: string[]
  notes: string[]
  dry_run: boolean
}

/**
 * Prompt système dédié transcripts (dérivé de EXTRACTION_SYSTEM, spec §7.2).
 * La règle d'auteur répond à un défaut mesuré : le LLM écrivait « L'utilisateur
 * recommande… » pour une idée de l'assistant. Gardée courte : la longueur du
 * prompt système pèse sur chaque appel et sur l'estimation de coût.
 */
export const TRANSCRIPT_EXTRACTION_SYSTEM = `You extract DURABLE facts from an excerpt of a conversation between a user and a coding assistant, for a long-term memory.
Keep ONLY what lasts and can be reused: user preferences, decisions and their rationale, exact configurations, project conventions, lessons learned from mistakes, learned processes.
Extract NOTHING ephemeral: passing state of a one-off task, pleasantries, unanswered questions, narration ("I am reading the file"), detail that is true only once.
Each fact must be SELF-CONTAINED (understandable alone) and carry something concrete (name, version, command, path, decision).
Each line starts with its author in brackets. Only [user] and [user, …] lines were written by the human user; any other label (assistant, notification, summary, system, another agent) was not.
For an idea, recommendation or decision, name its real author: "The user…" only if a [user] line says it, otherwise "The assistant proposed…" (add that the user approved it only if a [user] line shows it). Never guess an author.
Write every fact in the SAME LANGUAGE as the conversation. Never translate it.
Reply with a JSON object ONLY, no surrounding text:
{"facts": [{"fact": "self-contained, precise statement", "category": "preference|decision|config|error|process|general", "confidence": 0.0-1.0}]}
{"facts": []} if nothing durable.`

const DEFAULT_MAX_WINDOWS = 20
/** Repos par défaut avant d'extraire la fenêtre de queue d'une conversation en cours. */
const DEFAULT_TAIL_QUIET_MS = 30 * 60_000
/**
 * Coupe-circuit : nombre d'échecs D'AFFILÉE (appels témoins compris, sans
 * aucune réussite entre deux) à partir duquel le run cesse d'appeler le LLM.
 * Une fenêtre indigeste échoue seule ; une panne ou un quota épuisé font tout
 * échouer.
 */
export const LLM_CIRCUIT_BREAKER_FAILURES = 5
/** Cible de regroupement d'une fenêtre : ~6 tours OU ~2000 chars (borne le coût). */
const MAX_TURNS_PER_WINDOW = 6
const MAX_CHARS_PER_WINDOW = 2000

interface ConversationWindow {
  turns: Turn[]
}

function emptyReport(dryRun: boolean): ImportTranscriptsReport {
  return {
    files_read: 0,
    files_skipped_already_imported: 0,
    files_incomplete: 0,
    windows: 0,
    windows_skipped_known: 0,
    windows_with_secrets: 0,
    facts_extracted: 0,
    facts_quarantined: 0,
    facts_skipped_duplicates: 0,
    turns: 0,
    ...(dryRun ? { estimate: emptyEstimate() } : {}),
    errors: [],
    notes: [],
    dry_run: dryRun,
  }
}

/** Hash de contenu normalisé (dédup faits) : casse + espaces neutralisés. Aligné sur import-legacy. */
function contentHash(text: string): string {
  return sha256Hex(text.trim().replaceAll(/\s+/gu, ' ').toLowerCase())
}

/** Regroupe les tours en fenêtres (~6 tours / ~2000 chars). Une fenêtre = 1 appel LLM. */
function buildWindows(turns: Turn[]): ConversationWindow[] {
  const windows: ConversationWindow[] = []
  let current: Turn[] = []
  let chars = 0
  for (const turn of turns) {
    current.push(turn)
    chars += turn.text.length
    if (current.length >= MAX_TURNS_PER_WINDOW || chars >= MAX_CHARS_PER_WINDOW) {
      windows.push({ turns: current })
      current = []
      chars = 0
    }
  }
  if (current.length > 0) windows.push({ turns: current })
  return windows
}

/** Fenêtre que buildWindows n'a pas fermée : la conversation peut encore la faire grandir. */
function isOpenWindow(window: ConversationWindow): boolean {
  const chars = window.turns.reduce((n, t) => n + t.text.length, 0)
  return window.turns.length < MAX_TURNS_PER_WINDOW && chars < MAX_CHARS_PER_WINDOW
}

const WINDOW_HEAD = 'Extrait de conversation :\n'
const WINDOW_TAIL = '\n\nObjet JSON {"facts": [...]} des faits durables :'

/**
 * IDENTITÉ d'une fenêtre : son hash identifie la fenêtre dans
 * transcript_window_state. Ne pas le changer (ni le texte des tours, ni leur
 * rôle, ni ce gabarit), sinon toutes les fenêtres déjà extraites repartiraient
 * au LLM (ticket #27). Ce n'est PLUS le texte envoyé au LLM : voir llmPrompt.
 */
function windowPrompt(window: ConversationWindow): string {
  const lines = window.turns.map(t => `- [${t.role}] ${t.text}`)
  return `${WINDOW_HEAD}${lines.join('\n')}${WINDOW_TAIL}`
}

/** Étiquette des messages tapés pendant que l'assistant travaillait. */
const QUEUED_LABEL = 'user, sent while the assistant was working'

/**
 * Comment présenter au LLM un tour qui n'est pas de l'humain : étiquette, et
 * longueur gardée (0 = étiquette seule). Les résumés de compaction et les
 * contenus injectés reprennent ce qui est déjà ailleurs (fenêtres précédentes,
 * documentation d'une compétence) : seule l'étiquette reste. Une notification
 * de tâche garde son résumé, pas le résultat complet du sous-agent, déjà
 * extrait de la transcription du sous-agent elle-même.
 */
const SOURCE_RENDER: Record<TurnSource, { label: string; keep: number }> = {
  notification: { label: 'task notification, not written by the user', keep: 400 },
  summary: { label: 'summary of the earlier conversation, written by the assistant (omitted)', keep: 0 },
  system: { label: 'system content injected into the conversation, not written by the user (omitted)', keep: 0 },
  command: { label: 'local command or its output', keep: 300 },
  peer: { label: 'message from another agent session, not the user', keep: 1500 },
  scheduled: { label: 'scheduled task prompt, sent automatically', keep: 600 },
  orchestrator: { label: 'instructions from the agent that launched this sub-agent, not the user', keep: 2500 },
}

/**
 * Texte abrégé, avec marqueur visible (jamais de coupe muette). Ne coupe
 * jamais au milieu d'un `[secret:…]` : la coupe recule avant le placeholder.
 */
function excerpt(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = max
  const open = text.lastIndexOf('[secret:', cut)
  if (open !== -1 && text.indexOf(']', open) >= cut) cut = open
  return `${text.slice(0, cut)}…[abrégé]`
}

/**
 * `mask` est appliqué au corps ENTIER, AVANT la coupe : coupé d'abord, un
 * secret perd ce qui le suit (« @hôte » d'une URL, fin d'un jeton) et le motif
 * ne le reconnaît plus, alors que sa valeur partirait en clair.
 */
function renderSourcedTurn(turn: Turn, source: TurnSource, mask: (text: string) => string): string {
  const { label, keep } = SOURCE_RENDER[source]
  if (keep === 0) return `- [${label}]`
  let body = turn.text
  if (source === 'notification') {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim()
    body = summary ? summary : body.replace(/<result>[\s\S]*?(?:<\/result>|$)/, '')
  }
  return `- [${label}] ${excerpt(mask(body.trim()), keep)}`
}

/**
 * Texte de la fenêtre pour le LLM : chaque tour avec son auteur réel. Un tour
 * de l'humain ou de l'assistant s'écrit exactement comme dans windowPrompt :
 * une fenêtre sans tour étiqueté ni message en file donne le même texte.
 */
const TRUNCATION_MARK = '…[tronqué]'

/**
 * Tour coupé par le parseur (MAX_TURN_CHARS, avant le hash, donc avant tout
 * masquage) : une clé à cheval sur la coupe perd sa fin, n'est plus reconnue
 * et son début partirait en clair. On retire le dernier mot avant le marqueur,
 * dans le texte envoyé au LLM seulement (le hash ne bouge pas).
 */
function dropCutWord(text: string): string {
  if (!text.endsWith(TRUNCATION_MARK)) return text
  const body = text.slice(0, -TRUNCATION_MARK.length)
  const cut = body.search(/\s\S*$/)
  return `${cut > 0 ? body.slice(0, cut) : ''}${TRUNCATION_MARK}`
}

function llmWindowText(window: ConversationWindow, mask: (text: string) => string): string {
  const lines: string[] = []
  for (const raw of window.turns) {
    const t = raw.text.endsWith(TRUNCATION_MARK) ? { ...raw, text: dropCutWord(raw.text) } : raw
    for (const q of t.queuedBefore ?? []) lines.push(`- [${QUEUED_LABEL}] ${q}`)
    lines.push(t.source && t.role === 'user' ? renderSourcedTurn(t, t.source, mask) : `- [${t.role}] ${t.text}`)
    for (const q of t.queuedAfter ?? []) lines.push(`- [${QUEUED_LABEL}] ${q}`)
  }
  return `${WINDOW_HEAD}${lines.join('\n')}${WINDOW_TAIL}`
}

/**
 * Ce que reçoit vraiment le LLM : le contexte de l'unité (titre, date) puis la
 * fenêtre, et AUCUN secret en clair. Les tours abrégés sont masqués avant leur
 * coupe, puis le texte entier l'est (tours de l'humain, file d'attente,
 * contexte). Seuls comptent les secrets dont le placeholder figure dans le
 * texte final : ceux d'un passage omis ou coupé ne partent pas.
 */
function maskedLlmPrompt(
  window: ConversationWindow,
  context: string | undefined,
  maskPrompt: FileContext['maskPrompt'],
): { text: string; secrets: DetectedSecret[] } {
  const found: DetectedSecret[] = []
  const maskBody = (text: string): string => {
    const r = maskPrompt(text)
    found.push(...r.secrets)
    return r.text
  }
  const body = llmWindowText(window, maskBody)
  const final = maskPrompt(context ? `${context}\n${body}` : body)
  const sent = new Map<string, DetectedSecret>()
  for (const s of [...found, ...final.secrets]) if (final.text.includes(`[secret:${s.name}]`)) sent.set(s.name, s)
  return { text: final.text, secrets: [...sent.values()] }
}

/**
 * Filtre les tours par sinceDate. Un tour SANS ts est conservé (on ne jette pas
 * faute de métadonnée — décision conservatrice, signalée en note plus haut).
 */
function filterSince(turns: Turn[], sinceDate: string | undefined): Turn[] {
  if (!sinceDate) return turns
  const cutoff = Date.parse(sinceDate)
  if (Number.isNaN(cutoff)) return turns
  return turns.filter(t => {
    if (!t.ts) return true
    const ts = Date.parse(t.ts)
    return Number.isNaN(ts) || ts >= cutoff
  })
}

/**
 * Importe un lot de transcripts en quarantaine de revue. Ne throw jamais : toute
 * erreur d'un fichier/fenêtre est consignée dans report.errors + console.warn,
 * et l'import continue sur les autres.
 */
export async function importTranscripts(input: ImportTranscriptsInput): Promise<ImportTranscriptsReport> {
  const report = emptyReport(input.dryRun ?? false)
  const maxWindows = input.maxWindowsPerFile ?? DEFAULT_MAX_WINDOWS
  const tailQuietMs = input.tailQuietMs ?? DEFAULT_TAIL_QUIET_MS
  const systemPrompt = input.systemPrompt ?? TRANSCRIPT_EXTRACTION_SYSTEM
  const units = input.units ?? []

  // Dry-run SANS instance (export ChatGPT jamais importé) : aucune base à lire,
  // tout compte comme nouveau. Hors dry-run, une instance est obligatoire.
  if (input.instanceId === null) {
    if (!report.dry_run) {
      const msg = 'instance cible manquante : seul un dry-run peut tourner sans instance'
      console.warn(`[memoria] import transcripts : ${msg}`)
      report.errors.push(msg)
      return report
    }
    await runFiles(input, report, null, { scopeId: '', maxWindows, tailQuietMs, systemPrompt, units })
    return report
  }

  const privateScope = input.memoria.registry.getScopeByName(`private:${input.instanceId}`)
  if (!privateScope) {
    const msg = `scope privé introuvable pour l'instance ${input.instanceId} (pairing non fait ?)`
    console.warn(`[memoria] import transcripts : ${msg}`)
    report.errors.push(msg)
    return report
  }
  const scopeId = privateScope.id

  // Une seule connexion à la DB privée pour tout le run (better-sqlite3 WAL).
  const dbPath = input.memoria.paths.assistantDb(input.instanceId)
  const store = new ContentStore(dbPath)
  try {
    await runFiles(input, report, store, { scopeId, maxWindows, tailQuietMs, systemPrompt, units })
  } finally {
    store.close()
  }
  return report
}

/**
 * Boucle commune fichiers + unités. `store` null : dry-run sans instance
 * (aucune lecture ni écriture de base).
 */
async function runFiles(
  input: ImportTranscriptsInput,
  report: ImportTranscriptsReport,
  store: ContentStore | null,
  opts: { scopeId: string; maxWindows: number; tailQuietMs: number; systemPrompt: string; units: TranscriptUnit[] },
): Promise<void> {
  const { scopeId, maxWindows, tailQuietMs, systemPrompt, units } = opts

  // Sans LLM : on le dit franchement et on s'arrête (aucune invention de faits).
  // Le dry-run ne sonde pas le LLM : il promet zéro appel (une sonde OpenAI
  // passe par le réseau), il compte ce qu'un vrai import enverrait.
  const llmReady = !report.dry_run && input.extraction !== null && (await safeIsAvailable(input.extraction, report))
  if (!llmReady && !report.dry_run) {
    report.notes.push('no-llm : aucun LLM d’extraction disponible — 0 fait extrait (aucune invention)')
  }

  // Dédup persistante : fait déjà présent dans le scope privé, TOUS états
  // (supersédés inclus). Par l'index facts.norm_hash : précharger le texte de
  // tous les faits lisait la table entière sur disque au début de chaque
  // import (3 s de blocage à froid sur 67 000 faits, ticket #27).
  // Rattrapage des lignes sans hash : seulement pour un VRAI import (le
  // dry-run promet « aucune écriture », et sans LLM alreadyStored n'est jamais
  // appelé). Une seule transaction : un commit par ligne coûtait 10 fois plus.
  // « AND norm_hash IS NULL » : ne jamais écraser un hash posé entre la
  // lecture et l'écriture par un autre chemin (capture, synchro).
  if (store && !report.dry_run && llmReady) {
    const unhashed = store.db
      .prepare('SELECT id, fact FROM facts WHERE scope_id = ? AND norm_hash IS NULL')
      .all(scopeId) as Array<{ id: string; fact: string }>
    if (unhashed.length > 0) {
      const setHash = store.db.prepare('UPDATE facts SET norm_hash = ? WHERE id = ? AND norm_hash IS NULL')
      store.db.transaction(() => {
        for (const row of unhashed) setHash.run(factNormHash(row.fact), row.id)
      })()
    }
  }
  const knownStmt = store?.db.prepare('SELECT 1 FROM facts WHERE scope_id = ? AND norm_hash = ? LIMIT 1')
  const alreadyStored = (factText: string): boolean =>
    knownStmt !== undefined && knownStmt.get(scopeId, factNormHash(factText)) !== undefined
  const seenInRun = new Set<string>()
  const breaker: LlmBreaker = { streak: 0, probeFailed: false, open: false, filesLeft: 0 }
  const redactor = input.redactor ?? new RegexRedactor()
  const ctx: FileContext = {
    input,
    report,
    store,
    scopeId,
    maxWindows,
    tailQuietMs,
    llmReady,
    systemPrompt,
    alreadyStored,
    seenInRun,
    breaker,
    maskPrompt: prompt => {
      const result = redactor.redact(prompt)
      return { text: result.text, secrets: result.found }
    },
  }

  const filesTotal = input.files.length + units.length
  let filesDone = 0
  const afterOne = async (): Promise<void> => {
    filesDone++
    // Rendre la main à la boucle d'événements entre deux fichiers : un lot de
    // fichiers déjà connus ne fait aucun appel réseau, donc aucun `await` réel
    // — sans ça le daemon ne sert plus aucune requête pendant tout le lot.
    await yieldToEventLoop()
    notifyProgress(input.onProgress, { filesDone, filesTotal, factsImported: report.facts_quarantined })
  }
  for (const file of input.files) {
    try {
      await importOneFile(file, ctx)
    } catch (err) {
      // Erreur INATTENDUE sur un fichier : visible, jamais avalée, on continue.
      const msg = `fichier « ${file} » : ${(err as Error).message}`
      console.warn(`[memoria] import transcripts : ${msg}`)
      report.errors.push(msg)
    }
    await afterOne()
  }
  for (const unit of units) {
    try {
      await importOneUnit(unit, ctx)
    } catch (err) {
      const msg = `conversation « ${unit.label} » (${unit.key}) : ${(err as Error).message}`
      console.warn(`[memoria] import transcripts : ${msg}`)
      report.errors.push(msg)
    }
    await afterOne()
  }
  if (breaker.open) {
    const note = `coupe-circuit : ${LLM_CIRCUIT_BREAKER_FAILURES} échecs d'affilée (LLM en panne, quota, réponses illisibles ou écriture refusée), extraction arrêtée ; ${breaker.filesLeft} fichier(s) laissé(s) intact(s), tout repart au prochain import`
    report.notes.push(note)
    console.warn(`[memoria] import transcripts : ${note}`)
  }
  // En tête des notes : le CLI n'en affiche que les premières, et le dry-run
  // sert justement à voir ce qui partirait au modèle.
  if (report.windows_with_secrets > 0) {
    report.notes.unshift(
      report.dry_run
        ? `secrets : ${report.windows_with_secrets} fenêtre(s) à envoyer contiennent un secret (clé, jeton, mot de passe) ; il sera masqué ([secret:…]) avant l'envoi au modèle`
        : `secrets : ${report.windows_with_secrets} fenêtre(s) contenaient un secret (clé, jeton, mot de passe), masqué ([secret:…]) avant l'envoi au modèle`,
    )
  }
}

interface FileContext {
  input: ImportTranscriptsInput
  report: ImportTranscriptsReport
  /** null : dry-run sans instance, rien n'est connu ni écrit. */
  store: ContentStore | null
  scopeId: string
  maxWindows: number
  tailQuietMs: number
  llmReady: boolean
  systemPrompt: string
  /** Le fait (texte normalisé) existe-t-il déjà dans le scope privé, tous états ? */
  alreadyStored: (factText: string) => boolean
  seenInRun: Set<string>
  breaker: LlmBreaker
  /** Gate dur secrets du texte envoyé au LLM (jamais de l'entrée du hash de fenêtre). */
  maskPrompt: (prompt: string) => { text: string; secrets: DetectedSecret[] }
}

/** État du LLM sur tout le run : distingue une panne d'une fenêtre indigeste. */
interface LlmBreaker {
  /** Échecs d'affilée (fenêtres et appels témoins), remis à zéro à chaque réussite. */
  streak: number
  /** Un appel témoin a déjà échoué dans la série en cours : inutile d'en refaire un. */
  probeFailed: boolean
  /** Coupe-circuit ouvert : plus aucun appel LLM dans ce run. */
  open: boolean
  /** Fichiers non traités parce que le coupe-circuit était ouvert. */
  filesLeft: number
}

/** Nombre maximal d'essais d'une fenêtre que le LLM, par ailleurs en état de marche, n'arrive pas à extraire. */
export const MAX_FILE_ATTEMPTS = 3
/**
 * Garde-fou : nombre maximal d'imports où une fenêtre échoue alors que tout
 * semble en panne. Une fenêtre qui fait tomber le LLM local à chaque fois
 * ressemble à une panne ; sans cette borne elle serait rejouée sans fin.
 */
export const MAX_OUTAGE_ATTEMPTS = 10

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

interface FileStateRow {
  size: number
  mtime_ms: number
  source_hash: string
  complete: number
  attempts: number
  windows_total: number
  failed_windows: string
}

function readFileState(store: ContentStore | null, path: string): FileStateRow | undefined {
  if (!store) return undefined
  return store.db
    .prepare(
      'SELECT size, mtime_ms, source_hash, complete, attempts, windows_total, failed_windows FROM transcript_file_state WHERE path = ?',
    )
    .get(path) as FileStateRow | undefined
}

function writeFileState(
  store: ContentStore,
  path: string,
  s: { size: number; mtimeMs: number; sourceHash: string; complete: boolean; attempts: number; windowsTotal: number; failedJson?: string },
): void {
  store.db
    .prepare(
      `INSERT INTO transcript_file_state (path, size, mtime_ms, source_hash, complete, attempts, windows_total, failed_windows, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
         source_hash = excluded.source_hash, complete = excluded.complete, attempts = excluded.attempts,
         windows_total = excluded.windows_total, failed_windows = excluded.failed_windows, updated_at = excluded.updated_at`,
    )
    .run(path, s.size, s.mtimeMs, s.sourceHash, s.complete ? 1 : 0, s.attempts, s.windowsTotal, s.failedJson ?? '[]', nowISO())
}

/**
 * Marque posée dans failed_windows quand le dernier passage a été filtré par
 * sinceDate : les tours écartés n'ont jamais été lus, donc les fenêtres déjà
 * extraites ne disent rien de ce qui les précède.
 */
const PARTIAL_PASS_MARK = 'partial-pass'

/** Compteurs d'une fenêtre en échec : [essais comptés, échecs pendant une panne]. */
type Tries = [attempts: number, outages: number]

/**
 * Ce qu'il reste à faire sur un fichier incomplet (colonne failed_windows).
 * Les fenêtres sont désignées par leur HASH : un index ne désigne plus la même
 * fenêtre dès que le découpage change (sinceDate différent, plafond).
 */
interface PendingWork {
  /** Fenêtres réellement en échec, avec leurs compteurs. */
  failed: Map<string, Tries>
  /** Fenêtres jamais envoyées au LLM (plafond, coupe-circuit, import interrompu). */
  pending: Set<string>
  /** Dernier passage filtré par sinceDate. */
  partial: boolean
  /** Index numériques écrits par la toute première version (à traduire en hash). */
  legacyIndexes: number[]
}

/**
 * Lit failed_windows, tous formats :
 *  - actuel : {"failed": {hash: [essais, pannes]}, "pending": [hash], "partial": true} ;
 *  - anciens : tableau de hash (plus la marque partial-pass) ou d'index
 *    numériques. Ces états partageaient un compteur par fichier : chaque
 *    fenêtre hérite de ce compteur.
 */
function parsePendingWork(state: FileStateRow | undefined): PendingWork {
  const work: PendingWork = { failed: new Map(), pending: new Set(), partial: false, legacyIndexes: [] }
  if (!state) return work
  let raw: unknown
  try {
    raw = JSON.parse(state.failed_windows)
  } catch {
    return work
  }
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (e === PARTIAL_PASS_MARK) work.partial = true
      else if (typeof e === 'string' && e.length > 0) work.failed.set(e, [state.attempts, 0])
      else if (Number.isInteger(e) && (e as number) >= 0) work.legacyIndexes.push(e as number)
    }
    return work
  }
  if (raw === null || typeof raw !== 'object') return work
  const o = raw as { failed?: unknown; pending?: unknown; partial?: unknown }
  if (o.failed !== null && typeof o.failed === 'object') {
    for (const [hash, tries] of Object.entries(o.failed as Record<string, unknown>)) {
      const [a, b] = Array.isArray(tries) ? (tries as unknown[]) : []
      work.failed.set(hash, [Number.isInteger(a) ? (a as number) : 0, Number.isInteger(b) ? (b as number) : 0])
    }
  }
  if (Array.isArray(o.pending)) for (const h of o.pending) if (typeof h === 'string' && h.length > 0) work.pending.add(h)
  work.partial = o.partial === true
  return work
}

function serializePendingWork(failed: Map<string, Tries>, pending: string[], partial: boolean): string {
  return JSON.stringify({ failed: Object.fromEntries(failed), pending, ...(partial ? { partial: true } : {}) })
}

/**
 * Une fenêtre vient d'échouer : est-ce une panne générale ? `probe` rejoue un
 * appel minuscule ; s'il passe, le LLM marche et c'est la fenêtre qui est en
 * cause. Sans `probe` (échec d'écriture), l'échec est tenu pour général.
 * Ouvre le coupe-circuit après LLM_CIRCUIT_BREAKER_FAILURES échecs d'affilée.
 */
type FailureKind =
  /** Le LLM marche : c'est la fenêtre. Essai compté. */
  | 'window'
  /** Panne générale, et cette fenêtre est la SEULE suspecte de l'avoir provoquée (témoin lancé après elle, en échec) ou une écriture refusée : compteur de panne. */
  | 'suspect'
  /** Panne générale déjà établie : la fenêtre n'y est pour rien, aucun compteur. */
  | 'outage'

async function classifyFailure(
  breaker: LlmBreaker,
  probe: (() => Promise<boolean>) | null,
  opts: { knownOutage?: boolean } = {},
): Promise<FailureKind> {
  breaker.streak++
  let kind: FailureKind = probe ? 'outage' : 'suspect'
  if (opts.knownOutage) {
    // Limite de débit (HTTP 429) : panne générale par nature. Pas de témoin :
    // plus petit et lancé un instant plus tard, il peut passer et faire porter
    // la faute à la fenêtre, en consommant du quota au passage.
    breaker.probeFailed = true
    kind = 'outage'
  } else if (probe && !breaker.probeFailed) {
    if (await probe()) {
      breaker.streak = 0
      return 'window'
    }
    breaker.probeFailed = true
    breaker.streak++
    kind = 'suspect'
  }
  if (breaker.streak >= LLM_CIRCUIT_BREAKER_FAILURES) breaker.open = true
  return kind
}

/**
 * Une unité de travail, fichier ou conversation, une fois son contenu en main.
 * `parse` rend les tours (null : format inconnu). `live` : un fichier qui peut
 * encore grandir (conversation en cours) ; faux pour un export, instantané figé.
 */
interface LoadedUnit {
  key: string
  label: string
  size: number
  mtimeMs: number
  sourceHash: string
  state: FileStateRow | undefined
  canRetryNow: boolean
  live: boolean
  parse: () => { format: string; turns: Turn[] } | null
  context?: string
  metadata?: Record<string, unknown>
}

/**
 * Porte d'entrée commune : coupe-circuit, raccourci « inchangé ». Rend null si
 * l'unité est écartée sans être lue, sinon si un nouvel essai est permis.
 */
function gate(
  ctx: FileContext,
  state: FileStateRow | undefined,
  unchanged: boolean,
  label: string,
): { canRetryNow: boolean } | null {
  const { report, llmReady, breaker } = ctx
  const retryable = state !== undefined && state.complete === 0 && state.attempts < MAX_FILE_ATTEMPTS
  // COUPE-CIRCUIT OUVERT : le LLM ne répond plus. Tout fichier qui aurait
  // demandé une extraction est laissé tel quel (ni lu, ni état, ni essai) :
  // il repartira au prochain import.
  if (breaker.open && !(unchanged && !retryable)) {
    breaker.filesLeft++
    return null
  }
  // Un retry exige un LLM. Le dry-run laisse passer aussi (lecture seule) :
  // il doit annoncer les fenêtres restantes qu'un vrai import enverrait.
  const canRetryNow = retryable && (llmReady || report.dry_run)
  if (unchanged && !canRetryNow) {
    report.files_skipped_already_imported++
    report.notes.push(`déjà importé (inchangé) : ${label} — re-import = 0 nouveau`)
    return null
  }
  return { canRetryNow }
}

async function importOneFile(file: string, ctx: FileContext): Promise<void> {
  const { report, store } = ctx

  let size: number
  let mtimeMs: number
  try {
    const st = statSync(file)
    size = st.size
    mtimeMs = Math.trunc(st.mtimeMs)
  } catch (err) {
    report.errors.push(`lecture impossible « ${file} » : ${(err as Error).message}`)
    console.warn(`[memoria] import transcripts : lecture impossible « ${file} » : ${(err as Error).message}`)
    return
  }

  // RACCOURCI SANS LECTURE : même taille + même date qu'au dernier passage, et
  // rien à retenter → on n'ouvre pas le fichier (un `stat` coûte ~7 µs, lire et
  // hacher 5,4 Go bloquait le daemon).
  const state = readFileState(store, file)
  const unchanged = state !== undefined && state.size === size && state.mtime_ms === mtimeMs
  const open = gate(ctx, state, unchanged, basename(file))
  if (!open) return

  let content: string
  try {
    // Lecture ASYNCHRONE : l'E/S d'un gros fichier (72 Mo) ne fige pas le thread.
    content = await readFile(file, 'utf8')
  } catch (err) {
    report.errors.push(`lecture impossible « ${file} » : ${(err as Error).message}`)
    console.warn(`[memoria] import transcripts : lecture impossible « ${file} » : ${(err as Error).message}`)
    return
  }

  await importLoaded(ctx, {
    key: file,
    label: basename(file),
    size,
    mtimeMs,
    sourceHash: sha256Hex(content),
    state,
    canRetryNow: open.canRetryNow,
    live: true,
    parse: () => {
      const firstLines = content.slice(0, 65_536).split(/\r?\n/).slice(0, 12).join('\n')
      const format: TranscriptFormat = detectTranscriptFormat(file, firstLines)
      return format === 'unknown' ? null : { format, turns: parseTranscript(format, content) }
    },
  })
}

/**
 * Conversation déjà parsée (export ChatGPT). « Inchangée » = même hash que
 * l'état enregistré : son contenu est déjà en mémoire, rien à relire.
 */
async function importOneUnit(unit: TranscriptUnit, ctx: FileContext): Promise<void> {
  const state = readFileState(ctx.store, unit.key)
  const unchanged = state !== undefined && state.source_hash === unit.sourceHash
  const open = gate(ctx, state, unchanged, unit.label)
  if (!open) return
  await importLoaded(ctx, {
    key: unit.key,
    label: unit.label,
    size: unit.size,
    mtimeMs: unit.mtimeMs,
    sourceHash: unit.sourceHash,
    state,
    canRetryNow: open.canRetryNow,
    live: false,
    parse: () => ({ format: unit.format, turns: unit.turns }),
    context: unit.context,
    metadata: unit.metadata,
  })
}

async function importLoaded(ctx: FileContext, u: LoadedUnit): Promise<void> {
  const { input, report, store, scopeId, maxWindows, tailQuietMs, llmReady, alreadyStored, seenInRun, breaker } = ctx
  const { key, label, size, mtimeMs, sourceHash, state, canRetryNow } = u

  // Retry = même contenu qu'au passage incomplet (sinon c'est un nouveau contenu).
  const isRetry = canRetryNow && state!.source_hash === sourceHash

  // IDEMPOTENCE : ce contenu exact déjà importé → SKIP (0 nouveau).
  const already = store?.db
    .prepare("SELECT id FROM memory_sources WHERE source_hash = ? AND source_type = 'transcript'")
    .get(sourceHash) as { id: string } | undefined
  if (already && !isRetry) {
    report.files_skipped_already_imported++
    report.notes.push(`déjà importé (hash) : ${label} — re-import = 0 nouveau`)
    // Mémoriser taille + date : au prochain passage, plus aucune lecture. Un état
    // « incomplet » du même contenu (retry en attente d'un LLM) est conservé.
    if (store && !report.dry_run) {
      const pending = state !== undefined && state.source_hash === sourceHash && state.complete === 0
      writeFileState(store, key, {
        size,
        mtimeMs,
        sourceHash,
        complete: !pending,
        attempts: pending ? state.attempts : 0,
        windowsTotal: pending ? state.windows_total : 0,
        failedJson: pending ? state.failed_windows : undefined,
      })
    }
    return
  }

  /** Fichier sans rien à extraire, quel que soit le LLM : on ne le relira plus. */
  const markComplete = (): void => {
    if (!store || report.dry_run) return
    writeFileState(store, key, { size, mtimeMs, sourceHash, complete: true, attempts: 0, windowsTotal: 0 })
  }

  const parsed = u.parse()
  if (!parsed) {
    report.notes.push(`format non reconnu, ignoré : ${label}`)
    markComplete()
    return
  }
  const { format } = parsed

  report.files_read++

  const allTurns = parsed.turns
  const turns = filterSince(allTurns, input.sinceDate)
  report.turns += turns.length
  if (turns.length === 0) {
    report.notes.push(`aucun tour exploitable (${format}) : ${label}`)
    // Vidé par le filtre sinceDate : on ne mémorise rien, un import avec une
    // date plus ancienne doit pouvoir le reprendre.
    if (allTurns.length === 0) markComplete()
    return
  }

  const windows = buildWindows(turns)
  const isDoneStmt = store?.db.prepare('SELECT 1 FROM transcript_window_state WHERE window_hash = ?')
  const isDone = { get: (hash: string): unknown => isDoneStmt?.get(hash) }

  // ÉTAT DE CHAQUE FENÊTRE : déjà extraite (conversation qui a grandi depuis)
  // → aucun appel LLM. Sans ça le LLM reformule les mêmes faits à chaque import
  // et la file de revue se remplit de redites que la dédup ne reconnaît pas.
  const hashes: string[] = []
  const done: boolean[] = []
  for (let i = 0; i < windows.length; i++) {
    // Un très gros fichier fait des milliers de fenêtres : on rend la main.
    if (i > 0 && i % 200 === 0) await yieldToEventLoop()
    const hash = sha256Hex(windowPrompt(windows[i]!))
    hashes.push(hash)
    done.push(isDone.get(hash) !== undefined)
  }
  const known = done.filter(Boolean).length

  // CE QUE L'ÉTAT DU FICHIER DIT « À REPRENDRE ». Un ancien index numérique
  // n'est traduit en hash que s'il désigne encore la même fenêtre : même
  // contenu et même découpage (l'ancien code indexait les `maxWindows`
  // dernières fenêtres).
  const prev = parsePendingWork(state)
  const legacyBase = Math.max(hashes.length - maxWindows, 0)
  let legacyLost = false
  if (prev.legacyIndexes.length > 0) {
    if (state!.source_hash === sourceHash && state!.windows_total === hashes.length - legacyBase) {
      for (const i of prev.legacyIndexes) {
        const h = hashes[legacyBase + i]
        if (h !== undefined) prev.failed.set(h, [state!.attempts, 0])
      }
    } else {
      legacyLost = true
    }
  }
  const toResume = (h: string): boolean => prev.failed.has(h) || prev.pending.has(h)

  // POINT DE DÉPART : la plus ancienne fenêtre déjà extraite ou notée « à
  // reprendre ». Tout ce qui la précède a été écarté exprès par le plafond lors
  // du premier import (vieux historique) : on ne le ressort pas. Après un
  // passage filtré par sinceDate, pas de repère : ce qui précède n'a jamais
  // été lu.
  // transcript_window_state est COMMUN à toute l'instance : une fenêtre
  // « déjà extraite » peut venir d'un AUTRE fichier ou d'une autre
  // conversation (même texte collé, même rappel système en fin de
  // sous-agent : mesuré sur 128 fichiers réels sur 1 736). Le repère n'a donc
  // de sens que si un passage précédent de CETTE unité a pu écarter du vieil
  // historique. Pas de repère :
  //  - pour une conversation d'export (instantané figé, rien n'est jamais
  //    écarté : le repère ne pouvait que sauter son début, puis la sceller) ;
  //  - pour un fichier jamais traité (aucun état), ou dont aucun passage n'a
  //    dépassé le plafond (windows_total ≤ maxWindows, fichier importé tout
  //    jeune compris) : rien n'a été écarté, une fenêtre connue placée avant
  //    les autres vient forcément d'ailleurs. Limite : un import ultérieur avec
  //    un plafond plus grand peut ressortir l'historique écarté, au plus la
  //    taille de ce plafond.
  const firstKnown = hashes.findIndex((h, i) => done[i] || toResume(h))
  const nothingSetAside = state === undefined || state.windows_total <= maxWindows
  let anchor = prev.partial || !u.live || nothingSetAside ? -1 : firstKnown
  // Anciens index intraduisibles (le fichier a changé depuis) : on repart comme
  // l'ancien code, des `maxWindows` dernières fenêtres, sinon une fenêtre en
  // échec placée avant les fenêtres réussies ne serait plus jamais rejouée.
  if (legacyLost) anchor = anchor === -1 ? legacyBase : Math.min(anchor, legacyBase)
  // FICHIER DÉJÀ SUIVI : il a un repère, ou son passage précédent n'a rien pu
  // écarter (il tenait sous le plafond, ou sinceDate l'avait filtré). Cas visé :
  // une conversation importée toute jeune (une fenêtre encore ouverte, dont le
  // hash change dès qu'elle grandit) qui dépasse ensuite le plafond. Ses
  // fenêtres sont nouvelles, pas du vieil historique : reportées, pas ignorées.
  // Une conversation d'export n'a pas de « vieil historique » à sacrifier : son
  // surplus est toujours reporté, jamais ignoré (le début d'une conversation
  // est souvent là où naît l'idée).
  // Un fichier jamais traité n'est pas « suivi », même si l'une de ses
  // fenêtres est connue : elle peut venir d'un autre fichier.
  const tracked =
    !u.live || (state !== undefined && (anchor !== -1 || prev.partial || state.windows_total <= maxWindows))
  let todo: number[] = []
  for (let i = Math.max(anchor, 0); i < windows.length; i++) if (!done[i]) todo.push(i)

  // CONVERSATION EN COURS : la fenêtre de queue pas encore pleine d'un fichier
  // déjà suivi change de hash à chaque tour ajouté, donc repartait au LLM à
  // chaque import (mêmes faits reformulés). On attend que le fichier soit au
  // repos. Au tout premier passage on l'extrait : rien ne dit que la
  // conversation est encore en cours, et un premier import doit rendre ses faits.
  const tail = windows.length - 1
  const tailDeferred =
    u.live &&
    state !== undefined &&
    tailQuietMs > 0 &&
    todo.at(-1) === tail &&
    isOpenWindow(windows[tail]!) &&
    Date.now() - mtimeMs < tailQuietMs
  if (tailDeferred) todo.pop()

  // GARDE-FOU appliqué aux fenêtres PAS ENCORE extraites (avant : à toutes, il
  // ne retenait alors presque que des fenêtres connues et cachait les
  // nouvelles). On garde les PLUS RÉCENTES et on LOG le reste (jamais de
  // troncature silencieuse — règle du projet) : fichier déjà suivi → reportées
  // au prochain import ; premier passage → vieux historique ignoré.
  let postponed: number[] = []
  if (todo.length > maxWindows) {
    const over = todo.slice(0, todo.length - maxWindows)
    todo = todo.slice(-maxWindows)
    let note: string
    if (tracked) {
      postponed = over
      note = `${label} : ${over.length} fenêtre(s) reportée(s) au prochain import (cap ${maxWindows})`
    } else {
      note = `${label} : ${over.length} fenêtre(s) ancienne(s) ignorée(s) (cap ${maxWindows}) — gardé les plus récentes`
    }
    report.notes.push(note)
    console.warn(`[memoria] import transcripts : ${note}`)
  }
  if (tailDeferred) {
    report.notes.push(`${label} : conversation en cours, dernière fenêtre (incomplète) différée jusqu'au repos du fichier`)
  }

  /**
   * Texte RÉELLEMENT envoyé au LLM pour une fenêtre : auteurs étiquetés puis
   * secrets masqués. Jamais l'entrée du hash (windowPrompt, texte brut).
   */
  const promptFor = (i: number): { text: string; secrets: DetectedSecret[] } => maskedLlmPrompt(windows[i]!, u.context, ctx.maskPrompt)

  // dryRun : on compte ce qu'un vrai import enverrait, on n'écrit / n'extrait rien.
  if (report.dry_run) {
    report.windows += todo.length
    report.windows_skipped_known += known
    for (const [n, i] of todo.entries()) {
      // Un très gros fichier fait des milliers de fenêtres à masquer : on rend la main.
      if (n > 0 && n % 200 === 0) await yieldToEventLoop()
      const prompt = promptFor(i)
      if (prompt.secrets.length > 0) report.windows_with_secrets++
      if (report.estimate) addWindowToEstimate(report.estimate, ctx.systemPrompt.length + prompt.text.length, ctx.systemPrompt.length)
    }
    report.notes.push(`dry-run ${label} (${format}) : ${todo.length} fenêtre(s) — AUCUNE écriture`)
    return
  }

  // Sans LLM : aucune extraction possible — fenêtres comptées, 0 fait.
  // (`store` et l'instance manquent seulement en dry-run, déjà sorti plus haut.)
  if (!llmReady || !store || input.instanceId === null) {
    report.windows += todo.length
    report.windows_skipped_known += known
    return
  }
  const instanceId = input.instanceId

  report.windows_skipped_known += known
  if (isRetry && todo.length > 0) {
    report.notes.push(`nouvel essai ${label} : ${todo.length} fenêtre(s) restant du passage précédent`)
  }

  // Provenance : 1 memory_sources par fichier (créée à la 1re écriture utile).
  // L'index est UNIQUE sur source_hash : en retry, la source existe peut-être déjà.
  let sourceId: string | null = already?.id ?? null
  const ensureSource = (): string => {
    if (sourceId) return sourceId
    sourceId = newId()
    store.db
      .prepare(
        `INSERT INTO memory_sources (id, source_type, source_path, source_hash, imported_at, metadata)
         VALUES (?, 'transcript', ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        key,
        sourceHash,
        nowISO(),
        JSON.stringify({ ...u.metadata, format, turns: turns.length, windows: windows.length }),
      )
    return sourceId
  }

  const markDone = store.db.prepare('INSERT OR IGNORE INTO transcript_window_state (window_hash, done_at) VALUES (?, ?)')
  // Passage PARTIEL (sinceDate a écarté des tours) : le fichier n'est pas
  // scellé, sinon un import sans date ou avec une date plus ancienne le
  // sauterait par le raccourci `stat` alors que ses vieux tours n'ont jamais
  // été lus.
  const partial = turns.length < allTurns.length

  // CE QUI RESTERA À FAIRE après ce passage. Deux listes séparées : une
  // fenêtre en échec garde ses compteurs ; une fenêtre seulement reportée
  // (plafond, coupe-circuit, arrêt en cours) n'en a pas et ne peut donc pas
  // être abandonnée à cause des échecs d'une autre.
  const failed = new Map<string, Tries>()
  const pending: string[] = []
  const keepForLater = (hash: string): void => {
    const tries = prev.failed.get(hash)
    if (tries) failed.set(hash, tries)
    else pending.push(hash)
  }
  const saveState = (complete: boolean): void => {
    // Colonne attempts : le plus grand nombre d'essais parmi les fenêtres
    // encore en échec (toujours sous MAX_FILE_ATTEMPTS, une fenêtre abandonnée
    // sortant de la liste). Les états d'avant, bloqués à MAX, restent écartés.
    const attempts = Math.max(0, ...[...failed.values()].map(t => t[0]))
    writeFileState(store, key, {
      size,
      mtimeMs,
      sourceHash,
      complete,
      attempts,
      windowsTotal: windows.length,
      failedJson: complete ? undefined : serializePendingWork(failed, pending, partial),
    })
  }

  // ÉTAT « INCOMPLET » ÉCRIT AVANT LA PREMIÈRE EXTRACTION : si l'import s'arrête
  // en cours de fichier (daemon tué), le passage suivant le reprend. Avant,
  // l'état n'était écrit qu'à la fin : la source déjà créée faisait passer le
  // fichier pour « déjà importé » et le reste de ses fenêtres n'était jamais
  // extrait. Aucun essai n'est compté ici : un arrêt du daemon n'est pas un
  // échec d'extraction.
  if (todo.length > 0) {
    for (const i of [...postponed, ...todo]) keepForLater(hashes[i]!)
    saveState(false)
    failed.clear()
    pending.length = 0
  }
  for (const i of postponed) keepForLater(hashes[i]!)

  /** Dédup puis mise en quarantaine des faits d'une fenêtre. Une exception d'écriture remonte. */
  const storeWindowFacts = async (facts: ExtractedFact[]): Promise<void> => {
    for (const item of facts) {
      // Chaque fait coûte plusieurs recherches plein texte (dédup privée,
      // partagée, puis storeFact) : ~0,3 s sur une grosse base. Une fenêtre de
      // 8 faits d'affilée figeait le daemon 2 s — on rend la main entre deux.
      await yieldToEventLoop()
      report.facts_extracted++
      const hash = contentHash(item.fact)
      // Dédup intra-run + persistante (existant) + near-dup (findDuplicate).
      if (seenInRun.has(hash) || alreadyStored(item.fact)) {
        report.facts_skipped_duplicates++
        continue
      }
      // + « déjà connu ailleurs » : un fait déjà partagé dans `user` (ou un
      // autre scope lisible) ne doit pas être re-mis en quarantaine chez chaque
      // agent — même règle que la capture (knownElsewhere).
      if (
        findDuplicate(store, scopeId, item.fact) ||
        input.memoria.findKnownDuplicate(instanceId, item.fact, { includePrivate: false }) !== null
      ) {
        report.facts_skipped_duplicates++
        continue
      }
      quarantineFact(ctx, store, instanceId, ensureSource(), item)
      // Noté « vu » APRÈS l'écriture : si elle jette, le fait repart au retry.
      seenInRun.add(hash)
      report.facts_quarantined++
    }
  }

  let blamedOnWindow = 0
  let blamedOnOutage = 0
  let abandoned = 0
  for (const index of todo) {
    const windowHash = hashes[index]!
    if (breaker.open) {
      keepForLater(windowHash)
      continue
    }
    report.windows++
    const prompt = promptFor(index)
    if (prompt.secrets.length > 0) {
      report.windows_with_secrets++
      vaultSecrets(ctx, prompt.secrets, label)
    }
    const failure: { message?: string } = {}
    const facts = await extractWindow(input.extraction!, ctx.systemPrompt, prompt.text, report, label, failure)
    let kind: FailureKind
    if (facts === null) {
      // Appel en échec ou réponse illisible : la fenêtre, ou le LLM en général ?
      kind = await classifyFailure(breaker, () => probeLlm(input.extraction!, ctx.systemPrompt), {
        knownOutage: /\b429\b/.test(failure.message ?? ''),
      })
    } else {
      try {
        await storeWindowFacts(facts)
        // Marquée APRÈS l'écriture de ses faits : un arrêt en cours de fenêtre la rejoue.
        markDone.run(windowHash, nowISO())
        breaker.streak = 0
        breaker.probeFailed = false
        continue
      } catch (err) {
        // ÉCRITURE REFUSÉE (base occupée, moteur fermé, fait que storeFact
        // rejette) : la fenêtre est classée en échec et on passe à la suivante.
        // Avant, l'exception sortait du fichier sans rien compter : une
        // écriture qui échoue toujours renvoyait la fenêtre au LLM à chaque
        // import, sans borne.
        const msg = `écriture des faits d'une fenêtre en échec (${label}) : ${(err as Error).message}`
        console.warn(`[memoria] import transcripts : ${msg}`)
        report.errors.push(msg)
        kind = await classifyFailure(breaker, null)
      }
    }
    const [attempts, outages] = prev.failed.get(windowHash) ?? [0, 0]
    // Seule la fenêtre SUSPECTE prend un compteur de panne : pendant une panne
    // longue, les fenêtres saines qui échouent derrière elle ne s'usent pas
    // (sinon 4 fenêtres saines étaient abandonnées par tranche de 10 imports).
    const tries: Tries =
      kind === 'window' ? [attempts + 1, outages] : kind === 'suspect' ? [attempts, outages + 1] : [attempts, outages]
    if (kind === 'window') blamedOnWindow++
    else blamedOnOutage++
    if (tries[0] >= MAX_FILE_ATTEMPTS || tries[1] >= MAX_OUTAGE_ATTEMPTS) {
      // ABANDON de CETTE fenêtre seulement : notée « traitée » pour ne plus
      // jamais repartir au LLM, même si la conversation grandit.
      markDone.run(windowHash, nowISO())
      abandoned++
    } else {
      failed.set(windowHash, tries)
    }
  }

  if (blamedOnWindow + blamedOnOutage > 0) {
    const parts: string[] = []
    if (blamedOnWindow > 0) parts.push(`${blamedOnWindow} fenêtre(s) en échec, essai compté (${MAX_FILE_ATTEMPTS} au plus par fenêtre)`)
    if (blamedOnOutage > 0) parts.push(`${blamedOnOutage} fenêtre(s) en échec pendant une panne, essai non compté`)
    report.notes.push(`${label} : ${parts.join(' ; ')}`)
  }
  if (abandoned > 0) {
    const note = `${label} : ${abandoned} fenêtre(s) toujours en échec : abandon, plus de nouvel essai`
    report.notes.push(note)
    console.warn(`[memoria] import transcripts : ${note}`)
  }

  const remaining = failed.size + pending.length
  if (remaining === 0 && !tailDeferred && !partial) {
    // Aucun fait retenu mais fichier traité : on garde quand même la provenance
    // pour l'idempotence par hash (même contenu sous un autre chemin).
    if (!sourceId) ensureSource()
    saveState(true)
    return
  }

  // FENÊTRES RESTANTES : le fichier reste « incomplet » — elles repartiront au
  // prochain import. Avant, le hash était enregistré quand même et ces
  // fenêtres n'étaient JAMAIS retentées (12,5 % d'échecs sur 24 h, sans alerte).
  saveState(false)
  if (remaining > 0) report.files_incomplete++
}

interface ExtractedFact {
  fact: string
  category: string
  confidence: number
}

/** Détail d'une erreur réseau : `fetch failed` seul ne dit rien, la cause est dans `err.cause`. */
function errorDetail(err: unknown): string {
  const e = err as Error & { cause?: unknown }
  const cause = e.cause as (Error & { code?: string }) | undefined
  if (!cause) return e.message
  const c = [cause.code, cause.message].filter(Boolean).join(' ')
  return c ? `${e.message} (cause : ${c})` : e.message
}

/**
 * 1 SEUL appel LLM par fenêtre. Échec (appel qui jette, réponse sans JSON
 * lisible) → erreur consignée, `null` (fenêtre à retenter), on continue.
 */
async function extractWindow(
  extraction: LlmProvider,
  system: string,
  prompt: string,
  report: ImportTranscriptsReport,
  label: string,
  failure?: { message?: string },
): Promise<ExtractedFact[] | null> {
  try {
    const raw = await extraction.complete({
      system,
      prompt,
      json: true,
      maxTokens: 1024,
      temperature: 0.1,
    })
    return parseFactArray(raw)
  } catch (err) {
    const msg = `extraction de fenêtre en échec (${label}) : ${errorDetail(err)}`
    console.warn(`[memoria] import transcripts : ${msg}`)
    report.errors.push(msg)
    if (failure) failure.message = errorDetail(err)
    return null
  }
}

/**
 * Appel témoin : la même extraction, sur un extrait d'un mot. Il passe si le
 * LLM répond par un JSON lisible. C'est lui qui classe un échec, plutôt que le
 * texte de l'erreur : chaque fournisseur formule les siennes à sa façon, et un
 * même HTTP 400 veut dire « fenêtre trop longue » ou « réglage refusé pour
 * tous les appels » selon le cas. Mêmes réglages que l'extraction, pour
 * échouer comme elle si la cause est générale.
 */
async function probeLlm(extraction: LlmProvider, system: string): Promise<boolean> {
  try {
    const raw = await extraction.complete({
      system,
      prompt: windowPrompt({ turns: [{ role: 'user', text: 'ok' }] }),
      json: true,
      maxTokens: 1024,
      temperature: 0.1,
    })
    parseFactArray(raw)
    return true
  } catch (err) {
    console.warn(`[memoria] import transcripts : appel témoin en échec, panne générale probable : ${errorDetail(err)}`)
    return false
  }
}

/**
 * Secrets masqués d'une fenêtre envoyée au LLM → coffre (comme la capture),
 * pour qu'un `[secret:<nom>]` repris dans un fait pointe vers sa valeur. Le
 * masquage a déjà eu lieu : un coffre qui refuse n'expose rien, la valeur
 * n'est simplement pas conservée (erreur consignée, sans la valeur).
 */
function vaultSecrets(ctx: FileContext, secrets: DetectedSecret[], label: string): void {
  const sink = ctx.input.secretSink
  if (!sink) return
  for (const secret of secrets) {
    try {
      sink(secret)
    } catch (err) {
      const msg = `secret « ${secret.name} » (${secret.kind}) masqué mais non conservé au coffre (${label}) : ${hideValue((err as Error)?.message ?? String(err), secret.value)}`
      console.warn(`[memoria] import transcripts : ${msg}`)
      ctx.report.errors.push(msg)
    }
  }
}

/** Défense : une valeur de secret ne sort jamais dans un message. */
function hideValue(message: string, value: string): string {
  return value.length > 0 ? message.split(value).join('[secret]') : message
}

/**
 * Écrit un fait extrait en QUARANTAINE : storeFact privé → dormant → ligne
 * memory_import_items 'pending'. Reproduit le mécanisme review-first de
 * memoria.storeCaptured (mais source 'transcript' + provenance fichier).
 */
function quarantineFact(ctx: FileContext, store: ContentStore, instanceId: string, sourceId: string, item: ExtractedFact): void {
  const { input, scopeId } = ctx
  const fact = input.memoria.storeFact({
    instance: instanceId,
    content: item.fact,
    category: item.category,
    confidence: item.confidence,
    source: 'transcript-import',
  })
  // Invisible au recall jusqu'à approbation.
  store.db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(fact.id)
  store.db
    .prepare(
      `INSERT INTO memory_import_items (id, source_id, target_memory_id, target_type, proposed_scope_id, status, confidence)
       VALUES (?, ?, ?, 'fact', ?, 'pending', ?)`,
    )
    .run(newId(), sourceId, fact.id, scopeId, item.confidence)
}

/** Progression tolérante : un callback qui jette est loggé, l'import continue. */
function notifyProgress(
  cb: ImportTranscriptsInput['onProgress'],
  progress: ImportTranscriptsProgress,
): void {
  if (!cb) return
  try {
    cb(progress)
  } catch (err) {
    console.warn(`[memoria] import transcripts : callback de progression en échec : ${(err as Error).message}`)
  }
}

/** isAvailable tolérant : une exception du provider = indisponible (consigné), pas un crash. */
async function safeIsAvailable(provider: LlmProvider, report: ImportTranscriptsReport): Promise<boolean> {
  try {
    return await provider.isAvailable()
  } catch (err) {
    const msg = `provider.isAvailable() a échoué : ${(err as Error).message}`
    console.warn(`[memoria] import transcripts : ${msg}`)
    report.errors.push(msg)
    return false
  }
}
