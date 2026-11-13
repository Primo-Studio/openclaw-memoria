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
 *    ancienne, le reprend (les fenêtres déjà extraites restent sautées).
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
import { factNormHash, newId, nowISO, sha256Hex } from '../util.js'
import {
  detectTranscriptFormat,
  parseTranscript,
  type TranscriptFormat,
  type Turn,
} from './transcript-parsers.js'
import type { LlmProvider } from '../llm/provider.js'
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

export interface ImportTranscriptsInput {
  /** Chemins absolus des fichiers de transcript à importer. */
  files: string[]
  memoria: ImportTranscriptsMemoria
  /** assistant_instance_id cible (scope privé). */
  instanceId: string
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
  facts_extracted: number
  facts_quarantined: number
  facts_skipped_duplicates: number
  errors: string[]
  notes: string[]
  dry_run: boolean
}

/** Prompt système dédié transcripts (dérivé de EXTRACTION_SYSTEM, spec §7.2). */
const TRANSCRIPT_EXTRACTION_SYSTEM = `You extract DURABLE facts from an excerpt of a conversation between a user and a coding assistant, for a long-term memory.
Keep ONLY what lasts and can be reused: user preferences, decisions and their rationale, exact configurations, project conventions, lessons learned from mistakes, learned processes.
Extract NOTHING ephemeral: passing state of a one-off task, pleasantries, unanswered questions, narration ("I am reading the file"), detail that is true only once.
Each fact must be SELF-CONTAINED (understandable alone) and carry something concrete (name, version, command, path, decision).
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
    facts_extracted: 0,
    facts_quarantined: 0,
    facts_skipped_duplicates: 0,
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

/** Prompt utilisateur d'une fenêtre (rôles préservés pour le contexte). */
function windowPrompt(window: ConversationWindow): string {
  const lines = window.turns.map(t => `- [${t.role}] ${t.text}`)
  return `Extrait de conversation :\n${lines.join('\n')}\n\nObjet JSON {"facts": [...]} des faits durables :`
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

  const privateScope = input.memoria.registry.getScopeByName(`private:${input.instanceId}`)
  if (!privateScope) {
    const msg = `scope privé introuvable pour l'instance ${input.instanceId} (pairing non fait ?)`
    console.warn(`[memoria] import transcripts : ${msg}`)
    report.errors.push(msg)
    return report
  }
  const scopeId = privateScope.id

  // Sans LLM : on le dit franchement et on s'arrête (aucune invention de faits).
  const llmReady = input.extraction !== null && (await safeIsAvailable(input.extraction, report))
  if (!llmReady) {
    report.notes.push('no-llm : aucun LLM d’extraction disponible — 0 fait extrait (aucune invention)')
  }

  // Une seule connexion à la DB privée pour tout le run (better-sqlite3 WAL).
  const dbPath = input.memoria.paths.assistantDb(input.instanceId)
  const store = new ContentStore(dbPath)

  try {
    // Dédup persistante : fait déjà présent dans le scope privé, TOUS états
    // (supersédés inclus). Par l'index facts.norm_hash : précharger le texte de
    // tous les faits lisait la table entière sur disque au début de chaque
    // import (3 s de blocage à froid sur 67 000 faits, ticket #27).
    // Rattrapage des lignes sans hash : seulement pour un VRAI import (le
    // dry-run promet « aucune écriture », et sans LLM alreadyStored n'est jamais
    // appelé). Une seule transaction : un commit par ligne coûtait 10 fois plus.
    // « AND norm_hash IS NULL » : ne jamais écraser un hash posé entre la
    // lecture et l'écriture par un autre chemin (capture, synchro).
    if (!report.dry_run && llmReady) {
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
    const knownStmt = store.db.prepare('SELECT 1 FROM facts WHERE scope_id = ? AND norm_hash = ? LIMIT 1')
    const alreadyStored = (factText: string): boolean => knownStmt.get(scopeId, factNormHash(factText)) !== undefined
    const seenInRun = new Set<string>()
    const breaker: LlmBreaker = { streak: 0, probeFailed: false, open: false, filesLeft: 0 }

    let filesDone = 0
    for (const file of input.files) {
      try {
        await importOneFile(file, {
          input,
          report,
          store,
          scopeId,
          maxWindows,
          tailQuietMs,
          llmReady,
          alreadyStored,
          seenInRun,
          breaker,
        })
      } catch (err) {
        // Erreur INATTENDUE sur un fichier : visible, jamais avalée, on continue.
        const msg = `fichier « ${file} » : ${(err as Error).message}`
        console.warn(`[memoria] import transcripts : ${msg}`)
        report.errors.push(msg)
      }
      filesDone++
      // Rendre la main à la boucle d'événements entre deux fichiers : un lot de
      // fichiers déjà connus ne fait aucun appel réseau, donc aucun `await` réel
      // — sans ça le daemon ne sert plus aucune requête pendant tout le lot.
      await yieldToEventLoop()
      notifyProgress(input.onProgress, {
        filesDone,
        filesTotal: input.files.length,
        factsImported: report.facts_quarantined,
      })
    }
    if (breaker.open) {
      const note = `coupe-circuit : ${LLM_CIRCUIT_BREAKER_FAILURES} échecs d'affilée (LLM en panne, quota, réponses illisibles ou écriture refusée), extraction arrêtée ; ${breaker.filesLeft} fichier(s) laissé(s) intact(s), tout repart au prochain import`
      report.notes.push(note)
      console.warn(`[memoria] import transcripts : ${note}`)
    }
  } finally {
    store.close()
  }

  return report
}

