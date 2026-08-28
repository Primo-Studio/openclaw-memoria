/**
 * Journal — journal d'activité neutre (jamais de contenu, voir audit_log core).
 * Le daemon renvoie les 200 dernières entrées ; filtres, tri et pagination
 * sont locaux. Les raisons techniques (`provider=openai model=… ms=…`) sont
 * rendues lisibles par lib/cloud.ts (humanReason).
 *
 * Migré sur shadcn : PageHeader, filtres (recherche + acteur + action),
 * DataTable triable (tri = lib/sort.ts, testé), pagination, 3 états.
 */
import { useState } from 'react'
import { Search, SearchX } from 'lucide-react'
import { getAudit, type AuditEntry } from '../api'
import { DataTable, EmptyState, ErrorBanner, PageHeader, SectionCard, formatDate, formatNumber, useLoad, type DataColumn } from '../components/ui'
import { DataCards } from '../components/DataCards'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { useDirectory, type Directory, type Translate } from '../components/memory-names'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { humanReason } from '../lib/cloud'
import { cn } from '../lib/utils'
import { nextSort, type SortState } from '../lib/sort'

const PAGE_SIZE = 25

// Actions techniques → clé i18n audit.action.<action> (repli : l'action brute).
// Liste = toutes les actions émises par core (grep `action: '` dans packages/core/src).
const KNOWN_ACTIONS = new Set([
  'pair_assistant', 'complete_pairing', 'revoke_instance', 'delete_instance', 'store_fact', 'recall', 'forget',
  'person_autocreate', 'person_create', 'person_delete',
  'cloud_send', 'capture_turn', 'wal_entry_abandoned',
  'adopt_legacy', 'import_legacy', 'import_legacy_rollback', 'import_transcripts', 'import_cognition',
  'fact_correct', 'fact_expiry', 'fact_merge', 'set_scope_access', 'share_facts', 'sync_peer_paired',
  'set_capture_mode',
])

const ACTOR_TYPES: ReadonlyArray<AuditEntry['actor_type']> = ['assistant', 'user', 'system']

export function Audit() {
  const { t } = useT()
  const { state, reload } = useLoad(getAudit)
  // Noms d'agents et de mémoires : sans eux le journal ne parle qu'en UUID.
  const directory = useDirectory(t)

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        description={t('audit.lead')}
        actions={
          <MemRefreshButton label={t('common.refresh')} onClick={reload} disabled={state.status === 'loading'} spinning={state.status === 'loading'} />
        }
      />

      {state.status === 'loading' && (
        <div className="flex flex-col gap-3" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      )}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <EmptyState title={t('audit.empty.title')} body={t('audit.empty.body')} />
        ) : (
          <AuditTable entries={state.data} directory={directory} />
        ))}
    </>
  )
}

type SortKey = 'ts' | 'actor' | 'action' | 'scope'
const DATE_KEYS: readonly SortKey[] = ['ts']

// `set_capture_mode:<mode>` (core) porte le mode dans l'action elle-même :
// on sépare la famille (pour le libellé et le filtre) du détail (le mode, traduit).
const CAPTURE_MODE_PREFIX = 'set_capture_mode:'
const CAPTURE_MODE_KEYS: Record<string, string> = { 'auto-private': 'capture.auto', 'review-first': 'capture.review', incognito: 'capture.pause' }

/** Famille d'une action : ce sur quoi on filtre (`set_capture_mode:x` → `set_capture_mode`). */
function actionKey(action: string): string {
  return action.startsWith(CAPTURE_MODE_PREFIX) ? 'set_capture_mode' : action
}

/** Libellé traduit d'une action (repli sur l'action brute si non connue). */
function actionLabel(t: Translate, action: string): string {
  const key = actionKey(action)
  return KNOWN_ACTIONS.has(key) ? t(`audit.action.${key}`) : action
}

/** Détail porté par l'action elle-même (le mode de capture choisi), à défaut de `reason`. */
function actionDetail(t: Translate, action: string): string | null {
  if (!action.startsWith(CAPTURE_MODE_PREFIX)) return null
  const mode = action.slice(CAPTURE_MODE_PREFIX.length)
  const key = CAPTURE_MODE_KEYS[mode]
  return key ? t(key) : mode
}

