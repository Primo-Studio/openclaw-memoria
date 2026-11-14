/**
 * Lecture de l'export ChatGPT (Réglages → Contrôle des données → Exporter,
 * archive .zip reçue par mail) vers des conversations normalisées, puis des
 * unités pour l'importeur de transcripts.
 *
 * FORMAT : la page d'aide officielle d'OpenAI n'était pas lisible
 * automatiquement ; ce qui suit vient d'outils tiers et de sources
 * communautaires récents (modèles de données publiés, notes de version
 * d'outils d'import). À confirmer sur un vrai export, d'où le dry-run :
 * certains détails (transcriptions vocales, canal « analysis »,
 * is_user_system_message, marqueurs de citation, variante « conversations_000 »)
 * sont tolérés par prudence sans source qui les confirme.
 *  - conversations.json : TABLEAU de conversations ; depuis 2026, les gros
 *    exports le découpent en conversations-000.json, conversations-001.json…
 *    (même structure, chaque fichier est un tableau) ;
 *  - conversation : title, create_time, update_time (secondes epoch,
 *    décimales), id ou conversation_id, current_node, mapping, gizmo_id… ;
 *  - mapping : { id: { id, message, parent, children } } — un ARBRE : modifier
 *    un message ou régénérer une réponse crée une branche. La branche affichée
 *    est celle qui remonte de current_node jusqu'à la racine ;
 *  - message : author.role (system, user, assistant, tool), content
 *    (content_type text, multimodal_text, code, execution_output,
 *    tether_quote, thoughts, reasoning_recap, user_editable_context…, avec
 *    parts : chaînes ou objets image/audio), create_time, recipient (« all »
 *    ou un outil), channel, weight, metadata.is_visually_hidden_from_conversation.
 *
 * ON GARDE : les tours user et assistant VISIBLES, en texte (parts chaînes,
 * transcriptions du mode vocal), de la branche affichée seulement, avec leur
 * date. ON ÉCARTE : système, outils, appels d'outils (recipient ≠ all),
 * pensées et résumés de raisonnement, canaux « commentary » et « analysis »,
 * contexte caché (instructions personnalisées, mémoire), images. Chaque filtre
 * a sa propre raison dans les statistiques (hidden, user_system, weight0,
 * commentary, analysis…) : le dry-run dit lequel agit.
 *
 * MARQUEURS À CARACTÈRES PRIVÉS (U+E200 début, U+E202 séparateur, U+E201 fin),
 * non confirmés sur un vrai export : « cite » et « filecite » (sources) sont
 * retirés ; « entity » garde son libellé lisible, supposé être le 2e élément
 * du tableau JSON (["type","libellé",…]), sinon le texte intérieur entier,
 * jamais perdu ; un marqueur inconnu est laissé tel quel.
 *
 * TOLÉRANCE : un champ absent ou d'un autre type ne casse rien ; une
 * conversation illisible est comptée et sautée ; un fichier qui n'est pas un
 * tableau est signalé, les autres continuent. Lecture EN FLUX, octet par
 * octet : un conversations.json de plusieurs centaines de Mo ne tient jamais
 * en entier en mémoire, et le daemon ne se fige que le temps de parser UNE
 * conversation (voir la limite notée dans readChatGptExport).
 */
import { createReadStream, rmSync } from 'node:fs'
import { lstat, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sha256Hex } from '../util.js'
import { truncateTurnText, type Turn } from './transcript-parsers.js'
import type { TranscriptUnit } from './import-transcripts.js'
import { extractZipEntries, looksLikeZip } from './zip-extract.js'

/** Format consigné dans la provenance (memory_sources.metadata.format). */
export const CHATGPT_FORMAT = 'chatgpt'

/**
 * Prompt système d'extraction pour les conversations ChatGPT. Différent de
 * celui des agents de code : ChatGPT sert surtout à réfléchir, chercher des
 * idées, décider. La mémoire porte sur l'UTILISATEUR, pas sur le savoir
 * général que l'assistant déroule.
 */
