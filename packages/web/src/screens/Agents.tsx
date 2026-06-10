/**
 * Agents — connecter un assistant (code de pairing TTL 10 min, voir
 * PAIRING_TTL_MS côté core) et révoquer un accès, avec confirmation.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { getAgents, pairAgent, revokeAgent, type AgentEntry, type AgentType, type PairResult } from '../api'
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

export function Agents() {
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
          <AgentList agents={state.data} onRevoke={revoke} />
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

function AgentList({ agents, onRevoke }: { agents: AgentEntry[]; onRevoke: (id: string) => void }) {
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
            {!revoked && (
              <ConfirmButton label="Révoquer" confirmLabel="Confirmer la révocation ?" onConfirm={() => onRevoke(instance.id)} />
            )}
          </li>
        )
      })}
    </ul>
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
