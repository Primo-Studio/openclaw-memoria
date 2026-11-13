/**
 * Carte — tous les souvenirs sur un plan, placés par leur SENS : deux points
 * proches parlent de la même chose (projection 2D des embeddings, calculée par
 * le service et gardée en cache). Ce n'est pas le graphe des relations : avec
 * 83 % de liens génériques, le dessiner donnait une pelote illisible. Les fils
 * n'apparaissent qu'au clic, pour UN souvenir (voisins par le sens + souvenirs
 * qui partagent une entité).
 *
 * Canvas 2D sans dépendance : les positions sont fixes, il n'y a rien à
 * simuler. Couleur = agent ou catégorie (ordre fixe : une couleur suit son
 * agent, pas son rang), taille = nombre de rappels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Loader2, Orbit, RefreshCw, X } from 'lucide-react'
import {
  ApiError,
  getMemoryMap,
  getMemoryMapLinks,
  rebuildMemoryMap,
  type MemoryMap,
  type MemoryMapLinks,
  type MemoryMapPoint,
} from '../api'
import { MemScreenButton, MemScreenLink } from '../components/MemScreenLink'
import { EmptyState, ErrorBanner, PageHeader, Spinner, agentTypeLabel, formatDay, formatNumber, humanError } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { useT } from '../i18n'
import { agentFullName } from '../lib/agent-name'
import { categoryLabel } from '../lib/labels'
import { useResolvedTheme } from '../lib/theme'
import { cn } from '../lib/utils'

type ColorBy = 'agent' | 'category'

/** Catégories connues, dans un ordre FIXE (la couleur ne dépend pas des données présentes). */
const CATEGORY_ORDER = ['preference', 'decision', 'process', 'config', 'error']
const SLOTS = 5
const OTHER = '__other__'
const POLL_MS = 3000
const HIT_RADIUS = 9

interface View {
  scale: number
  tx: number
  ty: number
}

interface Palette {
  slots: string[]
  neutral: string
  ink: string
  line: string
  surface: string
  accent: string
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    slots: [1, 2, 3, 4, 5].map(i => v(`--chart-${i}`, '#888')),
    neutral: v('--muted-foreground', '#888'),
    ink: v('--foreground', '#111'),
    line: v('--border', '#ccc'),
    surface: v('--card', '#fff'),
    accent: v('--primary', '#c04410'),
  }
}

/** Clé de couleur d'un point : agent, ou catégorie connue (sinon « autres »). */
function colorKey(p: Pick<MemoryMapPoint, 'agent' | 'category'>, by: ColorBy): string {
  if (by === 'agent') return p.agent
  const c = p.category.toLowerCase()
  return CATEGORY_ORDER.includes(c) ? c : OTHER
}

function radiusOf(p: MemoryMapPoint): number {
  return 2.6 + Math.min(3.6, Math.sqrt(p.recall_count) * 0.8)
}

// ------------------------------------------------- logique pure (testée sans rendu)

export interface LegendKey {
  key: string
  /** Indice de teinte, ou -1 pour le neutre. */
  slot: number
  count: number
}

/**
 * Entrées de légende avec leur teinte. La teinte suit l'ENTITÉ, pas sa place
 * dans la liste affichée : rang dans la liste complète triée des agents (même
 * ceux sans point placé), indice fixe pour les catégories. Sinon masquer une
 * série ou recalculer la carte faisait changer de couleur toutes les suivantes.
 * Les identifiants sont dédoublonnés : deux entrées de même clé donneraient
 * deux boutons identiques.
 */
