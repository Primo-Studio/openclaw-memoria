/**
 * Mise en forme du rappel (T30) : fonctions PURES, sans base ni réseau.
 *
 * Le serveur MCP, le daemon et l'écran d'aperçu doivent montrer la MÊME chose :
 * si chacun réécrit sa projection, l'humain ne voit plus ce que l'IA reçoit.
 * Tout ce qui transforme un `RecallResult` vit donc ici, et le moteur n'y lit
 * que des données déjà chargées.
 */
import type { RecallBlock, RecallDropped, RecallItem, RecallResult } from '../types.js'

/** Plancher de l'arrêt sur décrochage : en dessous, on ne coupe jamais. */
export const RECALL_CUTOFF_FLOOR = 3
const MAX_ENTITIES = 4

// ---------------------------------------------------------------------------
// Arrêt sur décrochage
// ---------------------------------------------------------------------------

/**
 * Coupe la queue d'une liste DÉJÀ triée par score décroissant : tout ce qui est
 * sous `cutoff × meilleur score` part, sauf les `RECALL_CUTOFF_FLOOR` premiers.
 *
 * Seuil RELATIF et non absolu : le score du rappel est un produit non borné
 * (pertinence × récence × confiance × usage...), sa valeur brute ne veut rien
 * dire d'une requête à l'autre. `cutoff` absent ou invalide : rien n'est coupé.
 */
export function applyRecallCutoff<T>(
  sorted: T[],
  cutoff: number | undefined,
  scoreOf: (entry: T) => number,
): { kept: T[]; dropped: number } {
  if (typeof cutoff !== 'number' || !Number.isFinite(cutoff) || cutoff <= 0 || sorted.length <= RECALL_CUTOFF_FLOOR) {
    return { kept: sorted, dropped: 0 }
  }
  const threshold = Math.min(1, cutoff) * scoreOf(sorted[0]!)
  let keep = sorted.length
  for (let i = RECALL_CUTOFF_FLOOR; i < sorted.length; i++) {
    if (scoreOf(sorted[i]!) < threshold) {
      keep = i
      break
    }
  }
  return { kept: sorted.slice(0, keep), dropped: sorted.length - keep }
}

// ---------------------------------------------------------------------------
// Entités signifiantes
// ---------------------------------------------------------------------------

export interface EntityCandidate {
  name: string
  type: string
  mention_count: number
}

/** Types qui désignent quelqu'un ou quelque chose de précis (même liste que les thèmes). */
const STRONG_ENTITY_TYPES = new Set(['person', 'company', 'project', 'client'])

/**
 * Mots que l'extraction heuristique prend pour des entités parce qu'ils portent
 * une majuscule en début de phrase ou dans un nom de fichier. Liste courte et
 * assumée : on écarte le bruit ÉVIDENT, on ne prétend pas juger le reste.
 */
const NOISE_WORDS = new Set([
  'pour', 'avec', 'dans', 'sans', 'les', 'des', 'une', 'ce', 'cette', 'ces', 'il', 'elle', 'on', 'nous', 'quand', 'si',
  'the', 'this', 'that', 'these', 'and', 'for', 'with', 'from', 'when', 'if', 'it', 'we',
  'readme', 'thread', 'todo', 'note', 'notes', 'fwd', 're',
])

function isNoiseEntity(name: string): boolean {
  const n = name.trim()
  if (n.length < 2) return true
  const letters = (n.match(/\p{L}/gu) ?? []).length
  const digits = (n.match(/\d/g) ?? []).length
  // Dates, numéros, versions nues : aucun sens hors de leur phrase.
  if (letters === 0 || digits > letters) return true
  return NOISE_WORDS.has(
    n
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}+/gu, ''),
  )
}

/**
 * Entités à montrer pour un fait : types forts d'abord, puis les plus RARES
 * (une entité citée partout ne distingue rien), bruit évident écarté.
 */
