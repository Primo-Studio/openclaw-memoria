/**
 * PASSE SUR LES MESSAGES DE L'UTILISATEUR (« ses idées dans ses propres mots »).
 *
 * BRANCHEMENT
 *   `memoria.ts` n'importe jamais ce fichier. C'est l'hôte (le daemon,
 *   server.ts) qui appelle `memoria.registerUserMessagesPass(runUserMessagesPass)`.
 *   Ensuite `memoria.triage.runUserMessages(opts)` appelle
 *   `runUserMessagesPass(host, opts)` avec un `TriageHost` prêt à l'emploi :
 *   un seul tri à la fois (refus `running`), pause refusée (`paused`), pas de
 *   LLM (`no-llm`), prix inconnu chez un fournisseur cloud (`price-unknown`).
 *
 * ENTRÉES (lecture seule, jamais modifiées)
 *   - `claude-code` (défaut) : sessions PRINCIPALES, `host.roots.claudeProjectsDir`
 *     et `host.roots.archiveDir`, au niveau `<projet>/<session>.jsonl` (jamais un
 *     fichier sous `/subagents/`). Un même chemin relatif présent aux deux
 *     endroits n'est lu qu'une fois (le plus gros fichier, le vivant à égalité) ;
 *   - `codex-history` (sur demande) : `host.roots.codexHistoryFile` (prompts seuls,
 *     sans contexte), une source par `session_id` ;
 *   - `chatgpt` (sur demande) : tours `user` d'un export, dont le chemin vient de
 *     `opts.chatgptExport` (le contrat de l'hôte n'en porte pas : sans chemin, la
 *     source est sautée et c'est dit dans `errors`).
 *   Lecture en flux, ligne par ligne, avec retour à la boucle d'événements
 *   toutes les 10 ms de calcul (des sessions font 80 Mo ; ticket #27).
 *
 * CE QU'ON GARDE
 *   Seulement ce que l'humain a tapé. Attribution du parseur Claude Code
 *   (mêmes fonctions : `claudeUserSource`, `claudeQueuedHumanPrompt`) : tours
 *   `user` sans `source` (pas de notifications, résumés de compaction, rappels,
 *   sorties de commandes, messages d'autres sessions, consignes d'un agent
 *   chef), plus les messages en file d'attente (tapés pendant que l'assistant
 *   travaillait). En plus du parseur :
 *   - sessions lancées par un programme (`entrypoint` `sdk-*` : `claude -p`, SDK) ;
 *   - contenu d'autrui relayé (`<artifact-content-authored-by-others>`) ;
 *   - rappels et sorties de hooks insérés dans le message, marques d'images,
 *     contenus collés (`<pasted_content>`, longs blocs de code) retirés ;
 *     message coupé au-delà de 8 000 caractères.
 *   Contexte : les 500 derniers caractères du texte de l'assistant depuis le
 *   message humain précédent (pour comprendre un « oui », un « vas-y »).
 *
 * ORDRE, pour chaque message
 *   1. clé d'idempotence : sha256(clé de la source + `ts` + texte du parseur
 *      normalisé). La clé de la source ne dépend pas de l'endroit lu (archive ou
 *      vivant) ; le texte est celui du parseur, pas le texte nettoyé (changer
 *      les règles de nettoyage ne renvoie rien). `host.messageDone` vrai : sauté.
 *      Un message identique (même date, même texte) déjà vu dans une autre
 *      source pendant le passage est marqué `skipped` ;
 *   2. `host.isSensitive(message)` OU `host.isSensitive(contexte)` : rien ne
 *      part ; `markMessage(..., { status: 'sensitive' })` ;
 *   3. `host.redact` sur le message ET sur le contexte, juste avant l'envoi ;
 *   4. `host.complete` par lots (12 messages d'une même source au plus) ; le
 *      plafond est vérifié au pire cas AVANT l'appel (TriageBudgetError : arrêt
 *      propre, rien n'est marqué). Sortie validée à la main ;
 *   5. pour chaque fait (idée, décision, préférence, style) : re-masqué, filtre
 *      sensible (un fait sensible n'a pas de vecteur), vecteur si possible,
 *      `host.findSemanticDuplicate` (exact, ou ≥ 0,92 avec garde chiffres),
 *      sinon `host.storePendingTriaged` : fait DORMANT + ligne `fact_triage`
 *      (auteur_source `message`) sous une source `user-messages` par session ;
 *   6. `host.markMessage(..., { status: 'done', facts: n })`. Sortie illisible
 *      deux fois : `failed` (repris au passage suivant).
 *   Entre deux lots : `host.shouldStop()` non null → arrêt, `stopped`.
 *
 * AUTEUR
 *   `owner` quand l'idée est dans le message ; `ia:<agent>` (claude, codex, gpt
 *   selon la source) + `approuve_par_owner` quand elle vient du contexte et que
 *   le message l'accepte. Le LLM le dit ; le code le vérifie : la citation doit
 *   se trouver dans le message (sinon dans le contexte : idée de l'IA ;
 *   introuvable : citation vide), et le recouvrement de mots du fait avec le
 *   message et le contexte (seuils mesurés d'authorship.ts) peut retourner le
 *   verdict. Une préférence ou un style a toujours l'auteur `owner`.
 *
 * DRY-RUN
 *   Aucun appel, aucune écriture (ni `redact`, qui écrit au coffre, ni
 *   `markMessage`) : compte les messages à envoyer et rend `estimate_usd`.
 *
 * LIMITES CONNUES (contrat de l'hôte)
 *   - le plafond est celui de `runUserMessages` (TriageBudget neuf) : la dépense
 *     d'un passage du moteur n'y est pas cumulée ;
 *   - l'hôte ne prête ni le nom du modèle (`modele` reste vide) ni les fiches
 *     Person (un prénom cité reste dans `raison`, `person_id` vide) ;
 *   - `prompt_version` reste celle du moteur (`tri-v3`) : une version plus
 *     ancienne serait reclassée par `reclassify`, qui ne connaît pas la citation.
 *
 * Rend un `UserMessagesDetailReport` (un `UserMessagesReport` plus des
 * compteurs). Ne lève que sur une erreur de programmation : une panne d'API se
 * compte dans `errors` (coupe-circuit après 3 échecs d'affilée, sans marquer
 * les messages).
 */
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { LlmTruncatedError, type CompleteOptions } from '../llm/provider.js'
import { readChatGptExport, CHATGPT_KEY_PREFIX, type ChatGptConversation } from '../migration/chatgpt-export.js'
import {
  blocksToText,
  claudeQueuedHumanPrompt,
  claudeUserSource,
  isSystemNoise,
  truncateTurnText,
  type Turn,
} from '../migration/transcript-parsers.js'
import { normalizeText } from '../storage/content.js'
import { sha256Hex } from '../util.js'
import { AUTHOR_IA_MARGIN, AUTHOR_IA_MIN_SCORE, AUTHOR_OWNER_MARGIN, AUTHOR_OWNER_MIN_SCORE, contentTokens } from './authorship.js'
import { CIRCUIT_BREAKER_FAILURES, describeError, isNetworkDown, isNetworkError, isTransient, NETWORK_DOWN_RETRIES, networkDownDelay, pauseUnlessStopped } from './engine.js'
import { normalizeGenre } from './prompt.js'
import { SENSITIVE_PATTERNS, sensitiveMatch } from './sensitive.js'
import {
  PORTEES,
  RUBRIQUES,
  SOUS_TYPES,
  TriageBudgetError,
  type Auteur,
  type ConversationAtSource,
  type Genre,
  type Portee,
  type Rubrique,
  type SousType,
  type TriageHost,
  type TriageRow,
  type TriageStopReason,
  type UserMessageSourceKind,
  type UserMessagesPassOptions,
  type UserMessagesReport,
} from './types.js'

