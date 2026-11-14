/**
 * Parsers de transcripts d'agents → tours de conversation normalisés (spec §7.2).
 *
 * Quatre formats RÉELS supportés (vérifiés sur disque) :
 *  - Claude Code   : ~/.claude/projects/<slug>/<uuid>.jsonl (une ligne JSON/événement) ;
 *  - Codex rollout : ~/.codex/sessions/.../rollout-*.jsonl + archived_sessions/ ;
 *  - Codex history : ~/.codex/history.jsonl (prompts user seuls) ;
 *  - Markdown      : fichier .md découpé en sections de titre `##`.
 * L'export ChatGPT (un tableau JSON de conversations en arbre) a son propre
 * lecteur : chatgpt-export.ts.
 *
 * Robustesse (règle du projet « aucun mort silencieux ») :
 *  - une ligne JSON invalide est IGNORÉE (jamais de throw qui ferait perdre tout
 *    le fichier) — mais signalée via console.warn pour rester visible ;
 *  - les blocs/tours vides sont filtrés ;
 *  - le texte d'un tour est tronqué à MAX_TURN_CHARS (borne le coût LLM) ;
 *  - AUCUN catch muet : toute erreur inattendue passe par console.warn.
 */

/**
 * Auteur réel d'un tour `user` qui n'a PAS été écrit par l'humain (Claude
 * Code). Mesuré sur de vraies sessions : la plupart des caractères « user »
 * sont des notifications de tâches, des résumés de compaction écrits par
 * l'assistant, du contenu injecté (compétences, rappels, sorties de commande),
 * des messages d'autres sessions ou, dans un sous-agent, la consigne de l'agent
 * qui l'a lancé. Sans cette étiquette, le LLM d'extraction prête à
 * l'utilisateur les idées de l'assistant.
 *
 * NE SERT QU'AU TEXTE ENVOYÉ AU LLM. `role` et `text` restent exactement ceux
 * d'avant : ils forment le hash des fenêtres (transcript_window_state), et le
 * changer renverrait au LLM toutes les fenêtres déjà extraites.
 */
export type TurnSource =
  /** `<task-notification>` : fin d'une tâche de fond, résultat d'un sous-agent. */
  | 'notification'
  /** Résumé de compaction (« This session is being continued… »), écrit par l'assistant. */
  | 'summary'
  /** Contenu injecté : isMeta, `<system-reminder>`, compétence chargée, image, limite d'usage, interruption. */
  | 'system'
  /** Commande locale ou sa sortie (`<command-name>`, `<local-command-stdout>`, `<bash-input>`…). */
  | 'command'
  /** Message relayé d'une autre session d'agent. */
  | 'peer'
  /** Invite d'une tâche programmée, rejouée automatiquement. */
  | 'scheduled'
  /** Dans un sous-agent : consigne de l'agent qui l'a lancé (elle peut relayer l'utilisateur). */
  | 'orchestrator'

/** Tour de conversation normalisé — la sortie commune de tous les parsers. */
export interface Turn {
  role: 'user' | 'assistant'
  text: string
  /** Timestamp ISO si la source en porte un (sert au filtre sinceDate). */
  ts?: string
  /** Auteur réel d'un tour `user` qui n'est pas l'humain. Absent : l'humain (ou l'assistant). Hors hash de fenêtre. */
  source?: TurnSource
  /**
   * Messages que l'utilisateur a tapés pendant que l'assistant travaillait
   * (file d'attente de Claude Code), livrés juste avant ce tour. Ils ne sont
   * pas des tours : en ajouter déplacerait les frontières des fenêtres, donc
   * leurs hash. Hors hash de fenêtre.
   */
  queuedBefore?: string[]
  /** Idem, livrés après le dernier tour du fichier (aucun tour ne les suit encore). */
  queuedAfter?: string[]
}

export type TranscriptFormat = 'claude-code' | 'codex-rollout' | 'codex-history' | 'markdown' | 'unknown'

/** Plafond de caractères par tour — borne le coût d'extraction (jamais silencieux : on log la troncature). */
const MAX_TURN_CHARS = 20_000

