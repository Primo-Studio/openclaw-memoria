/**
 * Agents — détection des assistants de la machine + connexion 1 clic + import
 * des souvenirs avec progression (missions B1/B2/B3/B4), connexion par code de
 * pairing (TTL 10 min, voir PAIRING_TTL_MS côté core) et révocation.
 */
import { useEffect, useState, type ReactNode } from 'react'
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
  Spinner,
  agentTypeLabel,
  formatDate,
  humanError,
  useLoad,
} from '../components/ui'

const PAIRING_TTL_SECONDS = 10 * 60 // miroir de PAIRING_TTL_MS (registry.ts)

const AGENT_CHOICES: Array<{ type: AgentType; label: string; hint: string }> = [
  { type: 'claude-code', label: 'Claude Code', hint: 'L’assistant de votre terminal' },
  { type: 'codex', label: 'Codex', hint: 'L’assistant OpenAI' },
  { type: 'openclaw', label: 'OpenClaw', hint: 'Votre assistant OpenClaw' },
  { type: 'generic', label: 'Autre agent', hint: 'Tout agent compatible' },
]

type PairFlow =
  | { step: 'closed' }
  | { step: 'choose'; busy: AgentType | null; error: string | null }
  | { step: 'code'; type: AgentType; result: PairResult }

