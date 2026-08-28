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
 *
 * Les DEUX souvenirs en cause viennent maintenant de la proposition elle-même
 * (`proposal.fact` / `proposal.replacement`). Avant, l'écran allait pêcher les
 * 200 derniers souvenirs de l'agent pour retrouver leur texte : au-delà de
 * cette fenêtre il ne montrait rien, et il fallait un second appel réseau à
 * chaque chargement.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, decideRevision, getAgents, getRevisions, proposeRevisions, type AgentEntry, type RevisionFactDetail, type RevisionProposal } from '../api'
import { MemAgentPicker, MemNoAgentState } from '../components/MemAgentSelect'
import { MemListCount } from '../components/MemListCount'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { useDirectory } from '../components/memory-names'
import { EmptyState, ErrorBanner, PageHeader, Spinner, formatDay, humanError, listPhase } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { analyzableAgents } from '../lib/agents'
import { categoryLabel } from '../lib/labels'
import { cn } from '../lib/utils'

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
  // Annuaire des agents : sert à nommer l'agent d'origine d'un souvenir quand
  // ce n'est PAS celui qu'on est en train de regarder.
  const directory = useDirectory(t)

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
        actions={
          <MemRefreshButton
            label={t('revisions.reanalyze')}
            shortLabel={t('revisions.reanalyze_short')}
            onClick={retry}
            disabled={!instance || phase === 'loading'}
            spinning={phase === 'loading'}
          />
        }
      >
        {/* Même emplacement et même libellé « Agent » que sur les cinq autres
            écrans par agent : l'ancien « Agent analysé » était le seul de son
            espèce. */}
        <MemAgentPicker id="revisions-agent" agents={agents} value={instance} onChange={setInstance} disabled={busy} />
      </PageHeader>

      {error && <ErrorBanner message={error} onRetry={retry} />}

      {noAgent ? (
        <MemNoAgentState className="mx-auto w-full max-w-xl sm:py-8" />
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
          <MemListCount label={list.length > 1 ? t('revisions.count_plural', { count: list.length }) : t('revisions.count', { count: list.length })} />
          {/* Colonne bornée : une décision se lit comme un bloc, pas comme une
              bande de 1000 px pour deux lignes. */}
          <ul className="flex max-w-3xl flex-col gap-3">
            {list.map(r => (
              <li key={r.id}>
                <RevisionCard
                  proposal={r}
                  viewedInstance={instance}
                  agentName={directory.agentName}
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
 * leur date, leur catégorie et leur état, et celui qui sera gardé est marqué —
 * la phrase technique ne sert plus que de repli quand un souvenir manque.
 */
function RevisionCard({
  proposal,
  viewedInstance,
  agentName,
  busy,
  onDecide,
}: {
  proposal: RevisionProposal
  /** Agent en cours de consultation : son nom serait redondant sur chaque souvenir. */
  viewedInstance: string
  agentName: (instanceId: string) => string | null
  busy: boolean
  onDecide: (decision: 'accept' | 'dismiss') => void
}) {
  const { t } = useT()
  const hasReplacement = Boolean(proposal.replacement_fact_id)
  const kept = proposal.replacement ?? null
  const archived = proposal.fact ?? null
  // Souvenir supprimé depuis (ou service trop ancien pour l'envoyer) : on garde
  // la raison du moteur sous les yeux plutôt que de laisser un blanc.
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
          {hasReplacement && <RevisionFact fact={kept} kept viewedInstance={viewedInstance} agentName={agentName} />}
          <RevisionFact fact={archived} kept={false} viewedInstance={viewedInstance} agentName={agentName} />
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

/** Un des deux souvenirs de la proposition : sort gardé / rangé, texte, contexte. */
function RevisionFact({
  fact,
  kept,
  viewedInstance,
  agentName,
}: {
  fact: RevisionFactDetail | null
  kept: boolean
  viewedInstance: string
  agentName: (instanceId: string) => string | null
}) {
  const { t } = useT()
  // L'agent n'est nommé que s'il DIFFÈRE de celui qu'on regarde : sinon c'est
  // le même nom répété deux fois par carte, pour zéro information.
  const origin = fact?.assistant_instance_id && fact.assistant_instance_id !== viewedInstance ? agentName(fact.assistant_instance_id) : null
  return (
    <li className={cn('rounded-lg p-2.5 ring-1', kept ? 'bg-success/5 ring-success/30' : 'bg-muted/50 ring-foreground/10')}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline" className={cn('border-transparent', kept ? 'bg-success/15 text-success' : 'bg-background text-muted-foreground')}>
          {kept ? t('revisions.fact_kept') : t('revisions.fact_archived')}
        </Badge>
        {fact && <RevisionFactState fact={fact} />}
        {fact && <span className="text-xs text-muted-foreground tabular-nums">{formatDay(fact.created_at)}</span>}
        {fact?.category && <span className="text-xs text-muted-foreground">{categoryLabel(t, fact.category)}</span>}
        {origin && <span className="text-xs text-muted-foreground">{t('revisions.fact_from', { agent: origin })}</span>}
      </div>
      <p className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', fact ? (kept ? 'text-foreground' : 'text-muted-foreground') : 'text-xs text-muted-foreground italic')}>
        {fact ? fact.fact : t('revisions.fact_missing')}
      </p>
    </li>
  )
}

/**
 * État d'un souvenir, seulement quand il n'est PAS ordinaire : déjà remplacé,
 * en attente de revue, archivé. Sur un souvenir actif, rien — un badge « Actif »
 * sur chaque ligne serait du bruit.
 */
function RevisionFactState({ fact }: { fact: RevisionFactDetail }) {
  const { t } = useT()
  if (fact.superseded === 1) {
    return (
      <Badge variant="outline" className="border-transparent bg-warning/15 text-warning">
        {t('revisions.fact_state_superseded')}
      </Badge>
    )
  }
  if (fact.lifecycle_state === 'dormant') {
    return <Badge variant="outline">{t('revisions.fact_state_dormant')}</Badge>
  }
  if (fact.lifecycle_state === 'archived') {
    return <Badge variant="outline">{t('revisions.fact_state_archived')}</Badge>
  }
  return null
}