export const CHATGPT_EXTRACTION_SYSTEM = `You extract DURABLE facts from an excerpt of a conversation between a user and ChatGPT, a general-purpose AI assistant, for the user's long-term memory.
The memory is about the USER: what they want, decide, build, know and prefer. Take facts from what the user says, asks for, decides or validates. What the assistant says counts when the user adopts it, when it records something specific to the user's situation (an exact configuration, a plan the user follows), or when it is a concrete idea worth keeping for the user's projects.
For every idea or decision, say who it comes from: the user ("The user decided…", "The user's idea…") or the assistant ("ChatGPT proposed…"). Never attribute to the user what the assistant proposed.
Keep ONLY what lasts and can be reused:
- the user's ideas (app, business, product, content, tool or service ideas), with what makes each one concrete (target, problem, name, angle);
- decisions and their rationale;
- preferences, habits and working style;
- stable facts about the user's projects, company, clients, tools and life context;
- processes the user follows, lessons learned from mistakes;
- exact configurations worth keeping.
Extract NOTHING from one-off questions, general knowledge, translations, generic explanations, generic advice, or pleasantries.
Each fact must be SELF-CONTAINED (understandable alone) and carry something concrete (a name, a figure, a date, a decision).
When the excerpt is dated, put the month and year in facts about ideas and decisions.
Write every fact in the SAME LANGUAGE as the conversation. Never translate it.
Reply with a JSON object ONLY, no surrounding text:
{"facts": [{"fact": "self-contained, precise statement", "category": "idea|preference|decision|config|error|process|general", "confidence": 0.0-1.0}]}
{"facts": []} if nothing durable.`

/** Nom d'un fichier de conversations : conversations.json ou un morceau numéroté. */
export function isConversationsFileName(name: string): boolean {
  return /^conversations(?:[-_]\d+)?\.json$/i.test(name)
}

export interface ChatGptConversation {
  /** Identifiant stable (id ou conversation_id ; sinon empreinte titre + date). */
  id: string
  title: string
  /** ISO, si connue. */
  createTime?: string
  updateTime?: string
  /** Dernière mise à jour en ms (0 si inconnue) : départage des doublons. */
  updateMs: number
  gizmoId?: string
  model?: string
  turns: Turn[]
}

export interface ChatGptStats {
  /** Fichiers de conversations lus. */
  files: number
  /** Éléments trouvés dans les tableaux. */
  conversations_seen: number
  /** Conversations avec au moins un tour gardé (après dédoublonnage). */
  conversations_kept: number
  /** Conversations sans aucun tour visible. */
  conversations_empty: number
  /** Éléments illisibles (JSON invalide, pas un objet, fichier tronqué). */
  conversations_malformed: number
  /** Même conversation présente plusieurs fois : la plus récente est gardée. */
  conversations_duplicate: number
  /*
   * Compteurs de messages : dans readChatGptExport, seule la version RETENUE
   * de chaque conversation y entre (un doublon écarté ne gonfle rien).
   */
  /** Messages de la branche affichée. */
  messages_on_branch: number
  /** Tours gardés (user + assistant visibles, en texte). */
  messages_kept: number
  /** Nœuds hors de la branche affichée (anciennes versions, réponses régénérées). */
  nodes_off_branch: number
  /**
   * Messages écartés par raison, une par filtre : rôle (system, tool, no_role…),
   * hidden (is_visually_hidden_from_conversation), user_system
   * (is_user_system_message), weight0 (poids nul), tool_call (recipient ≠ all),
   * commentary et analysis (canal), type:<content_type>, empty.
   */
  dropped: Record<string, number>
}

export function emptyChatGptStats(): ChatGptStats {
  return {
    files: 0,
    conversations_seen: 0,
    conversations_kept: 0,
    conversations_empty: 0,
    conversations_malformed: 0,
    conversations_duplicate: 0,
    messages_on_branch: 0,
    messages_kept: 0,
    nodes_off_branch: 0,
    dropped: {},
  }
}

// ---------------------------------------------------------------------------
// Conversation → tours
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Aucune date d'un export ne dépasse l'an 2100 : au-delà, l'unité est fausse. */
const MAX_DATE_MS = Date.UTC(2100, 0, 1)

/** Nombre epoch → ms : secondes (décimales) sous 1e11, ms sous 1e14, microsecondes au-delà. */
function epochToMs(n: number): number {
  if (n < 1e11) return n * 1000
  if (n < 1e14) return n
  return n / 1000
}