/**
 * Qui a agi, en clair. « Vous » / « Système » pour les acteurs non-agents ;
 * pour un agent, son nom (« Claude Code ») et, à défaut seulement, l'ancien
 * repli « Agent 29e37881 ».
 */
function actorLabel(t: Translate, e: AuditEntry, dir: Directory): string {
  if (e.actor_type !== 'assistant') return t(`audit.actor.${e.actor_type}`)
  const name = dir.agentName(e.actor_id)
  return name ?? `${t('audit.actor.assistant')} ${e.actor_id.slice(0, 8)}`
}

/** La mémoire concernée, avec le même vocabulaire que l'écran Partage. */
function scopeLabelOf(e: AuditEntry, dir: Directory): string | null {
  if (!e.scope_id) return null
  return dir.scopeName(e.scope_id) ?? e.scope_id.slice(0, 8)
}

/** Valeur de tri (texte comparable) pour une colonne donnée : ce que la ligne AFFICHE,
 *  sinon la flèche de tri mentirait (tri sur l'UUID, noms à l'écran). */
function sortValue(t: Translate, e: AuditEntry, key: SortKey, dir: Directory): string {
  switch (key) {
    case 'ts':
      return e.ts
    case 'actor':
      return actorLabel(t, e, dir)
    case 'action':
      return actionLabel(t, e.action)
    case 'scope':
      return scopeLabelOf(e, dir) ?? ''
  }
}

