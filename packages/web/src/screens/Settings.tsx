/**
 * Réglages (spec §14) : choix du MOTEUR D'IA d'extraction — l'utilisateur
 * décide (provider + modèle), avec recommandations pour ne pas être perdu.
 * Local pour qui veut du local ; cloud (OpenAI/Anthropic/OpenRouter) sinon.
 * + emplacement de stockage. Routes « contrat » : 404 → « non disponible ».
 */
import { useCallback, useEffect, useState } from 'react'
import { useCallback as useCb } from 'react'
import { ConfirmButton, CopyButton, EmptyState, Spinner, formatCompact, formatDate, formatNumber } from '../components/ui'
import { EmbeddingsChooser } from '../components/EmbeddingsChooser'
import { currentLocale, useT } from '../i18n'
import { summarizeCloudSends } from '../lib/cloud'
import {
  ApiError,
  getControl,
  getDoctor,
  getLlmHealth,
  getLlmProfile,
  getLlmUsage,
  getOptions,
  getProviders,
  getSyncStatus,
  getVersion,
  runUpdate,
  setAutostart,
  setEnabled,
  setExtractionProvider,
  setProviderKey,
  setOption,
  syncInitHub,
  syncInvite,
  syncJoin,
  syncLeave,
  syncNow,
  syncRevoke,
  type ControlState,
  type DoctorReport,
  type LlmConfig,
  type LlmHealth,
  type LlmProviderName,
  type LlmUsagePeriod,
  type LlmUsageReport,
  type ProvidersStatus,
  type SyncStatus,
  type VersionInfo,
} from '../api'

// Libellés/hints → clés i18n settings.option.<key>.label / .hint
const OPTIONS: string[] = ['auto_themes_ai', 'auto_patterns', 'auto_revision', 'auto_self_observation', 'markdown_export']

interface ProviderChoice {
  id: LlmProviderName
  models: string[]
  /** Modèle conseillé (1er). */
  recommended: string
  local: boolean
}

// Libellés/hints → clés i18n settings.provider.<id>.label / .hint
const PROVIDERS: ProviderChoice[] = [
  { id: 'ollama', models: ['qwen2.5:3b', 'gemma3:4b', 'llama3.1:8b'], recommended: 'qwen2.5:3b', local: true },
  // models vide = liste dynamique (modèles réellement chargés dans LM Studio)
  { id: 'lmstudio', models: [], recommended: '', local: true },
  { id: 'openai', models: ['gpt-4o-mini', 'gpt-5-mini', 'gpt-4.1-mini'], recommended: 'gpt-4o-mini', local: false },
  { id: 'anthropic', models: ['claude-haiku-4-5-20251001'], recommended: 'claude-haiku-4-5-20251001', local: false },
  { id: 'openrouter', models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'google/gemini-flash-1.5'], recommended: 'openai/gpt-4o-mini', local: false },
]