/** Secondes, ms, microsecondes ou chaîne (nombre ou ISO) → ms ; undefined si illisible ou hors de 1970-2100. */
function toMs(value: unknown): number | undefined {
  let ms: number | undefined
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) ms = epochToMs(value)
  else if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) ms = epochToMs(n)
    else {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) ms = parsed
    }
  }
  if (ms === undefined || !(ms > 0) || ms >= MAX_DATE_MS) return undefined
  return ms
}

/** Même lecture que toMs, rendue en ISO. */
function toIso(value: unknown): string | undefined {
  const ms = toMs(value)
  return ms === undefined ? undefined : new Date(ms).toISOString()
}

function bump(stats: ChatGptStats, reason: string): void {
  stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1
}

/**
 * Vrai si la chaîne des parents de `start` atteint une racine (parent null ou
 * absent) ; faux pour un orphelin (parent introuvable) ou un cycle. `memo`
 * garde le verdict de chaque nœud traversé : tout l'arbre est vu une fois.
 */
function reachesRoot(mapping: Record<string, unknown>, start: string, memo: Map<string, boolean>): boolean {
  const path: string[] = []
  const onPath = new Set<string>()
  let id = start
  let rooted = false
  for (;;) {
    const known = memo.get(id)
    if (known !== undefined) {
      rooted = known
      break
    }
    const node = mapping[id]
    if (!isRecord(node) || onPath.has(id)) break // orphelin ou cycle
    path.push(id)
    onPath.add(id)
    const parent = str(node['parent'])
    if (parent === undefined) {
      rooted = true
      break
    }
    id = parent
  }
  for (const p of path) memo.set(p, rooted)
  return rooted
}

/**
 * Feuille de secours (current_node absent, ou sans message sur sa branche) :
 * la plus récente des feuilles RELIÉES à une racine. Une feuille orpheline ou
 * prise dans un cycle ne passe qu'en dernier recours, quand aucune feuille
 * n'est reliée (mapping abîmé : mieux vaut un bout de conversation que rien).
 */
function fallbackLeaf(mapping: Record<string, unknown>): string | undefined {
  const memo = new Map<string, boolean>()
  let best: string | undefined
  let bestTime = Number.NEGATIVE_INFINITY
  let bestRooted = false
  for (const [id, node] of Object.entries(mapping)) {
    if (!isRecord(node)) continue
    const children = Array.isArray(node['children']) ? (node['children'] as unknown[]) : []
    if (children.some(c => typeof c === 'string' && isRecord(mapping[c]))) continue
    const rooted = reachesRoot(mapping, id, memo)
    const msg = isRecord(node['message']) ? node['message'] : undefined
    const t = toMs(msg?.['create_time']) ?? Number.NEGATIVE_INFINITY
    if (best === undefined || (rooted && !bestRooted) || (rooted === bestRooted && t >= bestTime)) {
      best = id
      bestTime = t
      bestRooted = rooted
    }
  }
  return best
}

/** Chemin de `leaf` jusqu'à la racine, remis dans l'ordre. Protégé contre les cycles. */
function pathToRoot(mapping: Record<string, unknown>, leaf: string | undefined): Record<string, unknown>[] {
  const path: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let id = leaf
  while (id !== undefined && !seen.has(id)) {
    const node = mapping[id]
    if (!isRecord(node)) break
    seen.add(id)
    path.push(node)
    id = str(node['parent'])
  }
  return path.reverse()
}

/**
 * Branche affichée : celle de current_node. Si current_node manque, ou si sa
 * branche ne porte aucun message (current_node pointe la racine), celle de
 * la feuille de secours.
 */
function displayedBranch(mapping: Record<string, unknown>, currentNode: string | undefined): Record<string, unknown>[] {
  if (currentNode !== undefined && isRecord(mapping[currentNode])) {
    const path = pathToRoot(mapping, currentNode)
    if (path.some(node => isRecord(node['message']))) return path
  }
  return pathToRoot(mapping, fallbackLeaf(mapping))
}

/** Marqueur privé complet : U+E200 nom (U+E202 segment)* U+E201. */
const PRIVATE_MARKER = /\ue200([A-Za-z_]+)((?:\ue202[^\ue200\ue201\ue202]*)*)\ue201/g

