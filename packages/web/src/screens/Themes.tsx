/**
 * Thèmes — la « carte » de ce que sait Memoria, agent par agent, rangé par
 * SUJET. Chaque thème est une carte (nom, nombre de souvenirs, jauge
 * d'importance) ; cliquer un thème montre ses souvenirs : on voit OÙ chaque
 * chose est rangée. La vue « Relations » dessine les thèmes qui partagent des
 * souvenirs ou des entités (graphe SVG pur, sans dépendance).
 *
 * Migré sur shadcn : PageHeader (sélecteur d'agent + affinage IA dans la
 * barre supérieure), Tabs liste / relations, SectionCard, EmptyState,
 * squelette au chargement, toasts pour l'affinage — voir UI-GUIDE.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutGrid, Loader2, Sparkles, Tags, Waypoints, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, getTopics, getTopicFacts, getTopicRelations, refineTopics, type AdminFact, type Topic, type TopicGraph } from '../api'
import { useAnalyzableAgents } from '../components/CogAgentSelect'
import { MemAgentPicker, MemNoAgentState } from '../components/MemAgentSelect'
import { EmptyState, ErrorBanner, PageHeader, SectionCard, Spinner, formatNumber, humanError, listPhase } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useT } from '../i18n'
import { categoryLabel } from '../lib/labels'
import { cn } from '../lib/utils'

type View = 'list' | 'graph'

// Seuil d'affichage : les thèmes à 1 souvenir forment une longue queue qu'on
// ne montre pas par défaut (même règle pour la liste et le graphe).
const MIN_FACTS = 2

export function Themes() {
  const { t } = useT()
  const ag = useAnalyzableAgents()
  const [topics, setTopics] = useState<Topic[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<Topic | null>(null)
  const [facts, setFacts] = useState<AdminFact[] | null>(null)
  const [factsError, setFactsError] = useState<string | null>(null)
  const [refining, setRefining] = useState(false)
  const [view, setView] = useState<View>('list')

  useEffect(() => {
    if (!ag.instance) return
    let cancelled = false
    setError(null)
    setTopics(null)
    setActive(null)
    setFacts(null)
    getTopics(ag.instance, MIN_FACTS)
      .then(ts => {
        if (!cancelled) setTopics(ts)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 404 = vieux service sans la route : état vide, pas une panne.
        if (err instanceof ApiError && err.status === 404) setTopics([])
        else setError(err instanceof ApiError ? err.message : humanError(err))
      })
    return () => {
      cancelled = true
    }
  }, [ag.instance, ag.tick])

  const openTopic = useCallback(
    async (topic: Topic) => {
      setActive(topic)
      setFacts(null)
      setFactsError(null)
      try {
        setFacts(await getTopicFacts(ag.instance, topic.id))
      } catch (err) {
        setFactsError(err instanceof ApiError ? err.message : t('themes.error_load'))
      }
    },
    [ag.instance, t],
  )

  const refine = useCallback(async () => {
    setRefining(true)
    try {
      const n = await refineTopics(ag.instance)
      if (n > 0) {
        const fresh = await getTopics(ag.instance, MIN_FACTS)
        setTopics(fresh)
        // Le thème ouvert garde son détail mais prend son nouveau nom.
        setActive(cur => (cur ? (fresh.find(x => x.id === cur.id) ?? cur) : cur))
        toast.success(t('themes.refined_toast', { count: formatNumber(n) }))
      } else {
        toast.info(t('themes.error_no_ai'))
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('themes.error_refine'))
    } finally {
      setRefining(false)
    }
  }, [ag.instance, t])

  const phase = listPhase(topics, error)
  const bannerError = ag.error ?? error

  return (
    <>
      <PageHeader
        title={t('themes.title')}
        description={t('themes.lead')}
        actions={
          <>
            {/* POURQUOI caché sous 640 px : la barre supérieure mobile (menu, marque,
                titre, préférences) n'a pas la place d'un libellé,
                et une icône « étincelle » seule ne dit pas qu'elle réécrit TOUS les
                libellés de l'agent. Sur mobile, le même bouton est rendu LIBELLÉ dans
                la carte « Thèmes de l'agent » (voir ThemeGrid). */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="hidden sm:inline-flex" disabled={refining || !ag.instance} onClick={() => void refine()}>
                  {refining ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                  {refining ? t('themes.refining') : t('themes.refine_button')}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('themes.refine_title')}</TooltipContent>
            </Tooltip>
          </>
        }
      >
        {/* Le sélecteur d'agent vit ICI sur les six écrans par agent : sous la
            phrase d'intro, jamais dans la barre supérieure (à 390 px il y
            écrasait le titre de l'écran). */}
        <MemAgentPicker id="themes-agent" agents={ag.agents} value={ag.instance} onChange={ag.setInstance} />
      </PageHeader>

      {bannerError && <ErrorBanner message={bannerError} onRetry={ag.retry} />}

      {ag.noAgent ? (
        <MemNoAgentState className="mx-auto w-full max-w-xl sm:py-8" />
      ) : phase === 'loading' ? (
        <ThemesSkeleton />
      ) : phase === 'failed' || topics === null ? null : topics.length === 0 ? (
        <EmptyState icon={<Tags className="size-5" />} title={t('themes.empty_title')} body={t('themes.empty_body')} className="mx-auto w-full max-w-xl sm:py-8" />
      ) : (
        <Tabs value={view} onValueChange={v => setView(v as View)} className="gap-4">
          <TabsList aria-label={t('themes.view_aria')}>
            <TabsTrigger value="list">
              <LayoutGrid aria-hidden="true" />
              {t('themes.view_tiles')}
            </TabsTrigger>
            <TabsTrigger value="graph">
              <Waypoints aria-hidden="true" />
              {t('themes.view_relations')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="flex flex-col gap-4">
            <ThemeGrid
              topics={topics}
              activeId={active?.id ?? null}
              onOpen={topic => void openTopic(topic)}
              refining={refining}
              onRefine={() => void refine()}
            />
            {active && (
              <ThemeDetail
                topic={active}
                facts={facts}
                error={factsError}
                onRetry={() => void openTopic(active)}
                onClose={() => setActive(null)}
              />
            )}
          </TabsContent>

          <TabsContent value="graph">
            <ThemeRelations
              instance={ag.instance}
              tick={ag.tick}
              // Le détail n'est rendu qu'en vue Liste : on y bascule, sinon le clic
              // lançait un GET sans rien changer à l'écran.
              onOpen={topic => {
                setView('list')
                void openTopic(topic)
              }}
            />
          </TabsContent>
        </Tabs>
      )}
    </>
  )
}