/** Version du prompt de cette passe (notée dans la source `user-messages`). */
export const USER_MESSAGES_PROMPT_VERSION = 'messages-v1'
/** Caractères de contexte : fin du texte de l'assistant qui précède. */
export const CONTEXT_CHARS = 500
/** Au-delà, le message est coupé (les longs messages dictés tiennent dessous). */
export const MESSAGE_MAX_CHARS = 8000
/** Bloc de code collé au-delà duquel il est retiré du message. */
export const PASTED_BLOCK_CHARS = 400
/** Messages par appel (une même source). */
export const DEFAULT_BATCH_MESSAGES = 12
/** Caractères (messages + contextes) par appel. */
export const BATCH_MAX_CHARS = 12_000
/** Jetons de sortie par message envoyé retenus pour le dry-run (mesuré : 50 sur 20 vrais messages ; la plupart ne donnent rien). */
export const ESTIMATE_OUTPUT_TOKENS_PER_MESSAGE = 50
/** Sortie maximale : 200 + ceci par message du lot. */
export const MAX_OUTPUT_TOKENS_PER_MESSAGE = 220
/** Pause avant la reprise d'un appel en échec passager. */
export const DEFAULT_RETRY_DELAY_MS = 5000
/** Calcul maximal entre deux retours à la boucle d'événements (ms). */
const SLICE_MS = 10
/** Au-delà, l'historique Codex n'est pas lu (il fait quelques dizaines de Ko). */
const CODEX_HISTORY_MAX_BYTES = 32 * 1024 * 1024
/** Genres tirés des messages. */
const KEPT_GENRES: readonly Genre[] = ['idee', 'decision', 'preference', 'style']
/** Lignes JSONL utiles d'une session Claude Code (les autres ne sont pas parsées). */
const RELEVANT_LINE = /"type"\s*:\s*"(?:user|assistant|attachment)"/
const TEXT_BLOCKS = new Set(['text'])

// ---------------------------------------------------------------- options et rapport

export interface UserMessagesPassOptionsExt extends UserMessagesPassOptions {
  /** Export ChatGPT (zip, dossier décompressé ou conversations.json) : requis pour la source `chatgpt`. */
  chatgptExport?: string
  /** Pause avant la reprise d'un appel en échec passager (défaut 5 000 ms). */
  retryDelayMs?: number
  /** Messages par appel (défaut 12, de 1 à 30). */
  batchSize?: number
}

export interface UserMessagesDetailReport extends UserMessagesReport {
  /** Sources trouvées (sessions Claude Code, sessions Codex, conversations ChatGPT). */
  sessions_found: number
  /** Sources sans instance d'origine (sautées). */
  sessions_no_instance: number
  sessions_unreadable: number
  /** Même chemin relatif dans l'archive et dans ~/.claude/projects : lu une fois. */
  sessions_twin: number
  /** Tours `user` écartés parce que l'humain ne les a pas écrits, par auteur réel. */
  not_human: Record<string, number>
  /** Messages en file d'attente gardés (parmi messages_seen). */
  messages_queued: number
  messages_before_since: number
  messages_empty: number
  /** Contenu d'autrui relayé (`<artifact-content-authored-by-others>`). */
  messages_third_party: number
  /** Blocs collés ou rappels retirés d'un message gardé. */
  messages_cleaned: number
  /** Messages coupés à MESSAGE_MAX_CHARS. */
  messages_truncated: number
  /** Même message (date et texte) déjà vu dans une autre source. */
  messages_repeated: number
  /** Parmi messages_sensitive : bloqués par le contexte seul. */
  messages_sensitive_context: number
  /** Motif sensible qui a bloqué (source du motif, jamais le texte). */
  sensitive_by_pattern: Record<string, number>
  messages_failed: number
  secrets_masked: number
  /** Estimation (dry-run) ou mesure. */
  llm_calls_estimate: number
  tokens_in_estimate: number
  tokens_out_estimate: number
  by_genre: Record<string, number>
  /** Faits de l'IA approuvés par le propriétaire. */
  facts_ia_approved: number
  /** Plus long blocage de la boucle d'événements pendant la passe (ms). */
  max_block_ms: number | null
}

function emptyReport(dryRun: boolean): UserMessagesDetailReport {
  return {
    sessions_read: 0,
    messages_seen: 0,
    messages_known: 0,
    messages_sensitive: 0,
    messages_sent: 0,
    facts_created: 0,
    facts_duplicate: 0,
    llm_calls: 0,
    spent_usd: 0,
    estimate_usd: dryRun ? 0 : null,
    stopped: null,
    errors: [],
    sessions_found: 0,
    sessions_no_instance: 0,
    sessions_unreadable: 0,
    sessions_twin: 0,
    not_human: {},
    messages_queued: 0,
    messages_before_since: 0,
    messages_empty: 0,
    messages_third_party: 0,
    messages_cleaned: 0,
    messages_truncated: 0,
    messages_repeated: 0,
    messages_sensitive_context: 0,
    sensitive_by_pattern: {},
    messages_failed: 0,
    secrets_masked: 0,
    llm_calls_estimate: 0,
    tokens_in_estimate: 0,
    tokens_out_estimate: 0,
    by_genre: {},
    facts_ia_approved: 0,
    max_block_ms: null,
  }
}

function bump(counts: Record<string, number>, key: string, n = 1): void {
  counts[key] = (counts[key] ?? 0) + n
}

// ---------------------------------------------------------------- boucle d'événements

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Rend la main dès que la tranche de calcul en cours dépasse `ms`. Partagé avec la passe styles. */
export function slicer(ms = SLICE_MS): () => Promise<void> {
  let start = Date.now()
  return async () => {
    if (Date.now() - start < ms) return
    await yieldToEventLoop()
    start = Date.now()
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// ---------------------------------------------------------------- messages humains

/** Un message tapé par l'humain, avec ce qui précède. */
export interface HumanMessage {
  /** Texte du parseur : il forme la clé d'idempotence (jamais le texte nettoyé). */
  raw: string
  ts: string | null
  /** Fin du texte de l'assistant depuis le message humain précédent (CONTEXT_CHARS). */
  context: string
  /** Tapé pendant que l'assistant travaillait (file d'attente). */
  queued: boolean
  /** D'où vient la date, si elle diffère de celle de la source. */
  dateSource?: ConversationAtSource
}

/** Infos d'une ligne que le `Turn` du parseur ne porte pas. */
export interface ClaudeTurnMeta {
  /** `cli`, `claude-desktop`, `sdk-cli`… */
  entrypoint: string | null
  /** Messages en file livrés avant ce tour, avec l'horodatage de leur propre ligne. */
  queuedBefore: Array<{ text: string; ts: string | null }>
  /** Idem, après le dernier tour du fichier. */
  queuedAfter: Array<{ text: string; ts: string | null }>
}

export interface ClaudeStream {
  turns: Turn[]
  meta: ClaudeTurnMeta[]
  invalidLines: number
}

/** Lignes d'un fichier, en flux (une ligne de plusieurs Mo n'est jamais lue d'un bloc avec le reste). */
async function* fileLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })
  let rest = ''
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      for (const part of parts) yield part.endsWith('\r') ? part.slice(0, -1) : part
    }
    if (rest.length > 0) yield rest.endsWith('\r') ? rest.slice(0, -1) : rest
  } finally {
    stream.destroy()
  }
}