/** Libellé lisible d'un marqueur entity : 2e élément du tableau JSON, sinon le texte intérieur. */
function entityLabel(segments: string[]): string {
  if (segments.length === 1) {
    try {
      const parsed: unknown = JSON.parse(segments[0]!)
      if (Array.isArray(parsed)) {
        const label = typeof parsed[1] === 'string' ? parsed[1] : typeof parsed[0] === 'string' ? parsed[0] : ''
        if (label.trim()) return label.trim()
      }
    } catch {
      // pas du JSON : on garde le texte intérieur
    }
  }
  return segments.join(' ').trim()
}

/**
 * Citations de la recherche web (« 【12†source】 », marqueurs « cite » et
 * « filecite ») retirées : du bruit pour la mémoire. Marqueur « entity » :
 * son libellé reste, sans les délimiteurs privés.
 */
function stripCitations(text: string): string {
  return text
    .replace(/【[^【】]{0,120}†[^【】]{0,120}】/g, '')
    .replace(PRIVATE_MARKER, (whole: string, name: string, rest: string) => {
      if (name === 'cite' || name === 'filecite') return ''
      if (name === 'entity') return entityLabel(rest.split('\ue202').slice(1))
      return whole
    })
}

/** Texte d'un contenu text / multimodal_text : chaînes et transcriptions vocales ; images ignorées. */
function partsText(content: Record<string, unknown>): string {
  const parts = content['parts']
  const out: string[] = []
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part.trim()) out.push(part.trim())
      } else if (isRecord(part) && part['content_type'] === 'audio_transcription' && typeof part['text'] === 'string') {
        if (part['text'].trim()) out.push(part['text'].trim())
      }
    }
  } else if (typeof content['text'] === 'string') {
    out.push(content['text'].trim())
  }
  return stripCitations(out.join('\n')).trim()
}

/** Raison d'écarter un message, ou null s'il est visible et en texte. */
function dropReason(msg: Record<string, unknown>): string | null {
  const author = isRecord(msg['author']) ? msg['author'] : {}
  const role = author['role']
  if (role !== 'user' && role !== 'assistant') return typeof role === 'string' && role ? role : 'no_role'
  const meta = isRecord(msg['metadata']) ? msg['metadata'] : {}
  if (meta['is_visually_hidden_from_conversation'] === true) return 'hidden'
  if (meta['is_user_system_message'] === true) return 'user_system'
  if (msg['weight'] === 0) return 'weight0'
  const recipient = msg['recipient']
  if (typeof recipient === 'string' && recipient !== '' && recipient !== 'all') return 'tool_call'
  const channel = msg['channel']
  if (channel === 'commentary') return 'commentary'
  if (channel === 'analysis') return 'analysis'
  const content = isRecord(msg['content']) ? msg['content'] : undefined
  if (!content) return 'empty'
  const type = typeof content['content_type'] === 'string' ? content['content_type'] : 'text'
  if (type !== 'text' && type !== 'multimodal_text') return `type:${type}`
  return null
}

/**
 * Une conversation brute → conversation normalisée. null si l'élément n'est
 * pas un objet (compté illisible). Les tours peuvent être vides.
 */
export function parseChatGptConversation(raw: unknown, stats: ChatGptStats = emptyChatGptStats()): ChatGptConversation | null {
  if (!isRecord(raw)) {
    stats.conversations_malformed++
    return null
  }
  const title = (str(raw['title']) ?? '').trim() || 'Sans titre'
  const createTime = toIso(raw['create_time'])
  const updateTime = toIso(raw['update_time'])
  const mapping = isRecord(raw['mapping']) ? raw['mapping'] : {}
  const branch = displayedBranch(mapping, str(raw['current_node']))
  stats.nodes_off_branch += Math.max(0, Object.keys(mapping).length - branch.length)

  const turns: Turn[] = []
  for (const node of branch) {
    const msg = node['message']
    if (!isRecord(msg)) continue // racine sans message
    stats.messages_on_branch++
    const reason = dropReason(msg)
    if (reason) {
      bump(stats, reason)
      continue
    }
    const text = partsText(msg['content'] as Record<string, unknown>)
    if (!text) {
      bump(stats, 'empty')
      continue
    }
    const role = (msg['author'] as Record<string, unknown>)['role'] as 'user' | 'assistant'
    const ts = toIso(msg['create_time']) ?? createTime
    turns.push({ role, text: truncateTurnText(text, 'chatgpt'), ...(ts ? { ts } : {}) })
  }
  stats.messages_kept += turns.length

  const id =
    str(raw['id']) ??
    str(raw['conversation_id']) ??
    `sans-id-${sha256Hex(`${title}\n${createTime ?? ''}\n${turns[0]?.text ?? ''}`).slice(0, 24)}`
  const gizmoId = str(raw['gizmo_id'])
  const model = str(raw['default_model_slug'])
  return {
    id,
    title,
    ...(createTime ? { createTime } : {}),
    ...(updateTime ? { updateTime } : {}),
    updateMs: updateTime ? Date.parse(updateTime) : createTime ? Date.parse(createTime) : 0,
    ...(gizmoId ? { gizmoId } : {}),
    ...(model ? { model } : {}),
    turns,
  }
}

