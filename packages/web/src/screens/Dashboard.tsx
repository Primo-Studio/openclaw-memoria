/**
 * Tableau de bord — l'état de la mémoire en un coup d'œil :
 * santé (doctor), compteurs (stats), souvenirs en attente de traitement (WAL),
 * et ALERTE moteur d'extraction (anti-mort-silencieuse : si aucun moteur n'est
 * disponible, on le dit en rouge, on ne laisse pas la file gonfler en silence).
 *
 * Écran de RÉFÉRENCE de la migration shadcn : PageHeader (titre + actions
 * dans la barre supérieure), StatCard, SectionCard, DataTable, états
 * chargement / erreur / vide — voir UI-GUIDE.md.
 */
import { useState } from 'react'
import { Bot, Brain, ChevronDown, CircleAlert, CircleCheck, Database, Inbox, RefreshCw, TriangleAlert } from 'lucide-react'
import { getDoctor, getLlmHealth, getOverview, getStats, type AgentOverview, type DoctorDatabase, type DoctorReport, type LlmHealth, type Stats } from '../api'
import {
  DataTable,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SectionCard,
  StatCard,
  agentTypeLabel,
  formatBytes,
  formatNumber,
  useLoad,
  type DataColumn,
} from '../components/ui'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { cn } from '../lib/utils'

// Types de base de données connus → clé i18n dashboard.dbKind.<kind> (repli : le kind brut).
const KNOWN_DB_KINDS = new Set(['registry', 'assistant', 'shared'])

export function Dashboard({ onConnect, onConfigure }: { onConnect: () => void; onConfigure?: () => void }) {
  const { t } = useT()
  const { state, reload } = useLoad(async () => {
    const [stats, doctor, overview, llmHealth] = await Promise.all([
      getStats(),
      getDoctor(),
      getOverview().catch(() => []),
      // route « contrat » : absente sur un vieux service → pas de bannière
      getLlmHealth().catch(() => null),
    ])
    return { stats, doctor, overview, llmHealth }
  })

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        actions={
          <Button variant="outline" size="sm" onClick={reload} disabled={state.status === 'loading'}>
            <RefreshCw className={cn(state.status === 'loading' && 'animate-spin')} aria-hidden="true" />
            {t('common.refresh')}
          </Button>
        }
      />

      {state.status === 'loading' && <DashboardSkeleton />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        <DashboardBody
          stats={state.data.stats}
          doctor={state.data.doctor}
          overview={state.data.overview}
          llmHealth={state.data.llmHealth}
          onConnect={onConnect}
          onConfigure={onConfigure}
        />
      )}
    </>
  )
}

/** Squelette de la mise en page finale : pas de saut visuel au chargement. */
function DashboardSkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-4" role="status" aria-label={t('common.loading')}>
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map(i => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  )
}

