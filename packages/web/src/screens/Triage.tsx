/**
 * Tri des souvenirs : retrouver ses idées, décisions, process, leçons…
 * rangés par genre, et valider ce qui est juste. Rien n'est jamais effacé :
 * « marquer faux » cache un souvenir (réversible), « valider » le rend visible
 * aux IA (tant qu'il n'est pas validé, aucune IA ne le voit).
 *
 * Routes : GET /v1/admin/triage (liste filtrée, curseur opaque), GET
 * /v1/admin/triage/stats (compteurs des onglets), POST|GET|DELETE
 * /v1/admin/triage/run (passage : estimation, lancement, suivi, arrêt),
 * POST /v1/admin/triage/promote | correct | verdict, POST /v1/admin/share.
 *
 * LANCER LE TRI COÛTE DE L'ARGENT : le bouton passe TOUJOURS par une
 * estimation sans aucun appel (dry-run), dont le coût est affiché dans la
 * confirmation. Les souvenirs sensibles (paie, santé, mots de passe…) ne
 * partent jamais à une IA ; ils ont leur onglet, à revoir à la main.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Check, CheckSquare, ChevronDown, CircleStop, Gauge, Lightbulb, Play, Share2, ShieldCheck, SlidersHorizontal, Square, Tags } from 'lucide-react'
import { toast } from 'sonner'
import {
  TRIAGE_GENRES,
  TRIAGE_RUBRIQUES,
  TRIAGE_SOUS_TYPES,
  cancelTriageRun,
  correctTriage,
  getPersons,
  getTriageList,
  getTriageRun,
  getTriageStats,
  promoteTriage,
  setTriageVerdict,
  shareFacts,
  startTriageRun,
  type TriageEstimate,
  type TriageGenre,
  type TriageItem,
  type TriageRunStatus,
  type TriageStats,
} from '../api'
import { MemFactCard, MemMetaText } from '../components/MemFactCard'
import { MemListCount } from '../components/MemListCount'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { MemSearchInput } from '../components/MemSearchInput'
import { MemSelectionBar } from '../components/MemSelectionBar'
import { EmptyState, ErrorBanner, PageHeader, SectionCard, formatDay, formatDecimal, formatNumber, humanError, useIsNarrow } from '../components/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../components/ui/dropdown-menu'
import { Input } from '../components/ui/input'
import { Progress } from '../components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { useT } from '../i18n'
import { createSequence } from '../lib/sequence'
import {
  EMPTY_TRIAGE_FILTERS,
  TRIAGE_TABS,
  authorFamily,
  authorLabel,
  isApproximateDate,
  sourceName,
  tabCount,
  triageFilterFor,
  type TriageScreenFilters,
  type TriageTab,
} from '../lib/triage'
import { cn } from '../lib/utils'

/** Taille d'une page de la liste. */
const PAGE_SIZE = 50
/** Délai avant de relancer la liste après une frappe (recherche, projet). */
const TYPING_DEBOUNCE_MS = 300
/** Suivi d'un passage en cours. */
const RUN_POLL_MS = 2000
/** Entités visibles sur une ligne avant « +N ». */
const MAX_ENTITIES = 3

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function Triage() {
  const { t } = useT()
  const [tab, setTab] = useState<TriageTab>('idee')
  const [filters, setFilters] = useState<TriageScreenFilters>(EMPTY_TRIAGE_FILTERS)
  const [stats, setStats] = useState<TriageStats | null>(null)
  const [run, setRun] = useState<TriageRunStatus | null>(null)
  const [persons, setPersons] = useState<Map<string, string>>(new Map())
  const [items, setItems] = useState<TriageItem[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const seq = useRef(createSequence())

  const filter = useMemo(() => triageFilterFor(tab, filters), [tab, filters])

  const loadStats = useCallback(async () => {
    try {
      setStats(await getTriageStats())
    } catch (err) {
      console.warn('memoria-ui : compteurs du tri illisibles', err)
    }
  }, [])

  const loadList = useCallback(async () => {
    const id = seq.current.next()
    setError(null)
    try {
      const page = await getTriageList(filter, { limit: PAGE_SIZE })
      if (!seq.current.isCurrent(id)) return
      setItems(page.items)
      setCursor(page.next_cursor)
    } catch (err) {
      if (!seq.current.isCurrent(id)) return
      console.warn('memoria-ui : liste du tri illisible', err)
      setError(humanError(err))
    }
  }, [filter])

  const reload = useCallback(async () => {
    await Promise.all([loadStats(), loadList()])
  }, [loadStats, loadList])

  // Personnes (auteur « équipe ») et état du passage : une fois à l'ouverture.
  useEffect(() => {
    getPersons()
      .then(list => setPersons(new Map(list.map(p => [p.id, p.display_name]))))
      .catch(() => {})
    getTriageRun()
      .then(setRun)
      .catch(() => {})
    void loadStats()
  }, [loadStats])

  // Liste : tout de suite pour un onglet ou une liste déroulante, après une pause pour la frappe.
  const typed = `${filters.q}\u0000${filters.projet}`
  const lastTyped = useRef(typed)
  useEffect(() => {
    const delay = lastTyped.current === typed ? 0 : TYPING_DEBOUNCE_MS
    lastTyped.current = typed
    const timer = window.setTimeout(() => void loadList(), delay)
    return () => window.clearTimeout(timer)
  }, [loadList, typed])

  // Sélection vidée au changement d'onglet ou de filtre : elle désignait des souvenirs qui ne sont plus à l'écran.
  useEffect(() => setSelected(new Set()), [filter])

  // Suivi d'un passage : tant qu'il tourne, l'état est relu ; à la fin, compteurs et liste aussi.
  const running = run?.state === 'running'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      getTriageRun()
        .then(next => {
          setRun(next)
          if (next.state !== 'running') void reload()
        })
        .catch(() => {})
    }, RUN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, reload])

  const loadMore = async () => {
    if (!cursor) return
    const id = seq.current.next()
    setLoadingMore(true)
    try {
      const page = await getTriageList(filter, { cursor, limit: PAGE_SIZE })
      if (!seq.current.isCurrent(id)) return
      setItems(prev => [...(prev ?? []), ...page.items])
      setCursor(page.next_cursor)
    } catch (err) {
      toast.error(t('triage.action_failed', { message: humanError(err) }))
    } finally {
      setLoadingMore(false)
    }
  }

  /** Une action sur des souvenirs : occupé pendant l'appel, toast, puis rechargement. */
  const act = async (work: () => Promise<string | null>) => {
    setBusy(true)
    try {
      const message = await work()
      if (message) toast.success(message)
      setSelected(new Set())
      await reload()
    } catch (err) {
      console.warn('memoria-ui : action de tri refusée', err)
      toast.error(t('triage.action_failed', { message: humanError(err) }))
    } finally {
      setBusy(false)
    }
  }

  const validate = (ids: string[]) =>
    act(async () => {
      const r = await promoteTriage(ids)
      const parts = [r.promoted > 1 ? t('triage.validated_plural', { count: r.promoted }) : t('triage.validated_one', { count: r.promoted })]
      if (r.skipped_sensitive > 0) parts.push(t('triage.skipped_sensitive', { count: r.skipped_sensitive }))
      if (r.merged_members + r.merged_into_active > 0) parts.push(t('triage.merged', { count: r.merged_members + r.merged_into_active }))
      return parts.join(' ')
    })

  const share = (rows: TriageItem[]) =>
    act(async () => {
      // Un souvenir sensible (paie, santé, mot de passe…) n'est jamais partagé à toutes les IA.
      const shareable = rows.filter(r => !r.sensible)
      const pending = shareable.filter(r => !r.validated).map(r => r.fact_id)
      const active = shareable.filter(r => r.validated).map(r => r.fact_id)
      let shared = 0
      // En attente : validé puis partagé d'un seul geste ; déjà validé : partage simple.
      if (pending.length > 0) shared += (await promoteTriage(pending, { share: true })).shared
      if (active.length > 0) shared += (await shareFacts(active, 'user')).shared
      return t('triage.shared', { count: shared })
    })

  const correctGenre = (item: TriageItem, genre: TriageGenre) =>
    act(async () => {
      await correctTriage({ fact_id: item.fact_id, genre, ...(genre !== 'idee' && item.sous_type ? { sous_type: null } : {}) })
      return t('triage.corrected', { genre: t(`triage.genre.${genre}`) })
    })

  const markFalse = (ids: string[]) =>
    act(async () => {
      const n = await setTriageVerdict(ids, 'faux')
      toast(t('triage.marked_false', { count: n }), {
        action: { label: t('triage.undo'), onClick: () => void act(async () => (await setTriageVerdict(ids, null), t('triage.unmarked'))) },
      })
      return null
    })

  const notSensitive = (item: TriageItem) =>
    act(async () => {
      await correctTriage({ fact_id: item.fact_id, sensible: false })
      return t('triage.not_sensitive_done')
    })

  const list = items ?? []
  const allSelected = list.length > 0 && list.every(i => selected.has(i.fact_id))
  const selectedRows = list.filter(i => selected.has(i.fact_id))
  const setOne = (id: string, on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <>
      <PageHeader
        title={t('triage.title')}
        description={t('triage.lead')}
        actions={<MemRefreshButton label={t('common.refresh')} onClick={() => void reload()} disabled={busy} />}
      />

      <RunPanel run={run} stats={stats} onRun={setRun} onFinished={reload} />

      <Tabs value={tab} onValueChange={v => setTab(v as TriageTab)} className="gap-3">
        {/* Onze onglets : au téléphone la barre défile dans son conteneur (jamais la page) ;
            dès 640 px elle passe à la ligne, pour que « Sensibles » ne se cache pas hors champ. */}
        <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 pb-1 sm:overflow-visible">
          <TabsList aria-label={t('triage.tabs_label')} className="w-max sm:h-auto! sm:w-auto sm:flex-wrap sm:justify-start">
            {TRIAGE_TABS.map(g => {
              const count = tabCount(stats, g)
              return (
                <TabsTrigger key={g} value={g} className="flex-none px-2.5 max-sm:min-h-11 sm:h-7">
                  {t(`triage.tab.${g}`)}
                  {count !== null && <span className="text-xs tabular-nums text-muted-foreground">{formatNumber(count)}</span>}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>

        <FiltersBar tab={tab} filters={filters} onChange={setFilters} />

        <MemSelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
          {tab !== 'sensible' && (
            <Button size="sm" disabled={busy} onClick={() => void validate([...selected])}>
              <Check aria-hidden="true" />
              {t('triage.action.validate_selected')}
            </Button>
          )}
          {tab !== 'sensible' && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void share(selectedRows)}>
              <Share2 aria-hidden="true" />
              {t('triage.action.share')}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => void markFalse([...selected])}>
            <Ban aria-hidden="true" />
            {t('triage.action.mark_false')}
          </Button>
        </MemSelectionBar>

        {TRIAGE_TABS.map(g => (
          <TabsContent key={g} value={g} className="flex flex-col gap-3">
            {g === tab && (
              <TriageList
                tab={tab}
                items={items}
                error={error}
                onRetry={() => void loadList()}
                persons={persons}
                selected={selected}
                allSelected={allSelected}
                onToggleAll={() => setSelected(allSelected ? new Set() : new Set(list.map(i => i.fact_id)))}
                onSelect={setOne}
                busy={busy}
                hasMore={cursor !== null}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
                onValidate={item => void validate([item.fact_id])}
                onShare={item => void share([item])}
                onCorrect={(item, genre) => void correctGenre(item, genre)}
                onFalse={item => void markFalse([item.fact_id])}
                onNotSensitive={item => void notSensitive(item)}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </>
  )
}

// ---------------------------------------------------------------- passage

/** Montant en dollars : assez de décimales pour qu'une petite dépense ne s'affiche pas « 0,00 ». */
export function usd(t: Translate, amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return t('triage.usd_unknown')
  const digits = amount === 0 || amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4
  return t('triage.usd', { amount: formatDecimal(amount, digits) })
}

/** Texte de la confirmation : ce qui partira et ce que ça coûtera, ou « tout est déjà trié ». */
export function estimateText(t: Translate, e: TriageEstimate): string {
  if (e.facts_pending === 0) return t('triage.estimate.nothing')
  return t('triage.estimate.body', {
    facts: formatNumber(e.facts_pending),
    sensible: formatNumber(e.facts_sensible),
    calls: formatNumber(e.llm_calls_max),
    model: e.model ?? t('triage.estimate.no_model'),
    cost: usd(t, e.cost_usd),
    budget: usd(t, e.budget_usd),
  })
}

/**
 * Passage de tri : couverture (part déjà triée), état et dépense du dernier
 * passage, et les trois gestes. Lancer = estimation d'abord (aucun appel),
 * puis confirmation qui affiche le coût.
 */
function RunPanel({
  run,
  stats,
  onRun,
  onFinished,
}: {
  run: TriageRunStatus | null
  stats: TriageStats | null
  onRun: (s: TriageRunStatus) => void
  onFinished: () => Promise<void>
}) {
  const { t } = useT()
  const [estimate, setEstimate] = useState<TriageEstimate | null>(null)
  const [pending, setPending] = useState(false)
  const running = run?.state === 'running'
  const coverage = stats && stats.facts_total > 0 ? Math.round((stats.triaged / stats.facts_total) * 100) : null

  const askEstimate = async () => {
    setPending(true)
    try {
      const r = await startTriageRun({ dry_run: true })
      setEstimate(r.estimate)
    } catch (err) {
      toast.error(t('triage.action_failed', { message: humanError(err) }))
    } finally {
      setPending(false)
    }
  }

  const launch = async () => {
    setEstimate(null)
    setPending(true)
    try {
      onRun(await startTriageRun({}))
      toast.success(t('triage.run.started'))
    } catch (err) {
      toast.error(t('triage.action_failed', { message: humanError(err) }))
    } finally {
      setPending(false)
    }
  }

  const stop = async () => {
    setPending(true)
    try {
      await cancelTriageRun()
      toast(t('triage.run.stopping'))
      onRun(await getTriageRun())
      await onFinished()
    } catch (err) {
      toast.error(t('triage.action_failed', { message: humanError(err) }))
    } finally {
      setPending(false)
    }
  }

  const shownRun = run && run.state !== 'idle' ? run : null

  return (
    <SectionCard
      title={t('triage.run.title')}
      description={
        stats
          ? t('triage.coverage', { triaged: formatNumber(stats.triaged), total: formatNumber(stats.facts_total) })
          : t('triage.run.lead')
      }
      actions={
        running ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void stop()}>
            <CircleStop aria-hidden="true" />
            {t('triage.run.cancel')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void askEstimate()}>
            <Gauge aria-hidden="true" />
            {t('triage.run.estimate')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {coverage !== null && <Progress value={coverage} aria-label={t('triage.coverage_aria', { percent: coverage })} />}
        {shownRun ? (
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={running ? 'default' : shownRun.state === 'done' ? 'secondary' : 'outline'}>{t(`triage.run.state.${shownRun.state}`)}</Badge>
              {shownRun.finished_at && !running && (
                <span className="text-xs text-muted-foreground tabular-nums">{formatDay(shownRun.finished_at)}</span>
              )}
            </div>
            <p className="text-muted-foreground">
              {t('triage.run.progress', {
                done: formatNumber(shownRun.facts_done),
                classified: formatNumber(shownRun.classified),
                inherited: formatNumber(shownRun.inherited),
                sensible: formatNumber(shownRun.sensible),
                failed: formatNumber(shownRun.failed),
              })}
            </p>
            <p className="text-muted-foreground">
              {t('triage.run.cost', { spent: usd(t, shownRun.spent_usd), budget: usd(t, shownRun.budget_usd), calls: formatNumber(shownRun.llm_calls) })}
              {shownRun.max_block_ms !== null && ` ${t('triage.run.block', { ms: formatNumber(shownRun.max_block_ms) })}`}
            </p>
            {shownRun.error && <p className="text-destructive">{shownRun.error}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('triage.run.never')}</p>
        )}
      </div>

      <AlertDialog open={estimate !== null} onOpenChange={open => !open && setEstimate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('triage.estimate.title')}</AlertDialogTitle>
            <AlertDialogDescription>{estimate && estimateText(t, estimate)}</AlertDialogDescription>
          </AlertDialogHeader>
          {estimate && !estimate.within_budget && <p className="text-sm text-warning">{t('triage.estimate.over_budget')}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={!estimate || estimate.facts_pending === 0} onClick={() => void launch()}>
              <Play aria-hidden="true" />
              {t('triage.run.start')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  )
}

// ---------------------------------------------------------------- filtres

/**
 * Filtres. Au téléphone, sept listes déroulantes empilées remplissaient tout
 * l'écran avant le premier souvenir : seule la recherche reste visible, le
 * reste se déplie avec « Filtres (n) ». Dès 640 px, tout est visible.
 */
function FiltersBar({ tab, filters, onChange }: { tab: TriageTab; filters: TriageScreenFilters; onChange: (f: TriageScreenFilters) => void }) {
  const { t } = useT()
  const narrow = useIsNarrow()
  const [open, setOpen] = useState(false)
  const set = <K extends keyof TriageScreenFilters>(key: K, value: TriageScreenFilters[K]) => onChange({ ...filters, [key]: value })
  const active = (Object.keys(EMPTY_TRIAGE_FILTERS) as Array<keyof TriageScreenFilters>).filter(
    k => k !== 'q' && filters[k] !== EMPTY_TRIAGE_FILTERS[k],
  ).length
  const changed = active > 0 || filters.q !== ''
  const showAll = !narrow || open
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label={t('triage.filters_label')}>
      <div className="flex gap-2 sm:col-span-2">
        <MemSearchInput
          className="flex-1"
          value={filters.q}
          onChange={e => set('q', e.target.value)}
          placeholder={t('triage.filter.search')}
          aria-label={t('triage.filter.search')}
        />
        {narrow && (
          <Button type="button" variant="outline" className="max-sm:h-11" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            <SlidersHorizontal aria-hidden="true" />
            {active > 0 ? t('triage.filter.toggle_count', { count: active }) : t('triage.filter.toggle')}
          </Button>
        )}
      </div>
      {showAll && (
        <>
          <FilterSelect
            label={t('triage.filter.author')}
            value={filters.auteur}
            onChange={v => set('auteur', v as TriageScreenFilters['auteur'])}
            options={[
              ['all', t('triage.filter.author_all')],
              ['owner', t('triage.author.owner')],
              ['ia', t('triage.filter.author_ai')],
              ['person', t('triage.filter.author_team')],
              ['inconnu', t('triage.author.unknown')],
            ]}
          />
          <FilterSelect
            label={t('triage.filter.status')}
            value={filters.status}
            onChange={v => set('status', v as TriageScreenFilters['status'])}
            options={[
              ['all', t('triage.filter.status_all')],
              ['pending', t('triage.status.pending')],
              ['validated', t('triage.status.validated')],
            ]}
          />
          {tab === 'idee' && (
            <FilterSelect
              label={t('triage.filter.subtype')}
              value={filters.sous_type}
              onChange={v => set('sous_type', v as TriageScreenFilters['sous_type'])}
              options={[['all', t('triage.filter.subtype_all')], ...TRIAGE_SOUS_TYPES.map(s => [s, t(`triage.sous_type.${s}`)] as [string, string])]}
            />
          )}
          <FilterSelect
            label={t('triage.filter.rubrique')}
            value={filters.rubrique}
            onChange={v => set('rubrique', v as TriageScreenFilters['rubrique'])}
            options={[['all', t('triage.filter.rubrique_all')], ...TRIAGE_RUBRIQUES.map(r => [r, t(`triage.rubrique.${r}`)] as [string, string])]}
          />
          <Input value={filters.projet} onChange={e => set('projet', e.target.value)} placeholder={t('triage.filter.project')} aria-label={t('triage.filter.project')} />
          <FilterSelect
            label={t('triage.filter.period')}
            value={filters.period}
            onChange={v => set('period', v as TriageScreenFilters['period'])}
            options={[
              ['all', t('triage.filter.period_all')],
              ['7d', t('triage.filter.period_7d')],
              ['30d', t('triage.filter.period_30d')],
              ['90d', t('triage.filter.period_90d')],
              ['365d', t('triage.filter.period_365d')],
            ]}
          />
          <FilterSelect
            label={t('triage.filter.importance')}
            value={filters.importance}
            onChange={v => set('importance', v as TriageScreenFilters['importance'])}
            options={[
              ['all', t('triage.filter.importance_all')],
              ['1', t('triage.filter.importance_min', { n: 1 })],
              ['2', t('triage.filter.importance_min', { n: 2 })],
              ['3', t('triage.filter.importance_top')],
            ]}
          />
        </>
      )}
      {changed && showAll && (
        <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => onChange(EMPTY_TRIAGE_FILTERS)}>
          {t('triage.filter.reset')}
        </Button>
      )}
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------- liste

function TriageList({
  tab,
  items,
  error,
  onRetry,
  persons,
  selected,
  allSelected,
  onToggleAll,
  onSelect,
  busy,
  hasMore,
  loadingMore,
  onLoadMore,
  onValidate,
  onShare,
  onCorrect,
  onFalse,
  onNotSensitive,
}: {
  tab: TriageTab
  items: TriageItem[] | null
  error: string | null
  onRetry: () => void
  persons: ReadonlyMap<string, string>
  selected: Set<string>
  allSelected: boolean
  onToggleAll: () => void
  onSelect: (id: string, on: boolean) => void
  busy: boolean
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onValidate: (item: TriageItem) => void
  onShare: (item: TriageItem) => void
  onCorrect: (item: TriageItem, genre: TriageGenre) => void
  onFalse: (item: TriageItem) => void
  onNotSensitive: (item: TriageItem) => void
}) {
  const { t } = useT()
  if (items === null && !error) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label={t('common.loading')}>
        {[0, 1, 2].map(i => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    )
  }
  if (items === null) return <ErrorBanner message={error ?? ''} onRetry={onRetry} />
  if (items.length === 0) {
    return (
      <>
        {error && <ErrorBanner message={error} onRetry={onRetry} />}
        <EmptyState
          icon={tab === 'sensible' ? <ShieldCheck className="size-5" /> : <Lightbulb className="size-5" />}
          title={t(tab === 'sensible' ? 'triage.empty_sensitive_title' : 'triage.empty_title')}
          body={t(tab === 'sensible' ? 'triage.empty_sensitive_body' : 'triage.empty_body')}
        />
      </>
    )
  }
  return (
    <section aria-label={t('triage.list_label')} className="flex flex-col gap-3">
      {error && <ErrorBanner message={error} onRetry={onRetry} />}
      <MemListCount
        label={items.length > 1 ? t('triage.count_plural', { count: formatNumber(items.length) }) : t('triage.count', { count: items.length })}
        hint={hasMore ? t('triage.count_more') : undefined}
      >
        <Button type="button" variant="ghost" size="sm" onClick={onToggleAll} disabled={busy}>
          {allSelected ? <Square aria-hidden="true" /> : <CheckSquare aria-hidden="true" />}
          {allSelected ? t('selection.unselect_all') : t('selection.select_all')}
        </Button>
      </MemListCount>
      {tab === 'sensible' && <p className="text-sm text-muted-foreground">{t('triage.sensitive_hint')}</p>}
      <ul className="flex flex-col gap-3">
        {items.map(item => (
          <li key={item.fact_id}>
            <TriageCard
              item={item}
              persons={persons}
              selected={selected.has(item.fact_id)}
              onSelect={on => onSelect(item.fact_id, on)}
              busy={busy}
              onValidate={() => onValidate(item)}
              onShare={() => onShare(item)}
              onCorrect={genre => onCorrect(item, genre)}
              onFalse={() => onFalse(item)}
              onNotSensitive={() => onNotSensitive(item)}
            />
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button type="button" variant="outline" className="self-center max-sm:h-11" disabled={loadingMore} onClick={onLoadMore}>
          {t('triage.load_more')}
        </Button>
      )}
    </section>
  )
}

/**
 * Une ligne : titre (idées) puis le souvenir, et dessous ce qui permet de le
 * juger : statut, auteur et d'où on le sait, date de la conversation, « dit
 * N fois », entités, conversation source. Actions à droite.
 */
export function TriageCard({
  item,
  persons,
  selected = false,
  onSelect,
  busy = false,
  onValidate,
  onShare,
  onCorrect,
  onFalse,
  onNotSensitive,
}: {
  item: TriageItem
  persons: ReadonlyMap<string, string>
  selected?: boolean
  onSelect?: (on: boolean) => void
  busy?: boolean
  onValidate?: () => void
  onShare?: () => void
  onCorrect?: (genre: TriageGenre) => void
  onFalse?: () => void
  onNotSensitive?: () => void
}) {
  const { t } = useT()
  const source = sourceName(item.source_path)
  const family = authorFamily(item.auteur)
  const entities = item.entites.slice(0, MAX_ENTITIES)
  const moreEntities = item.entites.length - entities.length
  return (
    <MemFactCard
      selected={selected}
      onSelectedChange={onSelect}
      selectLabel={t('selection.select')}
      disabled={busy}
      className={cn(item.verdict === 'faux' && 'opacity-60')}
      meta={
        <>
          <Badge variant={item.validated ? 'secondary' : 'outline'} className={cn(item.validated && 'bg-success/10 text-success')}>
            {item.validated ? t('triage.status.validated') : t('triage.status.pending')}
          </Badge>
          {item.sensible && (
            <Badge variant="outline" className="border-transparent bg-warning/15 text-warning">
              {t('triage.sensitive_badge')}
            </Badge>
          )}
          {item.genre === 'idee' && item.sous_type && <Badge variant="secondary">{t(`triage.sous_type.${item.sous_type}`)}</Badge>}
          {item.auteur !== null && (
            <Badge variant="outline" title={t(`triage.author_source_title.${item.auteur_source}`)}>
              {authorLabel(t, item.auteur, persons)}
              {family !== 'inconnu' && item.auteur_source === 'message' && <Check aria-hidden="true" className="text-success" />}
            </Badge>
          )}
          {item.approuve_par_owner && <Badge variant="outline">{t('triage.approved_by_owner')}</Badge>}
          {/* Préférence ou style d'une AUTRE personne que le propriétaire : on dit de qui il s'agit. */}
          {item.person_id && (item.genre === 'preference' || item.genre === 'style') && (
            <Badge variant="outline">{t('triage.concerns', { name: persons.get(item.person_id) ?? t('triage.author.person_other') })}</Badge>
          )}
          {item.amas_size > 1 && (
            <Badge variant="outline" title={t('triage.said_title')}>
              {t('triage.said_times', { count: item.amas_size })}
            </Badge>
          )}
          {item.projet && <Badge variant="outline">{item.projet}</Badge>}
          {entities.map(e => (
            <Badge key={e} variant="secondary">
              {e}
            </Badge>
          ))}
          {moreEntities > 0 && (
            <Badge variant="secondary" title={item.entites.slice(MAX_ENTITIES).join(', ')}>
              {t('fact.topics_more', { count: moreEntities })}
            </Badge>
          )}
          <MemMetaText>
            {item.conversation_at ? t('triage.date', { date: formatDay(item.conversation_at) }) : t('triage.date_unknown')}
            {item.conversation_at && isApproximateDate(item.conversation_at_source) && ` ${t('triage.date_approx')}`}
            {item.auteur !== null && item.auteur_source !== 'inconnu' && ` · ${t(`triage.author_source.${item.auteur_source}`)}`}
            {typeof item.importance === 'number' && ` · ${t('triage.importance', { n: item.importance })}`}
            {source && (
              <>
                {' · '}
                <span title={item.source_path ?? undefined} className="break-all">
                  {t('triage.source', { name: source })}
                </span>
              </>
            )}
          </MemMetaText>
        </>
      }
      actions={
        <>
          {item.sensible && onNotSensitive ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onNotSensitive}>
              <ShieldCheck aria-hidden="true" />
              {t('triage.action.not_sensitive')}
            </Button>
          ) : (
            onValidate &&
            !item.validated && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onValidate}>
                <Check aria-hidden="true" />
                {t('triage.action.validate')}
              </Button>
            )
          )}
          {onShare && !item.sensible && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onShare} title={t('triage.action.share_title')}>
              <Share2 aria-hidden="true" />
              {t('triage.action.share')}
            </Button>
          )}
          {onCorrect && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" disabled={busy}>
                  <Tags aria-hidden="true" />
                  {t('triage.action.correct')}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t('triage.action.correct_label')}</DropdownMenuLabel>
                {TRIAGE_GENRES.filter(g => g !== item.genre).map(g => (
                  <DropdownMenuItem key={g} onSelect={() => onCorrect(g)}>
                    {t(`triage.genre.${g}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onFalse && item.verdict !== 'faux' && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={busy} onClick={onFalse}>
              <Ban aria-hidden="true" />
              {t('triage.action.mark_false')}
            </Button>
          )}
        </>
      }
    >
      {item.titre && <span className="block font-medium">{item.titre}</span>}
      {item.text}
    </MemFactCard>
  )
}
