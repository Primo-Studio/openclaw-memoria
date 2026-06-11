/**
 * Onboarding — premier lancement (spec §13), ton « tout est local ».
 * Étapes : bienvenue → stockage → MOTEUR D'INTELLIGENCE (obligatoire) →
 * connecter un 1er agent. L'étape moteur est LE rempart anti-mort-silencieuse :
 * on ne termine pas sans moteur d'extraction prêt, SAUF choix explicite du
 * mode dégradé (encart rouge qui dit ce que ça implique).
 */
import { useCallback, useEffect, useState } from 'react'
import { Wizard, type WizardStep } from '../components/Wizard'
import {
  ApiError,
  copyOpenClawKey,
  getDoctor,
  getLlmHealth,
  getOllamaPullStatus,
  pairAgent,
  setExtractionProvider,
  startOllamaPull,
  type AgentType,
  type DoctorReport,
  type LlmHealth,
  type LlmProviderName,
  type OllamaPullStatus,
  type PairResult,
} from '../api'

const AGENT_TYPES: Array<{ id: AgentType; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'generic', label: 'Autre (MCP)' },
]

type EngineChoice = LlmProviderName | 'openclaw'

/** Modèle conseillé par provider (lmstudio = premier modèle chargé). */
const DEFAULT_MODELS: Partial<Record<LlmProviderName, string>> = {
  ollama: 'qwen2.5:3b',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  openrouter: 'openai/gpt-4o-mini',
}

type EngineState = 'ready' | 'config' | 'off'