/**
 * Session Claude Code lue EN FLUX, tour par tour, avec les mêmes règles que
 * `parseClaudeCodeTranscript` (mêmes fonctions d'attribution) : mêmes tours,
 * mêmes `source`, mêmes files d'attente. En plus : l'`entrypoint` de chaque
 * ligne et l'horodatage des messages en file. Rend la main toutes les
 * `sliceMs` de calcul.
 */
export async function streamClaudeCodeTranscript(path: string, opts: { sliceMs?: number } = {}): Promise<ClaudeStream> {
  const tick = slicer(opts.sliceMs ?? SLICE_MS)
  const turns: Turn[] = []
  const meta: ClaudeTurnMeta[] = []
  const humanTexts = new Set<string>()
  let queued: Array<{ text: string; ts: string | null }> = []
  let invalidLines = 0
  for await (const line of fileLines(path)) {
    await tick()
    if (!RELEVANT_LINE.test(line)) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      invalidLines++
      continue
    }
    if (!isRecord(obj)) continue
    const queuedPrompt = claudeQueuedHumanPrompt(obj)
    if (queuedPrompt !== null) {
      queued.push({ text: queuedPrompt, ts: str(obj['timestamp']) })
      continue
    }
    const role = obj['type'] === 'user' || obj['type'] === 'assistant' ? obj['type'] : null
    if (!role) continue
    const message = obj['message']
    if (!isRecord(message)) continue
    const text = blocksToText(message['content'], TEXT_BLOCKS)
    if (!text) continue
    const ts = str(obj['timestamp'])
    const turn: Turn = { role, text: truncateTurnText(text, 'claude-code'), ...(ts ? { ts } : {}) }
    const m: ClaudeTurnMeta = { entrypoint: str(obj['entrypoint']), queuedBefore: [], queuedAfter: [] }
    if (role === 'user') {
      const source = claudeUserSource(obj, text)
      if (source) turn.source = source
      else humanTexts.add(turn.text)
    }
    if (queued.length > 0) {
      m.queuedBefore = queued
      queued = []
    }
    turns.push(turn)
    meta.push(m)
  }
  const last = meta.at(-1)
  if (queued.length > 0 && last) last.queuedAfter = queued
  turns.forEach((turn, i) => {
    const m = meta[i]!
    m.queuedBefore = m.queuedBefore.filter(q => !humanTexts.has(q.text))
    m.queuedAfter = m.queuedAfter.filter(q => !humanTexts.has(q.text))
    if (m.queuedBefore.length > 0) turn.queuedBefore = m.queuedBefore.map(q => q.text)
    if (m.queuedAfter.length > 0) turn.queuedAfter = m.queuedAfter.map(q => q.text)
  })
  if (invalidLines > 0) console.warn(`[memoria] messages : ${invalidLines} ligne(s) JSON illisible(s) ignorée(s) dans une session`)
  return { turns, meta, invalidLines }
}

/** Session lancée par un programme (`claude -p`, SDK) : ses tours `user` ne sont pas de l'humain. */
export function isAutomatedEntrypoint(entrypoint: string | null): boolean {
  return entrypoint !== null && /^sdk/i.test(entrypoint)
}

/** Texte d'assistant gardé pour le contexte (borné). */
function appendContext(buffer: string, text: string): string {
  const joined = buffer ? `${buffer}\n${text}` : text
  return joined.length > CONTEXT_CHARS * 4 ? joined.slice(-CONTEXT_CHARS * 4) : joined
}

function tail(text: string): string {
  return text.length > CONTEXT_CHARS ? text.slice(-CONTEXT_CHARS) : text
}

/** Messages humains d'une session Claude Code lue, avec leur contexte ; `notHuman` compte les tours écartés. */
export function humanMessagesFromClaude(stream: ClaudeStream, notHuman: Record<string, number> = {}): HumanMessage[] {
  const out: HumanMessage[] = []
  let assistant = ''
  stream.turns.forEach((turn, i) => {
    const m = stream.meta[i]!
    const automated = isAutomatedEntrypoint(m.entrypoint)
    const queue = (list: ClaudeTurnMeta['queuedBefore']): void => {
      for (const q of list) {
        if (automated) bump(notHuman, 'automated')
        else out.push({ raw: q.text, ts: q.ts ?? turn.ts ?? null, context: tail(assistant), queued: true })
      }
    }
    queue(m.queuedBefore)
    if (turn.role === 'assistant') assistant = appendContext(assistant, turn.text)
    else if (turn.source) bump(notHuman, turn.source)
    else if (automated) bump(notHuman, 'automated')
    else {
      out.push({ raw: turn.text, ts: turn.ts ?? null, context: tail(assistant), queued: false })
      assistant = ''
    }
    queue(m.queuedAfter)
  })
  return out
}

/** Tours `user` d'une conversation ChatGPT, avec la fin de la réponse précédente pour contexte. */
export function chatGptHumanMessages(conv: ChatGptConversation, notHuman: Record<string, number> = {}): HumanMessage[] {
  const out: HumanMessage[] = []
  let assistant = ''
  for (const turn of conv.turns) {
    if (turn.role === 'assistant') assistant = appendContext(assistant, turn.text)
    else if (turn.source) bump(notHuman, turn.source)
    else {
      const ts = turn.ts ?? conv.createTime ?? null
      out.push({ raw: turn.text, ts, context: tail(assistant), queued: false, dateSource: turn.ts ? 'fichier' : conv.createTime ? 'metadata' : 'inconnu' })
      assistant = ''
    }
  }
  return out
}

/** Historique Codex (`history.jsonl` : `{session_id, ts, text}`), groupé par session, dans l'ordre. Même filtre que parseCodexHistory. */
export function codexHistoryMessages(content: string): Map<string, HumanMessage[]> {
  const out = new Map<string, HumanMessage[]>()
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(obj)) continue
    const text = typeof obj['text'] === 'string' ? obj['text'].trim() : ''
    if (!text || isSystemNoise(text)) continue
    let ts: string | null = null
    const rawTs = obj['ts']
    if (typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0) {
      const d = new Date(rawTs < 1e11 ? rawTs * 1000 : rawTs)
      if (!Number.isNaN(d.getTime())) ts = d.toISOString()
    }
    const session = str(obj['session_id']) ?? 'sans-session'
    const list = out.get(session) ?? []
    list.push({ raw: truncateTurnText(text, 'codex-history'), ts, context: '', queued: false })
    out.set(session, list)
  }
  return out
}

// ---------------------------------------------------------------- nettoyage

export interface CleanedMessage {
  /** null : rien à envoyer (vide, ou contenu d'autrui). */
  text: string | null
  reason: 'empty' | 'third_party' | null
  /** Blocs retirés (rappels, hooks, contenus collés, blocs de code, images). */
  removed: number
  truncated: boolean
}

/**
 * Ce qui part au LLM d'un message humain : sans les rappels ni les sorties de
 * hooks insérés, sans marque d'image, sans contenu collé, coupé à
 * MESSAGE_MAX_CHARS. Un contenu relayé d'autrui n'est jamais gardé.
 */