export function Settings() {
  const { t } = useT()
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [providers, setProviders] = useState<ProvidersStatus | null>(null)
  const [health, setHealth] = useState<LlmHealth | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // clé API saisie par provider (non persistée tant qu'on ne valide pas)
  const [keyInput, setKeyInput] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      const [c, p, h] = await Promise.all([
        getLlmProfile(),
        getProviders(),
        // route « contrat » : absente → pas d'encart santé, le reste fonctionne
        getLlmHealth().catch(() => null),
      ])
      setConfig(c)
      setProviders(p)
      setHealth(h)
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
        setError(err instanceof ApiError ? err.message : t('settings.error.changeFailed'))
      } finally {
        setBusy(false)
      }
    },
    [refresh, t],
  )

  /** Enregistre la clé API collée par l'utilisateur, puis rafraîchit (le point passe au vert). */
  const saveKey = useCallback(
    async (provider: LlmProviderName) => {
      const key = (keyInput[provider] ?? '').trim()
      if (!key) return
      setBusy(true)
      try {
        await setProviderKey(provider, key)
        setKeyInput(prev => ({ ...prev, [provider]: '' }))
        await refresh()
        setError(null)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('settings.error.keySaveFailed'))
      } finally {
        setBusy(false)
      }
    },
    [keyInput, refresh, t],
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
          <h1>{t('settings.title')}</h1>
          <p className="muted">{t('settings.lead')}</p>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <ControlPanel onError={setError} />

      <UpdatePanel onError={setError} />

      <SyncPanel onError={setError} />

      <div className="settings-block">
        <h2>{t('settings.engine.title')}</h2>
        <p className="muted">
          {t('settings.engine.lead.before')}
          <strong>{t('settings.engine.lead.local')}</strong>
          {t('settings.engine.lead.middle')}
          <strong>{t('settings.engine.lead.cloud')}</strong>
          {t('settings.engine.lead.after')}
        </p>
        {health && <LlmHealthSummary health={health} />}
        {unavailable ? (
          <p className="muted">{t('settings.engine.unavailable')}</p>
        ) : !providers || !config ? (
          <div className="spinner-row"><span className="spinner" aria-hidden />{' '}{t('common.loading')}</div>
        ) : (
          <div className="provider-list">
            {PROVIDERS.map(p => {
              const avail = availabilityOf(p.id)
              const isCurrent = current?.provider === p.id
              // LM Studio : on propose les modèles réellement chargés
              const models = p.id === 'lmstudio' ? (health?.options.lmstudio.models ?? providers.lmstudio.models ?? []) : p.models
              return (
                <div key={p.id} className={`provider-card${isCurrent ? ' provider-current' : ''}`}>
                  <div className="provider-head">
                    <strong>{t(`settings.provider.${p.id}.label`)}</strong>
                    {p.id === 'openai' && <span className="badge-reco">{t('settings.engine.badgeRecommended')}</span>}
                    <span className={`dot ${avail ? 'dot-ok' : 'dot-warn'}`} title={avail ? t('settings.engine.detected') : t('settings.engine.missingKeyServer')} />
                  </div>
                  <p className="muted provider-hint">{t(`settings.provider.${p.id}.hint`)}</p>
                  {avail === false && (
                    <p className="provider-missing">
                      {p.id === 'ollama'
                        ? t('settings.engine.missing.ollama')
                        : p.id === 'lmstudio'
                          ? t('settings.engine.missing.lmstudio')
                          : t('settings.engine.missing.key', { provider: p.id })}
                    </p>
                  )}
                  {(p.id === 'openai' || p.id === 'openrouter' || p.id === 'anthropic') && (
                    <div className="provider-key">
                      <input
                        type="password"
                        className="key-input"
                        autoComplete="off"
                        placeholder={avail ? t('settings.engine.keyPlaceholderReplace') : t('settings.engine.keyPlaceholderPaste')}
                        value={keyInput[p.id] ?? ''}
                        onChange={e => setKeyInput(prev => ({ ...prev, [p.id]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy || !(keyInput[p.id]?.trim())}
                        onClick={() => void saveKey(p.id)}
                      >
                        {t('settings.engine.saveKey')}
                      </button>
                    </div>
                  )}
                  {p.id === 'lmstudio' && avail === true && models.length === 0 && (
                    <p className="provider-missing">{t('settings.engine.lmstudioNoModels')}</p>
                  )}
                  <div className="provider-models">
                    {models.map(model => (
                      <button
                        key={model}
                        type="button"
                        disabled={busy}
                        className={`capture-option${isCurrent && current?.model === model ? ' capture-active' : ''}`}
                        onClick={() => void choose(p.id, model)}
                        title={model === p.recommended ? t('settings.engine.modelRecommendedTitle') : ''}
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
            {t('settings.engine.current')} <strong>{config.extraction.provider}</strong> / {config.extraction.model ?? t('settings.engine.defaultModel')}
          </p>
        )}
      </div>

      {health && config && !unavailable && (
        <EmbeddingsChooser
          health={health}
          current={config.embeddings?.provider}
          currentModel={config.embeddings?.model}
          onChanged={refresh}
        />
      )}

      <UsagePanel />

      <div className="settings-block">
        <h2>{t('settings.storage.title')}</h2>
        <div className="path-row">
          <pre className="command path-grow">{doctor?.storage_root ?? '~/.memoria/data'}</pre>
          <CopyButton text={doctor?.storage_root ?? '~/.memoria/data'} label={t('settings.storage.copyPath')} />
        </div>
        <p className="muted">
          {t('settings.storage.desc.before')}
          <strong>{t('settings.storage.desc.usb')}</strong>
          {t('settings.storage.desc.after')}
        </p>
        <div className="path-row">
          <pre className="command path-grow">memoria move --to /Volumes/MaCle/memoria</pre>
          <CopyButton text="memoria move --to /Volumes/MaCle/memoria" label={t('settings.storage.copyCommand')} />
        </div>
        <p className="muted">
          {t('settings.storage.restart.before')}
          <code> memoria start </code>{t('settings.storage.restart.after')}
        </p>
      </div>

      <div className="settings-block">
        <h2>{t('settings.capture.title')}</h2>
        <p className="muted">{t('settings.capture.desc')}</p>
      </div>

      <div className="settings-block">
        <h2>{t('settings.options.title')}</h2>
        <p className="muted">{t('settings.options.desc')}</p>
        <OptionsPanel onError={setError} />
      </div>

      <div className="settings-block">
        <h2>{t('settings.export.title')}</h2>
        <p className="muted">
          {t('settings.export.desc.before')}
          <code>memoria export</code>{t('settings.export.desc.middle')}
          <code> .md </code>{t('settings.export.desc.after')}
        </p>
      </div>
    </section>
  )
}

/**
 * État de santé du moteur (llm_health) au-dessus des cartes provider :
 * extraction, recherche sémantique, et file d'attente — l'utilisateur voit
 * IMMÉDIATEMENT si Memoria apprend ou accumule en silence.
 */
function LlmHealthSummary({ health }: { health: LlmHealth }) {
  const { t } = useT()
  const count = formatNumber(health.wal_pending)
  return (
    <div className="llm-summary">
      <p className={health.extraction.available ? 'ok' : 'ko'}>
        {health.extraction.available
          ? t('settings.health.extractionReady', { provider: health.extraction.provider, model: health.extraction.model })
          : t('settings.health.extractionUnavailable', { reason: health.extraction.reason ?? t('settings.health.reasonUnknown') })}
      </p>
      <p className={health.embeddings.available ? 'ok' : 'warn'}>
        {health.embeddings.available
          ? t('settings.health.embeddingsReady', { provider: health.embeddings.provider, model: health.embeddings.model })
          : t('settings.health.embeddingsWarn', { reason: health.embeddings.reason ?? t('settings.health.embeddingsUnavailable') })}
      </p>
      {health.wal_pending > 0 && (
        <p className={health.extraction.available ? 'warn' : 'ko'}>
          {health.wal_pending > 1
            ? t('settings.health.walPendingPlural', { count })
            : t('settings.health.walPending', { count })}
          {health.extraction.available ? t('settings.health.walNext') : t('settings.health.walWaiting')}
        </p>
      )}
    </div>
  )
}

function UpdatePanel({ onError }: { onError: (m: string) => void }) {
  const { t } = useT()
  const [version, setVersion] = useState<VersionInfo | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setUnavailable(true))
  }, [])

  if (unavailable) return null
  if (version === null) return null

  return (
    <div className="settings-block">
      <h2>{t('settings.update.title')}</h2>
      <p className="muted">
        {t('settings.update.versionLabel')} <strong>{version.version}</strong>
        {version.sha ? <> · {t('settings.update.revision')} <code>{version.sha}</code></> : null}
        {!version.is_git && <> · {t('settings.update.frozen')}</>}
      </p>
      {version.is_git ? (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setNote(t('settings.update.inProgress'))
              try {
                const r = await runUpdate()
                setNote(r.message + (r.changed ? t('settings.update.restarted') : ''))
                if (r.changed) getVersion().then(setVersion).catch(() => {})
              } catch (err) {
                onError(err instanceof ApiError ? err.message : t('settings.update.failed'))
                setNote(null)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? t('settings.update.busy') : t('settings.update.button')}
          </button>
          <p className="muted" style={{ marginTop: '0.5rem' }}>{t('settings.update.hint')}</p>
        </>
      ) : (
        <p className="muted">{t('settings.update.notGit')}</p>
      )}
      {note && <p className="muted sync-note">{note}</p>}
    </div>
  )
}

function SyncPanel({ onError }: { onError: (m: string) => void }) {
  const { t } = useT()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [invite, setInvite] = useState<{ code: string; hub_lan: string | null } | null>(null)
  const [joinHub, setJoinHub] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCb(() => {
    getSyncStatus().then(setStatus).catch(() => setUnavailable(true))
  }, [])
  useEffect(() => refresh(), [refresh])

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } catch (err) { onError(err instanceof ApiError ? err.message : t('settings.sync.actionFailed')) } finally { setBusy(false) }
  }

  if (unavailable) return null
  if (status === null) return <div className="settings-block"><div className="spinner-row"><span className="spinner" aria-hidden />{' '}{t('common.loading')}</div></div>

  const configured = status.enabled && (status.role === 'hub' || status.hub)

  return (
    <div className="settings-block">
      <h2>{t('settings.sync.title')}</h2>
      <p className="muted">
        {t('settings.sync.desc.before')}
        <strong>{t('settings.sync.desc.private')}</strong>
        {t('settings.sync.desc.after')}
      </p>

      {!configured ? (
        <>
          <p className="muted">{t('settings.sync.notLinked')}</p>
          <div className="sync-setup">
            <div className="sync-card">
              <strong>{t('settings.sync.makeHubTitle')}</strong>
              <span className="muted">{t('settings.sync.makeHubDesc')}</span>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void wrap(async () => {
                const r = await syncInitHub('0.0.0.0:47600')
                setNote(t('settings.sync.hubConfigured', { machine: r.machine_id }))
                refresh()
              })}>{t('settings.sync.makeHubButton')}</button>
            </div>
            <div className="sync-card">
              <strong>{t('settings.sync.joinTitle')}</strong>
              <span className="muted">{t('settings.sync.joinDesc')}</span>
              <input type="text" placeholder={t('settings.sync.hubAddressPlaceholder')} value={joinHub} onChange={e => setJoinHub(e.target.value)} />
              <input type="text" placeholder={t('settings.sync.inviteCodePlaceholder')} value={joinCode} onChange={e => setJoinCode(e.target.value)} />
              <button type="button" className="btn btn-primary" disabled={busy || !joinHub.trim() || !joinCode.trim()} onClick={() => void wrap(async () => {
                const r = await syncJoin(joinHub.trim(), joinCode.trim())
                setNote(t('settings.sync.joined', { facts: r.facts, secrets: r.secrets }))
                refresh()
              })}>{t('settings.sync.joinButton')}</button>
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            {t('settings.sync.roleLabel')} <strong>{status.role === 'hub' ? t('settings.sync.roleHub') : t('settings.sync.roleSpoke')}</strong>
            {status.role === 'hub' && status.listen_lan ? ` · ${t('settings.sync.listen', { addr: status.listen_lan })}` : ''}
            {status.role === 'spoke' && status.hub ? ` · ${t('settings.sync.hubOf', { addr: status.hub })}` : ''}
            {' · '}{t('settings.sync.idLabel')} <code>{status.machine_id}</code>
          </p>

          <div className="sync-actions">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void wrap(async () => {
              const r = await syncNow(); setNote(t('settings.sync.syncDone', { pulled: r.pulled, pushed: r.pushed }))
            })}>{t('settings.sync.syncNow')}</button>
            {status.role === 'hub' && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void wrap(async () => {
                const inv = await syncInvite(); setInvite({ code: inv.code, hub_lan: inv.hub_lan })
              })}>{t('settings.sync.invite')}</button>
            )}
            {status.role === 'spoke' && (
              <ConfirmButton label={t('settings.sync.leave')} confirmLabel={t('settings.sync.leaveConfirm')} onConfirm={() => void wrap(async () => { await syncLeave(); refresh() })} />
            )}
          </div>

          {invite && (
            <div className="sync-invite">
              <p>{t('settings.sync.inviteIntro')}</p>
              <div className="command-row">
                <code className="command">{t('settings.sync.inviteHub', { addr: invite.hub_lan ?? t('settings.sync.inviteHubFallback') })}</code>
              </div>
              <div className="command-row">
                <code className="command">{t('settings.sync.inviteCode', { code: invite.code })}</code>
                <CopyButton text={invite.code} label={t('settings.sync.copyCode')} />
              </div>
              <p className="muted">{t('settings.sync.codeExpires')}</p>
            </div>
          )}

          {status.peers.length > 0 && (
            <ul className="peer-list">
              {status.peers.map(p => (
                <li key={p.machine_id} className="peer-row">
                  <span><strong>{p.display_name}</strong> <span className="badge badge-muted">{p.role}</span></span>
                  <span className="muted">{p.revoked_at ? t('settings.sync.revoked') : p.last_seen_at ? t('settings.sync.seenAt', { date: formatDate(p.last_seen_at) }) : t('settings.sync.neverSeen')}</span>
                  {!p.revoked_at && <ConfirmButton label={t('settings.sync.revoke')} confirmLabel={t('settings.sync.revokeConfirm')} onConfirm={() => void wrap(async () => { await syncRevoke(p.machine_id); refresh() })} />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {note && <p className="muted sync-note">{note}</p>}
    </div>
  )
}

function ControlPanel({ onError }: { onError: (m: string) => void }) {
  const { t } = useT()
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
        onError(err instanceof ApiError ? err.message : t('settings.error.changeFailed'))
        getControl().then(setState).catch(() => {})
      } finally {
        setBusy(null)
      }
    },
    [onError, t],
  )

  const toggleAutostart = useCb(
    async (enabled: boolean) => {
      setBusy('autostart')
      try {
        const a = await setAutostart(enabled)
        setState(prev => (prev ? { ...prev, autostart: a } : prev))
      } catch (err) {
        onError(err instanceof ApiError ? err.message : t('settings.error.changeFailed'))
        getControl().then(setState).catch(() => {})
      } finally {
        setBusy(null)
      }
    },
    [onError, t],
  )

  if (unavailable) return null
  if (state === null) return <div className="settings-block"><div className="spinner-row"><span className="spinner" aria-hidden />{' '}{t('common.loading')}</div></div>

  return (
    <div className="settings-block">
      <h2>{t('settings.control.title')}</h2>
      <label className="option-row">
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={busy === 'enabled'}
          onChange={e => void toggleEnabled(e.target.checked)}
        />
        <span>
          <strong>{t('settings.control.enabledTitle')}</strong>
          <span className="muted option-hint">
            {state.enabled
              ? t('settings.control.enabledOn')
              : t('settings.control.enabledOff')}
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
          <strong>{t('settings.control.autostartTitle')}</strong>
          <span className="muted option-hint">
            {state.autostart.supported
              ? t('settings.control.autostartOn')
              : t('settings.control.autostartUnsupported')}
          </span>
        </span>
      </label>
    </div>
  )
}

function OptionsPanel({ onError }: { onError: (m: string) => void }) {
  const { t } = useT()
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
        onError(err instanceof ApiError ? err.message : t('settings.error.changeFailed'))
        getOptions().then(setOptions).catch(() => {})
      } finally {
        setBusy(null)
      }
    },
    [onError, t],
  )

  if (options === null) return <p className="muted">{t('settings.options.unavailable')}</p>
  return (
    <div className="options-list">
      {OPTIONS.map(o => (
        <label key={o} className="option-row">
          <input
            type="checkbox"
            checked={options[o] ?? false}
            disabled={busy === o}
            onChange={e => void toggle(o, e.target.checked)}
          />
          <span>
            <strong>{t(`settings.option.${o}.label`)}</strong>
            <span className="muted option-hint">{t(`settings.option.${o}.hint`)}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

const USAGE_PERIODS: LlmUsagePeriod[] = ['24h', '7d', '30d', 'all']

function fmtTokens(n: number | null): string {
  return n === null ? '—' : formatNumber(n)
}

/** Coût estimé en dollars : « < 0,0001 $ » plutôt qu'un faux « 0,0000 $ ». */
function fmtUsd(v: number): string {
  if (v === 0) return '0 $'
  const fmt = (x: number, digits: number) => new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: digits }).format(x)
  if (v < 0.0001) return `< ${fmt(0.0001, 4)} $`
  return `${fmt(v, v < 0.01 ? 4 : 2)} $`
}

/**
 * « Données envoyées au cloud » — la réponse directe au retour bêta « l'interface
 * devrait indiquer clairement ce qui a été envoyé ». Jusqu'ici seul
 * `memoria doctor` le montrait. Même fenêtre que le panneau Consommation.
 * L'absence d'envoi EST l'information : on l'affiche en vert, pas en creux.
 */
function CloudSends({ rows }: { rows: LlmUsageReport['rows'] }) {
  const { t } = useT()
  const cloud = summarizeCloudSends(rows)
  if (cloud.rows.length === 0) {
    return (
      <div className="cloud-summary cloud-none" role="status">
        <strong>🔒 {t('settings.cloud.title')}</strong>
        <p>{t('settings.cloud.none')}</p>
      </div>
    )
  }
  const vars = { calls: formatNumber(cloud.calls), providers: cloud.providers.join(', '), chars: formatCompact(cloud.chars) }
  return (
    <div className="cloud-summary cloud-some" role="status">
      <strong>☁️ {t('settings.cloud.title')}</strong>
      <p>
        {t(cloud.calls > 1 ? 'settings.cloud.summary.plural' : 'settings.cloud.summary.one', vars)}
        {cloud.last_ts ? ` ${t('settings.cloud.last', { date: formatDate(cloud.last_ts) })}` : ''}
      </p>
      <ul className="cloud-rows">
        {cloud.rows.map(r => (
          <li key={`${r.provider}|${r.model}|${r.purpose}`}>
            <code>
              {r.provider}/{r.model}
            </code>{' '}
            · {t(`settings.usage.purpose.${r.purpose}`)} —{' '}
            {t('settings.cloud.row', { calls: formatNumber(r.calls), items: formatNumber(r.items), chars: formatCompact(r.chars) })}
            {r.failures > 0 && <span className="badge badge-warn"> {t('settings.cloud.failures', { count: r.failures })}</span>}
          </li>
        ))}
      </ul>
      <p className="muted">{t('settings.cloud.note')}</p>
    </div>
  )
}

/**
 * Consommation par modèle : appels, tokens, coût estimé — l'utilisateur voit
 * ce que sa mémoire lui coûte, modèle par modèle, locaux compris (0 $).
 * Route « contrat » : absente (daemon plus ancien) → encart « non disponible ».
 */
function UsagePanel() {
  const { t } = useT()
  const [period, setPeriod] = useState<LlmUsagePeriod>('24h')
  const [report, setReport] = useState<LlmUsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    getLlmUsage(period)
      .then(r => {
        if (!alive) return
        setReport(r)
        setUnavailable(false)
      })
      .catch(() => {
        if (alive) setUnavailable(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [period])

  const totals = report?.totals
  return (
    <div className="settings-block">
      <h2>{t('settings.usage.title')}</h2>
      <p className="muted">{t('settings.usage.lead')}</p>
      <div className="usage-periods" role="tablist" aria-label={t('settings.usage.title')}>
        {USAGE_PERIODS.map(p => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={p === period}
            className={p === period ? 'btn btn-primary' : 'btn'}
            onClick={() => setPeriod(p)}
          >
            {t(`settings.usage.period.${p}`)}
          </button>
        ))}
      </div>
      {loading && !report ? (
        <Spinner />
      ) : unavailable ? (
        <p className="muted">{t('settings.usage.unavailable')}</p>
      ) : !report || report.rows.length === 0 ? (
        <>
          <CloudSends rows={[]} />
          <EmptyState title={t('settings.usage.empty.title')} body={t('settings.usage.empty.body')} />
        </>
      ) : (
        <>
          <CloudSends rows={report.rows} />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('settings.usage.col.model')}</th>
                  <th>{t('settings.usage.col.purpose')}</th>
                  <th>{t('settings.usage.col.calls')}</th>
                  <th>{t('settings.usage.col.in')}</th>
                  <th>{t('settings.usage.col.out')}</th>
                  <th>{t('settings.usage.col.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map(r => (
                  <tr key={`${r.provider}|${r.model}|${r.purpose}`}>
                    <td>
                      <code>
                        {r.provider}/{r.model}
                      </code>
                      {r.local && (
                        <>
                          {' '}
                          <span className="badge badge-muted">{t('settings.usage.local')}</span>
                        </>
                      )}
                    </td>
                    <td>{t(`settings.usage.purpose.${r.purpose}`)}</td>
                    <td>
                      {formatNumber(r.calls)}
                      {r.failures > 0 && (
                        <>
                          {' '}
                          <span className="badge badge-warn">{t('settings.usage.failures', { count: r.failures })}</span>
                        </>
                      )}
                    </td>
                    <td>{fmtTokens(r.input_tokens)}</td>
                    <td>
                      {fmtTokens(r.output_tokens)}
                      {r.reasoning_tokens ? (
                        <span className="muted"> ({t('settings.usage.reasoning', { count: formatNumber(r.reasoning_tokens) })})</span>
                      ) : null}
                    </td>
                    <td>
                      {r.local
                        ? t('settings.usage.free')
                        : r.estimated_cost_usd === null
                          ? t('settings.usage.unknownCost')
                          : `≈ ${fmtUsd(r.estimated_cost_usd)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr>
                    <th>{t('settings.usage.total')}</th>
                    <td />
                    <td>{formatNumber(totals.calls)}</td>
                    <td>{fmtTokens(totals.input_tokens)}</td>
                    <td>{fmtTokens(totals.output_tokens)}</td>
                    <td>{totals.estimated_cost_usd === null ? t('settings.usage.unknownCost') : `≈ ${fmtUsd(totals.estimated_cost_usd)}`}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="muted">
            {t('settings.usage.note', { date: report.pricing_as_of })}
            {totals && totals.unmetered_calls > 0 ? ` ${t('settings.usage.unmetered', { count: totals.unmetered_calls })}` : ''}
          </p>
        </>
      )}
    </div>
  )
}
