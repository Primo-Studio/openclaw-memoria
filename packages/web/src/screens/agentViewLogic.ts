/**
 * Logique PURE de l'écran « Ce que voit l'IA » (aucun rendu React, aucun
 * réseau) : regroupement en blocs, raisons du match, statuts, score relatif,
 * estimation de tokens, résumé de colonne.
 *
 * POURQUOI un fichier à part : ces règles décident de ce que l'humain lit. Si
 * elles se trompent, l'écran ment sur ce que l'agent reçoit ; elles sont donc
 * testées sans navigateur (test/agent-view.test.ts).
 */
import type {
  RecallMatch,
  RecallPreview,
  RecallPreviewBlock,
  RecallPreviewDropped,
  RecallPreviewItem,
  RecallRender,
  RecallRenderId,
} from '../api'

type Translate = (key: string, vars?: Record<string, string | number>) => string

// ------------------------------------------------------------------ tokens

/**
 * Estimation du nombre de tokens d'un texte, quand le service ne le compte
 * pas. Même règle que le moteur pour que le chiffre soit comparable au budget
 * qu'il applique : un token pour 3,6 caractères (core/util.ts), sauf le bloc
 * OpenClaw, que son rendu coupe à 4 caractères par token
 * (core/engine/recall-format-openclaw.ts). Avec 3,6, un bloc OpenClaw plein
 * s'affichait au-dessus de son propre budget.
 */
export function estimateTokens(text: string, render?: RecallRenderId): number {
  return Math.ceil(text.length / (render === 'openclaw' ? 4 : 3.6))
}

/** Tokens d'un rendu : le compte du service s'il existe, sinon l'estimation propre à ce rendu. */
export function renderTokens(render: RecallRender | undefined, id?: RecallRenderId): number {
  if (!render) return 0
  return typeof render.tokens === 'number' && render.tokens >= 0 ? render.tokens : estimateTokens(render.text, id)
}

// ------------------------------------------------------------------- blocs

export interface ViewBlock {
  key: string
  /** Nom du thème ; '' pour le bloc des souvenirs sans thème commun. */
  title: string
  loose: boolean
  entities: string[]
  /** État courant du sujet (le souvenir le plus récent). Absent du bloc `loose`. */
  current: RecallPreviewItem | null
  /** Bloc de thème : les autres dans l'ordre du temps. Bloc `loose` : l'ordre du score. */
  others: RecallPreviewItem[]
}

function byDate(a: RecallPreviewItem, b: RecallPreviewItem): number {
  return (a.created_at ?? '').localeCompare(b.created_at ?? '')
}

/**
 * Regroupement de secours, quand le service n'envoie pas `blocks`. Même règle
 * que le moteur (core/engine/recall-format.ts) : un thème n'a un bloc que
 * s'il réunit au moins deux souvenirs, le reste va dans un bloc sans titre.
 */
function groupByTopic(items: RecallPreviewItem[]): RecallPreviewBlock[] {
  const groups = new Map<string, RecallPreviewItem[]>()
  for (const item of items) {
    if (!item.topic) continue
    groups.set(item.topic.id, [...(groups.get(item.topic.id) ?? []), item])
  }
  const blocks: RecallPreviewBlock[] = []
  const loose: RecallPreviewItem[] = []
  for (const item of items) {
    const group = item.topic ? groups.get(item.topic.id) : undefined
    if (!item.topic || !group || group.length < 2) {
      loose.push(item)
      continue
    }
    if (blocks.some(b => b.topic_id === item.topic!.id)) continue
    const chrono = [...group].sort(byDate)
    blocks.push({
      title: item.topic.name,
      topic_id: item.topic.id,
      item_ids: chrono.map(i => i.id),
      latest_id: chrono[chrono.length - 1]!.id,
    })
  }
  if (loose.length > 0) blocks.push({ title: '', item_ids: loose.map(i => i.id), latest_id: loose[0]!.id, loose: true })
  return blocks
}

