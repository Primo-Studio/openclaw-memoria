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
import { ApiError, decideRevision, getAgents, getRevisions, proposeRevisions, searchFacts, type AdminFact, type AgentEntry, type RevisionProposal } from '../api'
import { MemAgentSelect } from '../components/MemAgentSelect'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { EmptyState, ErrorBanner, PageHeader, Spinner, formatDay, humanError, listPhase } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Label } from '../components/ui/label'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { analyzableAgents } from '../lib/agents'
import { cn } from '../lib/utils'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const KNOWN_KINDS = new Set(['contradicted', 'duplicate', 'obsolete'])

/**
 * Combien de souvenirs on récupère pour retrouver le TEXTE des deux faits en
 * cause. Le daemon plafonne à 200 et ne sait pas (encore) rendre un fait par
 * son identifiant : au-delà de cette fenêtre, la carte le dit au lieu de
 * laisser un trou (voir `revisions.fact_missing`).
 */
const FACT_WINDOW = 200

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
  // Texte et date des souvenirs cités par les propositions, par identifiant.
  const [factsById, setFactsById] = useState<Map<string, AdminFact>>(new Map())
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
    setFactsById(new Map())
    try {
      // déclenche une analyse fraîche puis liste
      await proposeRevisions(inst).catch(() => 0)
      const proposals = await getRevisions(inst)
      setItems(proposals)
      // On ne demande d'arbitrage qu'en MONTRANT les souvenirs concernés : on
      // récupère les derniers souvenirs de l'agent pour retrouver leur texte.
      // Un échec ici n'est pas une panne d'écran — la carte se replie sur
      // l'explication du moteur.
      if (proposals.length > 0) {
        try {
          const facts = await searchFacts(inst, '', FACT_WINDOW)
          setFactsById(new Map(facts.map(f => [f.id, f])))
        } catch (err) {
          console.warn('memoria-ui : souvenirs des révisions illisibles', err)
        }
      }
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
        actions={
          <MemRefreshButton
            label={t('revisions.reanalyze')}
            shortLabel={t('revisions.reanalyze_short')}
            onClick={retry}
            disabled={!instance || phase === 'loading'}
            spinning={phase === 'loading'}
          />
        }
      />

      {agents.length > 0 && (
        <div className="mb-4 flex flex-col gap-1.5 sm:max-w-sm">
          <Label htmlFor="revisions-agent">{t('revisions.agent_label')}</Label>
          <MemAgentSelect id="revisions-agent" agents={agents} value={instance} onChange={setInstance} disabled={busy} />
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={retry} />}

      {noAgent ? (
        <EmptyState icon={<Bot className="size-5" />} title={t('memory.no_agent_title')} body={t('memory.no_agent_body')} className="mx-auto w-full max-w-xl sm:py-8" />
      ) : phase === 'loading' ? (
        <div className="flex flex-col gap-3">
          <Spinner label={t('revisions.analyzing')} />
          {[0, 1].map(i => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : phase === 'failed' ? null : phase === 'empty' ? (
        <EmptyState icon={<Sparkles className="size-5" />} title={t('revisions.empty_title')} body={t('revisions.empty_body')} className="mx-auto w-full max-w-xl sm:py-8" />
      ) : (
        <section aria-label={t('revisions.list_label')}>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <GitCompareArrows className="size-4 text-muted-foreground" aria-hidden="true" />
            {list.length > 1 ? t('revisions.count_plural', { count: list.length }) : t('revisions.count', { count: list.length })}
          </h2>
          {/* Colonne bornée : une décision se lit comme un bloc, pas comme une
              bande de 1000 px pour deux lignes. */}
          <ul className="flex max-w-3xl flex-col gap-3">
            {list.map(r => (
              <li key={r.id}>
                <RevisionCard
                  proposal={r}
                  kept={r.replacement_fact_id ? factsById.get(r.replacement_fact_id) : undefined}
                  archived={factsById.get(r.fact_id)}
                  busy={busy}
                  onDecide={decision => void decide(r.id, decision)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/**
 * Une proposition = une décision. POURQUOI ce composant : on demandait
 * d'arbitrer une contradiction en n'en citant qu'un côté, noyé dans une phrase
 * de moteur (« polarité opposée »). Ici les DEUX souvenirs sont affichés avec
 * leur date, et celui qui sera gardé est marqué — la phrase technique ne sert
 * plus que de repli quand un souvenir sort de la fenêtre récupérée.
 */
function RevisionCard({
  proposal,
  kept,
  archived,
  busy,
  onDecide,
}: {
  proposal: RevisionProposal
  /** Le souvenir CONSERVÉ (le plus récent), s'il a pu être retrouvé. */
  kept: AdminFact | undefined
  /** Le souvenir qui sera RANGÉ (le plus ancien), s'il a pu être retrouvé. */
  archived: AdminFact | undefined
  busy: boolean
  onDecide: (decision: 'accept' | 'dismiss') => void
}) {
  const { t } = useT()
  const hasReplacement = Boolean(proposal.replacement_fact_id)
  // Un souvenir manquant (hors fenêtre) : on garde la raison du moteur sous les
  // yeux plutôt que de laisser un blanc.
  const incomplete = !archived || (hasReplacement && !kept)
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={kindVariant(proposal.kind)}>{kindLabel(t, proposal.kind)}</Badge>
        </div>
        <p className="text-sm leading-relaxed">
          {hasReplacement ? t(`revisions.explain_${KNOWN_KINDS.has(proposal.kind) ? proposal.kind : 'contradicted'}`) : t('revisions.explain_alone')}
        </p>
        <ul className="flex flex-col gap-2">
          {hasReplacement && <RevisionFact fact={kept} kept />}
          <RevisionFact fact={archived} kept={false} />
        </ul>
        {incomplete && <p className="text-xs leading-relaxed break-words text-muted-foreground">{proposal.reason}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => onDecide('accept')}>
            <Check aria-hidden="true" />
            {hasReplacement ? t('revisions.action_accept') : t('revisions.action_accept_alone')}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDecide('dismiss')}>
            <X aria-hidden="true" />
            {t('revisions.action_dismiss')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** Un des deux souvenirs de la proposition : sort gardé / rangé, texte, date. */
function RevisionFact({ fact, kept }: { fact: AdminFact | undefined; kept: boolean }) {
  const { t } = useT()
  return (
    <li className={cn('rounded-lg p-2.5 ring-1', kept ? 'bg-success/5 ring-success/30' : 'bg-muted/50 ring-foreground/10')}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('border-transparent', kept ? 'bg-success/15 text-success' : 'bg-background text-muted-foreground')}>
          {kept ? t('revisions.fact_kept') : t('revisions.fact_archived')}
        </Badge>
        {fact && <span className="text-xs text-muted-foreground tabular-nums">{formatDay(fact.created_at)}</span>}
      </div>
      <p className={cn('text-sm leading-relaxed break-words', fact ? (kept ? 'text-foreground' : 'text-muted-foreground') : 'text-xs text-muted-foreground italic')}>
        {fact ? fact.fact : t('revisions.fact_missing', { count: FACT_WINDOW })}
      </p>
    </li>
  )
}