// ---------------------------------------------------------------------------
// Lecture en flux d'un tableau JSON
// ---------------------------------------------------------------------------

export class NotAnArrayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotAnArrayError'
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d])

/**
 * Découpe un tableau JSON de premier niveau en éléments, octet par octet, sur
 * des morceaux de taille quelconque. Les caractères de structure ([ ] { } " \ ,)
 * sont ASCII et n'apparaissent jamais au milieu d'un caractère UTF-8 : couper
 * les octets puis décoder chaque élément entier est sûr, même quand un emoji
 * tombe à cheval sur deux morceaux.
 */
export class JsonArraySplitter {
  private state: 'start' | 'between' | 'element' | 'junk' | 'done' = 'start'
  private depth = 0
  private inString = false
  private escape = false
  private parts: Buffer[] = []
  /** Éléments qui ne sont ni objet ni tableau (sautés). */
  junk = 0
  /** Contenu non vide après la fin du tableau. */
  trailing = false

  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = []
    let start = this.state === 'element' ? 0 : -1
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!
      switch (this.state) {
        case 'start':
          if (WS.has(c) || c === 0xef || c === 0xbb || c === 0xbf) continue // espaces, BOM UTF-8
          if (c === 0x5b) {
            this.state = 'between'
            continue
          }
          throw new NotAnArrayError('le fichier ne commence pas par un tableau JSON')
        case 'between':
          if (WS.has(c) || c === 0x2c) continue
          if (c === 0x5d) {
            this.state = 'done'
            continue
          }
          if (c === 0x7b || c === 0x5b) {
            this.state = 'element'
            this.depth = 1
            start = i
            continue
          }
          this.state = 'junk'
          this.junk++
          this.depth = 0
          if (c === 0x22) this.inString = true
          continue
        case 'element':
        case 'junk':
          if (this.inString) {
            if (this.escape) this.escape = false
            else if (c === 0x5c) this.escape = true
            else if (c === 0x22) this.inString = false
            continue
          }
          if (c === 0x22) {
            this.inString = true
            continue
          }
          if (c === 0x7b || c === 0x5b) {
            this.depth++
            continue
          }
          if (c === 0x7d || c === 0x5d) {
            if (this.state === 'junk' && this.depth === 0) {
              if (c === 0x5d) this.state = 'done'
              continue
            }
            this.depth--
            if (this.state === 'element' && this.depth === 0) {
              this.parts.push(chunk.subarray(start, i + 1))
              out.push(Buffer.concat(this.parts))
              this.parts = []
              this.state = 'between'
              start = -1
            }
            continue
          }
          if (this.state === 'junk' && this.depth === 0 && c === 0x2c) this.state = 'between'
          continue
        case 'done':
          if (!WS.has(c)) this.trailing = true
          continue
      }
    }
    // Élément à cheval sur le morceau suivant : copie (le tampon du flux peut être réutilisé).
    if (this.state === 'element' && start >= 0) this.parts.push(Buffer.from(chunk.subarray(start)))
    return out
  }

  /** Fin du flux : `truncated` si un élément ou le tableau n'est pas refermé. */
  end(): { started: boolean; closed: boolean; truncated: boolean } {
    return {
      started: this.state !== 'start',
      closed: this.state === 'done',
      truncated: this.state === 'element' || this.state === 'junk',
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// Entrée : zip, dossier ou fichier
// ---------------------------------------------------------------------------

/** Message d'accès refusé utile, surtout sous macOS (le daemon n'a pas accès à Téléchargements). */
export function accessErrorMessage(path: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return `export introuvable : « ${path} »`
  if (code === 'EPERM' || code === 'EACCES') {
    return (
      `accès refusé à « ${path} » (${code}). Sous macOS, le daemon lancé au démarrage n'a pas le droit de lire ` +
      `Téléchargements, Bureau ni Documents : déplace l'export dans ton dossier personnel (par exemple ~/chatgpt-export.zip) puis relance.`
    )
  }
  return `lecture impossible de « ${path} » : ${(err as Error).message}`
}

/** Fichiers de conversations d'un dossier : à la racine, sinon un niveau plus bas. Liens symboliques ignorés. */
async function conversationFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const top = entries.filter(e => e.isFile() && isConversationsFileName(e.name)).map(e => join(dir, e.name))
  if (top.length > 0) return top.sort()
  const nested: string[] = []
  for (const sub of entries.filter(e => e.isDirectory())) {
    const inner = await readdir(join(dir, sub.name), { withFileTypes: true })
    for (const e of inner) if (e.isFile() && isConversationsFileName(e.name)) nested.push(join(dir, sub.name, e.name))
  }
  return nested.sort()
}

/** Préfixe des dossiers temporaires d'extraction. */
const TEMP_PREFIX = 'memoria-chatgpt-'
/** Âge au-delà duquel un dossier d'extraction est un reste d'import interrompu. */
const STALE_TEMP_MS = 6 * 3600_000

/**
 * Un daemon tué pendant l'extraction laisse son dossier temporaire, qui
 * contient une copie complète de l'historique : on balaie les restes anciens
 * avant chaque nouvelle extraction (un seul import tourne à la fois).
 */
async function sweepStaleTempDirs(tmpRoot: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(tmpRoot)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue
    const dir = join(tmpRoot, name)
    try {
      const st = await lstat(dir)
      if (st.isDirectory() && Date.now() - st.mtimeMs > STALE_TEMP_MS) rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`[memoria] export ChatGPT : ancien dossier temporaire non supprimé (${dir}) : ${(err as Error).message}`)
    }
  }
}