export function cleanHumanText(raw: string): CleanedMessage {
  if (/^\s*<artifact-content-authored-by-others\b/.test(raw)) return { text: null, reason: 'third_party', removed: 0, truncated: false }
  let removed = 0
  const strip = (text: string, re: RegExp, by: string): string =>
    text.replace(re, () => {
      removed++
      return by
    })
  let t = raw
  t = strip(t, /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, ' ')
  t = strip(t, /<user-prompt-submit-hook>[\s\S]*?(?:<\/user-prompt-submit-hook>|$)/g, ' ')
  t = strip(t, /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/g, ' [contenu collé retiré] ')
  t = strip(t, /\[Image[^\]\n]{0,80}\]/g, ' ')
  t = t.replace(/```[\s\S]*?(?:```|$)/g, block => {
    if (block.length <= PASTED_BLOCK_CHARS) return block
    removed++
    return ' [bloc collé retiré] '
  })
  t = t
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  if (!/[\p{L}\p{N}]/u.test(t)) return { text: null, reason: 'empty', removed, truncated: false }
  let truncated = false
  if (t.length > MESSAGE_MAX_CHARS) {
    t = `${t.slice(0, MESSAGE_MAX_CHARS)}…[message coupé]`
    truncated = true
  }
  return { text: t, reason: null, removed, truncated }
}

/** Clé d'idempotence d'un message : sha256(clé de source + ts + texte du parseur normalisé). */
export function messageKey(sourceKey: string, ts: string | null, raw: string): string {
  return sha256Hex(`${sourceKey}\n${ts ?? ''}\n${normalizeKeyText(raw)}`)
}