export function legendKeys(
  points: ReadonlyArray<Pick<MemoryMapPoint, 'agent' | 'category'>>,
  agentIds: readonly string[],
  by: ColorBy,
): LegendKey[] {
  const counts = new Map<string, number>()
  for (const p of points) {
    const k = colorKey(p, by)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  // Au-delà du nombre de teintes, et pour « autres » : le neutre, jamais une teinte générée.
  const ranked = (by === 'agent' ? [...new Set(agentIds)].sort() : CATEGORY_ORDER).map((key, rank) => ({
    key,
    slot: rank < SLOTS ? rank : -1,
    count: counts.get(key) ?? 0,
  }))
  if (by === 'category') ranked.push({ key: OTHER, slot: -1, count: counts.get(OTHER) ?? 0 })
  return ranked.filter(l => l.count > 0)
}

/**
 * Jeton « dernière demande seulement » : une réponse lente à une demande
 * ancienne ne doit pas écraser la réponse à la demande en cours.
 */
export function latestGuard(): { begin: () => () => boolean } {
  let seq = 0
  return {
    begin() {
      const mine = ++seq
      return () => mine === seq
    },
  }
}

/** Seconde garde : des liens ne valent que pour le souvenir qu'ils décrivent. */
export function linksFor(links: MemoryMapLinks | null, selectedId: string | null): MemoryMapLinks | null {
  return links && selectedId !== null && links.id === selectedId ? links : null
}

/**
 * Fils à tracer : aucun si le souvenir choisi est masqué (légende, curseur de
 * temps), et jamais vers une cible masquée ou absente de la carte.
 */
export function drawableLinks(
  selectedId: string | null,
  links: MemoryMapLinks | null,
  visibleIds: ReadonlySet<string>,
): { neighbours: string[]; related: string[] } | null {
  const own = linksFor(links, selectedId)
  if (!own || selectedId === null || !visibleIds.has(selectedId)) return null
  return {
    neighbours: own.neighbours.map(n => n.id).filter(id => visibleIds.has(id)),
    related: own.related.map(r => r.id).filter(id => visibleIds.has(id)),
  }
}

export interface DragState {
  pointerId: number
  x: number
  y: number
  moved: boolean
}

/**
 * Un glisser ne part que du bouton principal, et d'un seul pointeur à la fois :
 * le clic droit ouvre le menu du navigateur (son relâchement n'arrive pas
 * toujours à la page), et un second doigt faisait sauter la carte.
 */
export function canStartDrag(e: { button: number; pointerId: number }, current: DragState | null): boolean {
  return e.button === 0 && (current === null || current.pointerId === e.pointerId)
}

/**
 * Glisser resté armé alors que le bouton principal n'est plus enfoncé :
 * relâchement jamais reçu, ou clic gauche relâché pendant qu'un autre bouton
 * reste tenu (le navigateur n'envoie alors aucun `pointerup`).
 */
export function dragAbandoned(e: { pointerId: number; buttons: number }, current: DragState | null): boolean {
  return current !== null && current.pointerId === e.pointerId && (e.buttons & 1) === 0
}

/**
 * Que faire d'un relâchement : rien (autre pointeur, pas de glisser), finir le
 * glisser, ou choisir le point sous le curseur. On ne choisit que sur le bouton
 * principal et sans déplacement : relâcher le clic droit ne sélectionne rien.
 */
export function releaseAction(
  e: { pointerId: number; button: number },
  current: DragState | null,
): 'ignore' | 'end' | 'select' {
  if (current === null || current.pointerId !== e.pointerId) return 'ignore'
  return !current.moved && e.button === 0 ? 'select' : 'end'
}

/** On ne redemande que pendant un calcul : une erreur attend une relance explicite. */
export function shouldPoll(status: MemoryMap['status'] | undefined): boolean {
  return status === 'computing'
}

/**
 * Redemande périodique, une demande à la fois : le délai ne repart qu'APRÈS la
 * réponse (ou l'échec). Avec un intervalle fixe, un service lent voyait les
 * demandes s'empiler. Renvoie la fonction d'arrêt.
 */
export function startPolling(run: () => Promise<unknown>, delayMs: number): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      run().then(schedule, schedule)
    }, delayMs)
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

export interface MapBanner {
  message: string
  /** Ce que fait « Réessayer » : relire la carte, ou relancer un calcul complet. */
  retry: 'load' | 'rebuild'
}

/**
 * Bandeaux d'erreur à montrer, les mêmes que la carte ait des points ou non :
 * sur une carte vide, un « Réessayer » en échec ne montrait rien.
 */