/** Texte cherché par le filtre libre : tout ce que la ligne affiche (traduit) + les identifiants bruts. */
function haystack(t: Translate, e: AuditEntry, dir: Directory): string {
  return [
    formatDate(e.ts),
    t(`audit.actor.${e.actor_type}`),
    actorLabel(t, e, dir),
    e.actor_id,
    actionLabel(t, e.action),
    e.action,
    e.reason ?? '',
    humanReason(e.action, e.reason) ?? '',
    actionDetail(t, e.action) ?? '',
    scopeLabelOf(e, dir) ?? '',
    e.scope_id ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

function AuditTable({ entries, directory }: { entries: AuditEntry[]; directory: Directory }) {
  const { t } = useT()
  // Tri par défaut : Date décroissante (le plus récent d'abord).
  const [sort, setSort] = useState<SortState<SortKey>>({ key: 'ts', dir: 'desc' })
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [actor, setActor] = useState<'all' | AuditEntry['actor_type']>('all')
  const [action, setAction] = useState('all')

  const q = query.trim().toLowerCase()
  const filtered = entries.filter(
    e => (actor === 'all' || e.actor_type === actor) && (action === 'all' || actionKey(e.action) === action) && (q === '' || haystack(t, e, directory).includes(q)),
  )
  const sorted = [...filtered].sort((a, b) => {
    const cmp = sortValue(t, a, sort.key, directory).localeCompare(sortValue(t, b, sort.key, directory), undefined, { numeric: true })
    return sort.dir === 'asc' ? cmp : -cmp
  })

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const slice = sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)

  // Actions proposées dans le filtre : celles réellement présentes, par libellé.
  const actions = [...new Set(entries.map(e => actionKey(e.action)))].sort((a, b) => actionLabel(t, a).localeCompare(actionLabel(t, b)))
  const filtering = q !== '' || actor !== 'all' || action !== 'all'
  const clearFilters = () => {
    setQuery('')
    setActor('all')
    setAction('all')
    setPage(0)
  }

  const reasonOf = (e: AuditEntry) => humanReason(e.action, e.reason) ?? actionDetail(t, e.action)

  const columns: DataColumn<AuditEntry>[] = [
    { id: 'ts', header: t('audit.col.date'), sortable: true, cell: e => formatDate(e.ts) },
    {
      id: 'actor',
      header: t('audit.col.actor'),
      sortable: true,
      // L'identifiant technique reste accessible au survol : il ne s'affiche plus.
      cell: e => <span title={e.actor_type === 'assistant' ? e.actor_id : undefined}>{actorLabel(t, e, directory)}</span>,
    },
    {
      id: 'action',
      header: t('audit.col.action'),
      sortable: true,
      // La raison peut être longue : elle passe sous l'action et se coupe,
      // au lieu d'étirer le tableau hors de la carte.
      className: 'min-w-56 whitespace-normal',
      cell: e => {
        const reason = reasonOf(e)
        return (
          <>
            <div>{actionLabel(t, e.action)}</div>
            {reason && <div className="text-xs text-muted-foreground">{reason}</div>}
          </>
        )
      },
    },
    {
      id: 'scope',
      header: t('audit.col.scope'),
      sortable: true,
      cell: e => {
        const label = scopeLabelOf(e, directory)
        return label ? <span title={e.scope_id ?? undefined}>{label}</span> : '—'
      },
    },
  ]

  return (
    // Pastille chiffrée dans l'en-tête de carte : la MÊME forme de compteur que
    // Thèmes et Personnes, au lieu d'une phrase en sous-titre.
    <SectionCard
      title={t('audit.list_title')}
      description={t('audit.window')}
      actions={
        <Badge variant="secondary" className="tabular-nums">
          {formatNumber(filtered.length)}
        </Badge>
      }
    >
      <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setPage(0)
            }}
            placeholder={t('audit.filter.search')}
            aria-label={t('audit.filter.search')}
            className="pl-8"
          />
        </div>
        <Select
          value={actor}
          onValueChange={v => {
            setActor(v as 'all' | AuditEntry['actor_type'])
            setPage(0)
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label={t('audit.col.actor')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('audit.filter.all_actors')}</SelectItem>
            {ACTOR_TYPES.map(type => (
              <SelectItem key={type} value={type}>
                {t(`audit.actor.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={action}
          onValueChange={v => {
            setAction(v)
            setPage(0)
          }}
        >
          <SelectTrigger className="w-full sm:w-56" aria-label={t('audit.col.action')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('audit.filter.all_actions')}</SelectItem>
            {actions.map(a => (
              <SelectItem key={a} value={a}>
                {actionLabel(t, a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<SearchX className="size-5" />}
          title={t('audit.filter.none.title')}
          body={t('audit.filter.none.body')}
          action={
            <Button variant="outline" size="sm" onClick={clearFilters}>
              {t('audit.filter.clear')}
            </Button>
          }
        />
      ) : (
        <>
          {/* Sous 640 px, le tableau était tranché en plein mot (« Mode de »,
              « Convers ») et la colonne mémoire tombait hors écran : une fiche
              par entrée, l'action en titre, le reste en clair dessous. */}
          <div className="sm:hidden">
            <DataCards
              rows={slice}
              rowKey={e => String(e.id)}
              title={e => actionLabel(t, e.action)}
              subtitle={e => reasonOf(e)}
              fields={e => {
                const scope = scopeLabelOf(e, directory)
                return [
                  { label: t('audit.col.actor'), value: actorLabel(t, e, directory) },
                  ...(scope ? [{ label: t('audit.col.scope'), value: scope }] : []),
                  { label: t('audit.col.date'), value: <span className="text-muted-foreground">{formatDate(e.ts)}</span> },
                ]
              }}
            />
          </div>
          <div className="hidden sm:block">
            <DataTable
              columns={columns}
              rows={slice}
              rowKey={e => String(e.id)}
              sort={{ by: sort.key, dir: sort.dir }}
              onSort={next => {
                setSort(s => nextSort(s, next.by as SortKey, DATE_KEYS))
                setPage(0)
              }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
              {t('common.prev')}
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">{t('common.page', { current: current + 1, total: pageCount })}</span>
            <Button variant="outline" size="sm" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
              {t('common.next')}
            </Button>
          </div>
        </>
      )}
      {filtering && filtered.length > 0 && (
        <div className="mt-2">
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t('audit.filter.clear')}
          </Button>
        </div>
      )}
    </SectionCard>
  )
}
