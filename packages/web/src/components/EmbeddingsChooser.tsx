import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  getMachineCaps,
  getOllamaPullStatus,
  setEmbeddingsProvider,
  setProviderKey,
  startOllamaPull,
  type LlmHealth,
  type MachineCaps,
  type OllamaPullStatus,
} from '../api'
import { useT } from '../i18n'

const LOCAL_EMBED_MODEL = 'nomic-embed-text'

/**
 * Choix du moteur de recherche sémantique (embeddings), partagé entre l'écran
 * Réglages et l'Onboarding. Deux moteurs réels : OpenAI (clé API, recommandé,
 * le plus simple) et Ollama local. Pour le local : scan de la machine, install
 * du modèle en 1 clic si la config le permet, sinon avertissement honnête.
 * (Le « login/OAuth » n'existe pas pour les embeddings — refusé côté moteur.)
 */
export function EmbeddingsChooser({
  health,
  current,
  currentModel,
  onChanged,
}: {
  health: LlmHealth
  current?: string
  currentModel?: string
  onChanged: () => void | Promise<void>
}) {
  const { t } = useT()
  const [caps, setCaps] = useState<MachineCaps | null>(null)
  const [capsError, setCapsError] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [pull, setPull] = useState<OllamaPullStatus | null>(null)
  const [pulling, setPulling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getMachineCaps()
      .then(setCaps)
      .catch(() => setCapsError(true))
  }, [])

  // Polling du téléchargement du modèle local ; à la fin, on bascule dessus.
  useEffect(() => {
    if (!pulling) return
    const timer = setInterval(() => {
      getOllamaPullStatus()
        .then(async s => {
          setPull(s)
          if (!s.running) {
            setPulling(false)
            if (s.error) {
              setError(t('settings.embed.pullFailed', { error: s.error }))
            } else {
              try {
                await setEmbeddingsProvider('ollama', LOCAL_EMBED_MODEL)
                await onChanged()
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e))
              }
            }
          }
        })
        .catch(() => setPulling(false))
    }, 1000)
    return () => clearInterval(timer)
  }, [pulling, onChanged, t])

  const choose = useCallback(
    async (provider: 'openai' | 'ollama') => {
      setBusy(true)
      setError(null)
      try {
        await setEmbeddingsProvider(provider, provider === 'openai' ? 'text-embedding-3-small' : LOCAL_EMBED_MODEL)
        await onChanged()
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [onChanged],
  )

  const saveKey = useCallback(async () => {
    const k = key.trim()
    if (!k) return
    setBusy(true)
    setError(null)
    try {
      await setProviderKey('openai', k)
      setKey('')
      await onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [key, onChanged])

  const installLocal = useCallback(() => {
    setError(null)
    setPull({ running: true, model: LOCAL_EMBED_MODEL, percent: null, status: t('settings.embed.installing', { pct: '' }), error: null })
    startOllamaPull(LOCAL_EMBED_MODEL)
      .then(() => setPulling(true))
      .catch(e => {
        setPull(null)
        setError(e instanceof ApiError ? e.message : String(e))
      })
  }, [t])

  const o = health.options
  const openaiOn = o.openai.available
  const ollamaServerUp = o.ollama.serverUp
  const ollamaReady = o.ollama.serverUp && o.ollama.hasEmbedModel
  const recommendLocal = caps?.recommend_local ?? false
  const openaiActive = current === 'openai'
  const ollamaActive = current === 'ollama'

  const capsVerdictKey =
    caps?.verdict === 'great'
      ? 'settings.embed.capsGreat'
      : caps?.verdict === 'ok'
        ? 'settings.embed.capsOk'
        : 'settings.embed.capsWeak'

  return (
    <div className="settings-block">
      <h2>{t('settings.embed.title')}</h2>
      <p className="muted">{t('settings.embed.lead')}</p>
      <div className="provider-list">
        {/* OpenAI — recommandé, le plus simple */}
        <div className={`provider-card${openaiActive ? ' provider-current' : ''}`}>
          <div className="provider-head">
            <strong>{t('settings.embed.openai.label')}</strong>
            <span className="badge-reco">{t('settings.embed.badgeRecommended')}</span>
            <span className={`dot ${openaiOn ? 'dot-ok' : 'dot-warn'}`} />
          </div>
          <p className="muted provider-hint">{t('settings.embed.openai.hint')}</p>
          {!openaiOn && (
            <>
              <p className="provider-missing">{t('settings.embed.openaiMissing')}</p>
              <div className="provider-key">
                <input
                  type="password"
                  className="key-input"
                  autoComplete="off"
                  placeholder={t('settings.embed.keyPlaceholder')}
                  value={key}
                  onChange={e => setKey(e.target.value)}
                />
                <button type="button" className="btn btn-primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
                  {t('settings.embed.saveKey')}
                </button>
              </div>
            </>
          )}
          <div className="provider-models">
            <button
              type="button"
              disabled={busy || !openaiOn}
              className={`capture-option${openaiActive ? ' capture-active' : ''}`}
              onClick={() => void choose('openai')}
            >
              {openaiActive ? t('settings.embed.active') : t('settings.embed.use')}
            </button>
          </div>
        </div>

        {/* Local (Ollama) — avancé, selon la puissance de la machine */}
        <div className={`provider-card${ollamaActive ? ' provider-current' : ''}`}>
          <div className="provider-head">
            <strong>{t('settings.embed.ollama.label')}</strong>
            <span className="muted">({t('settings.embed.badgeAdvanced')})</span>
            <span className={`dot ${ollamaReady ? 'dot-ok' : 'dot-warn'}`} />
          </div>
          <p className="muted provider-hint">{t('settings.embed.ollama.hint')}</p>

          {/* Verdict du scan machine */}
          {caps ? (
            <p className={recommendLocal ? 'muted' : 'provider-missing'}>
              {t('settings.embed.caps', {
                ram: String(caps.ram_gb),
                cores: String(caps.cpu_cores),
                arch: caps.apple_silicon ? 'Apple Silicon' : caps.arch,
              })}{' '}
              {t(capsVerdictKey)}
            </p>
          ) : capsError ? (
            <p className="muted">{t('settings.embed.capsUnknown')}</p>
          ) : (
            <p className="muted">{t('settings.embed.scanning')}</p>
          )}

          {/* Progression d'installation */}
          {pull && pull.running && (
            <p className="warn">
              {t('settings.embed.installing', { pct: pull.percent != null ? ` ${pull.percent}%` : '' })}
            </p>
          )}

          <div className="provider-models">
            {ollamaReady ? (
              <button
                type="button"
                disabled={busy}
                className={`capture-option${ollamaActive ? ' capture-active' : ''}`}
                onClick={() => void choose('ollama')}
              >
                {ollamaActive ? t('settings.embed.active') : t('settings.embed.use')}
              </button>
            ) : !ollamaServerUp ? (
              <p className="provider-missing">{t('settings.embed.ollamaAppMissing')}</p>
            ) : recommendLocal ? (
              <button type="button" className="btn btn-primary" disabled={busy || pulling} onClick={installLocal}>
                {t('settings.embed.installLocal')}
              </button>
            ) : (
              <>
                <p className="provider-missing">{t('settings.embed.notRecommended')}</p>
                <button type="button" className="capture-option" disabled={busy || pulling} onClick={installLocal}>
                  {t('settings.embed.installAnyway')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {typeof health.embeddings.pending === 'number' && health.embeddings.pending > 0 && (
        <p className="warn">{t('settings.embed.reindexing', { count: health.embeddings.pending.toLocaleString('fr-FR') })}</p>
      )}
      {error && <p className="provider-missing">{error}</p>}
      <p className="muted">{t('settings.embed.reindexNote')}</p>
      <p className="muted">{t('settings.embed.noLogin')}</p>
      {current && (
        <p className="muted" style={{ marginTop: '0.4rem' }}>
          {t('settings.embed.current')} <strong>{current}</strong> / {currentModel ?? t('settings.engine.defaultModel')}
        </p>
      )}
    </div>
  )
}