/** Texte tronqué à MAX_TURN_CHARS, avec marqueur visible (pas de coupe muette). */
function truncate(text: string, where: string): string {
  if (text.length <= MAX_TURN_CHARS) return text
  console.warn(`[memoria] transcript : tour tronqué (${text.length} → ${MAX_TURN_CHARS} chars) [${where}]`)
  return `${text.slice(0, MAX_TURN_CHARS)}…[tronqué]`
}

/** Même plafond pour les parsers hors de ce fichier (export ChatGPT). */
export const truncateTurnText = truncate

/** Découpe un contenu JSONL en lignes non vides (CRLF/LF tolérés). */
function jsonlLines(content: string): string[] {
  return content.split(/\r?\n/).filter(line => line.trim().length > 0)
}

/** Parse JSON tolérant : null si invalide + warn (jamais de throw qui perdrait le fichier entier). */
function safeParseLine(line: string, where: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    const excerpt = line.length > 80 ? `${line.slice(0, 80)}…` : line
    console.warn(`[memoria] transcript ${where} : ligne JSON invalide ignorée — « ${excerpt} »`)
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRole(value: unknown): 'user' | 'assistant' | null {
  return value === 'user' || value === 'assistant' ? value : null
}

/** Concatène un `content` qui peut être une string ou un tableau de blocs. Filtre le bruit (tool_use/thinking/env). */
function blocksToText(content: unknown, textTypes: ReadonlySet<string>): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const type = typeof block['type'] === 'string' ? (block['type'] as string) : ''
    if (!textTypes.has(type)) continue // ignore tool_use / tool_result / thinking / image…
    const text = block['text']
    if (typeof text === 'string' && text.trim().length > 0) parts.push(text.trim())
  }
  return parts.join('\n').trim()
}

/** Bruit système Codex à ne jamais extraire (contexte injecté, pas de l'utilisateur). */
function isSystemNoise(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('<environment_context>') || t.startsWith('<user_instructions>') || t.startsWith('<user_info>')
}

// ---------------------------------------------------------------------------
// 1. Claude Code — ~/.claude/projects/<slug>/<uuid>.jsonl
// ---------------------------------------------------------------------------

const CLAUDE_TEXT_BLOCKS = new Set(['text'])

/** Balises des commandes locales et de leur sortie (tapées par l'humain, mais pas un message). */
const CLAUDE_COMMAND_TAGS = /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/

/**
 * Auteur réel d'un tour `user` de Claude Code, undefined si c'est l'humain.
 * Champs d'abord (versions récentes : isCompactSummary, isMeta, origin.kind,
 * turnOrigin, isSidechain), puis le début du texte pour les lignes plus
 * anciennes, qui n'ont pas ces champs.
 */
function claudeUserSource(obj: Record<string, unknown>, text: string): TurnSource | undefined {
  const origin = isRecord(obj['origin']) ? obj['origin']['kind'] : undefined
  const turnOrigin = obj['turnOrigin']
  if (obj['isCompactSummary'] === true || text.startsWith('This session is being continued from a previous conversation')) {
    return 'summary'
  }
  if (origin === 'task-notification' || turnOrigin === 'task_notification' || text.startsWith('<task-notification>')) {
    return 'notification'
  }
  if (origin === 'peer' || turnOrigin === 'peer' || text.startsWith('Another Claude session sent a message')) return 'peer'
  if (turnOrigin === 'scheduled' || typeof obj['scheduledTaskId'] === 'string') return 'scheduled'
  if (origin === 'coordinator') return 'orchestrator'
  if (obj['isMeta'] === true || origin === 'auto-continuation' || turnOrigin === 'auto_continuation') return 'system'
  if (CLAUDE_COMMAND_TAGS.test(text)) return 'command'
  if (/^<(?:system-reminder|local-command-caveat)>/.test(text) || text.startsWith('[Request interrupted by user')) return 'system'
  // Sous-agent (fichier « sidechain ») : l'humain n'y écrit jamais, ses tours
  // `user` viennent de l'agent qui l'a lancé.
  if (obj['isSidechain'] === true && origin !== 'human') return 'orchestrator'
  return undefined
}