/** Squelette à la forme de la grille de thèmes : pas de saut visuel au chargement. */
function ThemesSkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-4" role="status" aria-label={t('common.loading')}>
      <Skeleton className="h-8 w-44 rounded-lg" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map(i => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

/** Grille des thèmes : une carte cliquable par thème, jauge = importance relative. */
function ThemeGrid({
  topics,
  activeId,
  onOpen,
  refining,
  onRefine,
}: {
  topics: Topic[]
  activeId: string | null
  onOpen: (topic: Topic) => void
  refining: boolean
  onRefine: () => void
}) {
  const { t } = useT()
  return (
    <SectionCard
      title={t('themes.list_title')}
      description={t('themes.list_hint')}
      actions={<Badge variant="secondary" className="tabular-nums">{formatNumber(topics.length)}</Badge>}
      className="mb-0"
      contentClassName="flex flex-col gap-3"
    >
      {/* Mobile : l'action « Affiner les libellés (IA) » avec son texte, plutôt
          qu'une icône seule dans la barre supérieure (elle y reste ≥ 640 px). */}
      <Button variant="outline" size="sm" className="w-full sm:hidden" disabled={refining} onClick={onRefine}>
        {refining ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
        {refining ? t('themes.refining') : t('themes.refine_button')}
      </Button>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {topics.map(topic => {
          const isActive = topic.id === activeId
          return (
            <button
              key={topic.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => onOpen(topic)}
              className={cn(
                'flex flex-col gap-2 rounded-xl bg-muted/40 p-3 text-left ring-1 ring-foreground/10 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60',
                isActive && 'bg-primary/10 ring-2 ring-primary hover:bg-primary/10',
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className={cn('text-sm leading-snug font-medium', isActive && 'text-primary')}>{topic.name}</span>
                <Badge variant={isActive ? 'default' : 'secondary'} className="shrink-0 tabular-nums">
                  {topic.fact_count > 1
                    ? t('themes.card_facts_plural', { count: formatNumber(topic.fact_count) })
                    : t('themes.card_facts', { count: formatNumber(topic.fact_count) })}
                </Badge>
              </span>
              {topic.keywords.length > 0 && <span className="truncate text-xs text-muted-foreground">{topic.keywords.slice(0, 4).join(' · ')}</span>}
            </button>
          )
        })}
      </div>
    </SectionCard>
  )
}

/** Souvenirs du thème ouvert, sous la grille (mots-clés en badges, un bloc par souvenir). */
function ThemeDetail({
  topic,
  facts,
  error,
  onRetry,
  onClose,
}: {
  topic: Topic
  facts: AdminFact[] | null
  error: string | null
  onRetry: () => void
  onClose: () => void
}) {
  const { t } = useT()
  const ref = useRef<HTMLDivElement>(null)
  // Le détail s'affiche SOUS la grille : sur mobile (une colonne) il serait hors
  // écran — on l'amène en haut de l'écran à chaque ouverture d'un thème. Sur
  // bureau, on ne bouge que s'il est hors de vue (la grille reste sous la main).
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 639px)').matches
    ref.current?.scrollIntoView({ block: narrow ? 'start' : 'nearest', behavior: 'smooth' })
  }, [topic.id])
  return (
    // scroll-mt : la barre supérieure est collante (56 px), le titre ne doit pas passer dessous.
    <div ref={ref} className="scroll-mt-16">
    <SectionCard
      title={topic.name}
      description={t('themes.detail_count', { count: formatNumber(topic.fact_count) })}
      actions={
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('common.close')}>
          <X aria-hidden="true" />
        </Button>
      }
      className="mb-0"
      contentClassName="flex flex-col gap-3"
    >
      {topic.keywords.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">{t('themes.keywords')}</span>
          {topic.keywords.slice(0, 8).map(k => (
            <Badge key={k} variant="secondary">
              {k}
            </Badge>
          ))}
        </div>
      )}
      {error ? (
        <ErrorBanner message={error} onRetry={onRetry} className="my-0" />
      ) : facts === null ? (
        <Spinner label={t('themes.loading_facts')} />
      ) : facts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('table.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {facts.map(f => (
            <li key={f.id} className="rounded-lg bg-muted/40 p-3">
              <p className="text-sm leading-relaxed">{f.fact}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <Badge variant="outline">{categoryLabel(t, f.category)}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
    </div>
  )
}

/**
 * Carte des relations entre thèmes : graphe circulaire SANS dépendance (SVG pur).
 * Deux thèmes reliés par une arête s'ils partagent des souvenirs ou des entités
 * (Néto, un client, un projet…). Épaisseur de l'arête = force du lien. Survol
 * ou focus d'un thème → ses liens ressortent ; clic / Entrée → ouvre ses
 * souvenirs (vue Liste). Couleurs = jetons (fill-primary, fill-foreground…)
 * pour rester lisible dans les deux thèmes.
 */
function ThemeRelations({ instance, tick, onOpen }: { instance: string; tick: number; onOpen: (topic: Topic) => void }) {
  const { t } = useT()
  const [graph, setGraph] = useState<TopicGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!instance) return
    let cancelled = false
    setGraph(null)
    setError(null)
    getTopicRelations(instance, MIN_FACTS)
      .then(g => {
        if (!cancelled) setGraph(g)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 404 = vieux service sans la route : état vide, pas une panne.
        if (err instanceof ApiError && err.status === 404) setGraph({ nodes: [], edges: [] })
        else setError(err instanceof ApiError ? err.message : humanError(err))
      })
    return () => {
      cancelled = true
    }
  }, [instance, tick, reloadTick])

  const layout = useMemo(() => {
    if (!graph) return null
    const n = graph.nodes.length
    // Marge de 130 : les libellés (jusqu'à 16 caractères + …) tiennent dans la
    // boîte de vue sans être coupés par le bord de la carte.
    const size = 600
    const cx = size / 2
    const cy = size / 2
    const R = size / 2 - 130
    const maxImp = Math.max(1, ...graph.nodes.map(x => x.importance_score))
    const pos = new Map<string, { x: number; y: number; r: number; topic: Topic; angle: number }>()
    graph.nodes.forEach((topic, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2
      pos.set(topic.id, {
        x: cx + R * Math.cos(angle),
        y: cy + R * Math.sin(angle),
        r: 7 + (topic.importance_score / maxImp) * 13,
        topic,
        angle,
      })
    })
    const maxW = Math.max(1, ...graph.edges.map(e => e.weight))
    return { size, pos, maxW }
  }, [graph])

  return (
    <SectionCard title={t('themes.relations_title')} description={t('themes.relations_hint')} className="mb-0">
      {error ? (
        <ErrorBanner message={error} onRetry={() => setReloadTick(x => x + 1)} className="my-0" />
      ) : graph === null || layout === null ? (
        <Spinner label={t('themes.loading_relations')} />
      ) : graph.edges.length === 0 ? (
        <EmptyState icon={<Waypoints className="size-5" />} title={t('themes.relations_empty_title')} body={t('themes.relations_empty_body')} className="mx-auto w-full max-w-xl sm:py-8" />
      ) : (
        <RelationsGraph graph={graph} layout={layout} hover={hover} setHover={setHover} onOpen={onOpen} />
      )}
    </SectionCard>
  )
}

