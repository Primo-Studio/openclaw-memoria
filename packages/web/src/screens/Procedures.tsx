/**
 * Procédures — « comment faire les choses ». Les savoir-faire de chaque agent
 * (commandes, workflows), avec leur taux de réussite. Memoria apprend de
 * chaque exécution : ce qui marche remonte, ce qui rate est annoté.
 *
 * Migré sur shadcn : PageHeader (sélecteur d'agent), SectionCard, une carte
 * par procédure (badge de réussite teinté, jauge, étapes numérotées avec
 * repli au-delà de six, déclencheurs), squelette, états vide / erreur —
 * voir UI-GUIDE.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, ListOrdered } from 'lucide-react'
import { ApiError, getProcedures, type Procedure } from '../api'
import { CogAgentSelect, useAnalyzableAgents } from '../components/CogAgentSelect'
import { EmptyState, ErrorBanner, PageHeader, SectionCard, formatNumber, humanError, listPhase } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { Progress } from '../components/ui/progress'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { cn } from '../lib/utils'

// Étapes visibles d'emblée ; au-delà, un bouton déplie le reste.
const STEPS_SHOWN = 6

export function Procedures() {
  const { t } = useT()
  const ag = useAnalyzableAgents()
  const [procedures, setProcedures] = useState<Procedure[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Instance dont on attend la liste : un résultat arrivé après un changement
  // d'agent est ignoré.
  const wanted = useRef('')

  const load = useCallback(async (inst: string) => {
    wanted.current = inst
    setProcedures(null)
    try {
      const list = await getProcedures(inst)
      if (wanted.current === inst) setProcedures(list)
    } catch (err) {
      if (wanted.current !== inst) return
      // 404 = vieux service sans la route : état vide, pas une panne.
      if (err instanceof ApiError && err.status === 404) setProcedures([])
      else setError(err instanceof ApiError ? err.message : humanError(err))
    }
  }, [])

  useEffect(() => {
    if (!ag.instance) return
    setError(null)
    void load(ag.instance)
  }, [ag.instance, ag.tick, load])

  const phase = listPhase(procedures, error)
  const bannerError = ag.error ?? error

  return (
    <>
      <PageHeader
        title={t('procedures.title')}
        description={t('procedures.lead')}
        actions={<CogAgentSelect agents={ag.agents} value={ag.instance} onChange={ag.setInstance} />}
      />

      {bannerError && <ErrorBanner message={bannerError} onRetry={ag.retry} />}

      {ag.noAgent ? (
        <EmptyState icon={<Bot className="size-5" />} title={t('memory.no_agent_title')} body={t('memory.no_agent_body')} className="mx-auto w-full max-w-xl sm:py-8" />
      ) : phase === 'loading' ? (
        <ProceduresSkeleton />
      ) : phase === 'failed' || procedures === null ? null : procedures.length === 0 ? (
        <EmptyState icon={<ListOrdered className="size-5" />} title={t('procedures.empty_title')} body={t('procedures.empty_body')} className="mx-auto w-full max-w-xl sm:py-8" />
      ) : (
        <SectionCard
          title={t('procedures.list_title')}
          description={t('procedures.list_hint')}
          actions={<Badge variant="secondary" className="tabular-nums">{formatNumber(procedures.length)}</Badge>}
          className="mb-0"
          contentClassName="grid gap-3 md:grid-cols-2"
        >
          {procedures.map(p => (
            <ProcedureCard key={p.id} procedure={p} />
          ))}
        </SectionCard>
      )}
    </>
  )
}

function ProceduresSkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={t('common.loading')}>
      <Skeleton className="h-10 w-full rounded-xl" />
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map(i => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

/** Couleur du taux : ≥ 70 % sain, ≥ 40 % à surveiller, sinon en difficulté. */
function rateTone(rate: number): 'success' | 'warning' | 'destructive' {
  return rate >= 70 ? 'success' : rate >= 40 ? 'warning' : 'destructive'
}

const RATE_TEXT = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const

const RATE_BAR = {
  success: '[&>[data-slot=progress-indicator]]:bg-success',
  warning: '[&>[data-slot=progress-indicator]]:bg-warning',
  destructive: '[&>[data-slot=progress-indicator]]:bg-destructive',
} as const

function ProcedureCard({ procedure: p }: { procedure: Procedure }) {
  const { t } = useT()
  const total = p.success_count + p.failure_count
  const rate = total > 0 ? Math.round((p.success_count / total) * 100) : null
  const tone = rate === null ? null : rateTone(rate)
  return (
    <Card size="sm" className="bg-muted/40 ring-0">
      <CardContent className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="leading-snug font-medium">{p.name}</span>
          {rate !== null && tone ? (
            <Badge variant="outline" className={cn('shrink-0 tabular-nums', RATE_TEXT[tone])}>
              {t('procedures.success_rate', { rate, total: formatNumber(total) })}
            </Badge>
          ) : (
            <Badge variant="secondary" className="shrink-0">
              {t('procedures.no_execution')}
            </Badge>
          )}
        </div>
        {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
        {rate !== null && tone && (
          <div className="flex flex-col gap-1">
            <Progress value={rate} aria-label={t('procedures.rate_label')} className={cn('h-1', RATE_BAR[tone])} />
            <span className="text-xs text-muted-foreground">
              {t('procedures.executions', { success: formatNumber(p.success_count), failure: formatNumber(p.failure_count) })}
            </span>
          </div>
        )}
        {p.steps.length > 0 && <Steps steps={p.steps} />}
        {p.trigger_patterns.length > 0 && (
          <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
            <span className="mr-1 text-xs text-muted-foreground">{t('procedures.triggers')}</span>
            {p.trigger_patterns.slice(0, 4).map(tp => (
              <Badge key={tp} variant="secondary" className="font-mono text-[11px]">
                {tp}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Étapes numérotées : les six premières, le reste derrière « N étapes de plus ». */
function Steps({ steps }: { steps: string[] }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const shown = steps.slice(0, STEPS_SHOWN)
  const rest = steps.slice(STEPS_SHOWN)
  const list = (items: string[], start: number) => (
    <ol className="list-decimal space-y-0.5 pl-5 text-sm marker:text-muted-foreground" start={start}>
      {items.map((s, i) => (
        <li key={start + i} className="pl-1">
          {s}
        </li>
      ))}
    </ol>
  )
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{t('procedures.steps')}</span>
      {list(shown, 1)}
      {rest.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleContent>{list(rest, STEPS_SHOWN + 1)}</CollapsibleContent>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="xs" className="mt-1 -ml-2 text-muted-foreground" aria-expanded={open} data-testid="proc-more">
              <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
              {open ? t('procedures.less_steps') : t('procedures.more_steps', { count: formatNumber(rest.length) })}
            </Button>
          </CollapsibleTrigger>
        </Collapsible>
      )}
    </div>
  )
}
