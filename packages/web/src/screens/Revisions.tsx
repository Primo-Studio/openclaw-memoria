/**
 * Révisions — le « ménage » de la mémoire. Memoria repère les souvenirs qui se
 * contredisent ou font doublon, et PROPOSE de les ranger : garder le plus
 * récent, écarter l'ancien. Rien n'est modifié sans ta validation.
 *
 * Écran migré sur shadcn : PageHeader (« Analyser à nouveau » dans la barre
 * supérieure), choix de l'agent en Select shadcn dans le flux (pas dans la
 * barre : sur mobile elle n'a pas la place), propositions en cartes avec le
 * type en badge (contradiction / doublon / obsolète) et l'arbitrage à droite,
 * toasts, trois états. Mêmes appels : GET /v1/admin/agents,
 * POST /v1/admin/propose_revisions puis GET /v1/admin/revisions,
 * POST /v1/admin/revision_decision.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bot, Check, GitCompareArrows, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, decideRevision, getAgents, getRevisions, proposeRevisions, type AgentEntry, type RevisionProposal } from '../api'
import { MemAgentSelect } from '../components/MemAgentSelect'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { EmptyState, ErrorBanner, PageHeader, Spinner, humanError, listPhase } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Label } from '../components/ui/label'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { analyzableAgents } from '../lib/agents'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const KNOWN_KINDS = new Set(['contradicted', 'duplicate', 'obsolete'])

/** Libellé traduit d'un type de révision (repli sur le type brut si inconnu). */
function kindLabel(t: Translate, kind: string): string {
  return KNOWN_KINDS.has(kind) ? t(`revisions.kind_${kind}`) : kind
}

/** Une contradiction se voit (rouge), un doublon est neutre, le reste discret. */
function kindVariant(kind: string): 'destructive' | 'secondary' | 'outline' {
  if (kind === 'contradicted') return 'destructive'
  if (kind === 'duplicate') return 'secondary'
  return 'outline'
}

export function Revisions() {
  const { t } = useT()
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState('')
  const [items, setItems] = useState<RevisionProposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Aucun agent analysable (ex. seul « Autre agent (MCP) ») → état vide explicite.
  const [noAgent, setNoAgent] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    getAgents()
      .then(a => {
        const real = analyzableAgents(a)
        setAgents(real)
        setNoAgent(real.length === 0)
        if (real[0]) setInstance(prev => prev || real[0]!.instance.id)
      })
      .catch((err: unknown) => {
        console.warn('memoria-ui : agents illisibles', err)
        setError(humanError(err))
      })
  }, [tick])

  const load = useCallback(async (inst: string) => {
    setItems(null)
    try {
      // déclenche une analyse fraîche puis liste
      await proposeRevisions(inst).catch(() => 0)
      setItems(await getRevisions(inst))
    } catch (err) {
      // 404 = vieux service sans la route : état vide, pas une panne.
      if (err instanceof ApiError && err.status === 404) setItems([])
      else {
        console.warn('memoria-ui : révisions illisibles', err)
        setError(humanError(err))
      }
    }
  }, [])

  useEffect(() => {
    if (instance) void load(instance)
  }, [instance, load, tick])

  const retry = useCallback(() => {
    setError(null)
    setTick(n => n + 1)
  }, [])

  const phase = listPhase(items, error)
  const list = items ?? []

  const decide = useCallback(
    async (id: string, decision: 'accept' | 'dismiss') => {
      setBusy(true)
      try {
        await decideRevision(instance, id, decision)
        setItems(prev => (prev ? prev.filter(i => i.id !== id) : prev))
        toast.success(decision === 'accept' ? t('revisions.accepted') : t('revisions.dismissed'))
      } catch (err) {
        // L'échec d'un arbitrage ne cache pas la liste : la proposition reste là, on le dit en toast.
        console.warn('memoria-ui : arbitrage de révision refusé', err)
        toast.error(t('review.action_failed_detail', { message: humanError(err) }))
      } finally {
        setBusy(false)
      }
    },
    [instance, t],
  )

  return (
    <>
      <PageHeader
        title={t('revisions.title')}
        description={t('revisions.lead')}
        actions={<MemRefreshButton label={t('revisions.reanalyze')} onClick={retry} disabled={!instance || phase === 'loading'} spinning={phase === 'loading'} />}
      />

      {agents.length > 0 && (
        <div className="mb-4 flex flex-col gap-1.5 sm:max-w-sm">
          <Label htmlFor="revisions-agent">{t('revisions.agent_label')}</Label>
          <MemAgentSelect id="revisions-agent" agents={agents} value={instance} onChange={setInstance} disabled={busy} />
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={retry} />}

      {noAgent ? (
        <EmptyState icon={<Bot className="size-5" />} title={t('memory.no_agent_title')} body={t('memory.no_agent_body')} />
      ) : phase === 'loading' ? (
        <div className="flex flex-col gap-3">
          <Spinner label={t('revisions.analyzing')} />
          {[0, 1].map(i => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : phase === 'failed' ? null : phase === 'empty' ? (
        <EmptyState icon={<Sparkles className="size-5" />} title={t('revisions.empty_title')} body={t('revisions.empty_body')} />
      ) : (
        <section aria-label={t('revisions.list_label')}>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <GitCompareArrows className="size-4 text-muted-foreground" aria-hidden="true" />
            {list.length > 1 ? t('revisions.count_plural', { count: list.length }) : t('revisions.count', { count: list.length })}
          </h2>
          <ul className="flex flex-col gap-3">
            {list.map(r => (
              <li key={r.id}>
                <Card size="sm">
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={kindVariant(r.kind)}>{kindLabel(t, r.kind)}</Badge>
                    </div>
                    <p className="text-sm leading-relaxed break-words">{r.reason}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void decide(r.id, 'accept')}>
                        <Check aria-hidden="true" />
                        {t('revisions.action_accept')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide(r.id, 'dismiss')}>
                        <X aria-hidden="true" />
                        {t('revisions.action_dismiss')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