/**
 * Blocs prêts à afficher. On suit les blocs du moteur quand il en envoie
 * (c'est SON regroupement que l'agent reçoit), sinon on regroupe ici.
 *
 * Aucun souvenir ne disparaît : un souvenir qu'aucun bloc ne cite (réponse
 * incohérente) rejoint le bloc sans thème, plutôt que d'être caché à l'humain.
 */
export function viewBlocks(items: RecallPreviewItem[], blocks?: RecallPreviewBlock[]): ViewBlock[] {
  if (items.length === 0) return []
  const byId = new Map(items.map(i => [i.id, i]))
  const rank = new Map(items.map((i, idx) => [i.id, idx]))
  const placed = new Set<string>()
  const out: ViewBlock[] = []
  const looseItems: RecallPreviewItem[] = []

  for (const block of blocks ?? groupByTopic(items)) {
    const members = block.item_ids.map(id => byId.get(id)).filter((i): i is RecallPreviewItem => i !== undefined && !placed.has(i.id))
    if (members.length === 0) continue
    for (const m of members) placed.add(m.id)
    if (block.loose) {
      looseItems.push(...members)
      continue
    }
    const current = members.find(m => m.id === block.latest_id) ?? members[members.length - 1]!
    out.push({
      key: block.topic_id ?? `block-${out.length}`,
      title: block.title,
      loose: false,
      entities: block.entities ?? [],
      current,
      others: members.filter(m => m !== current),
    })
  }

  looseItems.push(...items.filter(i => !placed.has(i.id)))
  if (looseItems.length > 0) {
    // Sans thème commun, il n'y a pas d'histoire à raconter : l'ordre utile est celui du score.
    looseItems.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    out.push({ key: 'loose', title: '', loose: true, entities: [], current: null, others: looseItems })
  }
  return out
}

// ------------------------------------------------------- pourquoi ce souvenir

export interface ReasonChip {
  kind: RecallMatch
  /** Nom de l'entité de passage, pour un voisin de graphe. */
  entity?: string
}

/** Ordre d'affichage fixe : on lit toujours les raisons dans le même ordre. */
const REASON_ORDER: readonly RecallMatch[] = ['pinned', 'text', 'meaning', 'graph', 'context']

/** Raisons du match d'un souvenir : dédoublonnées, ordonnées, valeurs inconnues ignorées. */
export function reasonChips(item: Pick<RecallPreviewItem, 'matched_by' | 'via_entity'>): ReasonChip[] {
  const given = new Set<string>(item.matched_by ?? [])
  return REASON_ORDER.filter(kind => given.has(kind)).map(kind => {
    const entity = kind === 'graph' ? item.via_entity?.trim() : undefined
    return entity ? { kind, entity } : { kind }
  })
}

/** Libellé d'une raison, dans la langue de l'interface. */
export function reasonLabel(t: Translate, chip: ReasonChip): string {
  if (chip.kind === 'graph') return chip.entity ? t('agentview.why.graph_via', { entity: chip.entity }) : t('agentview.why.graph')
  return t(`agentview.why.${chip.kind}`)
}

const ORIGINS = new Set(['declared', 'extracted', 'inferred', 'confirmed'])

/** Clé i18n de l'origine (« dit par toi », « déduit »...) ; null si absente ou inconnue. */
export function originKey(origin: string | undefined): string | null {
  return origin && ORIGINS.has(origin) ? `agentview.origin.${origin}` : null
}

export type StatusKind = 'contested' | 'duplicate' | 'obsolete' | 'expiring' | 'replaces'

/**
 * Statuts à signaler sur un souvenir. La révision en attente précise le motif
 * (contesté, doublon, obsolète) ; `status: contested` seul reste « contesté ».
 * Un seul statut de révision : `revision` et `status` disent la même chose.
 */