export function Agents({ onOpenReview }: { onOpenReview?: () => void }) {
  const { state, reload } = useLoad(getAgents)
  const [flow, setFlow] = useState<PairFlow>({ step: 'closed' })
  const [actionError, setActionError] = useState<string | null>(null)

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
    setActionError(null)
    revokeAgent(instanceId).then(
      () => reload(),
      (err: unknown) => {
        console.warn('memoria-ui : révocation échouée', err)
        setActionError(humanError(err))
      },
    )
  }

  const remove = (instanceId: string) => {
    setActionError(null)
    deleteAgent(instanceId).then(
      () => reload(),
      (err: unknown) => {
        console.warn('memoria-ui : suppression échouée', err)
        setActionError(humanError(err))
      },
    )
  }

  return (
    <section>
      <header className="screen-head">
        <h1>Agents</h1>
        {state.status === 'ready' && state.data.length > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => setFlow({ step: 'choose', busy: null, error: null })}>
            Connecter un agent
          </button>
        )}
      </header>

      <MachineAgents onChanged={reload} onOpenReview={onOpenReview} />

      {actionError && <ErrorBanner message={actionError} />}

      {state.status === 'loading' && <Spinner />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' &&
        (state.data.length === 0 && flow.step === 'closed' ? (
          <EmptyState
            title="Aucun agent connecté"
            body="Reliez votre premier assistant : il gardera en mémoire ce que vous faites ensemble, d’une session à l’autre."
            action={
              <button
                type="button"
                className="btn btn-primary btn-big"
                onClick={() => setFlow({ step: 'choose', busy: null, error: null })}
              >
                Connecter votre premier agent
              </button>
            }
          />
        ) : (
          <AgentList agents={state.data} onRevoke={revoke} onDelete={remove} />
        ))}

      {flow.step === 'choose' && (
        <Modal title="Quel agent voulez-vous connecter ?" onClose={() => setFlow({ step: 'closed' })}>
          {flow.error && <ErrorBanner message={flow.error} />}
          <div className="choice-grid">
            {AGENT_CHOICES.map(choice => (
              <button
                key={choice.type}
                type="button"
                className="choice-card"
                disabled={flow.busy !== null}
                onClick={() => startPairing(choice.type)}
              >
                <strong>{choice.label}</strong>
                <span className="muted">{flow.busy === choice.type ? 'Préparation…' : choice.hint}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {flow.step === 'code' && (
        <Modal title={`Connecter ${agentTypeLabel(flow.type)}`} onClose={closeFlow}>
          <PairingCode result={flow.result} onRegenerate={() => startPairing(flow.type)} />
          <div className="modal-foot">
            <button type="button" className="btn btn-primary" onClick={closeFlow}>
              C’est fait
            </button>
          </div>
        </Modal>
      )}
    </section>
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

/** Section « Sur cette machine » : détection, connexion 1 clic, import des souvenirs. */
function MachineAgents({ onChanged, onOpenReview }: { onChanged: () => void; onOpenReview?: () => void }) {
  const [detected, setDetected] = useState<DetectedAgent[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectBusy, setConnectBusy] = useState<string | null>(null)
  const [connectResults, setConnectResults] = useState<Record<string, ConnectAgentResult>>({})
  const [startFresh, setStartFresh] = useState<Set<string>>(loadStartFresh)
  const [flow, setFlow] = useState<ImportFlow>({ step: 'closed' })

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
      status => setFlow({ step: 'running', agent, status }),
      (err: unknown) => {
        console.warn('memoria-ui : démarrage de l’import échoué', err)
        setFlow({ step: 'failed', agent, message: humanError(err) })
      },
    )
  }

  // Polling du job (1 s) tant que la modale est en étape « running ».
  useEffect(() => {
    if (flow.step !== 'running') return
    const agent = flow.agent
    const id = window.setInterval(() => {
      getImportStatus().then(
        status => {
          if (status.state === 'done') setFlow({ step: 'done', agent, status })
          else if (status.state === 'error') setFlow({ step: 'failed', agent, message: status.error ?? 'Erreur inconnue — regarde le journal du daemon.' })
          else setFlow({ step: 'running', agent, status })
        },
        (err: unknown) => {
          // erreur de polling : visible en console, on retentera au tick suivant
          console.warn('memoria-ui : statut d’import illisible', err)
        },
      )
    }, 1000)
    return () => window.clearInterval(id)
  }, [flow])

  return (
    <div className="machine-agents">
      <div className="machine-head">
        <h2>Sur cette machine</h2>
        <button type="button" className="btn" onClick={detect} disabled={detecting}>
          {detecting ? 'Détection…' : '🔍 Détecter les agents'}
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      {detected !== null && detected.length === 0 && (
        <p className="muted">Aucun assistant détecté sur cette machine.</p>
      )}
      {detected !== null && detected.length > 0 && (
        <div className="machine-grid">
          {detected.map(agent => (
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

      {flow.step !== 'closed' && (
        <Modal
          title={`Importer les souvenirs — ${flow.agent.name}`}
          onClose={() => {
            // pendant le run on laisse le job finir côté daemon ; on ferme juste la fenêtre
            setFlow({ step: 'closed' })
            if (flow.step === 'done') onChanged()
          }}
        >
          {flow.step === 'confirm' && (
            <ImportConfirm agent={flow.agent} onConfirm={() => launchImport(flow.agent)} onCancel={() => setFlow({ step: 'closed' })} />
          )}
          {flow.step === 'running' && <ImportProgress status={flow.status} />}
          {flow.step === 'done' && (
            <ImportDone agent={flow.agent} status={flow.status} onOpenReview={onOpenReview} onClose={() => { setFlow({ step: 'closed' }); onChanged() }} />
          )}
          {flow.step === 'failed' && <ErrorBanner message={flow.message} />}
        </Modal>
      )}
    </div>
  )
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
  const connected = agent.already_connected !== null
  const dataLabel = describeData(agent)
  return (
    <div className="machine-card">
      <div className="machine-card-head">
        <strong>{agentIcon(agent.kind)} {agent.name}</strong>
        {connected ? <span className="badge badge-ok">Déjà connecté ✓</span> : <span className="badge badge-muted">Non connecté</span>}
      </div>
      <div className="machine-card-meta muted">
        {agent.installed ? 'CLI installée' : 'CLI absente'}
        {dataLabel && <> · {dataLabel}</>}
      </div>
      {connectResult && (
        <p className={connectResult.registered.registered ? 'machine-connect-ok' : 'machine-connect-warn'}>
          {connectResult.registered.registered
            ? `✓ Connecté. ${connectResult.restart_hint ?? ''}`
            : `⚠ Connecté, mais l'enregistrement automatique a échoué : ${connectResult.registered.detail}`}
        </p>
      )}
      <div className="machine-card-actions">
        {!connected && (
          <button type="button" className="btn btn-primary" onClick={onConnect} disabled={busy}>
            {busy ? 'Connexion…' : 'Connecter'}
          </button>
        )}
        {connected && dataLabel && !dismissed && (
          <>
            <button type="button" className="btn btn-primary" onClick={onImport}>
              Importer ses souvenirs
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDismiss}>
              Démarrer de zéro
            </button>
          </>
        )}
        {connected && dataLabel && dismissed && (
          <span className="muted">
            Démarrage de zéro — rien ne sera importé.{' '}
            <button type="button" className="btn-link" onClick={onUndoDismiss}>
              Changer d’avis
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

function agentIcon(kind: DetectedAgent['kind']): string {
  if (kind === 'claude-code') return '🤖'
  if (kind === 'codex') return '🧠'
  if (kind === 'openclaw') return '🦞'
  return '🖱️'
}

/** « 122 conversations trouvées » / « Mémoire OpenClaw : 3 573 souvenirs ». */
function describeData(agent: DetectedAgent): string | null {
  if (agent.data_found.transcript_files !== undefined) {
    const n = agent.data_found.transcript_files
    return `${n.toLocaleString('fr-FR')} conversation${n > 1 ? 's' : ''} trouvée${n > 1 ? 's' : ''}`
  }
  if (agent.data_found.legacy_db) {
    return `Mémoire OpenClaw : ${agent.data_found.legacy_db.fact_count.toLocaleString('fr-FR')} souvenirs`
  }
  return null
}

function ImportConfirm({ agent, onConfirm, onCancel }: { agent: DetectedAgent; onConfirm: () => void; onCancel: () => void }) {
  const isLegacy = agent.kind === 'openclaw'
  return (
    <div className="import-confirm">
      <p>
        <strong>Source : </strong>
        {describeData(agent)}
        {isLegacy && agent.data_found.legacy_db && <span className="muted"> ({agent.data_found.legacy_db.path})</span>}
      </p>
      {isLegacy ? (
        <p className="muted">
          La mémoire OpenClaw sera adoptée directement dans la mémoire privée de cet agent : les souvenirs
          deviennent actifs immédiatement (la base d’origine n’est jamais modifiée — un instantané est utilisé).
        </p>
      ) : (
        <p className="muted">
          Tes conversations seront analysées et résumées en souvenirs. Ils arrivent <strong>dormants</strong> :
          rien n’est utilisé avant ta validation dans l’écran Revue.
        </p>
      )}
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Annuler
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>
          Lancer l’import
        </button>
      </div>
    </div>
  )
}

function ImportProgress({ status }: { status: ImportJobStatus | null }) {
  const p = status?.progress
  const total = p && p.files_total > 0 ? p.files_total : 1
  const done = p ? Math.min(p.files_done, total) : 0
  const percent = Math.round((done / total) * 100)
  return (
    <div className="import-progress">
      <p>Import en cours… ne ferme pas le service Memoria.</p>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="muted">
        {p ? `${p.files_done}/${p.files_total} fichier(s) — ${p.facts_imported.toLocaleString('fr-FR')} souvenir(s) pour l'instant` : 'Démarrage…'}
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
  const n = status.progress.facts_imported
  const isLegacy = agent.kind === 'openclaw'
  return (
    <div className="import-done">
      {isLegacy ? (
        <p>
          ✓ <strong>{n.toLocaleString('fr-FR')} souvenirs adoptés</strong> — la mémoire OpenClaw est maintenant la
          mémoire privée de cet agent, active immédiatement.
        </p>
      ) : (
        <p>
          ✓ <strong>{n.toLocaleString('fr-FR')} souvenir{n > 1 ? 's' : ''} importé{n > 1 ? 's' : ''}</strong> — ils
          attendent ta validation dans l’écran Revue.
        </p>
      )}
      {status.errors.length > 0 && (
        <details className="import-errors">
          <summary>⚠ {status.errors.length} erreur(s) non bloquante(s) pendant l’import</summary>
          <ul>
            {status.errors.slice(0, 10).map((e, i) => (
              <li key={i} className="muted">{e}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Fermer
        </button>
        {!isLegacy && onOpenReview && (
          <button type="button" className="btn btn-primary" onClick={onOpenReview}>
            Ouvrir l’écran Revue →
          </button>
        )}
      </div>
    </div>
  )
}

function AgentList({ agents, onRevoke, onDelete }: { agents: AgentEntry[]; onRevoke: (id: string) => void; onDelete: (id: string) => void }) {
  if (agents.length === 0) return null
  return (
    <ul className="agent-list">
      {agents.map(({ instance, assistant_type }) => {
        const revoked = instance.revoked_at !== null
        const pending = !revoked && instance.last_seen_at === null
        return (
          <li key={instance.id} className={`agent-row${revoked ? ' agent-revoked' : ''}`}>
            <div className="agent-id">
              <strong>{agentTypeLabel(assistant_type)}</strong>
              <span className="muted">sur {instance.machine_id}</span>
            </div>
            <div className="agent-meta">
              {revoked ? (
                <span className="badge badge-muted">Déconnecté</span>
              ) : pending ? (
                <span className="badge badge-warn">En attente de l’agent</span>
              ) : (
                <span className="badge badge-ok">Connecté</span>
              )}
              <span className="muted">
                {instance.last_seen_at ? `Vu le ${formatDate(instance.last_seen_at)}` : `Ajouté le ${formatDate(instance.created_at)}`}
              </span>
            </div>
            {!revoked && !pending && <AgentExpertise instanceId={instance.id} />}
            <div className="agent-actions">
              {!revoked && (
                <ConfirmButton label="Révoquer" confirmLabel="Confirmer la révocation ?" onConfirm={() => onRevoke(instance.id)} />
              )}
              <ConfirmButton
                label="Supprimer"
                confirmLabel="Effacer la mémoire définitivement ?"
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
  const [domains, setDomains] = useState<ExpertiseDomain[]>([])
  const [self, setSelf] = useState<SelfObservation[]>([])
  useEffect(() => {
    getExpertise(instanceId)
      .then(d => setDomains(d.slice(0, 4)))
      .catch(() => setDomains([]))
    // analyse fraîche du comportement puis lecture
    deriveSelf(instanceId)
      .catch(() => 0)
      .then(() => getSelfObservations(instanceId))
      .then(o => setSelf(o.slice(0, 3)))
      .catch(() => setSelf([]))
  }, [instanceId])
  if (domains.length === 0 && self.length === 0) return null
  return (
    <div className="agent-insights">
      {domains.length > 0 && (
        <div className="agent-expertise" title="Domaines de maîtrise">
          <span className="muted">maîtrise :</span>
          {domains.map(d => <span key={d.domain} className="badge badge-theme">{d.domain}</span>)}
        </div>
      )}
      {self.length > 0 && (
        <div className="agent-self">
          {self.map(o => (
            <span key={o.id} className={`badge ${o.kind === 'weakness' ? 'badge-warn' : 'badge-muted'}`} title={o.kind}>
              {o.kind === 'strength' ? '✓ ' : o.kind === 'weakness' ? '⚠ ' : '• '}
              {o.observation.length > 60 ? o.observation.slice(0, 57) + '…' : o.observation}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function PairingCode({ result, onRegenerate }: { result: PairResult; onRegenerate: () => void }) {
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
    <div className="pairing">
      <p>
        Collez cette commande dans le terminal de votre agent (ou donnez-lui le code) — il se connectera tout seul.
      </p>
      <div className="pairing-code" aria-label="Code de connexion">
        {result.pairing_code}
      </div>
      <div className="command-row">
        <code className="command">{result.command}</code>
        <CopyButton text={result.command} label="Copier la commande" />
      </div>
      {expired ? (
        <div className="pairing-expired">
          <span>Ce code a expiré.</span>
          <button type="button" className="btn btn-primary" onClick={onRegenerate}>
            Générer un nouveau code
          </button>
        </div>
      ) : (
        <p className="muted">
          Ce code expire dans <strong>{mm}:{ss}</strong>. Il ne sert qu’une fois.
        </p>
      )}
    </div>
  )
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
