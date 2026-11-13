/**
 * Ce que voit l'IA : on tape une question, et on VOIT, agent par agent, ce
 * que la mémoire lui donnerait, et pourquoi.
 *
 * POURQUOI cet écran : le rappel était une boîte noire. L'écran Mémoire
 * cherche dans TOUS les souvenirs avec les droits de l'administrateur ; il ne
 * dit pas ce qu'un agent précis reçoit après ses filtres (partage, client,
 * budget, seuil). Ici le service exécute le VRAI rappel de chaque agent, en
 * aperçu : rien n'est compté ni journalisé (POST /v1/admin/recall_preview).
 *
 * Deux lectures du rappel de l'agent :
 *  - « Lisible » : les blocs par thème, l'état actuel en avant, et pour chaque
 *    souvenir les raisons de sa présence. Elle lit le résultat du rendu NATIF
 *    de l'agent (un agent OpenClaw n'a pas le même rappel qu'un agent MCP) ;
 *  - « Exactement ce qu'elle reçoit » : le texte brut envoyé à l'agent, et
 *    celui des autres formats, chacun avec son propre compte de tokens.
 *
 * La logique (regroupement, libellés, tokens) vit dans agentViewLogic.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Bot,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  Eye,
  FolderOpen,
  History,
  Lightbulb,
  MessageSquareQuote,
  Pause,
  Pin,
  Replace,
  Scissors,
  Sparkles,
  Tags,
  TextSearch,
  TriangleAlert,
  UserCheck,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import {
  ApiError,
  RECALL_RENDER_IDS,
  getAgents,
  getControl,
  isOldServiceError,
  previewRecall,
  type AgentEntry,
  type RecallMatch,
  type RecallPreview,
  type RecallPreviewItem,
  type RecallRenderId,
} from '../api'
import { MemNoAgentState, agentOptionLabel } from '../components/MemAgentSelect'
import { MemScreenLink } from '../components/MemScreenLink'
import { CopyButton, EmptyState, ErrorBanner, PageHeader, formatDay, formatNumber, humanError } from '../components/ui'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { useAgentNamer } from '../lib/agent-name'
import { isLiveAgent } from '../lib/agents'
import { categoryLabel } from '../lib/labels'
import { cn } from '../lib/utils'
import {
  bestScore,
  droppedSummary,
  originKey,
  previewSummary,
  reasonChips,
  reasonLabel,
  renderOrder,
  renderTokens,
  scorePercent,
  statusKinds,
  toggleAgent,
  viewBlocks,
  type StatusKind,
  type ViewBlock,
} from './agentViewLogic'

export type View = 'readable' | 'exact'

export type Run =
  | { status: 'loading' }
  | { status: 'ready'; preview: RecallPreview }
  /** `old` : le service ne connaît pas la route (404), réessayer ne sert à rien. */
  | { status: 'error'; message: string; old: boolean }

const EXAMPLES = ['agentview.example.1', 'agentview.example.2', 'agentview.example.3'] as const

// Une icône par raison : la pastille se lit sans la couleur (daltonisme, impression).
const REASON_ICONS: Record<RecallMatch, LucideIcon> = {
  text: TextSearch,
  meaning: Sparkles,
  graph: Waypoints,
  context: FolderOpen,
  pinned: Pin,
}

const ORIGIN_ICONS: Record<string, LucideIcon> = {
  declared: UserCheck,
  extracted: MessageSquareQuote,
  inferred: Lightbulb,
  confirmed: CircleCheck,
}

const STATUS_ICONS: Record<StatusKind, LucideIcon> = {
  contested: TriangleAlert,
  duplicate: TriangleAlert,
  obsolete: TriangleAlert,
  expiring: History,
  replaces: Replace,
}