export function rankEntities<T extends EntityCandidate>(candidates: T[], max = MAX_ENTITIES): T[] {
  const seen = new Set<string>()
  return candidates
    .filter(c => {
      const key = c.name.trim().toLowerCase()
      if (isNoiseEntity(c.name) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => {
      const strong = Number(STRONG_ENTITY_TYPES.has(b.type)) - Number(STRONG_ENTITY_TYPES.has(a.type))
      if (strong !== 0) return strong
      if (a.mention_count !== b.mention_count) return a.mention_count - b.mention_count
      return a.name.localeCompare(b.name)
    })
    .slice(0, max)
}

// ---------------------------------------------------------------------------
// Blocs par thème
// ---------------------------------------------------------------------------

function byDate(a: RecallItem, b: RecallItem): number {
  return (a.created_at ?? '').localeCompare(b.created_at ?? '')
}

/** Entités portées par au moins la moitié des souvenirs du bloc (et au moins deux). */
function sharedEntities(items: RecallItem[]): string[] {
  const counts = new Map<string, number>()
  for (const item of items) for (const name of item.entities ?? []) counts.set(name, (counts.get(name) ?? 0) + 1)
  const min = Math.max(2, Math.ceil(items.length / 2))
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1]) // tri stable : à égalité, l'ordre d'apparition
    .slice(0, MAX_ENTITIES)
    .map(([name]) => name)
}

/**
 * Clé de regroupement d'un thème : son NOM normalisé (casse, accents,
 * espaces). L'id d'un thème est propre à sa base : le même sujet présent en
 * privé et dans une base partagée donnait deux blocs de même titre, ou deux
 * souvenirs isolés. Le bloc garde le titre et l'id du premier item.
 */
function topicKey(topic: { id: string; name: string }): string {
  const name = topic.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name ? `name:${name}` : `id:${topic.id}`
}

/**
 * Regroupe les souvenirs par thème. Un thème n'a un bloc que s'il réunit au
 * moins deux souvenirs : un bloc d'un seul item n'apprend rien de plus que
 * l'item. Le reste va dans un dernier bloc `loose`, sans titre.
 *
 * Les blocs suivent l'ordre du meilleur score (celui de `items`) ; à
 * l'intérieur, l'ordre est celui du TEMPS, pour qu'on lise une histoire et que
 * `latest_id` désigne l'état courant.
 */