/**
 * Message tapé par l'humain pendant que l'assistant travaillait. Claude Code le
 * livre au milieu du tour en cours sous forme de pièce jointe `queued_command`,
 * jamais comme un tour `user` : sans ça il était perdu. Les autres entrées de
 * la file (notifications de tâches, messages d'autres sessions) sont écartées.
 */
function claudeQueuedHumanPrompt(obj: Record<string, unknown>): string | null {
  if (obj['type'] !== 'attachment' || obj['isSidechain'] === true) return null
  const a = obj['attachment']
  if (!isRecord(a) || a['type'] !== 'queued_command' || a['commandMode'] !== 'prompt' || a['isMeta'] === true) return null
  const origin = isRecord(a['origin']) ? a['origin']['kind'] : undefined
  if (origin !== undefined && origin !== 'human') return null
  const text = blocksToText(a['prompt'], CLAUDE_TEXT_BLOCKS)
  if (!text || claudeUserSource({}, text) !== undefined) return null
  return truncate(text, 'claude-code')
}

export function parseClaudeCodeTranscript(content: string): Turn[] {
  const turns: Turn[] = []
  /** Textes des tours écrits par l'humain : un message en file déjà présent comme tour n'est pas doublé. */
  const humanTexts = new Set<string>()
  /** Messages en file vus depuis le dernier tour : rattachés au tour suivant. */
  let queued: string[] = []
  for (const line of jsonlLines(content)) {
    const obj = safeParseLine(line, 'claude-code')
    if (!isRecord(obj)) continue
    const queuedPrompt = claudeQueuedHumanPrompt(obj)
    if (queuedPrompt !== null) {
      queued.push(queuedPrompt)
      continue
    }
    const role = asRole(obj['type'])
    if (!role) continue // summary / system / file-history-snapshot…
    const message = obj['message']
    if (!isRecord(message)) continue
    const text = blocksToText(message['content'], CLAUDE_TEXT_BLOCKS)
    if (!text) continue
    const ts = typeof obj['timestamp'] === 'string' ? (obj['timestamp'] as string) : undefined
    const turn: Turn = { role, text: truncate(text, 'claude-code'), ...(ts ? { ts } : {}) }
    if (role === 'user') {
      const source = claudeUserSource(obj, text)
      if (source) turn.source = source
      else humanTexts.add(turn.text)
    }
    if (queued.length > 0) {
      turn.queuedBefore = queued
      queued = []
    }
    turns.push(turn)
  }
  const last = turns.at(-1)
  if (queued.length > 0 && last) last.queuedAfter = queued
  for (const turn of turns) {
    for (const key of ['queuedBefore', 'queuedAfter'] as const) {
      const kept = turn[key]?.filter(q => !humanTexts.has(q))
      if (kept && kept.length > 0) turn[key] = kept
      else delete turn[key]
    }
  }
  return turns
}

// ---------------------------------------------------------------------------
// 2. Codex rollout — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl + archived
// ---------------------------------------------------------------------------

const CODEX_TEXT_BLOCKS = new Set(['input_text', 'output_text', 'text'])

export function parseCodexRollout(content: string): Turn[] {
  const turns: Turn[] = []
  for (const line of jsonlLines(content)) {
    const obj = safeParseLine(line, 'codex-rollout')
    if (!isRecord(obj)) continue
    if (obj['type'] !== 'response_item') continue
    const payload = obj['payload']
    if (!isRecord(payload)) continue
    if (payload['type'] !== 'message') continue
    const role = asRole(payload['role'])
    if (!role) continue
    const text = blocksToText(payload['content'], CODEX_TEXT_BLOCKS)
    if (!text || isSystemNoise(text)) continue
    const ts = typeof obj['timestamp'] === 'string' ? (obj['timestamp'] as string) : undefined
    turns.push({ role, text: truncate(text, 'codex-rollout'), ...(ts ? { ts } : {}) })
  }
  return turns
}

// ---------------------------------------------------------------------------
// 3. Codex history — ~/.codex/history.jsonl (prompts user seuls)
// ---------------------------------------------------------------------------

