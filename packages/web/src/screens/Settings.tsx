/**
 * Réglages (spec §14) : choix du MOTEUR D'IA d'extraction — l'utilisateur
 * décide (provider + modèle), avec recommandations pour ne pas être perdu.
 * Local pour qui veut du local ; cloud (OpenAI/Anthropic/OpenRouter) sinon.
 * + emplacement de stockage. Routes « contrat » : 404 → « non disponible ».
 */
import { useCallback, useEffect, useState } from 'react'
import { useCallback as useCb } from 'react'
import {
  ApiError,
  getControl,
  getDoctor,
  getLlmProfile,
  getOptions,
  getProviders,
  setAutostart,
  setEnabled,
  setExtractionProvider,
  setOption,
  type ControlState,
  type DoctorReport,
  type LlmConfig,
  type LlmProviderName,
  type ProvidersStatus,
} from '../api'

const OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'auto_themes_ai', label: 'Affiner les thèmes avec l’IA', hint: 'Donne automatiquement des noms clairs aux thèmes (coûte quelques appels au moteur configuré).' },
  { key: 'auto_patterns', label: 'Détecter les récurrences', hint: 'Repère automatiquement ce qui revient souvent (écran Récurrences).' },
  { key: 'auto_revision', label: 'Proposer le ménage', hint: 'Détecte automatiquement contradictions et doublons (écran Révisions).' },
  { key: 'auto_self_observation', label: 'Auto-observation des agents', hint: 'L’agent dégage ses forces/faiblesses depuis son historique (écran Agents).' },
  { key: 'markdown_export', label: 'Export Markdown automatique', hint: 'Tient à jour un miroir .md de la mémoire dans <stockage>/exports/.' },
]

interface ProviderChoice {
  id: LlmProviderName
  label: string
  models: string[]
  /** Modèle conseillé (1er). */
  recommended: string
  hint: string
  local: boolean
}

const PROVIDERS: ProviderChoice[] = [
  { id: 'ollama', label: 'Ollama (local)', models: ['qwen2.5:3b', 'gemma3:4b', 'llama3.1:8b'], recommended: 'qwen2.5:3b', hint: '100 % local, gratuit, rien ne sort de la machine. Qualité correcte.', local: true },
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-5-mini', 'gpt-4.1-mini'], recommended: 'gpt-4o-mini', hint: 'Excellente qualité d’extraction pour un coût minime. Recommandé.', local: false },
  { id: 'anthropic', label: 'Anthropic (Claude)', models: ['claude-haiku-4-5-20251001'], recommended: 'claude-haiku-4-5-20251001', hint: 'Haiku : rapide et précis. Cloud, votre clé.', local: false },
  { id: 'openrouter', label: 'OpenRouter', models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'google/gemini-flash-1.5'], recommended: 'openai/gpt-4o-mini', hint: 'Une seule clé, des centaines de modèles. Pour les utilisateurs avancés.', local: false },
]