export function AgentView() {
  const { t } = useT()
  const nameOf = useAgentNamer()
  const [agents, setAgents] = useState<AgentEntry[] | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [agentsTick, setAgentsTick] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [paused, setPaused] = useState(false)
  const [draft, setDraft] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [view, setView] = useState<View>('readable')
  // Numéro de la question en cours : une réponse arrivée après une nouvelle
  // question ne doit pas écraser les colonnes de la nouvelle.
  const generation = useRef(0)

  useEffect(() => {
    let cancelled = false
    getAgents()
      .then(all => {
        if (cancelled) return
        const live = all.filter(isLiveAgent)
        setAgentsError(null)
        setAgents(live)
        // Tous les agents par défaut : l'écran sert d'abord à comparer.
        setSelected(cur => {
          const kept = cur.filter(id => live.some(a => a.instance.id === id))
          return kept.length > 0 ? kept : live.map(a => a.instance.id)
        })
      })
      .catch((err: unknown) => {
        if (!cancelled) setAgentsError(err instanceof ApiError ? err.message : humanError(err))
      })
    // La pause n'empêche pas de regarder, mais change la réponse : on la dit.
    // Si l'état est illisible, on ne dit rien plutôt que d'inventer.
    getControl()
      .then(c => {
        if (!cancelled) setPaused(c.enabled === false)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agentsTick])

  const load = useCallback(
    (ids: string[], query: string, gen: number) => {
      if (ids.length === 0) return
      setRuns(cur => ({ ...cur, ...Object.fromEntries(ids.map(id => [id, { status: 'loading' } as Run])) }))
      for (const id of ids) {
        const type = agents?.find(a => a.instance.id === id)?.assistant_type
        previewRecall(id, query, type)
          .then(preview => {
            if (generation.current === gen) setRuns(cur => ({ ...cur, [id]: { status: 'ready', preview } }))
          })
          .catch((err: unknown) => {
            if (generation.current !== gen) return
            const old = isOldServiceError(err)
            const message = err instanceof ApiError ? err.message : humanError(err)
            setRuns(cur => ({ ...cur, [id]: { status: 'error', message, old } }))
          })
      }
    },
    [agents],
  )

  const ask = useCallback(
    (raw: string) => {
      const query = raw.trim()
      if (!query) return
      generation.current += 1
      setDraft(query)
      setAsked(query)
      setRuns({})
      load(selected, query, generation.current)
    },
    [load, selected],
  )

  // Question passée dans l'adresse (?q=…) : posée une fois, dès que les agents
  // sont connus. Sert aux liens depuis d'autres écrans et aux captures de la démo.
  const autoAsked = useRef(false)
  useEffect(() => {
    if (autoAsked.current || selected.length === 0) return
    const q = new URLSearchParams(window.location.search).get('q')?.trim()
    autoAsked.current = true
    if (q) ask(q)
  }, [selected, ask])

  const toggle = useCallback(
    (id: string) => {
      const all = (agents ?? []).map(a => a.instance.id)
      const next = toggleAgent(selected, id, all)
      setSelected(next)
      // Un agent ajouté après la question reçoit la même question, sans tout relancer.
      if (asked && next.includes(id) && !runs[id]) load([id], asked, generation.current)
    },
    [agents, asked, load, runs, selected],
  )

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    ask(draft)
  }

  const columns = useMemo(() => (agents ?? []).filter(a => selected.includes(a.instance.id)), [agents, selected])
  const oldService = columns.some(a => {
    const run = runs[a.instance.id]
    return run?.status === 'error' && run.old
  })
  const noAgent = agents !== null && agents.length === 0

  return (
    <>
      <PageHeader title={t('agentview.title')} description={t('agentview.intro')} />

      {agentsError && <ErrorBanner message={agentsError} onRetry={() => setAgentsTick(n => n + 1)} />}

      {paused && (
        <Alert className="mb-4 text-warning">
          <Pause aria-hidden="true" />
          <AlertTitle>{t('agentview.paused.title')}</AlertTitle>
          <AlertDescription>
            {t('agentview.paused.body')} <MemScreenLink screen="settings" label={t('common.open_screen', { screen: t('nav.settings') })} />
          </AlertDescription>
        </Alert>
      )}

      {noAgent ? (
        <MemNoAgentState className="mx-auto w-full max-w-xl sm:py-8" />
      ) : agents === null ? (
        agentsError ? null : (
          <Skeleton className="h-24 w-full" />
        )
      ) : (
        <>
          <form onSubmit={onSubmit} className="mb-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agentview-question">{t('agentview.question_label')}</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="agentview-question"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  placeholder={t('agentview.question_placeholder')}
                  autoComplete="off"
                  className="sm:flex-1"
                />
                <Button type="submit" disabled={draft.trim().length === 0}>
                  <Eye aria-hidden="true" />
                  {t('agentview.submit')}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('agentview.examples')}</span>
              {EXAMPLES.map(key => (
                <Button key={key} type="button" variant="outline" size="sm" className="h-auto min-h-7 py-1 whitespace-normal" onClick={() => ask(t(key))}>
                  {t(key)}
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap items-end justify-between gap-3">
              {agents.length > 1 && (
                <div role="group" aria-label={t('agentview.agents_label')} className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">{t('agentview.agents_label')}</span>
                  <div className="flex flex-wrap gap-2">
                    {agents.map(a => {
                      const on = selected.includes(a.instance.id)
                      return (
                        <Button
                          key={a.instance.id}
                          type="button"
                          size="sm"
                          variant={on ? 'secondary' : 'outline'}
                          aria-pressed={on}
                          className={cn(!on && 'text-muted-foreground')}
                          onClick={() => toggle(a.instance.id)}
                        >
                          {/* La coche, pas la teinte, dit que l'agent est retenu. */}
                          {on ? <Check aria-hidden="true" /> : <Bot aria-hidden="true" />}
                          {agentOptionLabel(a, agents, t, nameOf)}
                        </Button>
                      )
                    })}
                  </div>
                </div>
              )}
              <ViewSwitch view={view} onChange={setView} />
            </div>
          </form>

          {asked === null ? (
            <EmptyState icon={<Eye className="size-5" />} title={t('agentview.empty.title')} body={t('agentview.empty.body')} />
          ) : oldService ? (
            <ErrorBanner message={t('agentview.error.old_service')} />
          ) : (
            // Colonnes côte à côte sur grand écran : la comparaison se fait d'un regard.
            <div className={cn('grid gap-4', columns.length === 2 && 'lg:grid-cols-2', columns.length >= 3 && 'lg:grid-cols-2 2xl:grid-cols-3')}>
              {columns.map(a => (
                <AgentColumn
                  key={a.instance.id}
                  name={agentOptionLabel(a, agents, t, nameOf)}
                  run={runs[a.instance.id] ?? { status: 'loading' }}
                  view={view}
                  onRetry={() => load([a.instance.id], asked, generation.current)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------- choix de la vue

const VIEWS: readonly View[] = ['readable', 'exact']

/**
 * Choix entre « Lisible » et « Exactement ce qu'elle reçoit ».
 *
 * POURQUOI des boutons à bascule et pas des onglets : un onglet promet un
 * panneau (`aria-controls`), or ce choix change la lecture de TOUTES les
 * colonnes à la fois, il n'y a pas un panneau par onglet. Des onglets sans
 * panneau annonçaient un lien vers rien, et leur liste n'avait pas de nom.
 * Même motif que le choix des agents juste à côté : groupe nommé, `aria-pressed`.
 */
export function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const { t } = useT()
  return (
    <div role="group" aria-label={t('agentview.view_label')} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{t('agentview.view_label')}</span>
      <div className="flex flex-wrap gap-2">
        {VIEWS.map(v => {
          const on = view === v
          return (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={on ? 'secondary' : 'outline'}
              aria-pressed={on}
              className={cn('h-auto min-h-8 py-1 whitespace-normal', !on && 'text-muted-foreground')}
              onClick={() => onChange(v)}
            >
              {/* La coche, pas la teinte, dit quelle vue est active. */}
              {on && <Check aria-hidden="true" />}
              {t(`agentview.view.${v}`)}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ colonne

export function AgentColumn({ name, run, view, onRetry }: { name: string; run: Run; view: View; onRetry: () => void }) {
  const { t } = useT()
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{name}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {run.status === 'loading' ? (
          <div role="status" aria-label={t('agentview.column.loading')} className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-4/5" />
          </div>
        ) : run.status === 'error' ? (
          <ErrorBanner message={run.message || t('agentview.error.load')} onRetry={onRetry} className="my-0" />
        ) : (
          <>
            {/*
              En pause, on ne jette pas l'aperçu : la vue lisible dit ce que
              l'agent recevrait à la reprise, la vue brute ce qu'il reçoit
              vraiment maintenant. Le bandeau dit laquelle des deux on lit.
            */}
            {run.preview.disabled && (
              <p className="flex items-start gap-2 rounded-lg border border-dashed p-3 text-sm text-warning">
                <Pause className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t(view === 'readable' ? 'agentview.paused.resume' : 'agentview.paused.exact')}</span>
              </p>
            )}
            <SummaryLine preview={run.preview} />
            {view === 'readable' ? <ReadableView preview={run.preview} /> : <ExactView preview={run.preview} />}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function SummaryLine({ preview }: { preview: RecallPreview }) {
  const { t } = useT()
  const s = previewSummary(preview)
  const cells: Array<[number, string]> = [
    [s.memories, t('agentview.summary.memories')],
    [s.blocks, t('agentview.summary.blocks')],
    [s.dropped, t('agentview.summary.dropped')],
    // En pause, pas de chiffre de tokens : il compterait la réponse « en pause ».
    ...(s.tokens === null ? [] : [[s.tokens, t('agentview.summary.tokens')] as [number, string]]),
  ]
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map(([value, label]) => (
        // UN seul div entre dl et dt/dd : HTML n'en autorise pas deux, et un
        // lecteur d'écran n'associe plus le chiffre à son libellé au-delà.
        // dd avant dt à l'œil (le chiffre d'abord), dt avant dd dans le code.
        <div key={label} className="flex flex-col-reverse rounded-md bg-muted px-2.5 py-1.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-base font-semibold tabular-nums">{formatNumber(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

// ------------------------------------------------------------- vue lisible

function ReadableView({ preview }: { preview: RecallPreview }) {
  const { t } = useT()
  const blocks = useMemo(() => viewBlocks(preview.items, preview.blocks), [preview])
  const best = useMemo(() => bestScore(preview.items), [preview])
  const dropped = droppedSummary(preview.dropped)
  const hasThemes = blocks.some(b => !b.loose)

  return (
    <div className="flex flex-col gap-4">
      {blocks.length === 0 ? (
        <EmptyState title={t('agentview.none.title')} body={t('agentview.none.body')} className="border-0 px-0 py-4" />
      ) : (
        blocks.map(block => <BlockSection key={block.key} block={block} best={best} hasThemes={hasThemes} />)
      )}

      {dropped.total > 0 && (
        <div className="rounded-lg border border-dashed p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <Scissors className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {t('agentview.dropped.title', { count: formatNumber(dropped.total) })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t('agentview.dropped.lead')}</p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {dropped.parts.map(p => (
              <li key={p.reason}>{t(`agentview.dropped.${p.reason}`, { count: formatNumber(p.count) })}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function BlockSection({ block, best, hasThemes }: { block: ViewBlock; best: number; hasThemes: boolean }) {
  const { t } = useT()
  const count = block.others.length + (block.current ? 1 : 0)
  const title = block.loose ? t(hasThemes ? 'agentview.block.loose' : 'agentview.block.all') : block.title
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {!block.loose && <Tags className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <h2 className="min-w-0 text-sm font-semibold break-words">{title}</h2>
        <Badge variant="secondary" className="tabular-nums">
          {formatNumber(count)}
        </Badge>
        {block.entities.map(e => (
          <Badge key={e} variant="outline" className="max-w-full">
            <span className="truncate">{e}</span>
          </Badge>
        ))}
      </div>
      <ul className="flex flex-col gap-2">
        {block.current && <MemoryRow item={block.current} best={best} current showTopic={false} />}
        {block.others.map(item => (
          <MemoryRow key={item.id} item={item} best={best} showTopic={block.loose} />
        ))}
      </ul>
    </section>
  )
}

function MemoryRow({ item, best, current = false, showTopic }: { item: RecallPreviewItem; best: number; current?: boolean; showTopic: boolean }) {
  const { t } = useT()
  const reasons = reasonChips(item)
  const origin = originKey(item.origin)
  const OriginIcon = item.origin ? ORIGIN_ICONS[item.origin] : undefined
  const statuses = statusKinds(item)
  const percent = scorePercent(item.score, best)
  const links = item.links ?? []
  const category = categoryLabel(t, item.category)

  return (
    <li className={cn('rounded-lg border p-3', current && 'border-primary/50 bg-primary/5')}>
      {current && (
        <Badge className="mb-2">
          <CircleCheck aria-hidden="true" />
          {t('agentview.block.current')}
        </Badge>
      )}
      <p className="text-sm break-words whitespace-pre-wrap">{item.content}</p>

      {reasons.length > 0 && (
        <ul aria-label={t('agentview.why.label')} className="mt-2 flex flex-wrap gap-1.5">
          {reasons.map(chip => {
            const Icon = REASON_ICONS[chip.kind]
            return (
              <li key={chip.kind} className="max-w-full">
                <Badge variant="secondary" className="max-w-full">
                  <Icon aria-hidden="true" />
                  <span className="truncate">{reasonLabel(t, chip)}</span>
                </Badge>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {origin && (
          <span className="inline-flex items-center gap-1">
            {OriginIcon && <OriginIcon className="size-3.5" aria-hidden="true" />}
            {t(origin)}
          </span>
        )}
        {statuses.map(s => {
          const Icon = STATUS_ICONS[s]
          return (
            <span key={s} className={cn('inline-flex items-center gap-1 font-medium', s === 'replaces' ? 'text-foreground' : 'text-warning')}>
              <Icon className="size-3.5" aria-hidden="true" />
              {t(`agentview.status.${s}`)}
            </span>
          )
        })}
        {item.created_at && (
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="size-3.5" aria-hidden="true" />
            {formatDay(item.created_at)}
          </span>
        )}
        {category && <span>{category}</span>}
        {showTopic && item.topic?.name && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <Tags className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{item.topic.name}</span>
          </span>
        )}
        {item.trust && Number.isFinite(item.trust.confidence) && (
          <span>{t('agentview.trust', { percent: Math.round(Math.max(0, Math.min(1, item.trust.confidence)) * 100) })}</span>
        )}
      </div>

      {(item.entities?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.entities!.map(e => (
            <Badge key={e} variant="outline" className="max-w-full">
              <span className="truncate">{e}</span>
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{t('agentview.score', { percent })}</span>
      </div>

      {links.length > 0 && (
        <Collapsible className="mt-2">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="group -ml-2 text-muted-foreground">
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
              {t('agentview.links.toggle', { count: formatNumber(links.length) })}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 flex flex-col gap-1 border-l pl-3 text-xs">
              {links.map(l => (
                <li key={l.id} className="break-words">
                  {l.excerpt} <span className="text-muted-foreground">{t('agentview.links.via', { entity: l.via })}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  )
}

// --------------------------------------------------------------- vue exacte

function ExactView({ preview }: { preview: RecallPreview }) {
  const { t } = useT()
  // Par défaut, le format que CET agent reçoit : c'est la promesse de l'onglet.
  const [format, setFormat] = useState<RecallRenderId>(preview.native)
  const render = preview.renders[format]
  const formatName = (id: RecallRenderId) => {
    const name = t(`agentview.render.${id}`)
    return id === preview.native ? t('agentview.render.native', { name }) : name
  }
  const selectId = `agentview-format-${preview.instance}`

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={selectId}>{t('agentview.render.label')}</Label>
          <Select value={format} onValueChange={v => setFormat(v as RecallRenderId)}>
            <SelectTrigger id={selectId} className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {renderOrder(preview.native, RECALL_RENDER_IDS).map(id => (
                <SelectItem key={id} value={id}>
                  {formatName(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {render && render.text.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">{t('agentview.render.tokens', { count: formatNumber(renderTokens(render, format)) })}</span>
            <CopyButton text={render.text} />
          </div>
        )}
      </div>
      {!render ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t('agentview.render.missing')}</p>
      ) : render.text.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t('agentview.render.empty')}</p>
      ) : (
        // tabIndex : le bloc défile, il doit être atteignable au clavier.
        <pre tabIndex={0} className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs break-words whitespace-pre-wrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {render.text}
        </pre>
      )}
    </div>
  )
}