export function statusKinds(item: Pick<RecallPreviewItem, 'revision' | 'status'>): StatusKind[] {
  const out: StatusKind[] = []
  if (item.revision) {
    out.push(item.revision.kind === 'duplicate' ? 'duplicate' : item.revision.kind === 'obsolete' ? 'obsolete' : 'contested')
  } else if (item.status === 'contested') {
    out.push('contested')
  }
  if (item.status === 'expiring') out.push('expiring')
  if (item.status === 'replaces') out.push('replaces')
  return out
}

// ------------------------------------------------------------------- score

/**
 * Score en pourcentage DU MEILLEUR souvenir du même rappel. Le score brut est
 * un produit non borné : il ne veut rien dire seul, seulement par rapport aux
 * autres. Un score positif garde au moins 2 % pour que la barre reste visible.
 */
export function scorePercent(score: number, best: number): number {
  if (!(best > 0) || !(score > 0)) return 0
  return Math.max(2, Math.min(100, Math.round((score / best) * 100)))
}

/** Meilleur score d'un rappel (0 s'il est vide). */
export function bestScore(items: readonly RecallPreviewItem[]): number {
  return items.reduce((max, i) => (i.score > max ? i.score : max), 0)
}

// ------------------------------------------------------------------ écartés

export type DroppedReason = 'cutoff' | 'budget' | 'limit' | 'other'

export interface DroppedSummary {
  total: number
  parts: Array<{ reason: DroppedReason; count: number }>
}

const DROPPED_ORDER: readonly DroppedReason[] = ['cutoff', 'budget', 'limit', 'other']

/** Souvenirs coupés, par motif. Un motif inconnu est compté sous « autre », jamais perdu. */
export function droppedSummary(dropped: readonly RecallPreviewDropped[]): DroppedSummary {
  const counts = new Map<DroppedReason, number>()
  for (const d of dropped) {
    if (!(d.count > 0)) continue
    const reason: DroppedReason = d.reason === 'cutoff' || d.reason === 'budget' || d.reason === 'limit' ? d.reason : 'other'
    counts.set(reason, (counts.get(reason) ?? 0) + d.count)
  }
  const parts = DROPPED_ORDER.filter(r => counts.has(r)).map(reason => ({ reason, count: counts.get(reason)! }))
  return { total: parts.reduce((n, p) => n + p.count, 0), parts }
}

// ------------------------------------------------------------------- résumé

export interface PreviewSummary {
  memories: number
  blocks: number
  dropped: number
  /**
   * Tokens du rendu que l'agent reçoit réellement. null en pause : le texte
   * natif est alors la réponse « en pause », pas celui du rappel décrit ici.
   */
  tokens: number | null
}

/**
 * Résumé d'une colonne. `preview.items`, `blocks` et `dropped` sont ceux du
 * rappel du rendu NATIF (voir normalizeRecallPreview) : les quatre chiffres
 * parlent donc du même rappel, celui de cet agent.
 */
export function previewSummary(preview: RecallPreview): PreviewSummary {
  return {
    memories: preview.items.length,
    // Seuls les blocs de THÈME comptent : le bac « autres » n'est pas une
    // structure, le compter affichait « 1 bloc » pour une liste à plat.
    blocks: viewBlocks(preview.items, preview.blocks).filter(b => !b.loose).length,
    dropped: droppedSummary(preview.dropped).total,
    tokens: preview.disabled ? null : renderTokens(preview.renders[preview.native], preview.native),
  }
}

/** Rendus à proposer : celui de l'agent d'abord, puis les autres dans l'ordre fixe. */
export function renderOrder(native: RecallRenderId, all: readonly RecallRenderId[]): RecallRenderId[] {
  return [native, ...all.filter(id => id !== native)]
}

// ---------------------------------------------------------------- sélection

/**
 * Coche ou décoche un agent. On garde l'ordre de `all` (les colonnes ne
 * sautent pas) et on refuse de vider la sélection : un écran de comparaison
 * sans aucun agent ne montre plus rien et ne dit pas pourquoi.
 */
export function toggleAgent(selected: readonly string[], id: string, all: readonly string[]): string[] {
  const next = selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id]
  if (next.length === 0) return [...selected]
  return all.filter(a => next.includes(a))
}