function RelationsGraph({
  graph,
  layout,
  hover,
  setHover,
  onOpen,
}: {
  graph: TopicGraph
  layout: { size: number; pos: Map<string, { x: number; y: number; r: number; topic: Topic; angle: number }>; maxW: number }
  hover: string | null
  setHover: (id: string | null) => void
  onOpen: (topic: Topic) => void
}) {
  const { t } = useT()
  const { size, pos, maxW } = layout
  const strongest = graph.edges.slice(0, 8)
  const linked = (a: string, b: string) => graph.edges.some(e => (e.a === a && e.b === b) || (e.b === a && e.a === b))

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
      {/* Sous 480 px le graphe défile horizontalement dans sa carte : les libellés restent lisibles. */}
      <div className="overflow-x-auto px-4">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          role="group"
          aria-label={t('themes.graph_aria')}
          className="mx-auto h-auto w-full max-w-[520px] min-w-[440px] overflow-visible"
        >
          {graph.edges.map(e => {
            const pa = pos.get(e.a)
            const pb = pos.get(e.b)
            if (!pa || !pb) return null
            const lit = hover === null || hover === e.a || hover === e.b
            return (
              <line
                key={`${e.a}-${e.b}`}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                className="stroke-primary transition-opacity"
                strokeWidth={1 + (e.weight / maxW) * 5}
                strokeOpacity={lit ? 0.55 : 0.08}
                strokeLinecap="round"
              >
                <title>{e.via.length > 0 ? t('themes.edge_linked_by', { via: e.via.join(', ') }) : t('themes.edge_shared_facts', { count: e.shared_facts })}</title>
              </line>
            )
          })}
          {[...pos.values()].map(({ x, y, r, topic, angle }) => {
            const dim = hover !== null && hover !== topic.id && !linked(hover, topic.id)
            const focused = hover === topic.id
            const right = Math.cos(angle) >= 0
            return (
              <g
                key={topic.id}
                opacity={dim ? 0.25 : 1}
                role="button"
                tabIndex={0}
                aria-label={t('themes.node_open_aria', { name: topic.name })}
                onMouseEnter={() => setHover(topic.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(topic.id)}
                onBlur={() => setHover(null)}
                onClick={() => onOpen(topic)}
                onKeyDown={e => {
                  // accès clavier : Entrée / Espace = clic
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(topic)
                  }
                }}
                className="cursor-pointer outline-none transition-opacity"
              >
                {/* Anneau de focus / survol dessiné dans le SVG (l'outline CSS ne suit pas un <g>). */}
                {focused && <circle cx={x} cy={y} r={r + 4} className="fill-none stroke-ring" strokeWidth={2} />}
                <circle cx={x} cy={y} r={r} className="fill-primary" fillOpacity={focused ? 1 : 0.85} />
                <text
                  x={x + (right ? r + 6 : -(r + 6))}
                  y={y + 4}
                  textAnchor={right ? 'start' : 'end'}
                  className={cn('pointer-events-none fill-foreground text-[13px]', focused && 'font-medium')}
                >
                  {topic.name.length > 18 ? topic.name.slice(0, 16) + '…' : topic.name}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">{t('themes.strongest_links')}</h3>
        <ol className="flex flex-col gap-1.5 text-sm">
          {strongest.map(e => {
            const na = pos.get(e.a)?.topic.name ?? '?'
            const nb = pos.get(e.b)?.topic.name ?? '?'
            return (
              <li key={`${e.a}-${e.b}`} className="leading-snug">
                <span className="font-medium">{na}</span>
                <span className="mx-1 text-muted-foreground" aria-hidden="true">
                  ↔
                </span>
                <span className="font-medium">{nb}</span>
                <span className="text-muted-foreground">
                  {e.via.length > 0 ? t('themes.legend_via', { via: e.via.join(', ') }) : e.shared_facts > 0 ? t('themes.legend_shared', { count: e.shared_facts }) : ''}
                </span>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