export function Settings() {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [providers, setProviders] = useState<ProvidersStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([getLlmProfile(), getProviders()])
      setConfig(c)
      setProviders(p)
      setUnavailable(false)
    } catch {
      setUnavailable(true)
    }
  }, [])

  useEffect(() => {
    getDoctor().then(setDoctor).catch(() => setDoctor(null))
    void refresh()
  }, [refresh])

  const choose = useCallback(
    async (provider: LlmProviderName, model: string) => {
      setBusy(true)
      try {
        await setExtractionProvider(provider, model)
        await refresh()
        setError(null)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Changement impossible.')
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const current = config?.extraction
  const availabilityOf = (id: LlmProviderName): boolean | undefined => {
    if (!providers) return undefined
    return id === 'ollama' ? providers.ollama.available : providers[id]?.available
  }

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Réglages</h1>
          <p className="muted">Choisis ton moteur d’IA et où vit ta mémoire — tout reste sous ton contrôle.</p>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <ControlPanel onError={setError} />

      <div className="settings-block">
        <h2>Moteur d’extraction</h2>
        <p className="muted">
          Le modèle qui transforme les conversations en souvenirs durables. Choisis selon tes
          priorités : <strong>local</strong> (gratuit, privé) ou <strong>cloud</strong> (meilleure qualité).
        </p>
        {unavailable ? (
          <p className="muted">Réglage du moteur non disponible sur ce service.</p>
        ) : !providers || !config ? (
          <div className="spinner-row"><span className="spinner" aria-hidden /> Chargement…</div>
        ) : (
          <div className="provider-list">
            {PROVIDERS.map(p => {
              const avail = availabilityOf(p.id)
              const isCurrent = current?.provider === p.id
              return (
                <div key={p.id} className={`provider-card${isCurrent ? ' provider-current' : ''}`}>
                  <div className="provider-head">
                    <strong>{p.label}</strong>
                    {p.id === 'openai' && <span className="badge-reco">recommandé</span>}
                    <span className={`dot ${avail ? 'dot-ok' : 'dot-warn'}`} title={avail ? 'détecté' : 'clé/serveur absent'} />
                  </div>
                  <p className="muted provider-hint">{p.hint}</p>
                  {avail === false && (
                    <p className="provider-missing">
                      {p.local ? 'Ollama non détecté (lance « ollama serve »).' : `Clé absente — place-la dans ~/.${p.id}/api_key (chmod 600).`}
                    </p>
                  )}
                  <div className="provider-models">
                    {p.models.map(model => (
                      <button
                        key={model}
                        type="button"
                        disabled={busy || avail === false}
                        className={`capture-option${isCurrent && current?.model === model ? ' capture-active' : ''}`}
                        onClick={() => void choose(p.id, model)}
                        title={model === p.recommended ? 'conseillé' : ''}
                      >
                        {model}{model === p.recommended ? ' ★' : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {config?.extraction && (
          <p className="muted" style={{ marginTop: '0.8rem' }}>
            Actuel : <strong>{config.extraction.provider}</strong> / {config.extraction.model ?? '(défaut)'}
          </p>
        )}
      </div>

      <div className="settings-block">
        <h2>Emplacement de stockage</h2>
        <pre className="command">{doctor?.storage_root ?? '~/.memoria/data'}</pre>
        <p className="muted">
          Toutes tes mémoires (chiffrées pour les secrets). Pour emporter Memoria sur une
          <strong> clé USB</strong> (ou tout autre dossier), déplace-la depuis le terminal :
        </p>
        <pre className="command">memoria move --to /Volumes/MaCle/memoria</pre>
        <p className="muted">
          Le service s’arrête le temps du déplacement, met à jour la config, puis
          <code> memoria start </code> le relance au nouvel emplacement.
        </p>
      </div>

      <div className="settings-block">
        <h2>Capture</h2>
        <p className="muted">Mode (auto / revue / pause) : barre latérale, toujours accessible.</p>
      </div>

      <div className="settings-block">
        <h2>Options</h2>
        <p className="muted">
          Couches avancées de Memoria. Désactivées par défaut : activez-les quand vous voulez.
          Activer une option la fait tourner tout de suite, puis à chaque démarrage.
        </p>
        <OptionsPanel onError={setError} />
      </div>

      <div className="settings-block">
        <h2>Export Markdown</h2>
        <p className="muted">
          Aussi disponible à la demande : <code>memoria export</code> depuis le terminal (un fichier
          <code> .md </code> par thème).
        </p>
      </div>
    </section>
  )
}

function ControlPanel({ onError }: { onError: (m: string) => void }) {
  const [state, setState] = useState<ControlState | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    getControl().then(setState).catch(() => setUnavailable(true))
  }, [])

  const toggleEnabled = useCb(
    async (enabled: boolean) => {
      setBusy('enabled')
      setState(prev => (prev ? { ...prev, enabled } : prev)) // optimiste
      try {
        const v = await setEnabled(enabled)
        setState(prev => (prev ? { ...prev, enabled: v } : prev))
      } catch (err) {
        onError(err instanceof ApiError ? err.message : 'Changement impossible.')
        getControl().then(setState).catch(() => {})
      } finally {
        setBusy(null)
      }
    },
    [onError],
  )

  const toggleAutostart = useCb(
    async (enabled: boolean) => {
      setBusy('autostart')
      try {
        const a = await setAutostart(enabled)
        setState(prev => (prev ? { ...prev, autostart: a } : prev))
      } catch (err) {
        onError(err instanceof ApiError ? err.message : 'Changement impossible.')
        getControl().then(setState).catch(() => {})
      } finally {
        setBusy(null)
      }
    },
    [onError],
  )

  if (unavailable) return null
  if (state === null) return <div className="settings-block"><div className="spinner-row"><span className="spinner" aria-hidden /> Chargement…</div></div>

  return (
    <div className="settings-block">
      <h2>Contrôle</h2>
      <label className="option-row">
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={busy === 'enabled'}
          onChange={e => void toggleEnabled(e.target.checked)}
        />
        <span>
          <strong>Memoria actif</strong>
          <span className="muted option-hint">
            {state.enabled
              ? 'Capture et rappel des souvenirs en fonctionnement. Décoche pour mettre en pause sans tout fermer.'
              : '⏸ En pause : les agents tournent mais n’écrivent ni ne lisent aucune mémoire.'}
          </span>
        </span>
      </label>
      <label className="option-row">
        <input
          type="checkbox"
          checked={state.autostart.installed}
          disabled={busy === 'autostart' || !state.autostart.supported}
          onChange={e => void toggleAutostart(e.target.checked)}
        />
        <span>
          <strong>Lancer au démarrage</strong>
          <span className="muted option-hint">
            {state.autostart.supported
              ? 'Démarre Memoria automatiquement à chaque ouverture de session (launchd).'
              : 'Disponible sur macOS uniquement pour l’instant.'}
          </span>
        </span>
      </label>
    </div>
  )
}

function OptionsPanel({ onError }: { onError: (m: string) => void }) {
  const [options, setOptions] = useState<Record<string, boolean> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    getOptions().then(setOptions).catch(() => setOptions(null))
  }, [])

  const toggle = useCb(
    async (key: string, enabled: boolean) => {
      setBusy(key)
      setOptions(prev => (prev ? { ...prev, [key]: enabled } : prev)) // optimiste
      try {
        setOptions(await setOption(key, enabled))
      } catch (err) {
        onError(err instanceof ApiError ? err.message : 'Changement impossible.')
        getOptions().then(setOptions).catch(() => {})
      } finally {
        setBusy(null)
      }
    },
    [onError],
  )

  if (options === null) return <p className="muted">Options non disponibles.</p>
  return (
    <div className="options-list">
      {OPTIONS.map(o => (
        <label key={o.key} className="option-row">
          <input
            type="checkbox"
            checked={options[o.key] ?? false}
            disabled={busy === o.key}
            onChange={e => void toggle(o.key, e.target.checked)}
          />
          <span>
            <strong>{o.label}</strong>
            <span className="muted option-hint">{o.hint}</span>
          </span>
        </label>
      ))}
    </div>
  )
}