export interface PreparedExport {
  /** Fichiers de conversations à lire, dans l'ordre. */
  files: string[]
  /** Dossier temporaire créé pour un zip (supprimé par cleanup). */
  tempDir: string | null
  cleanup: () => void
}

/**
 * Prépare l'entrée : un zip est extrait (seulement ses fichiers de
 * conversations) dans un dossier temporaire neuf, à supprimer avec cleanup().
 */
export async function prepareChatGptExport(inputPath: string, opts: { tmpRoot?: string } = {}): Promise<PreparedExport> {
  let st
  try {
    st = await stat(inputPath)
  } catch (err) {
    throw new Error(accessErrorMessage(inputPath, err))
  }
  const none = { tempDir: null, cleanup: () => {} }
  try {
    if (st.isDirectory()) {
      const files = await conversationFilesIn(inputPath)
      if (files.length === 0) throw new Error(`aucun conversations.json (ni conversations-000.json…) dans « ${inputPath} »`)
      return { files, ...none }
    }
    if (await looksLikeZip(inputPath)) {
      // Dossier NEUF, à nous (mkdtemp : 0700) ; supprimé quoi qu'il arrive.
      const tmpRoot = opts.tmpRoot ?? tmpdir()
      await sweepStaleTempDirs(tmpRoot)
      const tempDir = await mkdtemp(join(tmpRoot, TEMP_PREFIX))
      const cleanup = (): void => rmSync(tempDir, { recursive: true, force: true })
      try {
        const extracted = await extractZipEntries(inputPath, tempDir, name => {
          const last = name.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
          return isConversationsFileName(last)
        })
        if (extracted.length === 0) throw new Error('aucun conversations.json (ni conversations-000.json…) dans le zip')
        // Ordre de l'archive par nom : conversations-000, -001… puis les autres.
        extracted.sort((a, b) => a.name.localeCompare(b.name))
        return { files: extracted.map(e => e.path), tempDir, cleanup }
      } catch (err) {
        cleanup()
        throw err
      }
    }
    if (inputPath.toLowerCase().endsWith('.json')) return { files: [inputPath], ...none }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') throw new Error(accessErrorMessage(inputPath, err))
    throw err
  }
  throw new Error(`format non reconnu : « ${basename(inputPath)} » (attendu : le .zip de l'export, son dossier décompressé, ou conversations.json)`)
}

