/**
 * Agents — détection des assistants de la machine + connexion 1 clic + import
 * des souvenirs avec progression (missions B1/B2/B3/B4), connexion par code de
 * pairing (TTL 10 min, voir PAIRING_TTL_MS côté core) et révocation.
 *
 * Migré sur shadcn : PageHeader (titre + actions dans la barre supérieure),
 * SectionCard « Sur cette machine » / « Agents connectés », Dialog pour les
 * parcours (import, code de connexion), AlertDialog (ConfirmButton) pour
 * révoquer/supprimer, toasts pour les confirmations — voir UI-GUIDE.md.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Braces,
  Check,
  CircleCheck,
  Loader2,
  MessageCircle,
  MousePointerClick,
  Plus,
  RefreshCw,
  ScanSearch,
  Terminal,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  connectAgent,
  deleteAgent,
  deriveSelf,
  detectMachineAgents,
  getAgents,
  getExpertise,
  getImportStatus,
  getSelfObservations,
  pairAgent,
  revokeAgent,
  startImport,
  type AgentEntry,
  type AgentType,
  type ConnectAgentResult,
  type DetectedAgent,
  type ExpertiseDomain,
  type ImportJobStatus,
  type PairResult,
  type SelfObservation,
} from '../api'
import {
  ConfirmButton,
  CopyButton,
  EmptyState,
  ErrorBanner,
  SectionCard,
  PageHeader,
  Spinner,
  agentTypeLabel,
  formatDate,
  formatNumber,
  humanError,
  useLoad,
} from '../components/ui'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { useAgentNamer } from '../lib/agent-name'
import { CommandBlock, StatusBadge } from '../components/SetupBits'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Progress } from '../components/ui/progress'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { importPollOutcome, interruptedImport } from '../lib/import-flow'
import { TOUCH_ROW_ACTION } from '../lib/touch'
import { cn } from '../lib/utils'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const PAIRING_TTL_SECONDS = 10 * 60 // miroir de PAIRING_TTL_MS (registry.ts)

const AGENT_CHOICES: Array<{ type: AgentType; labelKey: string; hintKey: string; icon: LucideIcon }> = [
  { type: 'claude-code', labelKey: 'agents.choice.claudeCode.label', hintKey: 'agents.choice.claudeCode.hint', icon: Terminal },
  { type: 'codex', labelKey: 'agents.choice.codex.label', hintKey: 'agents.choice.codex.hint', icon: Braces },
  { type: 'openclaw', labelKey: 'agents.choice.openclaw.label', hintKey: 'agents.choice.openclaw.hint', icon: MessageCircle },
  { type: 'generic', labelKey: 'agents.choice.generic.label', hintKey: 'agents.choice.generic.hint', icon: Plus },
]

type PairFlow =
  | { step: 'closed' }
  | { step: 'choose'; busy: AgentType | null; error: string | null }
  | { step: 'code'; type: AgentType; result: PairResult }

export function Agents({ onOpenReview }: { onOpenReview?: () => void }) {
  const { t } = useT()
  const { state, reload } = useLoad(getAgents)
  const [flow, setFlow] = useState<PairFlow>({ step: 'closed' })

  const openChooser = () => setFlow({ step: 'choose', busy: null, error: null })

  const startPairing = (type: AgentType) => {
    setFlow({ step: 'choose', busy: type, error: null })
    pairAgent(type).then(
      result => setFlow({ step: 'code', type, result }),
      (err: unknown) => {
        console.warn('memoria-ui : pairing échoué', err)
        setFlow({ step: 'choose', busy: null, error: humanError(err) })
      },
    )
  }

  const closeFlow = () => {
    setFlow({ step: 'closed' })
    reload()
  }

  const revoke = (instanceId: string) => {
    revokeAgent(instanceId).then(
      () => {
        toast.success(t('agents.toast.revoked'))
        reload()
      },
      (err: unknown) => {
        console.warn('memoria-ui : révocation échouée', err)
        toast.error(humanError(err))
      },
    )
  }

  const remove = (instanceId: string) => {
    deleteAgent(instanceId).then(
      () => {
        toast.success(t('agents.toast.deleted'))
        reload()
      },
      (err: unknown) => {
        console.warn('memoria-ui : suppression échouée', err)
        toast.error(humanError(err))
      },
    )
  }

  const hasAgents = state.status === 'ready' && state.data.length > 0

  return (
    <>
      <PageHeader
        title={t('agents.title')}
        actions={
          <>
            {/* Seul écran à porter AUSSI un bouton principal : à 390 px, les deux
                libellés réduisaient le titre de la barre à « A… ». */}
            <MemRefreshButton
              label={t('common.refresh')}
              compact
              onClick={reload}
              disabled={state.status === 'loading'}
              spinning={state.status === 'loading'}
            />
            {/* Le bouton principal n'apparaît qu'avec des agents : sinon l'état vide porte l'appel à l'action. */}
            {hasAgents && (
              <Button size="sm" onClick={openChooser}>
                <Plus aria-hidden="true" />
                <span className="sm:hidden">{t('agents.connectShort')}</span>
                <span className="hidden sm:inline">{t('agents.connect')}</span>
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <MachineAgents onChanged={reload} onOpenReview={onOpenReview} />

        <SectionCard title={t('agents.list.title')} description={t('agents.list.lead')} className="mb-0">
          {state.status === 'loading' && <Spinner />}
          {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} className="my-0" />}
          {state.status === 'ready' &&
            (state.data.length === 0 ? (
              <EmptyState
                title={t('agents.empty.title')}
                body={t('agents.empty.body')}
                action={
                  <Button size="lg" onClick={openChooser}>
                    <Plus aria-hidden="true" />
                    {t('agents.empty.action')}
                  </Button>
                }
              />
            ) : (
              <AgentList agents={state.data} onRevoke={revoke} onDelete={remove} />
            ))}
        </SectionCard>
      </div>

      <PairingDialog flow={flow} onChoose={startPairing} onCancel={() => setFlow({ step: 'closed' })} onDone={closeFlow} />
    </>
  )
}