export function buildRecallBlocks(items: RecallItem[]): RecallBlock[] {
  const groups = new Map<string, RecallItem[]>()
  for (const item of items) {
    if (!item.topic) continue
    const key = topicKey(item.topic)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const blocks: RecallBlock[] = []
  const loose: RecallItem[] = []
  const done = new Set<string>()
  for (const item of items) {
    const key = item.topic ? topicKey(item.topic) : undefined
    const group = key ? groups.get(key)! : undefined
    if (!key || !group || group.length < 2) {
      loose.push(item)
      continue
    }
    if (done.has(key)) continue
    done.add(key)
    const chrono = [...group].sort(byDate)
    const entities = sharedEntities(group)
    blocks.push({
      title: item.topic!.name,
      topic_id: item.topic!.id,
      item_ids: chrono.map(i => i.id),
      latest_id: chrono[chrono.length - 1]!.id,
      ...(entities.length > 0 ? { entities } : {}),
    })
  }
  if (loose.length > 0) {
    const chrono = [...loose].sort(byDate)
    blocks.push({ title: '', item_ids: chrono.map(i => i.id), latest_id: chrono[chrono.length - 1]!.id, loose: true })
  }
  return blocks
}

// ---------------------------------------------------------------------------
// Projection compacte (JSON) pour un modèle
// ---------------------------------------------------------------------------

/** Raisons du match, la raison « graphe » précisée par son entité de passage. */
function whyOf(item: RecallItem): string[] {
  return (item.matched_by ?? []).map(m => (m === 'graph' && item.via_entity ? `graph:${item.via_entity}` : m))
}

/**
 * Projection compacte d'un recall pour le LLM.
 *
 * Mesuré E2E (12 items) : le RecallResult brut pèse 2,44× le contenu utile
 * (`scope_id`, `source_db`, `score` à 16 décimales, `created_at` à la
 * milliseconde, `scopes_searched`). Aucun de ces champs ne sert au modèle. On
 * garde ce qui guide une décision : id (feedback/pin/correct), kind, contenu,
 * catégorie, date, score arrondi, origine et révision en attente. `disabled`
 * (Memoria en pause) est conservé : « rien » ne veut pas dire « aucun souvenir ».
 *
 * T30 : `why`, `topic` (nom seul), `entities`, `status`, `links` et, au niveau
 * global, `dropped` s'ajoutent UNIQUEMENT quand ils existent. Un résultat sans
 * champs nouveaux donne exactement la sortie d'avant.
 */
export function compactRecall(payload: RecallResult & { disabled?: boolean }): Record<string, unknown> {
  const items = (payload.items ?? []).map(i => {
    const out: Record<string, unknown> = { id: i.id, kind: i.kind, content: i.content, category: i.category }
    if (typeof i.created_at === 'string' && i.created_at) out['date'] = i.created_at.slice(0, 10)
    out['score'] = Math.round((i.score ?? 0) * 1000) / 1000
    if (i.origin) out['origin'] = i.origin
    if (i.revision) out['revision'] = i.revision
    const why = whyOf(i)
    if (why.length > 0) out['why'] = why
    if (i.topic?.name) out['topic'] = i.topic.name
    if (i.entities && i.entities.length > 0) out['entities'] = i.entities
    if (i.status) out['status'] = i.status
    if (i.links && i.links.length > 0) out['links'] = i.links
    return out
  })
  return {
    items,
    total_found: payload.totalFound ?? items.length,
    tokens: payload.tokens ?? 0,
    ...(payload.dropped && payload.dropped.length > 0 ? { dropped: payload.dropped } : {}),
    ...(payload.disabled ? { disabled: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Rendu texte en blocs, lu par un modèle
// ---------------------------------------------------------------------------

export interface FormatRecallBlocksOptions {
  /** Longueur maximale du texte rendu. Jamais dépassée. */
  maxChars?: number
  /** Titre du bloc des souvenirs sans thème. Défaut « Other ». */
  looseTitle?: string
}

/**
 * Un souvenir est une DONNÉE, jamais une instruction ni de la mise en page :
 * on l'aplatit sur une ligne et on casse ce qui pourrait ouvrir un titre, une
 * puce ou un bloc de code dans le prompt qui le reçoit.
 */
function flat(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/`{3,}/g, "'''")
    .trim()
    .replace(/^([#>*+-]+\s+)+/, '')
}

/** Libellés (thème, entité) : extraits automatiquement, donc nettoyés plus fort. */
function label(text: string): string {
  return flat(text)
    .replace(/[[\]#"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const ORIGIN_WORD: Record<string, string> = {
  declared: 'stated',
  extracted: 'extracted',
  inferred: 'inferred',
  confirmed: 'confirmed',
}

function statusWord(item: RecallItem): string | undefined {
  const rev = item.revision
  if (rev) {
    const target = rev.replacement_fact_id ? ` #${rev.replacement_fact_id}` : ''
    if (rev.kind === 'duplicate') return `duplicate of${target || ' a newer memory'}`
    if (rev.kind === 'obsolete') return 'flagged obsolete'
    return `contested by${target || ' a newer memory'}`
  }
  if (item.status === 'contested') return 'contested'
  if (item.status === 'expiring') return 'expiring'
  if (item.status === 'replaces') return 'replaces an older memory'
  return undefined
}

/** Crochets d'un souvenir : raison(s) du match, origine, statut, voisins. */
function annotations(item: RecallItem): string {
  const parts: string[] = []
  const why = whyOf(item).map(label)
  if (why.length > 0) parts.push(why.join('+'))
  if (item.origin) parts.push(ORIGIN_WORD[item.origin] ?? item.origin)
  const status = statusWord(item)
  if (status) parts.push(status)
  if (item.links && item.links.length > 0) {
    parts.push(`near: ${item.links.map(l => `#${l.id} "${label(l.excerpt)}" via ${label(l.via)}`).join('; ')}`)
  }
  return parts.length > 0 ? ` [${parts.join(' · ')}]` : ''
}

function itemLine(prefix: string, item: RecallItem): string {
  const date = typeof item.created_at === 'string' && item.created_at ? `${item.created_at.slice(0, 10)} ` : ''
  return `${prefix} ${date}#${item.id} ${flat(item.content)}${annotations(item)}`
}

function droppedText(dropped: RecallDropped[] | undefined): string {
  const list = (dropped ?? []).filter(d => d.count > 0)
  if (list.length === 0) return ''
  const total = list.reduce((n, d) => n + d.count, 0)
  return `, ${total} dropped (${list.map(d => `${d.reason} ${d.count}`).join(', ')})`
}

/**
 * Rendu texte du format en blocs. Libellés en anglais court : le texte est lu
 * par des modèles (même convention que le bloc « Relevant memory » de
 * l'adaptateur OpenClaw), le contenu reste dans sa langue.
 *
 *   Memory: 2 blocks, 5 kept, 7 dropped (cutoff 4, limit 3)
 *   Memory: 1 block, 2 of 5 kept, 7 dropped (...)      <- budget trop court
 *   ## <thème> (3) · <entités communes>
 *   now 2026-10-03 #<id> <état courant> [text+graph:Atlas · stated · replaces an older memory]
 *   - 2026-09-01 #<id> <plus ancien> [text · extracted · contested by #<id>]
 *   ## Other (2)
 *   - 2026-08-01 #<id> ... [meaning · stated]
 *
 * Dans un bloc de thème, la ligne `now` est le souvenir le plus récent, puis
 * les autres suivent dans l'ordre du temps. Le bloc sans thème garde l'ordre du
 * score : ses souvenirs n'ont pas d'histoire commune à raconter.
 *
 * Budget : une ligne qui ferait dépasser `maxChars` n'est pas écrite, et tout
 * ce qui suit non plus (une ligne « +N more » le dit si elle tient). L'en-tête
 * est écrit EN DERNIER, avec les nombres de blocs et de souvenirs réellement
 * rendus : il ne doit pas annoncer ce que le lecteur ne trouvera pas dessous.
 */
export function formatRecallBlocks(result: RecallResult, opts: FormatRecallBlocksOptions = {}): string {
  const items = result.items ?? []
  if (items.length === 0) return ''
  const blocks = result.blocks ?? buildRecallBlocks(items)
  const byId = new Map(items.map(i => [i.id, i]))
  const rank = new Map(items.map((i, idx) => [i.id, idx]))
  const max = typeof opts.maxChars === 'number' && opts.maxChars > 0 ? Math.floor(opts.maxChars) : Infinity

  const headerFor = (blockCount: number, shown: number): string => {
    const kept = shown < items.length ? `${shown} of ${items.length} kept` : `${items.length} kept`
    return `Memory: ${blockCount} block${blockCount > 1 ? 's' : ''}, ${kept}${droppedText(result.dropped)}`
  }

  /** Pose les lignes sous un en-tête de `headerLength` caractères, sans jamais dépasser `max`. */
  const render = (headerLength: number): { lines: string[]; written: number; writtenBlocks: number } => {
    const lines: string[] = []
    let size = headerLength
    let written = 0
    let writtenBlocks = 0
    /** Ajoute des lignes d'un seul tenant (titre + premier item) ou rien. */
    const push = (...chunk: string[]): boolean => {
      const cost = chunk.reduce((n, l) => n + l.length + 1, 0)
      if (size + cost > max) return false
      lines.push(...chunk)
      size += cost
      return true
    }

    outer: for (const block of blocks) {
      const members = block.item_ids.map(id => byId.get(id)).filter((i): i is RecallItem => i !== undefined)
      if (members.length === 0) continue
      let ordered: Array<{ prefix: string; item: RecallItem }>
      let title: string
      if (block.loose) {
        title = `## ${label(opts.looseTitle ?? 'Other')} (${members.length})`
        ordered = [...members].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).map(item => ({ prefix: '-', item }))
      } else {
        const entities = (block.entities ?? []).map(label).filter(Boolean)
        title = `## ${label(block.title)} (${members.length})${entities.length > 0 ? ` · ${entities.join(', ')}` : ''}`
        const latest = byId.get(block.latest_id) ?? members[members.length - 1]!
        ordered = [{ prefix: 'now', item: latest }, ...members.filter(i => i !== latest).map(item => ({ prefix: '-', item }))]
      }
      for (let i = 0; i < ordered.length; i++) {
        const line = itemLine(ordered[i]!.prefix, ordered[i]!.item)
        // Le titre ne part jamais seul : un titre sans souvenir dessous tromperait.
        const ok = i === 0 ? push(title, line) : push(line)
        if (!ok) break outer
        written++
        if (i === 0) writtenBlocks++
      }
    }
    if (written < items.length) push(`(+${items.length - written} more not shown)`)
    return { lines, written, writtenBlocks }
  }

  // Les nombres de l'en-tête ne sont connus qu'une fois les lignes posées.
  // Premier essai avec l'en-tête complet : si tout tient, c'est le rendu.
  const complete = render(headerFor(blocks.length, items.length).length)
  if (complete.written === items.length) {
    return [headerFor(complete.writtenBlocks, complete.written), ...complete.lines].join('\n')
  }
  // Sinon on repose les lignes en réservant la forme la plus longue de
  // l'en-tête partiel (« N of M kept »), pour que le total reste sous `max`.
  const partial = render(headerFor(blocks.length, items.length).replace(`${items.length} kept`, `${items.length} of ${items.length} kept`).length)
  const header = headerFor(partial.writtenBlocks, partial.written)
  if (header.length > max) return header.slice(0, max)
  return [header, ...partial.lines].join('\n')
}