export interface ChatGptExportRead {
  conversations: ChatGptConversation[]
  stats: ChatGptStats
  /** Problèmes non bloquants (fichier tronqué, pas un tableau…). */
  errors: string[]
}

/** Ajoute les compteurs de messages d'une conversation au bilan. */
function addMessageStats(total: ChatGptStats, part: ChatGptStats): void {
  total.messages_on_branch += part.messages_on_branch
  total.messages_kept += part.messages_kept
  total.nodes_off_branch += part.nodes_off_branch
  for (const [reason, n] of Object.entries(part.dropped)) total.dropped[reason] = (total.dropped[reason] ?? 0) + n
}

/**
 * Lit tout l'export : extraction éventuelle, lecture en flux de chaque
 * fichier, dédoublonnage par identifiant (la version la plus récente gagne),
 * nettoyage du dossier temporaire. Seuls les tours gardés restent en mémoire.
 * Les compteurs de messages sont tenus par conversation, et seule la version
 * retenue d'un doublon entre au bilan.
 */
export async function readChatGptExport(
  inputPath: string,
  opts: { tmpRoot?: string; chunkSize?: number; onFile?: (done: number, total: number) => void } = {},
): Promise<ChatGptExportRead> {
  const stats = emptyChatGptStats()
  const errors: string[] = []
  const byId = new Map<string, { conv: ChatGptConversation; stats: ChatGptStats }>()
  const prepared = await prepareChatGptExport(inputPath, opts)
  try {
    let fileIndex = 0
    for (const file of prepared.files) {
      stats.files++
      // Nom affichable : jamais le chemin temporaire (il n'existera plus).
      const label = basename(file).replace(/^\d{4}-/, '')
      const splitter = new JsonArraySplitter()
      let sinceYield = 0
      try {
        const stream = createReadStream(file, { highWaterMark: opts.chunkSize ?? 1024 * 1024 })
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          for (const element of splitter.push(chunk)) {
            stats.conversations_seen++
            let raw: unknown
            try {
              // LIMITE CONNUE : une conversation se parse d'un bloc, sans rendre
              // la main. Mesuré : environ 70 ms pour 28 Mo, 230 ms pour 98 Mo.
              // Acceptable (une conversation ordinaire pèse quelques centaines
              // de Ko) ; sinon, parser les très gros éléments hors du fil
              // principal (worker).
              raw = JSON.parse(element.toString('utf8'))
            } catch (err) {
              stats.conversations_malformed++
              console.warn(`[memoria] export ChatGPT ${label} : conversation illisible ignorée (${(err as Error).message})`)
              continue
            }
            const local = emptyChatGptStats()
            const conv = parseChatGptConversation(raw, local)
            if (!conv) stats.conversations_malformed += local.conversations_malformed
            else {
              const prev = byId.get(conv.id)?.conv
              if (prev) {
                stats.conversations_duplicate++
                if (conv.updateMs > prev.updateMs || (conv.updateMs === prev.updateMs && conv.turns.length > prev.turns.length)) {
                  byId.set(conv.id, { conv, stats: local })
                }
              } else {
                byId.set(conv.id, { conv, stats: local })
              }
            }
            // Une conversation ordinaire se parse en quelques ms : on rend la
            // main régulièrement, le daemon continue de répondre.
            if (++sinceYield >= 20) {
              sinceYield = 0
              await yieldToEventLoop()
            }
          }
          await yieldToEventLoop()
        }
        stats.conversations_seen += splitter.junk
        stats.conversations_malformed += splitter.junk
        const end = splitter.end()
        if (!end.started) errors.push(`${label} : fichier vide`)
        else if (end.truncated) {
          stats.conversations_malformed++
          errors.push(`${label} : fichier tronqué, la dernière conversation est illisible (les précédentes sont gardées)`)
        } else if (!end.closed) errors.push(`${label} : tableau non refermé (fichier tronqué ?)`)
        if (end.closed && splitter.trailing) errors.push(`${label} : contenu inattendu après le tableau, ignoré`)
      } catch (err) {
        if (err instanceof NotAnArrayError) errors.push(`${label} : ${err.message}, fichier ignoré`)
        else errors.push(`${label} : ${(err as NodeJS.ErrnoException).code ? accessErrorMessage(label, err) : (err as Error).message}`)
        console.warn(`[memoria] export ChatGPT ${label} : ${(err as Error).message}`)
      }
      fileIndex++
      opts.onFile?.(fileIndex, prepared.files.length)
    }
  } finally {
    prepared.cleanup()
  }

  const conversations: ChatGptConversation[] = []
  for (const { conv, stats: part } of byId.values()) {
    addMessageStats(stats, part)
    if (conv.turns.length === 0) stats.conversations_empty++
    else conversations.push(conv)
  }
  // Ordre stable : la plus ancienne d'abord (puis l'identifiant).
  conversations.sort((a, b) => (a.createTime ?? '').localeCompare(b.createTime ?? '') || a.id.localeCompare(b.id))
  stats.conversations_kept = conversations.length
  return { conversations, stats, errors }
}