interface FileContext {
  input: ImportTranscriptsInput
  report: ImportTranscriptsReport
  store: ContentStore
  scopeId: string
  maxWindows: number
  tailQuietMs: number
  llmReady: boolean
  /** Le fait (texte normalisé) existe-t-il déjà dans le scope privé, tous états ? */
  alreadyStored: (factText: string) => boolean
  seenInRun: Set<string>
  breaker: LlmBreaker
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

function readFileState(store: ContentStore, path: string): FileStateRow | undefined {
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

async function importOneFile(file: string, ctx: FileContext): Promise<void> {
  const { input, report, store, scopeId, maxWindows, tailQuietMs, llmReady, alreadyStored, seenInRun, breaker } = ctx

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
  const retryable = state !== undefined && state.complete === 0 && state.attempts < MAX_FILE_ATTEMPTS
  // COUPE-CIRCUIT OUVERT : le LLM ne répond plus. Tout fichier qui aurait
  // demandé une extraction est laissé tel quel (ni lu, ni état, ni essai) :
  // il repartira au prochain import.
  if (breaker.open && !(unchanged && !retryable)) {
    breaker.filesLeft++
    return
  }
  // Un retry exige un LLM. Le dry-run laisse passer aussi (lecture seule) :
  // il doit annoncer les fenêtres restantes qu'un vrai import enverrait.
  const canRetryNow = retryable && (llmReady || report.dry_run)
  if (unchanged && !canRetryNow) {
    report.files_skipped_already_imported++
    report.notes.push(`déjà importé (inchangé) : ${basename(file)} — re-import = 0 nouveau`)
    return
  }

  let content: string
  try {
    // Lecture ASYNCHRONE : l'E/S d'un gros fichier (72 Mo) ne fige pas le thread.
    content = await readFile(file, 'utf8')
  } catch (err) {
    report.errors.push(`lecture impossible « ${file} » : ${(err as Error).message}`)
    console.warn(`[memoria] import transcripts : lecture impossible « ${file} » : ${(err as Error).message}`)
    return
  }

  const sourceHash = sha256Hex(content)
  // Retry = même contenu qu'au passage incomplet (sinon c'est un nouveau contenu).
  const isRetry = canRetryNow && state!.source_hash === sourceHash

  // IDEMPOTENCE : ce contenu exact déjà importé → SKIP (0 nouveau).
  const already = store.db
    .prepare("SELECT id FROM memory_sources WHERE source_hash = ? AND source_type = 'transcript'")
    .get(sourceHash) as { id: string } | undefined
  if (already && !isRetry) {
    report.files_skipped_already_imported++
    report.notes.push(`déjà importé (hash) : ${basename(file)} — re-import = 0 nouveau`)
    // Mémoriser taille + date : au prochain passage, plus aucune lecture. Un état
    // « incomplet » du même contenu (retry en attente d'un LLM) est conservé.
    if (!report.dry_run) {
      const pending = state !== undefined && state.source_hash === sourceHash && state.complete === 0
      writeFileState(store, file, {
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
    if (report.dry_run) return
    writeFileState(store, file, { size, mtimeMs, sourceHash, complete: true, attempts: 0, windowsTotal: 0 })
  }

  const firstLines = content.slice(0, 65_536).split(/\r?\n/).slice(0, 12).join('\n')
  const format: TranscriptFormat = detectTranscriptFormat(file, firstLines)
  if (format === 'unknown') {
    report.notes.push(`format non reconnu, ignoré : ${basename(file)}`)
    markComplete()
    return
  }

  report.files_read++

  const allTurns = parseTranscript(format, content)
  const turns = filterSince(allTurns, input.sinceDate)
  if (turns.length === 0) {
    report.notes.push(`aucun tour exploitable (${format}) : ${basename(file)}`)
    // Vidé par le filtre sinceDate : on ne mémorise rien, un import avec une
    // date plus ancienne doit pouvoir le reprendre.
    if (allTurns.length === 0) markComplete()
    return
  }

  const windows = buildWindows(turns)
  const isDone = store.db.prepare('SELECT 1 FROM transcript_window_state WHERE window_hash = ?')

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
  let anchor = prev.partial ? -1 : hashes.findIndex((h, i) => done[i] || toResume(h))
  // Anciens index intraduisibles (le fichier a changé depuis) : on repart comme
  // l'ancien code, des `maxWindows` dernières fenêtres, sinon une fenêtre en
  // échec placée avant les fenêtres réussies ne serait plus jamais rejouée.
  if (legacyLost) anchor = anchor === -1 ? legacyBase : Math.min(anchor, legacyBase)
  // FICHIER DÉJÀ SUIVI : il a un repère, ou son passage précédent n'a rien pu
  // écarter (il tenait sous le plafond, ou sinceDate l'avait filtré). Cas visé :
  // une conversation importée toute jeune (une fenêtre encore ouverte, dont le
  // hash change dès qu'elle grandit) qui dépasse ensuite le plafond. Ses
  // fenêtres sont nouvelles, pas du vieil historique : reportées, pas ignorées.
  const tracked = anchor !== -1 || (state !== undefined && (prev.partial || state.windows_total <= maxWindows))
  let todo: number[] = []
  for (let i = Math.max(anchor, 0); i < windows.length; i++) if (!done[i]) todo.push(i)

  // CONVERSATION EN COURS : la fenêtre de queue pas encore pleine d'un fichier
  // déjà suivi change de hash à chaque tour ajouté, donc repartait au LLM à
  // chaque import (mêmes faits reformulés). On attend que le fichier soit au
  // repos. Au tout premier passage on l'extrait : rien ne dit que la
  // conversation est encore en cours, et un premier import doit rendre ses faits.
  const tail = windows.length - 1
  const tailDeferred =
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
      note = `${basename(file)} : ${over.length} fenêtre(s) reportée(s) au prochain import (cap ${maxWindows})`
    } else {
      note = `${basename(file)} : ${over.length} fenêtre(s) ancienne(s) ignorée(s) (cap ${maxWindows}) — gardé les plus récentes`
    }
    report.notes.push(note)
    console.warn(`[memoria] import transcripts : ${note}`)
  }
  if (tailDeferred) {
    report.notes.push(`${basename(file)} : conversation en cours, dernière fenêtre (incomplète) différée jusqu'au repos du fichier`)
  }

  // dryRun : on compte ce qu'un vrai import enverrait, on n'écrit / n'extrait rien.
  if (report.dry_run) {
    report.windows += todo.length
    report.windows_skipped_known += known
    report.notes.push(`dry-run ${basename(file)} (${format}) : ${todo.length} fenêtre(s) — AUCUNE écriture`)
    return
  }

  // Sans LLM : aucune extraction possible — fenêtres comptées, 0 fait.
  if (!llmReady) {
    report.windows += todo.length
    report.windows_skipped_known += known
    return
  }

  report.windows_skipped_known += known
  if (isRetry && todo.length > 0) {
    report.notes.push(`nouvel essai ${basename(file)} : ${todo.length} fenêtre(s) restant du passage précédent`)
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
        file,
        sourceHash,
        nowISO(),
        JSON.stringify({ format, turns: turns.length, windows: windows.length }),
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
    writeFileState(store, file, {
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
        input.memoria.findKnownDuplicate(input.instanceId, item.fact, { includePrivate: false }) !== null
      ) {
        report.facts_skipped_duplicates++
        continue
      }
      quarantineFact(ctx, ensureSource(), item)
      // Noté « vu » APRÈS l'écriture : si elle jette, le fait repart au retry.
      seenInRun.add(hash)
      report.facts_quarantined++
    }
  }

  let blamedOnWindow = 0
  let blamedOnOutage = 0
  let abandoned = 0
  for (const index of todo) {
    const window = windows[index]!
    const windowHash = hashes[index]!
    if (breaker.open) {
      keepForLater(windowHash)
      continue
    }
    report.windows++
    const failure: { message?: string } = {}
    const facts = await extractWindow(input.extraction!, window, report, file, failure)
    let kind: FailureKind
    if (facts === null) {
      // Appel en échec ou réponse illisible : la fenêtre, ou le LLM en général ?
      kind = await classifyFailure(breaker, () => probeLlm(input.extraction!), {
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
        const msg = `écriture des faits d'une fenêtre en échec (${basename(file)}) : ${(err as Error).message}`
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
    report.notes.push(`${basename(file)} : ${parts.join(' ; ')}`)
  }
  if (abandoned > 0) {
    const note = `${basename(file)} : ${abandoned} fenêtre(s) toujours en échec : abandon, plus de nouvel essai`
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
  window: ConversationWindow,
  report: ImportTranscriptsReport,
  file: string,
  failure?: { message?: string },
): Promise<ExtractedFact[] | null> {
  try {
    const raw = await extraction.complete({
      system: TRANSCRIPT_EXTRACTION_SYSTEM,
      prompt: windowPrompt(window),
      json: true,
      maxTokens: 1024,
      temperature: 0.1,
    })
    return parseFactArray(raw)
  } catch (err) {
    const msg = `extraction de fenêtre en échec (${basename(file)}) : ${errorDetail(err)}`
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
async function probeLlm(extraction: LlmProvider): Promise<boolean> {
  try {
    const raw = await extraction.complete({
      system: TRANSCRIPT_EXTRACTION_SYSTEM,
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
 * Écrit un fait extrait en QUARANTAINE : storeFact privé → dormant → ligne
 * memory_import_items 'pending'. Reproduit le mécanisme review-first de
 * memoria.storeCaptured (mais source 'transcript' + provenance fichier).
 */
function quarantineFact(ctx: FileContext, sourceId: string, item: ExtractedFact): void {
  const { input, store, scopeId } = ctx
  const fact = input.memoria.storeFact({
    instance: input.instanceId,
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