// ------------------------------------------------------------ dialogue commun

/** Bouton de fermeture traduit (le composant Dialog généré porte un « Close » en dur). */
function DialogCloseButton() {
  const { t } = useT()
  return (
    <DialogClose asChild>
      <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label={t('common.close')}>
        <X aria-hidden="true" />
      </Button>
    </DialogClose>
  )
}

// ------------------------------------------------------------ code de connexion

function PairingDialog({
  flow,
  onChoose,
  onCancel,
  onDone,
}: {
  flow: PairFlow
  onChoose: (type: AgentType) => void
  onCancel: () => void
  onDone: () => void
}) {
  const { t } = useT()
  const open = flow.step !== 'closed'
  const close = () => (flow.step === 'code' ? onDone() : onCancel())
  return (
    <Dialog open={open} onOpenChange={isOpen => !isOpen && close()}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {flow.step === 'choose' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('agents.choose.title')}</DialogTitle>
              <DialogDescription>{t('agents.choose.lead')}</DialogDescription>
            </DialogHeader>
            {flow.error && <ErrorBanner message={flow.error} className="my-0" />}
            <div className="grid gap-2 sm:grid-cols-2">
              {AGENT_CHOICES.map(choice => {
                const Icon = choice.icon
                const busy = flow.busy === choice.type
                return (
                  <button
                    key={choice.type}
                    type="button"
                    disabled={flow.busy !== null}
                    onClick={() => onChoose(choice.type)}
                    className="flex items-start gap-3 rounded-lg border p-3 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{t(choice.labelKey)}</span>
                      <span className="block text-xs text-muted-foreground">{busy ? t('agents.choose.preparing') : t(choice.hintKey)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
        {flow.step === 'code' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('agents.code.title', { agent: agentTypeLabel(flow.type) })}</DialogTitle>
              <DialogDescription>{t('agents.pairing.instructions')}</DialogDescription>
            </DialogHeader>
            <PairingCode result={flow.result} onRegenerate={() => onChoose(flow.type)} />
            <DialogFooter>
              <Button onClick={onDone}>
                <Check aria-hidden="true" />
                {t('agents.code.done')}
              </Button>
            </DialogFooter>
          </>
        )}
        {/* En dernier dans le DOM : le focus initial va au premier choix, pas à la croix. */}
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function PairingCode({ result, onRegenerate }: { result: PairResult; onRegenerate: () => void }) {
  const { t } = useT()
  const [secondsLeft, setSecondsLeft] = useState(PAIRING_TTL_SECONDS)

  useEffect(() => {
    setSecondsLeft(PAIRING_TTL_SECONDS)
    const id = window.setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(id)
  }, [result.pairing_code])

  const expired = secondsLeft === 0
  const mm = Math.floor(secondsLeft / 60)
  const ss = String(secondsLeft % 60).padStart(2, '0')

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-lg bg-muted px-4 py-3 text-center font-mono text-2xl font-semibold tracking-[0.2em] tabular-nums select-all"
        aria-label={t('agents.pairing.codeLabel')}
      >
        {result.pairing_code}
      </div>
      <CommandBlock text={result.command} copyLabel={t('agents.pairing.copy')} />
      {expired ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{t('agents.pairing.expired')}</AlertTitle>
          <div className="col-start-2 mt-2">
            <Button size="sm" onClick={onRegenerate}>
              <RefreshCw aria-hidden="true" />
              {t('agents.pairing.regenerate')}
            </Button>
          </div>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground" role="timer">
          {t('agents.pairing.expiresBefore')}
          <strong className="tabular-nums text-foreground">
            {mm}:{ss}
          </strong>
          {t('agents.pairing.expiresAfter')}
        </p>
      )}
    </div>
  )
}

// ------------------------------------------------------------ Sur cette machine

const START_FRESH_KEY = 'memoria.start_fresh'

/** Choix « Démarrer de zéro » mémorisé localement (pas d'action serveur). */
function loadStartFresh(): Set<string> {
  try {
    const raw = localStorage.getItem(START_FRESH_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch (err) {
    console.warn('memoria-ui : choix « démarrer de zéro » illisible', err)
    return new Set()
  }
}

function saveStartFresh(kinds: Set<string>): void {
  try {
    localStorage.setItem(START_FRESH_KEY, JSON.stringify([...kinds]))
  } catch (err) {
    console.warn('memoria-ui : choix « démarrer de zéro » non sauvegardé', err)
  }
}

type ImportFlow =
  | { step: 'closed' }
  | { step: 'confirm'; agent: DetectedAgent }
  | { step: 'running'; agent: DetectedAgent; status: ImportJobStatus | null }
  | { step: 'done'; agent: DetectedAgent; status: ImportJobStatus }
  | { step: 'failed'; agent: DetectedAgent; message: string }

/**
 * Section « Sur cette machine » : détection, connexion 1 clic, import des
 * souvenirs. `embedded` = rendu sans carte (dans une étape de l'onboarding).
 */
export function MachineAgents({ onChanged, onOpenReview, embedded = false }: { onChanged: () => void; onOpenReview?: () => void; embedded?: boolean }) {
  const { t } = useT()
  const [detected, setDetected] = useState<DetectedAgent[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectBusy, setConnectBusy] = useState<string | null>(null)
  const [connectResults, setConnectResults] = useState<Record<string, ConnectAgentResult>>({})
  const [startFresh, setStartFresh] = useState<Set<string>>(loadStartFresh)
  const [flow, setFlow] = useState<ImportFlow>({ step: 'closed' })
  // Statut d'import PERSISTÉ par le daemon, lu au montage : un job coupé par un
  // arrêt du daemon (state `interrupted`) doit se voir ici, pas rester muet.
  const [persisted, setPersisted] = useState<ImportJobStatus | null>(null)

  const detect = () => {
    setDetecting(true)
    setError(null)
    detectMachineAgents().then(
      agents => {
        setDetected(agents)
        setDetecting(false)
      },
      (err: unknown) => {
        console.warn('memoria-ui : détection des agents échouée', err)
        setError(humanError(err))
        setDetecting(false)
      },
    )
  }

  const connect = (agent: DetectedAgent) => {
    setConnectBusy(agent.kind)
    setError(null)
    connectAgent(agent.kind).then(
      result => {
        setConnectResults(prev => ({ ...prev, [agent.kind]: result }))
        setConnectBusy(null)
        toast.success(t('agents.toast.connected', { name: agent.name }))
        onChanged()
        detect() // rafraîchit already_connected
      },
      (err: unknown) => {
        console.warn('memoria-ui : connexion 1 clic échouée', err)
        setError(humanError(err))
        setConnectBusy(null)
      },
    )
  }

  const dismissImport = (agent: DetectedAgent) => {
    const next = new Set(startFresh)
    next.add(agent.kind)
    setStartFresh(next)
    saveStartFresh(next)
  }

  const undoDismiss = (agent: DetectedAgent) => {
    const next = new Set(startFresh)
    next.delete(agent.kind)
    setStartFresh(next)
    saveStartFresh(next)
  }

  const launchImport = (agent: DetectedAgent) => {
    const isLegacy = agent.kind === 'openclaw'
    startImport({
      instance_id: agent.already_connected!,
      kind: isLegacy ? 'legacy' : 'transcripts',
      ...(isLegacy && agent.data_found.legacy_db ? { legacy_path: agent.data_found.legacy_db.path } : {}),
    }).then(
      status => {
        setPersisted(null) // le job relancé remplace le statut interrompu
        setFlow({ step: 'running', agent, status })
      },
      (err: unknown) => {
        console.warn('memoria-ui : démarrage de l’import échoué', err)
        setFlow({ step: 'failed', agent, message: humanError(err) })
      },
    )
  }

  // P0 : détection automatique au montage (ne pas exiger un clic « Détecter »).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { detect() }, [])

  // Au montage : un import interrompu par un arrêt du daemon est affiché avec
  // son message et un bouton pour le relancer (route absente / muette → rien).
  useEffect(() => {
    getImportStatus().then(
      status => setPersisted(status.state === 'interrupted' ? status : null),
      (err: unknown) => console.warn('memoria-ui : statut d’import persisté illisible', err),
    )
  }, [])

  // Compte des erreurs de polling consécutives : au-delà d'un seuil, le service
  // est considéré injoignable → on sort le spinner de son état infini (P0).
  const pollErrors = useRef(0)

  // Polling du job (1 s) tant que la fenêtre est en étape « running ».
  useEffect(() => {
    if (flow.step !== 'running') return
    pollErrors.current = 0
    const agent = flow.agent
    const id = window.setInterval(() => {
      getImportStatus().then(
        status => {
          pollErrors.current = 0
          // done / error / interrupted / idle : chaque état a une issue explicite
          // (lib/import-flow.ts) — un état inconnu ne laisse jamais tourner le spinner.
          const next = importPollOutcome(status, t)
          if (next.kind === 'done') setFlow({ step: 'done', agent, status: next.status })
          else if (next.kind === 'failed') setFlow({ step: 'failed', agent, message: next.message })
          else setFlow({ step: 'running', agent, status: next.status })
        },
        (err: unknown) => {
          // Erreur de polling : on retente, mais au bout de ~8 s sans réponse on
          // abandonne proprement au lieu de tourner à l'infini.
          console.warn('memoria-ui : statut d’import illisible', err)
          pollErrors.current += 1
          if (pollErrors.current >= 8) setFlow({ step: 'failed', agent, message: t('agents.import.lost') })
        },
      )
    }, 1000)
    return () => window.clearInterval(id)
  }, [flow])

  const interrupted = persisted ? interruptedImport(persisted, detected, t) : null
  const resumeAgent = interrupted?.agent ?? null

  const detectButton = (
    <Button variant="outline" size="sm" onClick={detect} disabled={detecting}>
      {detecting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ScanSearch aria-hidden="true" />}
      {detecting ? t('agents.machine.detecting') : t('agents.machine.detect')}
    </Button>
  )

  // « Sur cette machine » = ce qu'il RESTE à brancher. Un agent déjà connecté et
  // sans souvenirs à reprendre n'offre AUCUNE action (cf. la zone d'actions de
  // MachineAgentCard) : il répétait à l'identique la liste « Agents connectés »
  // juste en dessous, soit ~250 px inertes en haut de l'écran mobile.
  // En onboarding (embedded), on montre tout : c'est là qu'on branche les agents.
  const actionable = detected === null || embedded ? detected : detected.filter(a => a.already_connected === null || describeData(t, a) !== null)
  // Tout est déjà branché : on ne cache pas la section (le bouton « Détecter »
  // doit rester là), on la réduit à la phrase qui répond à la seule question de
  // l'écran — « est-ce que c'est connecté ? ».
  const allDone = detected !== null && detected.length > 0 && actionable !== null && actionable.length === 0

  const body = (
    <div className="flex flex-col gap-3">
      {/* Le texte d'intro vit dans le contenu, pas dans l'en-tête de carte : à côté du
          bouton Détecter, il se retrouvait compressé sur 3 colonnes sous 640 px. */}
      {!embedded && !allDone && <p className="text-sm text-muted-foreground">{t('agents.machine.lead')}</p>}
      {allDone && <p className="text-sm text-muted-foreground">{t('agents.machine.allConnected')}</p>}
      {error && <ErrorBanner message={error} onRetry={detect} className="my-0" />}
      {interrupted && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{interrupted.message}</AlertTitle>
          <div className="col-start-2 mt-2">
            {resumeAgent ? (
              <Button size="sm" onClick={() => launchImport(resumeAgent)}>
                <RefreshCw aria-hidden="true" />
                {t('agents.import.resume')}
              </Button>
            ) : (
              <AlertDescription>{t('agents.import.resumeUnknownAgent')}</AlertDescription>
            )}
          </div>
        </Alert>
      )}
      {detected === null && !error && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label={t('agents.machine.detecting')}>
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      )}
      {detected !== null && detected.length === 0 && <p className="text-sm text-muted-foreground">{t('agents.machine.none')}</p>}
      {actionable !== null && actionable.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {actionable.map(agent => (
            <MachineAgentCard
              key={agent.kind}
              agent={agent}
              busy={connectBusy === agent.kind}
              connectResult={connectResults[agent.kind]}
              dismissed={startFresh.has(agent.kind)}
              onConnect={() => connect(agent)}
              onImport={() => setFlow({ step: 'confirm', agent })}
              onDismiss={() => dismissImport(agent)}
              onUndoDismiss={() => undoDismiss(agent)}
            />
          ))}
        </div>
      )}
    </div>
  )

  const dialog = (
    <ImportDialog
      flow={flow}
      onOpenReview={onOpenReview}
      onLaunch={launchImport}
      onClose={() => {
        // pendant le run on laisse le job finir côté daemon ; on ferme juste la fenêtre
        const wasDone = flow.step === 'done'
        setFlow({ step: 'closed' })
        if (wasDone) onChanged()
      }}
    />
  )

  if (embedded) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('agents.machine.title')}</h2>
          {detectButton}
        </div>
        {body}
        {dialog}
      </div>
    )
  }

  return (
    <>
      <SectionCard title={t('agents.machine.title')} actions={detectButton} className="mb-0">
        {body}
      </SectionCard>
      {dialog}
    </>
  )
}