export function parseCodexHistory(content: string): Turn[] {
  const turns: Turn[] = []
  for (const line of jsonlLines(content)) {
    const obj = safeParseLine(line, 'codex-history')
    if (!isRecord(obj)) continue
    const text = typeof obj['text'] === 'string' ? (obj['text'] as string).trim() : ''
    if (!text || isSystemNoise(text)) continue
    // ts en epoch SECONDES → ISO (history.jsonl ne porte pas de millisecondes).
    let ts: string | undefined
    const rawTs = obj['ts']
    if (typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0) {
      const ms = rawTs < 1e11 ? rawTs * 1000 : rawTs
      const d = new Date(ms)
      if (!Number.isNaN(d.getTime())) ts = d.toISOString()
    }
    turns.push({ role: 'user', text: truncate(text, 'codex-history'), ...(ts ? { ts } : {}) })
  }
  return turns
}

// ---------------------------------------------------------------------------
// 4. Markdown générique — sections par titre `##` (role user par défaut)
// ---------------------------------------------------------------------------

export function parseMarkdown(content: string): Turn[] {
  const turns: Turn[] = []
  const lines = content.split(/\r?\n/)
  let buffer: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (text.length > 0) turns.push({ role: 'user', text: truncate(text, 'markdown') })
  }

  for (const line of lines) {
    // Un titre de niveau 2+ (## …) ouvre une nouvelle section : on clôt la précédente.
    if (/^#{2,6}\s+\S/.test(line)) {
      flush()
      buffer.push(line)
    } else {
      buffer.push(line)
    }
  }
  flush()
  return turns
}

// ---------------------------------------------------------------------------
// Détection de format
// ---------------------------------------------------------------------------

/**
 * Devine le format à partir du chemin ET des premières lignes (les deux pèsent).
 * `firstLines` = quelques lignes du début du fichier (l'appelant lit un échantillon).
 * Renvoie 'unknown' si rien ne correspond — l'importeur SKIP alors le fichier
 * proprement (jamais de parse à l'aveugle qui inventerait des tours).
 */
export function detectTranscriptFormat(path: string, firstLines: string): TranscriptFormat {
  const lower = path.toLowerCase()

  // 1) Indices forts par chemin (les plus fiables).
  if (lower.includes('.codex') && lower.endsWith('history.jsonl')) return 'codex-history'
  if (/rollout-.*\.jsonl$/.test(lower) || lower.includes('/.codex/sessions/') || lower.includes('/archived_sessions/')) {
    return 'codex-rollout'
  }
  if (lower.includes('/.claude/projects/') && lower.endsWith('.jsonl')) return 'claude-code'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'

  // 2) Indices par contenu (extension ambiguë comme un .jsonl hors arborescence connue).
  const sample = jsonlLines(firstLines)
  for (const line of sample) {
    const obj = safeParseLine(line, 'detect')
    if (!isRecord(obj)) continue
    // Codex history : {session_id, ts, text}
    if ('session_id' in obj && 'text' in obj && 'ts' in obj && !('type' in obj)) return 'codex-history'
    // Codex rollout : {timestamp, type:'response_item', payload}
    if (obj['type'] === 'response_item' && isRecord(obj['payload'])) return 'codex-rollout'
    if ('timestamp' in obj && 'payload' in obj) return 'codex-rollout'
    // Claude Code : {type:'user'|'assistant', message:{...}}
    if (asRole(obj['type']) && isRecord(obj['message'])) return 'claude-code'
    // Claude Code variantes (summary/system) avec un uuid + sessionId
    if ('sessionId' in obj && 'uuid' in obj) return 'claude-code'
  }

  // 3) Markdown si le début ressemble à du markdown (titres) et pas à du JSON.
  if (firstLines.trimStart().startsWith('#') || /^\s*#{1,6}\s+\S/m.test(firstLines)) return 'markdown'

  return 'unknown'
}

/** Dispatch chemin/format → parser adapté. 'unknown' → tableau vide (jamais de throw). */
export function parseTranscript(format: TranscriptFormat, content: string): Turn[] {
  switch (format) {
    case 'claude-code':
      return parseClaudeCodeTranscript(content)
    case 'codex-rollout':
      return parseCodexRollout(content)
    case 'codex-history':
      return parseCodexHistory(content)
    case 'markdown':
      return parseMarkdown(content)
    case 'unknown':
      return []
  }
}