function DashboardBody({
  stats,
  doctor,
  overview,
  llmHealth,
  onConnect,
  onConfigure,
}: {
  stats: Stats
  doctor: DoctorReport
  overview: AgentOverview[]
  llmHealth: LlmHealth | null
  onConnect: () => void
  onConfigure?: () => void
}) {
  const { t } = useT()
  const walPending = doctor.databases.reduce((sum, db) => sum + (db.wal_pending ?? 0), 0)

  return (
    <div className="flex flex-col gap-4">
      <LlmBanner health={llmHealth} onConfigure={onConfigure} />

      <HealthCard doctor={doctor} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard value={stats.facts} label={t('dashboard.stat.factsLabel')} hint={t('dashboard.stat.factsHint')} icon={<Brain className="size-4" />} />
        <StatCard value={stats.instances} label={t('dashboard.stat.agentsLabel')} hint={t('dashboard.stat.agentsHint')} icon={<Bot className="size-4" />} />
        <StatCard value={stats.databases} label={t('dashboard.stat.spacesLabel')} hint={t('dashboard.stat.spacesHint')} icon={<Database className="size-4" />} />
        <StatCard
          value={walPending}
          label={t('dashboard.stat.pendingLabel')}
          hint={walPending === 0 ? t('dashboard.stat.pendingHintEmpty') : t('dashboard.stat.pendingHintSome')}
          tone={walPending > 0 ? 'warn' : 'default'}
          icon={<Inbox className="size-4" />}
        />
      </div>

      {stats.instances === 0 && (
        <EmptyState
          icon={<Bot className="size-5" />}
          title={t('dashboard.empty.title')}
          body={t('dashboard.empty.body')}
          action={
            <Button size="lg" onClick={onConnect}>
              {t('dashboard.empty.connect')}
            </Button>
          }
        />
      )}

      {overview.length > 0 && (
        <SectionCard title={t('dashboard.overview.title')}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {overview.map(a => (
              <Card key={a.instance} size="sm" className="bg-muted/40 ring-0">
                <CardContent className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 font-medium">
                    <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
                    {agentTypeLabel(a.type)}
                  </div>
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <div className="flex gap-1">
                      <dt className="font-semibold tabular-nums">{formatNumber(a.facts)}</dt>
                      <dd className="text-muted-foreground">{t('dashboard.overview.facts')}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="font-semibold tabular-nums">{formatNumber(a.themes)}</dt>
                      <dd className="text-muted-foreground">{t('dashboard.overview.themes')}</dd>
                    </div>
                    {a.procedures > 0 && (
                      <div className="flex gap-1">
                        <dt className="font-semibold tabular-nums">{formatNumber(a.procedures)}</dt>
                        <dd className="text-muted-foreground">{t('dashboard.overview.procedures')}</dd>
                      </div>
                    )}
                  </dl>
                  {a.expertise.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-xs text-muted-foreground">{t('dashboard.overview.expertise')}</span>
                      {a.expertise.map(d => (
                        <Badge key={d} variant="secondary">
                          {d}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </SectionCard>
      )}

      <StorageDetails doctor={doctor} />
    </div>
  )
}

/**
 * Bannière moteur d'extraction : visible UNIQUEMENT quand l'extraction est
 * indisponible (avec le nombre de souvenirs en attente s'il y en a). Rien
 * d'affiché quand tout va bien.
 */
function LlmBanner({ health, onConfigure }: { health: LlmHealth | null; onConfigure?: () => void }) {
  const { t } = useT()
  if (!health || health.extraction.available) return null
  const pending = health.wal_pending
  const critical = pending > 0
  return (
    // Le bouton « Configurer » est à droite sur bureau, sous le texte sur mobile
    // (en absolu, il recouvrait le titre sous 640 px).
    <Alert variant={critical ? 'destructive' : 'default'} className={cn(!critical && 'text-warning', onConfigure && 'sm:pr-36')}>
      {critical ? <CircleAlert /> : <TriangleAlert />}
      <AlertTitle>
        {critical
          ? t(pending > 1 ? 'dashboard.banner.pendingCritical.plural' : 'dashboard.banner.pendingCritical.one', { count: formatNumber(pending) })
          : t('dashboard.banner.noEngine')}
      </AlertTitle>
      {health.extraction.reason && <AlertDescription>{health.extraction.reason}</AlertDescription>}
      {onConfigure && (
        <AlertAction className="static mt-2 col-start-2 sm:absolute sm:top-2 sm:right-2 sm:mt-0">
          <Button size="sm" onClick={onConfigure}>
            {t('dashboard.banner.configure')}
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

function HealthCard({ doctor }: { doctor: DoctorReport }) {
  const { t } = useT()
  if (doctor.ok) {
    return (
      <Card size="sm">
        <CardContent className="flex items-center gap-3">
          <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
          <div>
            <div className="font-medium">{t('dashboard.health.okTitle')}</div>
            <p className="text-sm text-muted-foreground">{t('dashboard.health.okBody')}</p>
          </div>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card size="sm" className="ring-warning/40">
      <CardContent className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0">
          <div className="font-medium">{t('dashboard.health.warnTitle')}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-muted-foreground">
            {doctor.warnings.map(w => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

/** Détails du stockage, repliés par défaut (info technique, utile en cas de doute). */
function StorageDetails({ doctor }: { doctor: DoctorReport }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const columns: DataColumn<DoctorDatabase>[] = [
    {
      id: 'kind',
      header: t('dashboard.storage.colType'),
      cell: db => (KNOWN_DB_KINDS.has(db.kind) ? t(`dashboard.dbKind.${db.kind}`) : db.kind),
    },
    {
      id: 'path',
      header: t('dashboard.storage.colLocation'),
      cell: db => (
        <span className="inline-flex items-center gap-2">
          <code className="text-xs">{db.path}</code>
          {!db.exists && <Badge variant="destructive">{t('dashboard.storage.missing')}</Badge>}
        </span>
      ),
    },
    { id: 'size', header: t('dashboard.storage.colSize'), align: 'right', cell: db => (db.exists ? formatBytes(db.size_bytes) : '—') },
    { id: 'pending', header: t('dashboard.storage.colPending'), align: 'right', cell: db => db.wal_pending ?? '—' },
  ]
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-expanded={open}
          >
            {t('dashboard.storage.summary')}
            <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-3 pt-3">
            <p className="text-sm text-muted-foreground">
              {t('dashboard.storage.locationBefore')}
              <code className="text-xs">{doctor.storage_root}</code>
              {t('dashboard.storage.locationAfter')}
            </p>
            <DataTable columns={columns} rows={doctor.databases} rowKey={db => db.path} dense />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