const KIND_ICONS: Record<DetectedAgent['kind'], LucideIcon> = {
  'claude-code': Terminal,
  codex: Braces,
  openclaw: MessageCircle,
  cursor: MousePointerClick,
}

function MachineAgentCard({
  agent,
  busy,
  connectResult,
  dismissed,
  onConnect,
  onImport,
  onDismiss,
  onUndoDismiss,
}: {
  agent: DetectedAgent
  busy: boolean
  connectResult: ConnectAgentResult | undefined
  dismissed: boolean
  onConnect: () => void
  onImport: () => void
  onDismiss: () => void
  onUndoDismiss: () => void
}) {
  const { t } = useT()
  const connected = agent.already_connected !== null
  const dataLabel = describeData(t, agent)
  const details = [connected ? null : agent.installed ? t('agents.card.cliInstalled') : t('agents.card.cliAbsent'), dataLabel].filter(
    (d): d is string => d !== null,
  )
  const Icon = KIND_ICONS[agent.kind]
  return (
    <Card size="sm" className={cn('bg-muted/40 ring-0', connected && 'ring-1 ring-success/30')}>
      <CardContent className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 font-medium">
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{agent.name}</span>
          </div>
          {connected ? (
            <StatusBadge tone="ok">{t('agents.card.connected')}</StatusBadge>
          ) : (
            <StatusBadge tone="muted">{t('agents.card.notConnected')}</StatusBadge>
          )}
        </div>
        {/* Une fois l'agent connecté, savoir si son application est installée
            n'apprend plus rien et contredisait le badge vert juste au-dessus
            (« Déjà connecté » / « CLI absente »). On ne garde alors que ce
            qu'il reste à faire : « 122 conversations trouvées ». */}
        {details.length > 0 && <p className="text-xs text-muted-foreground">{details.join(' · ')}</p>}
        {connectResult && (
          <p className={cn('flex items-start gap-1.5 text-xs', connectResult.registered.registered ? 'text-success' : 'text-warning')}>
            {connectResult.registered.registered ? (
              <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>
              {connectResult.registered.registered
                ? t('agents.card.connectOk', { hint: connectResult.restart_hint ?? '' })
                : t('agents.card.connectWarn', { detail: connectResult.registered.detail })}
            </span>
          </p>
        )}
        {/* Zone d'actions rendue seulement s'il y a quelque chose à faire (sinon un vide inutile en bas de carte). */}
        {(!connected || dataLabel) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {!connected && (
              <Button size="sm" className={TOUCH_ROW_ACTION} onClick={onConnect} disabled={busy}>
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                {busy ? t('agents.card.connecting') : t('agents.card.connect')}
              </Button>
            )}
            {connected && dataLabel && !dismissed && (
              <>
                <Button size="sm" className={TOUCH_ROW_ACTION} onClick={onImport}>
                  {t('agents.card.import')}
                </Button>
                <Button size="sm" variant="ghost" className={TOUCH_ROW_ACTION} onClick={onDismiss}>
                  {t('agents.card.startFresh')}
                </Button>
              </>
            )}
            {connected && dataLabel && dismissed && (
              <span className="text-xs text-muted-foreground">
                {t('agents.card.startFreshNote')}{' '}
                <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onUndoDismiss}>
                  {t('agents.card.undoDismiss')}
                </Button>
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** « 122 conversations trouvées » / « Mémoire OpenClaw : 3 573 souvenirs ». */
function describeData(t: Translate, agent: DetectedAgent): string | null {
  if (agent.data_found.transcript_files !== undefined) {
    const n = agent.data_found.transcript_files
    const key = n > 1 ? 'agents.data.conversations.plural' : 'agents.data.conversations.one'
    return t(key, { n: formatNumber(n) })
  }
  if (agent.data_found.legacy_db) {
    return t('agents.data.legacy', { n: formatNumber(agent.data_found.legacy_db.fact_count) })
  }
  return null
}

// ------------------------------------------------------------ import (dialogue)

function ImportDialog({
  flow,
  onOpenReview,
  onLaunch,
  onClose,
}: {
  flow: ImportFlow
  onOpenReview?: () => void
  onLaunch: (agent: DetectedAgent) => void
  onClose: () => void
}) {
  const { t } = useT()
  if (flow.step === 'closed') return null
  const agent = flow.agent
  const isLegacy = agent.kind === 'openclaw'
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('agents.import.title', { name: agent.name })}</DialogTitle>
          <DialogDescription>
            {t('agents.confirm.source')}
            {describeData(t, agent)}
            {isLegacy && agent.data_found.legacy_db && <span className="break-all"> ({agent.data_found.legacy_db.path})</span>}
          </DialogDescription>
        </DialogHeader>

        {flow.step === 'confirm' && (
          <>
            <p className="text-sm text-muted-foreground">
              {isLegacy ? (
                t('agents.confirm.legacyBody')
              ) : (
                <>
                  {t('agents.confirm.transcriptsBefore')}
                  <strong className="text-foreground">{t('agents.confirm.transcriptsDormant')}</strong>
                  {t('agents.confirm.transcriptsAfter')}
                </>
              )}
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t('agents.confirm.cancel')}
              </Button>
              <Button onClick={() => onLaunch(agent)}>{t('agents.confirm.launch')}</Button>
            </DialogFooter>
          </>
        )}

        {flow.step === 'running' && <ImportProgress status={flow.status} />}

        {flow.step === 'done' && (
          <ImportDone agent={agent} status={flow.status} onOpenReview={onOpenReview} onClose={onClose} />
        )}

        {flow.step === 'failed' && (
          <>
            <ErrorBanner message={flow.message} className="my-0" />
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t('common.close')}
              </Button>
              <Button onClick={() => onLaunch(agent)}>
                <RefreshCw aria-hidden="true" />
                {t('common.retry')}
              </Button>
            </DialogFooter>
          </>
        )}
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function ImportProgress({ status }: { status: ImportJobStatus | null }) {
  const { t } = useT()
  const p = status?.progress
  const total = p && p.files_total > 0 ? p.files_total : 1
  const done = p ? Math.min(p.files_done, total) : 0
  const percent = Math.round((done / total) * 100)
  return (
    <div className="flex flex-col gap-3" role="status">
      <p className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
        {t('agents.progress.running')}
      </p>
      <Progress value={percent} className="h-2" aria-label={t('agents.progress.running')} />
      <p className="text-sm text-muted-foreground tabular-nums">
        {p ? t('agents.progress.detail', { done: p.files_done, total: p.files_total, facts: formatNumber(p.facts_imported) }) : t('agents.progress.starting')}
      </p>
    </div>
  )
}

function ImportDone({
  agent,
  status,
  onOpenReview,
  onClose,
}: {
  agent: DetectedAgent
  status: ImportJobStatus
  onOpenReview?: () => void
  onClose: () => void
}) {
  const { t } = useT()
  const n = status.progress.facts_imported
  const isLegacy = agent.kind === 'openclaw'
  const [errorsOpen, setErrorsOpen] = useState(false)
  return (
    <>
      <Alert className="ring-1 ring-success/30">
        <CircleCheck className="text-success" />
        <AlertTitle>
          {isLegacy
            ? t('agents.done.legacyStrong', { n: formatNumber(n) })
            : t(n > 1 ? 'agents.done.transcriptsStrong.plural' : 'agents.done.transcriptsStrong.one', { n: formatNumber(n) })}
        </AlertTitle>
        <AlertDescription>{isLegacy ? t('agents.done.legacyAfter') : t('agents.done.transcriptsAfter')}</AlertDescription>
      </Alert>
      {status.errors.length > 0 && (
        <Collapsible open={errorsOpen} onOpenChange={setErrorsOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-warning" aria-expanded={errorsOpen}>
              <TriangleAlert aria-hidden="true" />
              {t('agents.done.errorsSummary', { n: status.errors.length })}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-muted-foreground">
              {status.errors.slice(0, 10).map((e, i) => (
                <li key={i} className="break-words">{e}</li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('agents.done.close')}
        </Button>
        {!isLegacy && onOpenReview && <Button onClick={onOpenReview}>{t('agents.done.openReview')}</Button>}
      </DialogFooter>
    </>
  )
}

// ------------------------------------------------------------ agents connectés

function AgentList({ agents, onRevoke, onDelete }: { agents: AgentEntry[]; onRevoke: (id: string) => void; onDelete: (id: string) => void }) {
  const { t } = useT()
  const nameOf = useAgentNamer()
  return (
    <ul className="-my-3 divide-y">
      {agents.map(entry => {
        const { instance, assistant_type } = entry
        const revoked = instance.revoked_at !== null
        const pending = !revoked && instance.last_seen_at === null
        return (
          <li key={instance.id} className={cn('flex flex-col gap-3 py-3 md:flex-row md:items-start md:justify-between', revoked && 'opacity-60')}>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{nameOf(entry)}</span>
                {revoked ? (
                  <StatusBadge tone="muted">{t('agents.list.revoked')}</StatusBadge>
                ) : pending ? (
                  <StatusBadge tone="warn">{t('agents.list.pending')}</StatusBadge>
                ) : (
                  <StatusBadge tone="ok">{t('agents.list.connected')}</StatusBadge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('agents.list.on', { machine: instance.machine_id })}
                {' · '}
                {instance.last_seen_at ? t('agents.list.seenAt', { date: formatDate(instance.last_seen_at) }) : t('agents.list.addedAt', { date: formatDate(instance.created_at) })}
              </p>
              {!revoked && !pending && <AgentExpertise instanceId={instance.id} />}
            </div>
            {/* gap-3 : « Supprimer » (définitif) ne doit pas coller à « Révoquer » sous le doigt. */}
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              {!revoked && (
                <ConfirmButton
                  className={TOUCH_ROW_ACTION}
                  label={t('agents.list.revoke')}
                  title={t('agents.list.revokeTitle')}
                  description={t('agents.list.revokeBody')}
                  confirmLabel={t('agents.list.revoke')}
                  onConfirm={() => onRevoke(instance.id)}
                />
              )}
              <ConfirmButton
                className={TOUCH_ROW_ACTION}
                label={t('agents.list.delete')}
                title={t('agents.list.deleteTitle')}
                description={t('agents.list.deleteBody')}
                confirmLabel={t('agents.list.delete')}
                variant="destructive"
                onConfirm={() => onDelete(instance.id)}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Domaines de maîtrise + forces/faiblesses de l'agent (couches 8 + 19). */
function AgentExpertise({ instanceId }: { instanceId: string }) {
  const { t } = useT()
  const [domains, setDomains] = useState<ExpertiseDomain[]>([])
  const [self, setSelf] = useState<SelfObservation[]>([])
  // Garde `cancelled` : la liste se remonte à chaque reload() (révocation,
  // dialogue…) ; sans elle, la réponse d'un ancien instanceId pouvait écraser
  // les badges d'un autre agent.
  useEffect(() => {
    let cancelled = false
    getExpertise(instanceId)
      .then(d => {
        if (!cancelled) setDomains(d.slice(0, 4))
      })
      .catch(() => {
        if (!cancelled) setDomains([])
      })
    // analyse fraîche du comportement puis lecture
    deriveSelf(instanceId)
      .catch(() => 0)
      .then(() => getSelfObservations(instanceId))
      .then(o => {
        if (!cancelled) setSelf(o.slice(0, 3))
      })
      .catch(() => {
        if (!cancelled) setSelf([])
      })
    return () => {
      cancelled = true
    }
  }, [instanceId])
  if (domains.length === 0 && self.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {domains.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" title={t('agents.expertise.title')}>
          <span className="mr-1 text-xs text-muted-foreground">{t('agents.expertise.label')}</span>
          {domains.map(d => (
            <Badge key={d.domain} variant="secondary">
              {d.domain}
            </Badge>
          ))}
        </div>
      )}
      {self.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {self.map(o => (
            <SelfObservationBadge key={o.id} observation={o} />
          ))}
        </div>
      )}
    </div>
  )
}

function SelfObservationBadge({ observation: o }: { observation: SelfObservation }) {
  const { t } = useT()
  const text = o.observation.length > 60 ? o.observation.slice(0, 57) + '…' : o.observation
  const kindLabel = o.kind === 'strength' ? t('agents.self.strength') : o.kind === 'weakness' ? t('agents.self.weakness') : t('agents.self.other')
  const icon: ReactNode =
    o.kind === 'strength' ? <Check aria-hidden="true" /> : o.kind === 'weakness' ? <TriangleAlert aria-hidden="true" /> : null
  return (
    <Badge
      variant="outline"
      className={cn('h-auto max-w-full py-0.5 text-left whitespace-normal', o.kind === 'weakness' && 'border-warning/40 text-warning')}
      title={kindLabel}
    >
      {icon}
      {text}
    </Badge>
  )
}