/** Texte du parseur normalisé (clé d'idempotence, empreinte des messages répétés). */
export function normalizeKeyText(text: string): string {
  return normalizeText(text).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------- sources

export interface PlannedSource {
  kind: UserMessageSourceKind
  /** Clé stable (indépendante de l'endroit lu) : idempotence et memory_sources. */
  key: string
  /** Chemin passé à resolveInstanceForSource et rangé dans memory_sources.source_path. */
  path: string | null
  /** D'où vient la date des messages. */
  dateSource: ConversationAtSource
  agent: string
  load(notHuman: Record<string, number>): Promise<HumanMessage[]>
}

export interface ClaudeSessionFile {
  /** `<projet>/<session>.jsonl`. */
  rel: string
  /** Chemin canonique sous ~/.claude/projects (celui que l'import a noté). */
  canonical: string
  /** Fichier lu. */
  file: string
  readFrom: 'fichier' | 'archive'
  size: number
  mtimeMs: number
  /** Présent aux deux endroits. */
  twin: boolean
}

/** Sessions principales (jamais un sous-agent), une par chemin relatif, de la plus ancienne à la plus récente. */
export async function listClaudeSessions(roots: { claudeProjectsDir: string; archiveDir: string }): Promise<ClaudeSessionFile[]> {
  const found = new Map<string, { live?: { file: string; size: number; mtimeMs: number }; archive?: { file: string; size: number; mtimeMs: number } }>()
  for (const [root, where] of [
    [roots.claudeProjectsDir, 'live'],
    [roots.archiveDir, 'archive'],
  ] as const) {
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.name === 'subagents') continue
      let entries
      try {
        entries = await readdir(join(root, project.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = join(root, project.name, entry.name)
        try {
          const st = await stat(file)
          const rel = `${project.name}/${entry.name}`
          const slot = found.get(rel) ?? {}
          slot[where] = { file, size: st.size, mtimeMs: st.mtimeMs }
          found.set(rel, slot)
        } catch {
          /* fichier disparu entre-temps */
        }
      }
    }
  }
  const out: ClaudeSessionFile[] = []
  for (const [rel, slot] of found) {
    const useLive = slot.live !== undefined && (slot.archive === undefined || slot.live.size >= slot.archive.size)
    const chosen = useLive ? slot.live! : slot.archive!
    out.push({
      rel,
      canonical: join(roots.claudeProjectsDir, rel),
      file: chosen.file,
      readFrom: useLive ? 'fichier' : 'archive',
      size: chosen.size,
      mtimeMs: Math.max(slot.live?.mtimeMs ?? 0, slot.archive?.mtimeMs ?? 0),
      twin: slot.live !== undefined && slot.archive !== undefined,
    })
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.rel.localeCompare(b.rel))
  return out
}

/**
 * Sources de messages demandées (défaut : sessions Claude Code), dans l'ordre
 * de lecture. Partagé avec la passe styles : `report` ne reçoit que les
 * erreurs et le nombre de sessions présentes aux deux endroits.
 */
export async function planSources(
  host: TriageHost,
  opts: Pick<UserMessagesPassOptionsExt, 'sources' | 'chatgptExport'>,
  report: { errors: string[]; sessions_twin: number },
): Promise<PlannedSource[]> {
  const kinds = new Set<UserMessageSourceKind>(opts.sources && opts.sources.length > 0 ? opts.sources : ['claude-code'])
  const out: PlannedSource[] = []
  if (kinds.has('claude-code')) {
    for (const s of await listClaudeSessions(host.roots)) {
      if (s.twin) report.sessions_twin++
      out.push({
        kind: 'claude-code',
        key: `claude-code:${s.rel}`,
        path: s.canonical,
        dateSource: s.readFrom,
        agent: 'claude',
        load: async notHuman => humanMessagesFromClaude(await streamClaudeCodeTranscript(s.file), notHuman),
      })
    }
  }
  if (kinds.has('codex-history')) {
    const file = host.roots.codexHistoryFile
    try {
      const st = await stat(file)
      if (st.size > CODEX_HISTORY_MAX_BYTES) report.errors.push(`codex-history : fichier trop gros (${st.size} octets), sauté`)
      else {
        const sessions = codexHistoryMessages(await readFile(file, 'utf8'))
        for (const [session, messages] of sessions) {
          out.push({
            kind: 'codex-history',
            key: `codex-history:${session}`,
            path: file,
            dateSource: 'fichier',
            agent: 'codex',
            load: () => Promise.resolve(messages),
          })
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') report.errors.push(`codex-history : illisible (${(err as Error).message})`)
    }
  }
  if (kinds.has('chatgpt')) {
    if (!opts.chatgptExport) report.errors.push('chatgpt : chemin de l’export absent (option chatgptExport), source sautée')
    else {
      try {
        const read = await readChatGptExport(opts.chatgptExport)
        for (const e of read.errors) report.errors.push(`chatgpt : ${e}`)
        for (const conv of read.conversations) {
          out.push({
            kind: 'chatgpt',
            key: `${CHATGPT_KEY_PREFIX}${conv.id}`,
            path: `${CHATGPT_KEY_PREFIX}${conv.id}`,
            dateSource: 'fichier',
            agent: 'gpt',
            load: notHuman => Promise.resolve(chatGptHumanMessages(conv, notHuman)),
          })
        }
      } catch (err) {
        report.errors.push(`chatgpt : ${(err as Error).message}`)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- prompt

export const USER_MESSAGES_SYSTEM_V1 = `Tu lis des messages que le propriétaire de cette mémoire a écrits LUI-MÊME à son assistant IA, pendant des conversations de travail. Ton but : ne perdre AUCUNE de ses idées, de ses décisions, de ses préférences, ni ce qui caractérise sa manière d'échanger, et ignorer tout le reste.

Chaque entrée porte :
- m : numéro du message dans le lot ;
- date : jour du message ;
- contexte : la fin de ce que l'assistant a écrit juste avant (pour comprendre un « oui », un « vas-y », un « la 2 ») ; ce n'est PAS le propriétaire qui l'a écrit ;
- message : ce que le propriétaire a tapé ou dicté (souvent sans ponctuation, avec des fautes).

À TIRER (genre) :
- "idee" : la proposition de quelque chose de NOUVEAU, pas encore fait : app, jeu, fonction notable d'un produit, offre ou service à vendre, format de contenu, outil, nom, stratégie. sous_type : "app", "business", "contenu", "outil", "amelioration" (d'un produit existant) ou "autre" ;
- "decision" : un choix tranché : option retenue, prix, abandon, marché visé, plan validé, règle d'une app ;
- "preference" : une règle ou une préférence générale sur sa manière de travailler, d'écrire, de présenter, de communiquer, valable au-delà de la tâche du jour ;
- "style" : une observation sur SA MANIÈRE D'ÉCHANGER avec l'assistant (longueur et ton des messages, dictée, façon de demander, de proposer, de valider ou de recadrer). AU PLUS UN style par lot, seulement s'il se voit nettement sur plusieurs messages.

À NE PAS TIRER :
- une demande faite à l'assistant (fais, donne-moi, écris, explique, vérifie, corrige, relance, continue), même sur un projet : ce n'est ni une idée ni une décision ;
- une question (jamais une décision), un souci, une inquiétude, un remerciement, un agacement passager ;
- un état d'avancement, un détail de code ou d'un écran.
La plupart des messages ne donnent RIEN : c'est normal.

AUTEUR (idee et decision) :
- "owner" : l'idée ou le choix est dans le message lui-même ;
- "ia_approuvee" : l'idée ou le choix vient du contexte (proposition de l'assistant) et le message l'accepte clairement (« oui », « go », « on part sur la 2 »). Sans accord clair, ne tire rien.

POUR CHAQUE ÉLÉMENT :
- m : le numéro EXACT du message d'où vient la citation ;
- texte : une phrase autonome, à la troisième personne, dans la langue du message, compréhensible sans le contexte (de quoi on parle, pour quel projet). Désigne le propriétaire par son prénom s'il est donné plus bas, sinon par « l'utilisateur » ;
- titre : pour idee et decision, 8 mots au plus, qui nomment la chose ;
- citation : un extrait EXACT et court du message (3 à 20 mots), recopié tel quel, fautes comprises ;
- personne : pour preference et style, "owner" si c'est le propriétaire, sinon le prénom tel qu'il est écrit ;
- rubriques : 0 à 3 parmi "clients", "vente", "rh", "erreurs", "outils", "savoir_entreprise", "projet", "app", "contenu", "finance", "juridique", "infra" ;
- portee : "perso" (propre à cet assistant), "user" (la personne, pour toutes ses IA) ou "entite" (partageable dans l'entreprise) ;
- importance (0 à 3) et durabilite (0 à 3) ;
- projet : le projet ou le sujet en 1 à 4 mots si on le devine ;
- entites : 0 à 3 noms propres cités.

Exemples (inventés) :
- message « et si on faisait une appli pour échanger des graines entre jardiniers du quartier » → idee, app, auteur owner, titre « Appli d'échange de graines entre voisins », texte « L'utilisateur a l'idée d'une appli pour échanger des graines entre jardiniers d'un même quartier. », citation « une appli pour échanger des graines ».
- contexte « … trois noms possibles pour la chorale : Echo, Canopée, Mistral. » ; message « canopée c'est parfait » → decision, auteur ia_approuvee, titre « Nom de la chorale : Canopée », citation « canopée c'est parfait ».
- message « reponds moi toujours en phrases courtes sans jargon » → preference, personne owner, portee user.
- message « relance les tests et dis moi » → rien.
- message « ecris moi un texte pour presenter le projet au club » → rien (une demande).
- message « tu crois que le marché est assez grand ? » → rien (une question).
- message « merci super » → rien.

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"items":[{"m":1,"genre":"idee","sous_type":"app","auteur":"owner","titre":"...","texte":"...","citation":"...","rubriques":["app"],"portee":"user","importance":2,"durabilite":2,"projet":"...","entites":["..."]}]}
Sans rien à tirer : {"items":[]}.`

/** Prompt système : la consigne neutre + le contexte local du propriétaire, s'il est réglé. */
export function buildUserMessagesSystem(owner: { display_name: string | null; context: string | null } = { display_name: null, context: null }): string {
  const bits: string[] = []
  const name = owner.display_name?.trim()
  const context = owner.context?.trim()
  if (name) bits.push(`Le propriétaire s'appelle ${name.slice(0, 80)}.`)
  if (context) bits.push(context.slice(0, 600))
  return bits.length > 0 ? `${USER_MESSAGES_SYSTEM_V1}\n\nContexte du propriétaire : ${bits.join(' ')}` : USER_MESSAGES_SYSTEM_V1
}

export interface MessagesPromptItem {
  date: string | null
  context: string
  message: string
}

/** Message utilisateur d'un lot : une ligne JSON par message, numérotées à partir de 1. */
export function renderMessagesBatch(agent: string, items: readonly MessagesPromptItem[]): string {
  return (
    `Messages du propriétaire (conversation avec l'assistant ${agent}) :\n` +
    items
      .map((it, i) =>
        JSON.stringify({ m: i + 1, ...(it.date ? { date: it.date.slice(0, 10) } : {}), ...(it.context ? { contexte: it.context } : {}), message: it.message }),
      )
      .join('\n')
  )
}

// ---------------------------------------------------------------- sortie du LLM

export interface ProposedFact {
  m: number
  genre: 'idee' | 'decision' | 'preference' | 'style'
  sous_type: SousType | null
  texte: string
  titre: string | null
  citation: string | null
  /** Ce que dit le LLM : `ia` = idée de l'IA approuvée par le propriétaire. */
  auteur: 'owner' | 'ia'
  personne: string | null
  rubriques: Rubrique[]
  portee: Portee | null
  importance: number | null
  durabilite: number | null
  projet: string | null
  entites: string[]
}

function key(value: unknown): string {
  return typeof value === 'string' ? normalizeText(value.trim()).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ') : ''
}

function level(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : null
}

export function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.replace(/\s+/g, ' ').trim()
  return t.length === 0 ? null : t.slice(0, max)
}

/**
 * Lit la réponse du LLM pour un lot de `size` messages. Sortie sans JSON
 * lisible : lève (le lot repart une fois). Une entrée au genre hors des
 * quatre retenus, sans texte ou au numéro hors du lot est écartée (comptée).
 */
export function parseMessagesOutput(raw: string, size: number): { items: ProposedFact[]; invalid: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('messages : réponse du LLM sans JSON')
    try {
      parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
      throw new Error('messages : réponse du LLM illisible')
    }
  }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['items']) ? (parsed['items'] as unknown[]) : null
  if (!list) throw new Error('messages : la réponse du LLM ne contient pas de liste « items »')
  const items: ProposedFact[] = []
  let invalid = 0
  for (const entry of list) {
    if (!isRecord(entry)) {
      invalid++
      continue
    }
    const m = typeof entry['m'] === 'number' ? entry['m'] : Number(entry['m'])
    const genre = normalizeGenre(entry['genre'])
    const texte = clip(entry['texte'], 500)
    if (!Number.isInteger(m) || m < 1 || m > size || !genre || !KEPT_GENRES.includes(genre) || !texte || texte.length < 12) {
      invalid++
      continue
    }
    const stKey = key(entry['sous_type'])
    const rubriques: Rubrique[] = []
    for (const r of Array.isArray(entry['rubriques']) ? entry['rubriques'] : []) {
      const k = key(r).replace(/ /g, '_')
      if ((RUBRIQUES as readonly string[]).includes(k) && !rubriques.includes(k as Rubrique) && rubriques.length < 3) rubriques.push(k as Rubrique)
    }
    const pKey = key(entry['portee'])
    const aKey = key(entry['auteur'])
    const entites: string[] = []
    for (const e of Array.isArray(entry['entites']) ? entry['entites'] : []) {
      const t = clip(e, 60)
      if (t && t.length >= 2 && !entites.includes(t) && entites.length < 3) entites.push(t)
    }
    const authored = genre === 'idee' || genre === 'decision'
    items.push({
      m,
      genre: genre as ProposedFact['genre'],
      sous_type: genre === 'idee' ? ((SOUS_TYPES as readonly string[]).includes(stKey) ? (stKey as SousType) : 'autre') : null,
      texte,
      titre: authored ? clip(entry['titre'], 120) : null,
      citation: clip(entry['citation'], 300),
      auteur: authored && /^(ia|ai|assistant|agent|ia approuvee|approuvee|ia approuve)$/.test(aKey) ? 'ia' : 'owner',
      personne: genre === 'preference' || genre === 'style' ? clip(entry['personne'], 60) : null,
      rubriques,
      portee: (PORTEES as readonly string[]).includes(pKey) ? (pKey as Portee) : null,
      importance: level(entry['importance']),
      durabilite: level(entry['durabilite']),
      projet: clip(entry['projet'], 60),
      entites,
    })
  }
  return { items, invalid }
}

/** Texte comparable : minuscules, sans accents, mots séparés par une espace. */
function comparable(text: string): string {
  return normalizeText(text).replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Part des mots d'une citation qui doivent se retrouver dans une même fenêtre du message. */
export const QUOTE_MIN_SCORE = 0.75

/**
 * Passage de `hay` que cite `needle`, recopié TEL QUEL depuis `hay` (fautes
 * comprises), ou null. Le LLM corrige souvent une faute en citant : une
 * fenêtre de mots du message de même longueur que la citation doit en
 * contenir au moins QUOTE_MIN_SCORE (à la casse, aux accents et à la
 * ponctuation près).
 */
export function findQuote(hay: string, needle: string | null): string | null {
  if (!needle) return null
  const q = comparable(needle).split(' ').filter(Boolean)
  if (q.length === 0 || q.join('').length < 3) return null
  // Sous-mots comparables, chacun relié au mot d'origine (« c'est » → « c », « est »).
  const spans: Array<{ start: number; end: number }> = []
  const sub: Array<{ token: string; word: number }> = []
  for (const m of hay.matchAll(/\S+/g)) {
    const parts = comparable(m[0]).split(' ').filter(Boolean)
    if (parts.length === 0) continue
    spans.push({ start: m.index, end: m.index + m[0].length })
    for (const token of parts) sub.push({ token, word: spans.length - 1 })
  }
  if (sub.length < q.length) return null
  const want = new Map<string, number>()
  for (const t of q) want.set(t, (want.get(t) ?? 0) + 1)
  let best = { score: 0, from: 0 }
  for (let from = 0; from + q.length <= sub.length; from++) {
    const left = new Map(want)
    let hits = 0
    for (let k = from; k < from + q.length; k++) {
      const n = left.get(sub[k]!.token) ?? 0
      if (n > 0) {
        hits++
        left.set(sub[k]!.token, n - 1)
      }
    }
    if (hits > best.score) best = { score: hits, from }
    if (hits === q.length) break
  }
  if (best.score / q.length < QUOTE_MIN_SCORE) return null
  const first = spans[sub[best.from]!.word]!
  const last = spans[sub[best.from + q.length - 1]!.word]!
  return hay.slice(first.start, last.end).slice(0, 300)
}

/** Vrai si `needle` se lit dans `hay` (voir findQuote). */
export function quoteIn(hay: string, needle: string | null): boolean {
  return findQuote(hay, needle) !== null
}

function overlap(fact: Set<string>, other: Set<string>): number {
  if (fact.size === 0) return 0
  let common = 0
  for (const t of fact) if (other.has(t)) common++
  return common / fact.size
}

export interface SettledAuthor {
  /** Idée (ou décision) de l'IA, approuvée par le propriétaire. */
  approved: boolean
  citation: string | null
}

/**
 * Vérifie l'auteur que dit le LLM avec le message et son contexte :
 *  - citation trouvée dans le message : recopiée telle qu'elle y est écrite ;
 *    trouvée seulement dans le contexte : c'est l'IA qui l'a écrit (approuvée),
 *    la citation devient le début du message (les mots de l'accord) ;
 *    introuvable : vide ;
 *  - idée ou décision : recouvrement des mots du fait avec le contexte
 *    (≥ 0,5 et ≥ message + 0,2 → IA) ou avec le message (≥ 0,6 et ≥ contexte
 *    + 0,3 → propriétaire), seuils mesurés d'authorship.ts ;
 *  - préférence et style : toujours le propriétaire.
 */
export function settleAuthor(item: ProposedFact, message: string, context: string): SettledAuthor {
  const quote = findQuote(message, item.citation)
  const inMessage = quote !== null
  if (item.genre !== 'idee' && item.genre !== 'decision') return { approved: false, citation: quote }
  const inContext = !inMessage && context.length > 0 && quoteIn(context, item.citation)
  let approved = item.auteur === 'ia'
  const facts = contentTokens(item.texte)
  const fromMessage = overlap(facts, contentTokens(message))
  const fromContext = context ? overlap(facts, contentTokens(context)) : 0
  if (!approved && fromContext >= AUTHOR_IA_MIN_SCORE && fromContext >= fromMessage + AUTHOR_IA_MARGIN) approved = true
  else if (approved && !inContext && fromMessage >= AUTHOR_OWNER_MIN_SCORE && fromMessage >= fromContext + AUTHOR_OWNER_MARGIN) approved = false
  if (inContext) approved = true
  // Une idée de l'IA sans contexte n'a pas de preuve : on la donne au propriétaire, qui l'a écrite.
  if (approved && context.length === 0) approved = false
  const citation = quote ?? (approved ? message.replace(/\s+/g, ' ').trim().slice(0, 160) : null)
  return { approved, citation }
}

const CATEGORY_OF: Record<ProposedFact['genre'], string> = {
  idee: 'general',
  decision: 'decision',
  preference: 'preference',
  style: 'preference',
}

/** Motif sensible qui bloque un texte (source du motif, jamais le texte), pour le rapport. */
function sensitiveLabel(text: string): string | null {
  const hit = sensitiveMatch(text)
  if (hit === null) return null
  const pattern = SENSITIVE_PATTERNS.find(re => new RegExp(re.source).test(hit))
  return pattern ? pattern.source : 'autre'
}

// ---------------------------------------------------------------- appel LLM

/**
 * Appel LLM d'une passe (messages, styles). Réseau coupé ou connexion perdue :
 * on attend son retour sans compter d'échec (l'appel compte seulement s'il a
 * pu partir) ; échec passager : une reprise. `onCall` compte chaque appel
 * parti ; `checkStop` lève pour arrêter pendant une attente. Plafond
 * (TriageBudgetError, l'appel n'est pas parti) : remonte tel quel.
 */
export async function completeWithRetries(
  host: TriageHost,
  call: CompleteOptions,
  opts: { retryDelayMs: number; onCall(): void; checkStop(): void },
): Promise<string> {
  let retried = false
  for (let outage = 0; ; ) {
    let text: string
    try {
      text = (await host.complete(call)).text
    } catch (err) {
      if (err instanceof TriageBudgetError) throw err
      if (isNetworkError(err) && outage < NETWORK_DOWN_RETRIES && !host.shouldStop()) {
        if (!isNetworkDown(err)) opts.onCall()
        await pauseUnlessStopped(networkDownDelay(opts.retryDelayMs, outage++), () => host.shouldStop() !== null)
        opts.checkStop()
        continue
      }
      opts.onCall()
      if (!retried && isTransient(err) && !host.shouldStop()) {
        retried = true
        await new Promise(resolve => setTimeout(resolve, opts.retryDelayMs))
        continue
      }
      throw err
    }
    opts.onCall()
    return text
  }
}

// ---------------------------------------------------------------- la passe

interface Pending {
  key: string
  msg: HumanMessage
  /** Texte nettoyé (avant masquage). */
  text: string
}

class StopPass extends Error {
  constructor(readonly reason: TriageStopReason) {
    super(reason)
  }
}

class Pass {
  readonly report: UserMessagesDetailReport
  private readonly dryRun: boolean
  private readonly system: string
  private readonly batchSize: number
  private readonly retryDelayMs: number
  private readonly maxMessages: number | null
  private consecutiveFailures = 0
  /** Vecteurs indisponibles (aucun fournisseur) : doublons exacts seulement. */
  private vectorsOff = false
  /** Plafond touché par un appel de vecteurs : le lot est fini, puis la passe s'arrête. */
  private budgetHit = false
  private estimateUnknown = false
  /** Empreinte (date + texte) → clé du premier message vu avec elle. */
  private readonly twins = new Map<string, string>()
  private sessionsDone = 0
  private sessionsTotal = 0

  constructor(
    private readonly host: TriageHost,
    private readonly opts: UserMessagesPassOptionsExt,
  ) {
    this.dryRun = opts.dryRun === true
    this.report = emptyReport(this.dryRun)
    this.system = buildUserMessagesSystem(host.owner)
    this.batchSize = Math.max(1, Math.min(30, Math.floor(opts.batchSize ?? DEFAULT_BATCH_MESSAGES)))
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    this.maxMessages = typeof opts.maxMessages === 'number' && opts.maxMessages > 0 ? Math.floor(opts.maxMessages) : null
  }

  private checkStop(): void {
    const reason = this.host.shouldStop()
    if (reason) throw new StopPass(reason)
    if (this.budgetHit) throw new StopPass('budget')
    if (this.maxMessages !== null && this.report.messages_sent >= this.maxMessages) throw new StopPass('max_facts')
  }

  private progress(): void {
    this.opts.onProgress?.({
      sessions_done: this.sessionsDone,
      sessions_total: this.sessionsTotal,
      messages_sent: this.report.messages_sent,
      facts_created: this.report.facts_created,
      spent_usd: this.dryRun ? 0 : this.host.spentUsd(),
    })
  }

  async run(): Promise<UserMessagesDetailReport> {
    const r = this.report
    const sources = await planSources(this.host, this.opts, r)
    r.sessions_found = sources.length
    this.sessionsTotal = sources.length
    try {
      for (const source of sources) {
        this.checkStop()
        await this.source(source)
        this.sessionsDone++
        this.progress()
        await yieldToEventLoop()
      }
    } catch (err) {
      if (!(err instanceof StopPass)) throw err
      r.stopped = err.reason
    }
    if (this.dryRun) {
      if (this.estimateUnknown) r.estimate_usd = null
      else if (r.estimate_usd !== null) r.estimate_usd = Math.round(r.estimate_usd * 10_000) / 10_000
    } else r.spent_usd = this.host.spentUsd()
    return r
  }

  private async source(source: PlannedSource): Promise<void> {
    const r = this.report
    const instance = this.host.resolveInstanceForSource({ kind: source.kind, ...(source.path ? { path: source.path } : {}) })
    if (!instance) {
      r.sessions_no_instance++
      return
    }
    let messages: HumanMessage[]
    try {
      messages = await source.load(r.not_human)
    } catch (err) {
      r.sessions_unreadable++
      r.errors.push(`${source.key} : illisible (${(err as Error).message})`)
      return
    }
    r.sessions_read++
    const tick = slicer()
    const ready: Pending[] = []
    for (const msg of messages) {
      await tick()
      if (this.opts.since && msg.ts && msg.ts < this.opts.since) {
        r.messages_before_since++
        continue
      }
      const cleaned = cleanHumanText(msg.raw)
      if (!cleaned.text) {
        if (cleaned.reason === 'third_party') r.messages_third_party++
        else r.messages_empty++
        continue
      }
      r.messages_seen++
      if (msg.queued) r.messages_queued++
      if (cleaned.removed > 0) r.messages_cleaned++
      if (cleaned.truncated) r.messages_truncated++
      const key = messageKey(source.key, msg.ts, msg.raw)
      // Même message (date et texte) déjà vu pendant ce passage : une session reprise recopie l'historique.
      const twin = sha256Hex(`${msg.ts ?? ''}\n${normalizeKeyText(msg.raw)}`)
      const firstKey = this.twins.get(twin)
      if (firstKey === undefined) this.twins.set(twin, key)
      if (this.host.messageDone(instance, key)) {
        r.messages_known++
        continue
      }
      if (firstKey !== undefined) {
        r.messages_repeated++
        if (!this.dryRun && firstKey !== key) this.host.markMessage(instance, key, { source_key: source.key, ts: msg.ts, status: 'skipped', facts: 0 })
        continue
      }
      const inMessage = this.host.isSensitive(cleaned.text)
      if (inMessage || this.host.isSensitive(msg.context)) {
        r.messages_sensitive++
        if (!inMessage) r.messages_sensitive_context++
        bump(r.sensitive_by_pattern, sensitiveLabel(inMessage ? cleaned.text : msg.context) ?? 'autre')
        if (!this.dryRun) this.host.markMessage(instance, key, { source_key: source.key, ts: msg.ts, status: 'sensitive', facts: 0 })
        continue
      }
      ready.push({ key, msg, text: cleaned.text })
    }
    // Lots : messages consécutifs d'une même source, bornés en nombre et en caractères.
    let i = 0
    while (i < ready.length) {
      this.checkStop()
      const room = this.maxMessages === null ? this.batchSize : Math.min(this.batchSize, this.maxMessages - r.messages_sent)
      const batch: Pending[] = []
      let chars = 0
      while (i < ready.length && batch.length < room) {
        const p = ready[i]!
        const size = p.text.length + p.msg.context.length
        if (batch.length > 0 && chars + size > BATCH_MAX_CHARS) break
        batch.push(p)
        chars += size
        i++
      }
      await this.batch(instance, source, batch)
      this.progress()
      await yieldToEventLoop()
    }
  }

  private async batch(instance: string, source: PlannedSource, batch: Pending[], attempt = 0): Promise<void> {
    const r = this.report
    if (this.dryRun) {
      const prompt = renderMessagesBatch(
        source.agent,
        batch.map(p => ({ date: p.msg.ts, context: p.msg.context, message: p.text })),
      )
      const inputChars = this.system.length + prompt.length
      const out = ESTIMATE_OUTPUT_TOKENS_PER_MESSAGE * batch.length
      const cost = this.host.estimateCost(inputChars, out)
      if (cost === null) this.estimateUnknown = true
      else r.estimate_usd = (r.estimate_usd ?? 0) + cost
      r.llm_calls_estimate++
      r.tokens_in_estimate += Math.ceil(inputChars / 4)
      r.tokens_out_estimate += out
      r.messages_sent += batch.length
      return
    }
    // Masquage juste avant l'envoi (la valeur d'un secret va au coffre).
    let secrets = 0
    const sent = batch.map(p => {
      const m = this.host.redact(p.text)
      const c = this.host.redact(p.msg.context)
      secrets += m.secrets + c.secrets
      return { pending: p, message: m.text, context: c.text, secrets: m.secrets }
    })
    r.secrets_masked += secrets
    const prompt = renderMessagesBatch(
      source.agent,
      sent.map(s => ({ date: s.pending.msg.ts, context: s.context, message: s.message })),
    )
    const maxTokens = Math.min(4096, 200 + MAX_OUTPUT_TOKENS_PER_MESSAGE * batch.length)
    let text: string
    try {
      text = await this.complete(prompt, maxTokens)
    } catch (err) {
      if (err instanceof StopPass) throw err
      if (err instanceof LlmTruncatedError && batch.length > 1) {
        const half = Math.ceil(batch.length / 2)
        await this.batch(instance, source, batch.slice(0, half), attempt)
        this.checkStop()
        await this.batch(instance, source, batch.slice(half), attempt)
        return
      }
      if (err instanceof LlmTruncatedError) {
        this.mark(instance, source, batch, 'failed')
        r.errors.push('messages : sortie coupée pour un message seul (repris au passage suivant)')
        return
      }
      this.consecutiveFailures++
      r.errors.push(`messages : appel en échec (${describeError(err)})`)
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_FAILURES) throw new StopPass('circuit')
      return
    }
    this.consecutiveFailures = 0
    if (attempt === 0) r.messages_sent += batch.length
    let parsed: { items: ProposedFact[]; invalid: number }
    try {
      parsed = parseMessagesOutput(text, batch.length)
    } catch (err) {
      if (attempt === 0) {
        this.checkStop()
        return this.batch(instance, source, batch, 1)
      }
      this.mark(instance, source, batch, 'failed')
      r.errors.push((err as Error).message)
      return
    }
    await this.store(instance, source, sent, parsed.items)
  }

  /** Appel LLM : plafond vérifié par l'hôte avant l'envoi ; une reprise sur un échec passager. */
  private async complete(prompt: string, maxTokens: number): Promise<string> {
    try {
      return await completeWithRetries(
        this.host,
        { system: this.system, prompt, json: true, temperature: 0, maxTokens },
        { retryDelayMs: this.retryDelayMs, onCall: () => this.report.llm_calls++, checkStop: () => this.checkStop() },
      )
    } catch (err) {
      // Plafond : l'appel n'est pas parti.
      if (err instanceof TriageBudgetError) throw new StopPass('budget')
      throw err
    }
  }

  private mark(instance: string, source: PlannedSource, batch: Pending[], status: 'done' | 'failed', facts?: Map<number, number>): void {
    batch.forEach((p, i) => {
      this.host.markMessage(instance, p.key, { source_key: source.key, ts: p.msg.ts, status, facts: facts?.get(i + 1) ?? 0 })
    })
    if (status === 'failed') this.report.messages_failed += batch.length
  }

  private async store(
    instance: string,
    source: PlannedSource,
    sent: Array<{ pending: Pending; message: string; context: string; secrets: number }>,
    items: ProposedFact[],
  ): Promise<void> {
    const r = this.report
    // Au plus un style par lot : des styles presque identiques à chaque lot noieraient l'écran.
    let styles = 0
    const kept = items.filter(it => it.genre !== 'style' || styles++ === 0)
    const facts = kept.map(item => {
      // Le LLM se trompe parfois de numéro : la citation désigne alors un autre message du lot.
      if (!quoteIn(sent[item.m - 1]!.message, item.citation)) {
        const k = sent.findIndex(x => quoteIn(x.message, item.citation))
        if (k !== -1) item.m = k + 1
      }
      const s = sent[item.m - 1]!
      const masked = this.host.redact(item.texte)
      const author = settleAuthor(item, s.message, s.context)
      return { item, s, text: masked.text, secrets: masked.secrets, sensitive: this.host.isSensitive(masked.text), author }
    })
    // Vecteurs des faits non sensibles (un fait sensible n'en a jamais).
    const vectors = new Map<number, Float32Array>()
    const toEmbed = facts.map((f, i) => ({ f, i })).filter(x => !x.f.sensitive)
    if (toEmbed.length > 0 && !this.vectorsOff) {
      try {
        const vecs = await this.host.embed(toEmbed.map(x => x.f.text))
        toEmbed.forEach((x, k) => {
          const v = vecs[k]
          if (v) vectors.set(x.i, v)
        })
      } catch (err) {
        if (err instanceof TriageBudgetError) this.budgetHit = true
        else {
          const message = (err as Error)?.message ?? String(err)
          if (/aucun fournisseur de vecteurs/.test(message)) this.vectorsOff = true
          r.errors.push(`messages : vecteurs indisponibles, doublons exacts seulement (${message})`)
        }
      }
    }
    const perMessage = new Map<number, number>()
    for (const [i, f] of facts.entries()) {
      // Chaque doublon cherché coûte 90 à 130 ms sur la plus grosse base : la main
      // est rendue entre deux faits (un lot de 6 faits figeait la boucle 0,6 s, 16/11).
      if (i > 0) await yieldToEventLoop()
      const vector = vectors.get(i)
      const dup = this.host.findSemanticDuplicate(instance, f.text, vector)
      if (dup) {
        r.facts_duplicate++
        continue
      }
      const auteur: Auteur = f.author.approved ? `ia:${source.agent}` : 'owner'
      const personne = f.item.personne
      const other = personne !== null && !/^(owner|proprietaire|le proprietaire|utilisateur|l'utilisateur)$/i.test(normalizeText(personne))
      const triage: Partial<Omit<TriageRow, 'fact_id' | 'triaged_at'>> = {
        genre: f.item.genre,
        sous_type: f.item.sous_type,
        rubriques: f.item.rubriques,
        portee: f.item.portee,
        person_id: null,
        auteur,
        auteur_source: 'message',
        approuve_par_owner: f.author.approved,
        durabilite: f.item.durabilite,
        importance: f.item.importance,
        autonome: true,
        projet: f.item.projet,
        titre: f.item.titre,
        citation: f.author.citation,
        entites: f.item.entites,
        conversation_at: f.s.pending.msg.ts,
        conversation_at_source: f.s.pending.msg.ts ? (f.s.pending.msg.dateSource ?? source.dateSource) : 'inconnu',
        origine: 'session',
        raison: other ? `personne non reliée à une fiche : ${personne}` : null,
        secret_found: f.secrets > 0 || f.s.secrets > 0,
        sensible: f.sensitive,
      }
      const res = this.host.storePendingTriaged({
        instance,
        content: f.text,
        category: CATEGORY_OF[f.item.genre],
        triage,
        source: { key: source.key, path: source.path, metadata: { kind: source.kind, prompt: USER_MESSAGES_PROMPT_VERSION } },
        ...(vector ? { vector } : {}),
      })
      if (!res.created) {
        r.facts_duplicate++
        continue
      }
      r.facts_created++
      bump(r.by_genre, f.item.genre)
      if (f.author.approved) r.facts_ia_approved++
      perMessage.set(f.item.m, (perMessage.get(f.item.m) ?? 0) + 1)
    }
    this.mark(
      instance,
      source,
      sent.map(s => s.pending),
      'done',
      perMessage,
    )
  }
}

/** La passe : voir le contrat en tête de fichier. */
export async function runUserMessagesPass(host: TriageHost, opts: UserMessagesPassOptions = {}): Promise<UserMessagesDetailReport> {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  try {
    const report = await new Pass(host, opts as UserMessagesPassOptionsExt).run()
    report.max_block_ms = Math.round(delay.max / 1e6)
    return report
  } finally {
    delay.disable()
  }
}