// ---------------------------------------------------------------------------
// Conversations → unités d'import
// ---------------------------------------------------------------------------

/** Préfixe des clés d'unité : transcript_file_state.path et memory_sources.source_path. */
export const CHATGPT_KEY_PREFIX = 'chatgpt:'

/**
 * Une conversation = une unité. Le hash porte sur l'identifiant et les tours
 * GARDÉS (rôle + texte) : une simple mise à jour de métadonnées dans un
 * nouvel export ne crée pas de nouvelle source ; le titre n'y entre pas non
 * plus (un renommage ne relance rien).
 */
export function chatGptUnit(conv: ChatGptConversation): TranscriptUnit {
  const canonical = JSON.stringify(conv.turns.map(t => [t.role, t.text]))
  const sourceHash = sha256Hex(`${CHATGPT_FORMAT}\n${conv.id}\n${canonical}`)
  const firstTs = conv.turns.find(t => t.ts)?.ts
  const lastTs = [...conv.turns].reverse().find(t => t.ts)?.ts
  const day = (firstTs ?? conv.createTime)?.slice(0, 10)
  const title = conv.title.length > 200 ? `${conv.title.slice(0, 200)}…` : conv.title
  return {
    key: `${CHATGPT_KEY_PREFIX}${conv.id}`,
    label: title.length > 80 ? `${title.slice(0, 80)}…` : title,
    format: CHATGPT_FORMAT,
    turns: conv.turns,
    sourceHash,
    size: conv.turns.reduce((n, t) => n + t.text.length, 0),
    mtimeMs: Number.isFinite(conv.updateMs) ? Math.trunc(conv.updateMs) : 0,
    context: `Conversation ChatGPT « ${title} »${day ? ` du ${day}` : ''}.`,
    metadata: {
      conversation_id: conv.id,
      title: conv.title,
      ...(conv.createTime ? { create_time: conv.createTime } : {}),
      ...(conv.updateTime ? { update_time: conv.updateTime } : {}),
      ...(firstTs ? { first_message_at: firstTs } : {}),
      ...(lastTs ? { last_message_at: lastTs } : {}),
      ...(conv.gizmoId ? { gizmo_id: conv.gizmoId } : {}),
      ...(conv.model ? { model: conv.model } : {}),
      messages: conv.turns.length,
    },
  }
}

export function chatGptUnits(conversations: ChatGptConversation[]): TranscriptUnit[] {
  return conversations.map(chatGptUnit)
}

/**
 * Même chose pour le daemon : hacher tout le texte d'un gros export prend
 * une seconde ou plus, on rend la main toutes les 50 conversations.
 */
export async function chatGptUnitsAsync(conversations: ChatGptConversation[]): Promise<TranscriptUnit[]> {
  const out: TranscriptUnit[] = []
  for (let i = 0; i < conversations.length; i++) {
    if (i > 0 && i % 50 === 0) await yieldToEventLoop()
    out.push(chatGptUnit(conversations[i]!))
  }
  return out
}
