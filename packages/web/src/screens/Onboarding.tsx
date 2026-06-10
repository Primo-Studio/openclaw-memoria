/**
 * Onboarding — premier lancement (spec §13), < 60 s, ton « tout est local ».
 * Étapes : bienvenue → stockage → moteur d'IA → connecter un 1er agent.
 * Déclenché par App quand 0 agent connecté. Bouton « passer » disponible.
 */
import { useEffect, useState } from 'react'
import { Wizard, type WizardStep } from '../components/Wizard'
import {
  ApiError,
  getDoctor,
  getProviders,
  pairAgent,
  type AgentType,
  type DoctorReport,
  type PairResult,
  type ProvidersStatus,
} from '../api'

const AGENT_TYPES: Array<{ id: AgentType; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'generic', label: 'Autre (MCP)' },
]

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [providers, setProviders] = useState<ProvidersStatus | null>(null)
  const [providersUnavailable, setProvidersUnavailable] = useState(false)
  const [type, setType] = useState<AgentType>('claude-code')
  const [pair, setPair] = useState<PairResult | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getDoctor().then(setDoctor).catch(() => setDoctor(null))
  }, [])

  useEffect(() => {
    if (step !== 2) return
    getProviders()
      .then(p => { setProviders(p); setProvidersUnavailable(false) })
      .catch(() => setProvidersUnavailable(true))
  }, [step])

  const startPairing = async () => {
    try {
      setPair(await pairAgent(type))
    } catch (err) {
      setPair(null)
      console.warn('pairing onboarding échoué', err instanceof ApiError ? err.message : err)
    }
  }

  const steps: WizardStep[] = [
    {
      id: 'welcome',
      title: 'Bienvenue dans Memoria',
      render: () => (
        <div className="ob-step">
          <p className="ob-lead">La mémoire locale de vos agents IA.</p>
          <p>
            Chaque assistant (Claude Code, Codex, OpenClaw…) garde sa propre mémoire, ici, sur
            cette machine. <strong>Rien ne part dans le cloud.</strong>
          </p>
          <p className="muted">Cette mise en route prend moins d’une minute.</p>
        </div>
      ),
    },
    {
      id: 'storage',
      title: 'Où vit votre mémoire',
      render: () => (
        <div className="ob-step">
          <p>Vos souvenirs sont stockés dans :</p>
          <pre className="command">{doctor?.storage_root ?? '~/.memoria/data'}</pre>
          <p className="muted">
            Emplacement modifiable plus tard dans les Réglages. Tout y est chiffré pour les
            secrets et reste 100 % local.
          </p>
        </div>
      ),
    },
    {
      id: 'ai',
      title: 'Votre moteur d’IA',
      render: () => (
        <div className="ob-step">
          {providersUnavailable ? (
            <p className="muted">Détection des moteurs non disponible — vous pourrez la configurer dans les Réglages.</p>
          ) : !providers ? (
            <div className="spinner-row"><span className="spinner" aria-hidden /> Détection…</div>
          ) : (
            <ul className="ob-providers">
              <li className={providers.ollama.available ? 'ok' : 'off'}>
                <strong>Ollama</strong> {providers.ollama.available ? `détecté (${providers.ollama.models.length} modèle·s)` : 'non détecté'}
                {providers.ollama.available && providers.ollama.models.length === 0 && (
                  <div className="muted">Aucun modèle : <code>ollama pull nomic-embed-text</code> + <code>ollama pull qwen2.5:3b</code></div>
                )}
              </li>
              <li className={providers.anthropic.available ? 'ok' : 'off'}>
                <strong>Anthropic (Claude)</strong> {providers.anthropic.available ? 'clé détectée' : 'pas de clé (optionnel)'}
              </li>
              <li className={providers.lmstudio.available ? 'ok' : 'off'}>
                <strong>LM Studio</strong> {providers.lmstudio.available ? 'détecté' : 'non détecté'}
              </li>
            </ul>
          )}
          <p className="muted">Memoria fonctionne 100 % en local avec Ollama. Le cloud (Claude) est optionnel.</p>
        </div>
      ),
    },
    {
      id: 'agent',
      title: 'Connecter un premier agent',
      render: () => (
        <div className="ob-step">
          {!pair ? (
            <>
              <p>Quel assistant voulez-vous relier à sa mémoire ?</p>
              <div className="ob-types">
                {AGENT_TYPES.map(t => (
                  <button key={t.id} type="button" className={`capture-option${type === t.id ? ' capture-active' : ''}`} onClick={() => setType(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-primary" onClick={() => void startPairing()}>Générer le code</button>
            </>
          ) : (
            <>
              <p>Collez cette commande dans le chat de votre agent :</p>
              <pre className="command">{pair.command}</pre>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { void navigator.clipboard.writeText(pair.command); setCopied(true) }}
              >
                {copied ? 'Copié ✓' : 'Copier'}
              </button>
              <p className="muted">Code : <strong>{pair.pairing_code}</strong> — valable 10 minutes.</p>
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="welcome">
      <div className="welcome-card ob-card">
        <div className="brand">Memo<span style={{ color: 'var(--accent)' }}>ria</span></div>
        <Wizard
          steps={steps}
          current={step}
          onBack={() => setStep(s => Math.max(0, s - 1))}
          onNext={() => setStep(s => Math.min(steps.length - 1, s + 1))}
          onFinish={onDone}
          onSkip={onDone}
          nextLabel={step === steps.length - 1 ? 'Terminer' : 'Continuer'}
        />
      </div>
    </div>
  )
}