export function mapBanners(error: string | null, computeError: string | null): MapBanner[] {
  const out: MapBanner[] = []
  if (error) out.push({ message: error, retry: 'load' })
  if (computeError) out.push({ message: computeError, retry: 'rebuild' })
  return out
}

export interface LinkRow {
  id: string
  note: string
  /** Faux si le souvenir est masqué (légende, curseur de temps) : affiché, pas cliquable. */
  shown: boolean
}

/**
 * Lignes du panneau : un voisin absent de la carte est omis ; un voisin masqué
 * reste listé mais non cliquable (l'ouvrir donnait un panneau sans anneau ni
 * fil sur la carte).
 */
export function linkRows(
  items: ReadonlyArray<{ id: string; note: string }>,
  knownIds: { has(id: string): boolean },
  visibleIds: ReadonlySet<string>,
): LinkRow[] {
  return items.filter(i => knownIds.has(i.id)).map(i => ({ ...i, shown: visibleIds.has(i.id) }))
}

/** Point survolé : seulement s'il passe encore les filtres ET la recherche. */
export function hoverTarget(hoverId: string | null, matchingIds: ReadonlySet<string>): string | null {
  return hoverId !== null && matchingIds.has(hoverId) ? hoverId : null
}

export function MemoryMapScreen() {
  const { t } = useT()
  const theme = useResolvedTheme()
  const [map, setMap] = useState<MemoryMap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [colorBy, setColorBy] = useState<ColorBy>('agent')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [until, setUntil] = useState(100)
  // Des identifiants, pas des objets : après un recalcul les points changent de
  // place, et un objet gardé ici dessinait l'anneau à l'ancienne position.
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rawLinks, setLinks] = useState<MemoryMapLinks | null>(null)
  const [linksError, setLinksError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 })
  const [size, setSize] = useState({ w: 800, h: 560 })
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<DragState | null>(null)
  const [linksGuard] = useState(latestGuard)
  const [loadGuard] = useState(latestGuard)

  // Jeton « dernière demande » : la réponse lente d'une lecture ancienne (encore
  // « computing ») ne doit pas écraser une réponse plus récente (« ready », « error »).
  const load = useCallback((): Promise<void> => {
    const current = loadGuard.begin()
    return getMemoryMap()
      .then(m => {
        if (!current()) return
        setMap(m)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!current()) return
        // 404 = service plus ancien que cette interface : pas une panne.
        if (err instanceof ApiError && err.status === 404) setError(t('map.error.old_service'))
        else setError(humanError(err))
      })
  }, [t, loadGuard])

  useEffect(() => {
    void load()
  }, [load])

  // Tant que le service calcule, on redemande : la carte arrive toute seule.
  useEffect(() => {
    if (!shouldPoll(map?.status)) return
    return startPolling(load, POLL_MS)
  }, [map?.status, load])

  // Le canvas suit la largeur de son conteneur.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [map?.status])

  const points = useMemo(() => map?.points ?? [], [map])

  // Bornes de dates pour le curseur de temps.
  const [minTs, maxTs] = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const p of points) {
      const ts = Date.parse(p.created_at)
      if (Number.isNaN(ts)) continue
      if (ts < lo) lo = ts
      if (ts > hi) hi = ts
    }
    return lo === Infinity ? [0, 0] : [lo, hi]
  }, [points])
  const cutoff = until >= 100 ? Infinity : minTs + ((maxTs - minTs) * until) / 100

  // Légende : une entrée par agent (ordre stable par identifiant) ou par catégorie (ordre fixe).
  const legend = useMemo(() => {
    const agents = map?.agents ?? []
    return legendKeys(points, agents.map(a => a.id), colorBy).map(l => {
      const agent = agents.find(a => a.id === l.key)
      const label =
        colorBy === 'agent'
          ? agent
            ? agent.type === 'shared'
              ? t('map.shared', { name: agent.name })
              : agentFullName(agent.name, agent.type)
            : agentTypeLabel('generic')
          : l.key === OTHER
            ? t('map.other')
            : categoryLabel(t, l.key)
      return { ...l, label }
    })
  }, [points, colorBy, map, t])

  const slotOf = useMemo(() => new Map(legend.map(l => [l.key, l.slot])), [legend])
  const needle = query.trim().toLowerCase()

  const visible = useMemo(
    () =>
      points.filter(p => {
        if (hidden.has(colorKey(p, colorBy))) return false
        const ts = Date.parse(p.created_at)
        return Number.isNaN(ts) || ts <= cutoff
      }),
    [points, hidden, colorBy, cutoff],
  )
  const matching = useMemo(
    () => (needle ? visible.filter(p => p.label.toLowerCase().includes(needle)) : visible),
    [visible, needle],
  )

  // Monde [-1, 1] → pixels. Même échelle sur x et y : les distances restent lisibles.
  const toScreen = useCallback(
    (p: { x: number; y: number }): [number, number] => {
      const base = (Math.min(size.w, size.h) / 2 - 24) * view.scale
      return [size.w / 2 + view.tx + p.x * base, size.h / 2 + view.ty - p.y * base]
    },
    [size, view],
  )

  const byId = useMemo(() => new Map(points.map(p => [p.id, p])), [points])
  const visibleIds = useMemo(() => new Set(visible.map(p => p.id)), [visible])
  // Dérivés de la carte courante : positions toujours à jour, null si le point a disparu.
  const selected = selectedId !== null ? (byId.get(selectedId) ?? null) : null
  // Survol limité aux points qui passent la recherche : si elle change pendant
  // un survol, l'anneau et l'infobulle ne restent pas sur un point estompé.
  const matchingIds = useMemo(() => new Set(matching.map(p => p.id)), [matching])
  const shownHoverId = hoverTarget(hoverId, matchingIds)
  const hover = shownHoverId !== null ? (byId.get(shownHoverId) ?? null) : null
  const links = linksFor(rawLinks, selectedId)

  // Le souvenir choisi n'est plus sur la carte (remplacé ou supprimé avant un
  // recalcul) : on ferme le panneau plutôt que de montrer un fantôme.
  useEffect(() => {
    if (!map || selectedId === null || byId.has(selectedId)) return
    linksGuard.begin()
    setSelectedId(null)
    setLinks(null)
    setLinksError(null)
  }, [map, byId, selectedId, linksGuard])

  // ------------------------------------------------------------------ dessin
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pal = readPalette()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const colorOf = (p: MemoryMapPoint): string => {
      const slot = slotOf.get(colorKey(p, colorBy)) ?? -1
      return slot < 0 ? pal.neutral : pal.slots[slot]!
    }
    const matchSet = needle ? new Set(matching.map(p => p.id)) : null

    // Les fils du souvenir choisi, SOUS les points. Rien si lui-même est masqué.
    const threads = drawableLinks(selectedId, links, visibleIds)
    const shownSelected = selected && visibleIds.has(selected.id) ? selected : null
    if (shownSelected && threads) {
      const [sx, sy] = toScreen(shownSelected)
      const draw = (id: string, dashed: boolean, color: string): void => {
        const target = byId.get(id)
        if (!target) return
        const [x, y] = toScreen(target)
        ctx.beginPath()
        ctx.setLineDash(dashed ? [4, 4] : [])
        ctx.moveTo(sx, sy)
        ctx.lineTo(x, y)
        ctx.strokeStyle = color
        ctx.lineWidth = dashed ? 1 : 1.5
        ctx.stroke()
      }
      for (const id of threads.related) draw(id, true, pal.neutral)
      for (const id of threads.neighbours) draw(id, false, pal.ink)
      ctx.setLineDash([])
    }

    const linked = new Set<string>(threads ? [...threads.neighbours, ...threads.related] : [])
    for (const p of visible) {
      const [x, y] = toScreen(p)
      if (x < -10 || y < -10 || x > size.w + 10 || y > size.h + 10) continue
      const dim = matchSet ? !matchSet.has(p.id) : shownSelected ? p.id !== shownSelected.id && !linked.has(p.id) : false
      ctx.globalAlpha = dim ? 0.14 : 0.85
      ctx.beginPath()
      ctx.arc(x, y, radiusOf(p), 0, Math.PI * 2)
      ctx.fillStyle = colorOf(p)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Anneau de surface + contour : le point survolé / choisi se détache des voisins.
    // `hover` est déjà limité aux points trouvés ; un point masqué ou estompé n'a pas d'anneau.
    for (const p of [hover, shownSelected]) {
      if (!p) continue
      const [x, y] = toScreen(p)
      const r = radiusOf(p) + 3
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.strokeStyle = pal.surface
      ctx.lineWidth = 4
      ctx.stroke()
      ctx.strokeStyle = pal.ink
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [visible, visibleIds, matching, needle, size, toScreen, colorBy, slotOf, hover, selected, selectedId, links, byId, theme])

  // ------------------------------------------------------------ interactions
  const pointAt = useCallback(
    (cx: number, cy: number): MemoryMapPoint | null => {
      let best: MemoryMapPoint | null = null
      let bestD = HIT_RADIUS * HIT_RADIUS
      for (const p of matching) {
        const [x, y] = toScreen(p)
        const d = (x - cx) ** 2 + (y - cy) ** 2
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      return best
    },
    [matching, toScreen],
  )

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const select = useCallback(
    (id: string | null) => {
      // Jeton pris AVANT tout, même pour une fermeture : la réponse tardive
      // d'un autre souvenir ne doit ni remplir le panneau ni afficher son erreur.
      const current = linksGuard.begin()
      setSelectedId(id)
      setLinks(null)
      setLinksError(null)
      if (id === null) return
      getMemoryMapLinks(id)
        .then(l => {
          if (current()) setLinks(l)
        })
        .catch((err: unknown) => {
          if (current()) setLinksError(humanError(err))
        })
    },
    [linksGuard],
  )

  // Molette = zoom autour du curseur. Écouteur natif : React attache `wheel`
  // en passif, on ne pourrait pas empêcher la page de défiler.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left - size.w / 2
      const cy = e.clientY - rect.top - size.h / 2
      setView(v => {
        const scale = Math.min(40, Math.max(0.6, v.scale * Math.exp(-e.deltaY * 0.0015)))
        const k = scale / v.scale
        return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [size, map?.status])

  const rebuild = (): void => {
    rebuildMemoryMap()
      .then(load)
      .catch((err: unknown) => setError(humanError(err)))
  }
  const retryOf = { load: () => void load(), rebuild }

  const toggle = (key: string): void =>
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const palette = useMemo(readPalette, [theme])
  const computing = map?.status === 'computing'
  const hasPoints = points.length > 0
  // Calcul en échec : le service ne relance plus tout seul, on montre pourquoi
  // et on laisse la main (« Réessayer » relance un calcul complet).
  const computeError =
    map?.status === 'error'
      ? map.error
        ? t('map.error.compute_detail', { detail: map.error })
        : t('map.error.compute')
      : null

  const header = (
    <PageHeader
      title={t('map.title')}
      description={t('map.intro')}
      actions={
        hasPoints || computing || computeError ? (
          <Button variant="outline" size="sm" onClick={rebuild} disabled={computing}>
            {computing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {computing ? t('map.computing') : t('map.rebuild')}
          </Button>
        ) : undefined
      }
    />
  )

  if (error && !map) {
    return (
      <>
        {header}
        <ErrorBanner message={error} onRetry={retryOf.load} />
      </>
    )
  }
  if (!map) {
    return (
      <>
        {header}
        <Spinner />
      </>
    )
  }
  if (map.status === 'no-embeddings') {
    return (
      <>
        {header}
        <EmptyState
          icon={<Orbit aria-hidden="true" />}
          title={t('map.no_embeddings.title')}
          body={t('map.no_embeddings.body')}
          action={<MemScreenButton screen="settings" label={t('map.no_embeddings.cta')} />}
        />
      </>
    )
  }
  const banners = mapBanners(error, computeError).map(b => (
    <ErrorBanner key={b.retry} message={b.message} onRetry={retryOf[b.retry]} />
  ))

  if (!hasPoints) {
    return (
      <>
        {header}
        {banners}
        {computeError ? null : computing ? (
          <Spinner label={t('map.computing_first')} />
        ) : (
          <EmptyState icon={<Orbit aria-hidden="true" />} title={t('map.empty.title')} body={t('map.empty.body')} />
        )}
      </>
    )
  }

  const shownLabel = hover ?? null
  const [hx, hy] = shownLabel ? toScreen(shownLabel) : [0, 0]

  return (
    <>
      {header}
      {banners}

      {/* Filtres : une seule rangée, au-dessus de la carte. */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs value={colorBy} onValueChange={v => { setColorBy(v as ColorBy); setHidden(new Set()) }}>
          <TabsList aria-label={t('map.color_by')}>
            <TabsTrigger value="agent">{t('map.color.agent')}</TabsTrigger>
            <TabsTrigger value="category">{t('map.color.category')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('map.search')}
          aria-label={t('map.search')}
          className="h-9 w-56"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{until >= 100 ? t('map.all_dates') : t('map.until', { date: formatDay(new Date(cutoff).toISOString()) })}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={until}
            onChange={e => setUntil(Number(e.target.value))}
            aria-label={t('map.time_slider')}
            className="w-40 accent-primary"
          />
        </label>
        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {t('map.count', { shown: formatNumber(matching.length), total: formatNumber(points.length) })}
          {map.unplaced > 0 && ` · ${t('map.unplaced', { count: formatNumber(map.unplaced) })}`}
        </span>
      </div>

      {/* Légende cliquable : masque / affiche une série. */}
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('map.legend')}>
        {legend.map(l => (
          <button
            key={l.key}
            type="button"
            onClick={() => toggle(l.key)}
            aria-pressed={!hidden.has(l.key)}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm transition-opacity',
              hidden.has(l.key) && 'opacity-45',
            )}
          >
            <span
              className="size-2.5 rounded-full"
              style={{ background: l.slot < 0 ? palette.neutral : palette.slots[l.slot] }}
              aria-hidden="true"
            />
            <span>{l.label}</span>
            <span className="text-muted-foreground tabular-nums">{formatNumber(l.count)}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="overflow-hidden p-0">
          <div ref={wrapRef} className="relative h-[560px] w-full">
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={t('map.canvas_label', { count: formatNumber(matching.length) })}
              className={cn('block size-full touch-none', hover ? 'cursor-pointer' : 'cursor-grab')}
              style={{ width: size.w, height: size.h }}
              onPointerDown={e => {
                if (!canStartDrag(e, drag.current)) return
                const [x, y] = local(e)
                drag.current = { pointerId: e.pointerId, x, y, moved: false }
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={e => {
                const [x, y] = local(e)
                // Relâchement jamais reçu (menu du navigateur, perte de focus) :
                // sans cela la carte suivait le curseur sans bouton enfoncé.
                if (dragAbandoned(e, drag.current)) drag.current = null
                const d = drag.current
                if (d) {
                  if (d.pointerId !== e.pointerId) return
                  const dx = x - d.x
                  const dy = y - d.y
                  if (d.moved || Math.abs(dx) + Math.abs(dy) > 3) {
                    d.moved = true
                    d.x = x
                    d.y = y
                    setView(v => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }))
                  }
                  return
                }
                setHoverId(pointAt(x, y)?.id ?? null)
              }}
              onPointerUp={e => {
                const action = releaseAction(e, drag.current)
                if (action === 'ignore') return
                drag.current = null
                if (action !== 'select') return
                const [x, y] = local(e)
                select(pointAt(x, y)?.id ?? null)
              }}
              onPointerCancel={e => {
                if (drag.current?.pointerId === e.pointerId) drag.current = null
              }}
              onLostPointerCapture={e => {
                if (drag.current?.pointerId === e.pointerId) drag.current = null
              }}
              onPointerLeave={() => setHoverId(null)}
            />
            {shownLabel && (
              <div
                className="pointer-events-none absolute z-10 max-w-xs rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                style={{ left: Math.min(hx + 14, size.w - 300), top: Math.min(hy + 14, size.h - 96) }}
              >
                <p className="line-clamp-4">{shownLabel.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {legendLabel(legend, colorKey(shownLabel, 'agent'), map, t)} · {formatDay(shownLabel.created_at)}
                </p>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="absolute right-3 bottom-3"
              onClick={() => setView({ scale: 1, tx: 0, ty: 0 })}
            >
              <Crosshair aria-hidden="true" />
              {t('map.reset_view')}
            </Button>
          </div>
        </Card>

        <Card>
          <CardContent className="space-y-3 text-sm">
            {!selected && <p className="text-muted-foreground">{t('map.detail.hint')}</p>}
            {selected && (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{categoryLabel(t, selected.category)}</Badge>
                    <Badge variant="outline">{legendLabel(legend, selected.agent, map, t)}</Badge>
                  </div>
                  <Button variant="ghost" size="icon-xs" onClick={() => select(null)} aria-label={t('common.close')}>
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <p className="leading-relaxed">{links?.content ?? selected.label}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDay(selected.created_at)} · {t('map.detail.recalls', { count: formatNumber(selected.recall_count) })}
                </p>
                {linksError && <ErrorBanner message={linksError} />}
                {!links && !linksError && <Spinner />}
                {links && links.entities.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {links.entities.map(name => (
                      <Badge key={name} variant="outline">
                        {name}
                      </Badge>
                    ))}
                  </div>
                )}
                {links && (
                  <LinkList
                    title={t('map.detail.neighbours')}
                    empty={t('map.detail.no_neighbours')}
                    items={links.neighbours.map(n => ({ id: n.id, note: `${Math.round(n.similarity * 100)} %` }))}
                    byId={byId}
                    visibleIds={visibleIds}
                    hiddenLabel={t('map.detail.hidden')}
                    onPick={select}
                  />
                )}
                {links && links.related.length > 0 && (
                  <LinkList
                    title={t('map.detail.related')}
                    empty=""
                    items={links.related.map(r => ({ id: r.id, note: r.via }))}
                    byId={byId}
                    visibleIds={visibleIds}
                    hiddenLabel={t('map.detail.hidden')}
                    onPick={select}
                  />
                )}
                <MemScreenLink screen="memory" label={t('map.open_memory')} />
              </>
            )}
          </CardContent>
        </Card>
      </div>
      {map.computed_at && (
        <p className="mt-2 text-xs text-muted-foreground">{t('map.computed_at', { date: formatDay(map.computed_at) })}</p>
      )}
    </>
  )
}

/** Nom d'un agent pour l'infobulle et le panneau, quelle que soit la coloration active. */
function legendLabel(
  legend: Array<{ key: string; label: string }>,
  agentId: string,
  map: MemoryMap,
  t: ReturnType<typeof useT>['t'],
): string {
  const agent = map.agents.find(a => a.id === agentId)
  if (!agent) return legend.find(l => l.key === agentId)?.label ?? agentTypeLabel('generic')
  return agent.type === 'shared' ? t('map.shared', { name: agent.name }) : agentFullName(agent.name, agent.type)
}

function LinkList({
  title,
  empty,
  items,
  byId,
  visibleIds,
  hiddenLabel,
  onPick,
}: {
  title: string
  empty: string
  items: Array<{ id: string; note: string }>
  byId: Map<string, MemoryMapPoint>
  visibleIds: ReadonlySet<string>
  hiddenLabel: string
  onPick: (id: string) => void
}) {
  const rows = linkRows(items, byId, visibleIds)
  return (
    <div>
      <h3 className="mb-1.5 font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map(i => {
            const p = byId.get(i.id)!
            const body = (
              <>
                <span className="line-clamp-2">{p.label}</span>
                <span className="text-xs text-muted-foreground">{i.shown ? i.note : `${i.note} · ${hiddenLabel}`}</span>
              </>
            )
            return (
              <li key={`${i.id}-${i.note}`}>
                {i.shown ? (
                  <button
                    type="button"
                    onClick={() => onPick(p.id)}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="px-2 py-1.5 opacity-60">{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