function StateBadge({ state }: { state: EngineState }) {
  if (state === 'ready') return <span className="badge badge-ok">Prêt</span>
  if (state === 'config') return <span className="badge badge-warn">À configurer</span>
  return <span className="badge badge-muted">Non détecté</span>
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [type, setType] = useState<AgentType>('claude-code')
  const [pair, setPair] = useState<PairResult | null>(null)
  const [copied, setCopied] = useState(false)

  // --- état de l'étape moteur
  const [health, setHealth] = useState<LlmHealth | null>(null)
  const [healthUnavailable, setHealthUnavailable] = useState(false)
  const [checking, setChecking] = useState(false)
  const [selected, setSelected] = useState<EngineChoice | null>(null)
  const [chosenNote, setChosenNote] = useState<string | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [testResult, setTestResult] = useState<LlmHealth | null>(null)
  // téléchargement Ollama en cours (polling 1 s)
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullStatus, setPullStatus] = useState<OllamaPullStatus | null>(null)

  useEffect(() => {
    getDoctor().then(setDoctor).catch(() => setDoctor(null))
  }, [])

  const refreshHealth = useCallback(async (): Promise<LlmHealth | null> => {
    setChecking(true)
    try {
      const h = await getLlmHealth()
      setHealth(h)
      setHealthUnavailable(false)
      return h
    } catch {
      // route absente (vieux service) : on n'affiche pas l'étape en bloquant
      setHealthUnavailable(true)
      return null
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (step === 2 && health === null && !healthUnavailable) void refreshHealth()
  }, [step, health, healthUnavailable, refreshHealth])

  /** Persiste le moteur choisi via POST /v1/admin/llm_extraction. */
  const persistChoice = useCallback(async (engine: LlmProviderName, h: LlmHealth | null): Promise<void> => {
    const model = engine === 'lmstudio' ? h?.options.lmstudio.models[0] : DEFAULT_MODELS[engine]
    try {
      await setExtractionProvider(engine, model)
      setChosenNote(`✓ Moteur enregistré : ${engine}${model ? ` / ${model}` : ''}`)
      setEngineError(null)
    } catch (err) {
      setEngineError(err instanceof ApiError ? err.message : 'Enregistrement du moteur impossible.')
    }
  }, [])

  // polling du téléchargement Ollama (barres de progression)
  useEffect(() => {
    if (!pulling) return
    const timer = setInterval(() => {
      getOllamaPullStatus()
        .then(s => {
          setPullStatus(s)
          if (!s.running) {
            setPulling(null)
            if (s.error) setEngineError(`Téléchargement de ${s.model ?? 'modèle'} en échec : ${s.error}`)
            void refreshHealth().then(h => {
              // une fois Ollama complet, on persiste le choix automatiquement
              if (h?.options.ollama.available) void persistChoice('ollama', h)
            })
          }
        })
        .catch(() => setPulling(null))
    }, 1000)
    return () => clearInterval(timer)
  }, [pulling, refreshHealth, persistChoice])

  const choose = useCallback(
    async (engine: EngineChoice) => {
      setSelected(engine)
      setTestResult(null)
      setChosenNote(null)
      if (!health) return
      const o = health.options
      if (engine === 'openclaw') {
        // copie la clé OpenClaw vers ~/.<provider>/api_key puis bascule dessus
        const provider = o.openclaw.provider
        if (!provider) return
        try {
          await copyOpenClawKey(provider)
          const h = await refreshHealth()
          await persistChoice(provider, h)
        } catch (err) {
          setEngineError(err instanceof ApiError ? err.message : 'Copie de la clé OpenClaw impossible.')
        }
        return
      }
      const ready =
        engine === 'ollama' ? o.ollama.available
        : engine === 'lmstudio' ? o.lmstudio.available && o.lmstudio.models.length > 0
        : o[engine].available
      if (ready) await persistChoice(engine, health)
    },
    [health, persistChoice, refreshHealth],
  )

  const startPull = useCallback((model: string) => {
    setEngineError(null)
    setPullStatus({ running: true, model, percent: null, status: 'démarrage', error: null })
    startOllamaPull(model)
      .then(() => setPulling(model))
      .catch(err => {
        setPullStatus(null)
        setEngineError(err instanceof ApiError ? err.message : 'Téléchargement impossible.')
      })
  }, [])

  const reverify = useCallback(async () => {
    setTestResult(null)
    const h = await refreshHealth()
    if (h && selected && selected !== 'openclaw') {
      const o = h.options
      const ready =
        selected === 'ollama' ? o.ollama.available
        : selected === 'lmstudio' ? o.lmstudio.available && o.lmstudio.models.length > 0
        : o[selected].available
      if (ready && !h.extraction.available) await persistChoice(selected, h)
      else if (ready) setChosenNote(`✓ Moteur prêt : ${h.extraction.provider} / ${h.extraction.model}`)
    }
  }, [refreshHealth, selected, persistChoice])

  const runTest = useCallback(async () => {
    const h = await refreshHealth()
    setTestResult(h)
  }, [refreshHealth])

  const startPairing = async () => {
    try {
      setPair(await pairAgent(type))
    } catch (err) {
      setPair(null)
      console.warn('pairing onboarding échoué', err instanceof ApiError ? err.message : err)
    }
  }

  const engineOk = health?.extraction.available === true
  const engineGateOpen = engineOk || degraded || healthUnavailable

  const steps: WizardStep[] = [
    {
      id: 'welcome',
      title: 'Bienvenue dans Memoria',
      render: () => (
        <div className="ob-step">
          <p className="ob-lead">La mémoire locale de tes agents IA.</p>
          <p>
            Chaque assistant (Claude Code, Codex, OpenClaw…) garde sa propre mémoire, ici, sur
            cette machine. <strong>Rien ne part dans le cloud.</strong>
          </p>
          <p className="muted">Cette mise en route prend moins de deux minutes.</p>
        </div>
      ),
    },
    {
      id: 'storage',
      title: 'Où vit ta mémoire',
      render: () => (
        <div className="ob-step">
          <p>Tes souvenirs sont stockés dans :</p>
          <pre className="command">{doctor?.storage_root ?? '~/.memoria/data'}</pre>
          <p className="muted">
            Emplacement modifiable plus tard dans les Réglages. Tout y est chiffré pour les
            secrets et reste 100 % local.
          </p>
        </div>
      ),
    },
    {
      id: 'engine',
      title: 'Moteur d’intelligence',
      render: () => (
        <EngineStep
          health={health}
          healthUnavailable={healthUnavailable}
          checking={checking}
          selected={selected}
          chosenNote={chosenNote}
          engineError={engineError}
          testResult={testResult}
          pullStatus={pullStatus}
          pulling={pulling}
          degraded={degraded}
          onChoose={engine => void choose(engine)}
          onPull={startPull}
          onReverify={() => void reverify()}
          onTest={() => void runTest()}
          onDegraded={() => {
            setDegraded(true)
            setStep(3)
          }}
        />
      ),
    },
    {
      id: 'agent',
      title: 'Connecter un premier agent',
      render: () => (
        <div className="ob-step">
          {degraded && (
            <p className="provider-missing">
              Mode dégradé actif : configure un moteur dans Réglages dès que possible.
            </p>
          )}
          {!pair ? (
            <>
              <p>Quel assistant veux-tu relier à sa mémoire ?</p>
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
              <p>Colle cette commande dans le chat de ton agent :</p>
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
          nextLabel={step === steps.length - 1 ? 'Terminer' : 'Continuer'}
          nextDisabled={step === 2 && !engineGateOpen}
        />
      </div>
    </div>
  )
}

// ------------------------------------------------------- étape moteur (A4)

function EngineStep({
  health,
  healthUnavailable,
  checking,
  selected,
  chosenNote,
  engineError,
  testResult,
  pullStatus,
  pulling,
  degraded,
  onChoose,
  onPull,
  onReverify,
  onTest,
  onDegraded,
}: {
  health: LlmHealth | null
  healthUnavailable: boolean
  checking: boolean
  selected: EngineChoice | null
  chosenNote: string | null
  engineError: string | null
  testResult: LlmHealth | null
  pullStatus: OllamaPullStatus | null
  pulling: string | null
  degraded: boolean
  onChoose: (engine: EngineChoice) => void
  onPull: (model: string) => void
  onReverify: () => void
  onTest: () => void
  onDegraded: () => void
}) {
  if (healthUnavailable) {
    return (
      <div className="ob-step">
        <p className="muted">
          Détection des moteurs non disponible sur ce service — tu pourras configurer le moteur
          dans les Réglages.
        </p>
      </div>
    )
  }
  if (!health) {
    return (
      <div className="ob-step">
        <div className="spinner-row"><span className="spinner" aria-hidden /> Détection des moteurs…</div>
      </div>
    )
  }

  const o = health.options
  const cards: Array<{ id: EngineChoice; icon: string; label: string; hint: string; state: EngineState }> = [
    {
      id: 'ollama',
      icon: '🦙',
      label: 'Ollama',
      hint: 'Recommandé — 100 % local et gratuit',
      state: o.ollama.available ? 'ready' : o.ollama.serverUp || o.ollama.binaryInPath ? 'config' : 'off',
    },
    {
      id: 'lmstudio',
      icon: '🖥️',
      label: 'LM Studio',
      hint: 'Local — interface graphique pour modèles open source',
      state: o.lmstudio.available && o.lmstudio.models.length > 0 ? 'ready' : o.lmstudio.available ? 'config' : 'off',
    },
    { id: 'openai', icon: '🔑', label: 'OpenAI', hint: 'Clé API — payant à l’usage', state: o.openai.available ? 'ready' : 'config' },
    { id: 'openrouter', icon: '🔑', label: 'OpenRouter', hint: 'Clé API — payant à l’usage', state: o.openrouter.available ? 'ready' : 'config' },
    { id: 'anthropic', icon: '🔑', label: 'Anthropic', hint: 'Clé API — payant à l’usage', state: o.anthropic.available ? 'ready' : 'config' },
  ]
  if (o.openclaw.available && o.openclaw.reusable && o.openclaw.provider) {
    cards.push({
      id: 'openclaw',
      icon: '🔁',
      label: 'Réutiliser ma config OpenClaw',
      hint: `Copie ta clé ${o.openclaw.provider} déjà configurée dans OpenClaw`,
      state: 'ready',
    })
  }

  return (
    <div className="ob-step">
      <p className="muted">
        C’est lui qui transforme tes conversations en souvenirs. Sans moteur, Memoria
        enregistre mais <strong>n’apprend rien</strong>.
      </p>

      <div className="engine-grid">
        {cards.map(c => (
          <button
            key={c.id}
            type="button"
            className={`engine-card${selected === c.id ? ' engine-active' : ''}`}
            onClick={() => onChoose(c.id)}
          >
            <span className="engine-head">
              <span>{c.icon} <strong>{c.label}</strong></span>
              <StateBadge state={c.state} />
            </span>
            <span className="muted engine-hint">{c.hint}</span>
          </button>
        ))}
      </div>

      {engineError && <div className="error-banner">{engineError}</div>}
      {chosenNote && <p className="engine-note">{chosenNote}</p>}

      {selected === 'ollama' && <OllamaGuide o={o.ollama} pulling={pulling} pullStatus={pullStatus} onPull={onPull} onReverify={onReverify} checking={checking} />}
      {selected === 'lmstudio' && <LmStudioGuide o={o.lmstudio} onReverify={onReverify} checking={checking} />}
      {(selected === 'openai' || selected === 'openrouter' || selected === 'anthropic') && (
        <ApiKeyGuide provider={selected} available={o[selected].available} onReverify={onReverify} checking={checking} />
      )}

      <div className="engine-test">
        <button type="button" className="btn btn-ghost" disabled={checking} onClick={onTest}>
          {checking ? 'Vérification…' : 'Tester'}
        </button>
        {testResult && (
          <ul className="engine-results">
            <li className={testResult.extraction.available ? 'ok' : 'ko'}>
              {testResult.extraction.available
                ? `✓ Extraction prête (${testResult.extraction.provider} / ${testResult.extraction.model})`
                : `✗ Extraction indisponible — ${testResult.extraction.reason ?? 'raison inconnue'}`}
            </li>
            <li className={testResult.embeddings.available ? 'ok' : 'ko'}>
              {testResult.embeddings.available
                ? `✓ Recherche sémantique prête (${testResult.embeddings.provider} / ${testResult.embeddings.model})`
                : `⚠ ${testResult.embeddings.reason ?? 'Recherche sémantique indisponible'}`}
            </li>
          </ul>
        )}
      </div>

      {!health.extraction.available && !degraded && (
        <div className="degraded-box">
          <p>
            <strong>Memoria enregistrera tes conversations mais n’en extraira AUCUN souvenir
            tant qu’aucun moteur n’est configuré.</strong> Tes données restent en file d’attente
            et seront traitées dès qu’un moteur sera prêt.
          </p>
          <button type="button" className="btn btn-danger" onClick={onDegraded}>
            Continuer sans moteur (mode dégradé)
          </button>
        </div>
      )}
    </div>
  )
}

function OllamaGuide({
  o,
  pulling,
  pullStatus,
  onPull,
  onReverify,
  checking,
}: {
  o: LlmHealth['options']['ollama']
  pulling: string | null
  pullStatus: OllamaPullStatus | null
  onPull: (model: string) => void
  onReverify: () => void
  checking: boolean
}) {
  if (!o.serverUp) {
    return (
      <div className="engine-guide">
        <p>
          1. Télécharge Ollama : <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a>
        </p>
        <p>2. Installe-le et lance l’application (l’icône apparaît dans la barre de menus).</p>
        <button type="button" className="btn btn-primary" disabled={checking} onClick={onReverify}>
          J’ai installé, re-vérifier
        </button>
      </div>
    )
  }
  const missing: Array<{ model: string; label: string }> = []
  if (!o.hasExtractModel) missing.push({ model: 'qwen2.5:3b', label: 'Télécharger qwen2.5:3b (extraction, ~1,9 Go)' })
  if (!o.hasEmbedModel) missing.push({ model: 'nomic-embed-text', label: 'Télécharger nomic-embed-text (recherche, ~274 Mo)' })
  if (missing.length === 0) {
    return <div className="engine-guide"><p className="engine-note">✓ Ollama est prêt ({o.models.length} modèle·s).</p></div>
  }
  return (
    <div className="engine-guide">
      <p>Ollama tourne — il manque {missing.length === 1 ? 'un modèle' : 'deux modèles'} :</p>
      {missing.map(m => {
        const isPullingThis = pullStatus?.model === m.model && (pullStatus.running || pulling === m.model)
        return (
          <div key={m.model} className="pull-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={pulling !== null || pullStatus?.running === true}
              onClick={() => onPull(m.model)}
            >
              {m.label}
            </button>
            {isPullingThis && (
              <div className="progress" role="progressbar" aria-valuenow={pullStatus?.percent ?? undefined}>
                <div className="progress-fill" style={{ width: `${pullStatus?.percent ?? 2}%` }} />
                <span className="progress-label">
                  {pullStatus?.percent !== null && pullStatus?.percent !== undefined ? `${pullStatus.percent} %` : pullStatus?.status ?? '…'}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function LmStudioGuide({ o, onReverify, checking }: { o: LlmHealth['options']['lmstudio']; onReverify: () => void; checking: boolean }) {
  return (
    <div className="engine-guide">
      {!o.available ? (
        <>
          <p>1. Télécharge LM Studio : <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">lmstudio.ai</a></p>
          <p>2. Télécharge un modèle (ex. Qwen 2.5 7B Instruct) depuis son onglet Découverte.</p>
          <p>3. Démarre le serveur local : onglet <strong>Developer</strong> → « Start Server » (port 1234).</p>
        </>
      ) : o.models.length === 0 ? (
        <p>LM Studio répond mais aucun modèle n’est chargé — charge un modèle puis re-vérifie.</p>
      ) : (
        <p className="engine-note">✓ LM Studio est prêt (modèle : {o.models[0]}).</p>
      )}
      <button type="button" className="btn btn-primary" disabled={checking} onClick={onReverify}>
        Re-vérifier
      </button>
    </div>
  )
}

function ApiKeyGuide({
  provider,
  available,
  onReverify,
  checking,
}: {
  provider: 'openai' | 'openrouter' | 'anthropic'
  available: boolean
  onReverify: () => void
  checking: boolean
}) {
  const command = `echo 'TA_CLÉ' > ~/.${provider}/api_key && chmod 600 ~/.${provider}/api_key`
  return (
    <div className="engine-guide">
      {available ? (
        <p className="engine-note">✓ Clé {provider} détectée.</p>
      ) : (
        <>
          <p>
            Crée une clé API sur le site de {provider === 'openai' ? 'OpenAI' : provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'},
            puis colle cette commande dans ton terminal (remplace TA_CLÉ) :
          </p>
          <pre className="command">mkdir -p ~/.{provider} && {command}</pre>
          <p className="muted">Memoria ne te demandera jamais de coller ta clé ici — elle reste dans un fichier protégé (chmod 600).</p>
        </>
      )}
      <button type="button" className="btn btn-primary" disabled={checking} onClick={onReverify}>
        Re-vérifier
      </button>
    </div>
  )
}
