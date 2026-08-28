/**
 * Réglages (spec §14) : choix du MOTEUR D'IA d'extraction — l'utilisateur
 * décide (provider + modèle), avec recommandations pour ne pas être perdu.
 * Local pour qui veut du local ; cloud (OpenAI/Anthropic/OpenRouter) sinon.
 * + recherche sémantique, consommation, contrôle du service, mise à jour,
 * synchro, stockage, options. Routes « contrat » : 404 → « non disponible ».
 *
 * shadcn : trois onglets pour ne pas noyer un non-technicien —
 * « Moteur d'IA » (santé, extraction, recherche sémantique, consommation),
 * « Service » (contrôle, mise à jour, synchro, stockage), « Options ».
 * Une SectionCard par sujet, Switch pour les bascules, toasts pour les
 * confirmations, AlertDialog (ConfirmButton) pour ce qui coupe ou révoque.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CircleCheck, CircleX, Cloud, Cpu, Download, Laptop, Loader2, Lock, Monitor, Power, RefreshCw, SlidersHorizontal, Star, TriangleAlert, Usb } from 'lucide-react'
import { toast } from 'sonner'
import {
  ConfirmButton,
  CopyButton,
  DataTable,
  EmptyState,
  PageHeader,
  SectionCard,
  Spinner,
  formatCompact,
  formatDate,
  formatNumber,
  providerLabel,
  type DataColumn,
} from '../components/ui'
import { Chip, CommandBlock, StatusBadge, SwitchRow } from '../components/SetupBits'
import { EmbeddingsChooser } from '../components/EmbeddingsChooser'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { currentLocale, useT } from '../i18n'
import {
  HANDOVER_MAX_PROBES,
  HANDOVER_RETRY_EVERY_MS,
  HANDOVER_WAIT_MS,
  afterHandoverProbeFailed,
  planAutostartChange,
  supervisorNoteKey,
} from '../lib/autostart'
import { summarizeCloudSends } from '../lib/cloud'
import { cn } from '../lib/utils'
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
  type LlmUsageRow,
  type ProvidersStatus,
  type SyncPeer,
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

type SettingsTab = 'engine' | 'service' | 'options'
const TAB_KEY = 'memoria.settings.tab'

/** Onglet mémorisé localement : on revient là où on était (jamais bloquant si localStorage manque). */
function loadTab(): SettingsTab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'service' || v === 'options' ? v : 'engine'
  } catch {
    return 'engine'
  }
}

export function Settings() {
  const { t } = useT()
  const [tab, setTab] = useState<SettingsTab>(loadTab)
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [providers, setProviders] = useState<ProvidersStatus | null>(null)
  const [health, setHealth] = useState<LlmHealth | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  // clé API saisie par provider (non persistée tant qu'on ne valide pas)
  const [keyInput, setKeyInput] = useState<Record<string, string>>({})

  // Les échecs d'action remontent en toast (visibles quel que soit l'onglet).
  const onError = useCallback((m: string) => toast.error(m), [])

  const changeTab = (v: string) => {
    const next: SettingsTab = v === 'service' || v === 'options' ? v : 'engine'
    setTab(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      /* préférence non mémorisée : sans conséquence */
    }
  }

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
        toast.success(t('settings.toast.engineChanged', { provider: providerLabel(provider), model }))
      } catch (err) {
        onError(err instanceof ApiError ? err.message : t('settings.error.changeFailed'))
      } finally {
        setBusy(false)
      }
    },
    [refresh, t, onError],
  )

  /** Enregistre la clé API collée par l'utilisateur, puis rafraîchit (le badge passe au vert). */
  const saveKey = useCallback(
    async (provider: LlmProviderName) => {
      const key = (keyInput[provider] ?? '').trim()
      if (!key) return
      setBusy(true)
      try {
        await setProviderKey(provider, key)
        setKeyInput(prev => ({ ...prev, [provider]: '' }))
        await refresh()
        toast.success(t('settings.toast.keySaved', { provider: providerLabel(provider) }))
      } catch (err) {
        onError(err instanceof ApiError ? err.message : t('settings.error.keySaveFailed'))
      } finally {
        setBusy(false)
      }
    },
    [keyInput, refresh, t, onError],
  )

  const current = config?.extraction
  const availabilityOf = (id: LlmProviderName): boolean | undefined => {
    if (!providers) return undefined
    return id === 'ollama' ? providers.ollama.available : providers[id]?.available
  }

  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.lead')} />

      <Tabs value={tab} onValueChange={changeTab} className="gap-4">
        <TabsList className="h-auto w-full flex-wrap sm:w-fit">
          <TabsTrigger value="engine">
            <Cpu aria-hidden="true" />
            {t('settings.tab.engine')}
          </TabsTrigger>
          <TabsTrigger value="service">
            <Power aria-hidden="true" />
            {t('settings.tab.service')}
          </TabsTrigger>
          <TabsTrigger value="options">
            <SlidersHorizontal aria-hidden="true" />
            {t('settings.tab.options')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="engine" className="flex flex-col gap-4">
          {health && <LlmHealthSummary health={health} />}

          <SectionCard
            title={t('settings.engine.title')}
            description={
              <>
                {t('settings.engine.lead.before')}
                <strong className="text-foreground">{t('settings.engine.lead.local')}</strong>
                {t('settings.engine.lead.middle')}
                <strong className="text-foreground">{t('settings.engine.lead.cloud')}</strong>
                {t('settings.engine.lead.after')}
              </>
            }
            className="mb-0"
          >
            {unavailable ? (
              <p className="text-sm text-muted-foreground">{t('settings.engine.unavailable')}</p>
            ) : !providers || !config ? (
              <Spinner />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {PROVIDERS.map(p => (
                  <ProviderCard
                    key={p.id}
                    choice={p}
                    available={availabilityOf(p.id)}
                    isCurrent={current?.provider === p.id}
                    currentModel={current?.model}
                    // LM Studio : on propose les modèles réellement chargés
                    models={p.id === 'lmstudio' ? (health?.options.lmstudio.models ?? providers.lmstudio.models ?? []) : p.models}
                    busy={busy}
                    keyValue={keyInput[p.id] ?? ''}
                    onKeyChange={v => setKeyInput(prev => ({ ...prev, [p.id]: v }))}
                    onSaveKey={() => void saveKey(p.id)}
                    onChoose={model => void choose(p.id, model)}
                  />
                ))}
              </div>
            )}
            {config?.extraction && (
              <p className="mt-3 text-xs text-muted-foreground">
                {t('settings.engine.current')} <strong className="text-foreground">{providerLabel(config.extraction.provider ?? '')}</strong> /{' '}
                {config.extraction.model ?? t('settings.engine.defaultModel')}
              </p>
            )}
          </SectionCard>

          {health && config && !unavailable && (
            <EmbeddingsChooser health={health} current={config.embeddings?.provider} currentModel={config.embeddings?.model} onChanged={refresh} />
          )}

          <UsagePanel />
        </TabsContent>

        <TabsContent value="service" className="flex flex-col gap-4">
          <ControlPanel onError={onError} />
          <UpdatePanel onError={onError} />
          <SyncPanel onError={onError} />
          <StorageCard doctor={doctor} />
        </TabsContent>

        <TabsContent value="options" className="flex flex-col gap-4">
          <SectionCard title={t('settings.options.title')} description={t('settings.options.desc')} className="mb-0">
            <OptionsPanel onError={onError} />
          </SectionCard>
          <SectionCard title={t('settings.capture.title')} className="mb-0">
            <p className="text-sm text-muted-foreground">{t('settings.capture.desc')}</p>
          </SectionCard>
          <SectionCard title={t('settings.export.title')} className="mb-0">
            <p className="text-sm text-muted-foreground">
              {t('settings.export.desc.before')}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">memoria export</code>
              {t('settings.export.desc.middle')}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">.md</code>
              {t('settings.export.desc.after')}
            </p>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </>
  )
}

// ------------------------------------------------------------ moteur d'extraction

const PROVIDER_ICONS: Record<LlmProviderName, typeof Cloud> = {
  ollama: Laptop,
  lmstudio: Monitor,
  openai: Cloud,
  anthropic: Cloud,
  openrouter: Cloud,
}

function ProviderCard({
  choice: p,
  available,
  isCurrent,
  currentModel,
  models,
  busy,
  keyValue,
  onKeyChange,
  onSaveKey,
  onChoose,
}: {
  choice: ProviderChoice
  available: boolean | undefined
  isCurrent: boolean
  currentModel: string | undefined
  models: string[]
  busy: boolean
  keyValue: string
  onKeyChange: (v: string) => void
  onSaveKey: () => void
  onChoose: (model: string) => void
}) {
  const { t } = useT()
  const Icon = PROVIDER_ICONS[p.id]
  const isCloud = p.id === 'openai' || p.id === 'openrouter' || p.id === 'anthropic'
  const submitKey = (e: FormEvent) => {
    e.preventDefault()
    onSaveKey()
  }
  return (
    <Card size="sm" className={cn('bg-muted/40 ring-0', isCurrent && 'bg-primary/5 ring-1 ring-primary/40')}>
      <CardContent className="flex h-full flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{t(`settings.provider.${p.id}.label`)}</span>
          {p.id === 'openai' && <Badge>{t('settings.engine.badgeRecommended')}</Badge>}
          {isCurrent && <Badge variant="secondary">{t('settings.engine.badgeActive')}</Badge>}
          {available !== undefined && (
            <StatusBadge tone={available ? 'ok' : 'warn'} className="ml-auto">
              {available ? t('settings.engine.detected') : t('settings.engine.missingKeyServer')}
            </StatusBadge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t(`settings.provider.${p.id}.hint`)}</p>
        {available === false && (
          <p className="text-xs text-warning">
            {p.id === 'ollama'
              ? t('settings.engine.missing.ollama')
              : p.id === 'lmstudio'
                ? t('settings.engine.missing.lmstudio')
                : t('settings.engine.missing.key', { provider: p.id })}
          </p>
        )}
        {isCloud && (
          <form onSubmit={submitKey} className="flex flex-col gap-1.5">
            <Label htmlFor={`key-${p.id}`}>{t('settings.engine.keyLabel')}</Label>
            <div className="flex gap-2">
              <Input
                id={`key-${p.id}`}
                type="password"
                autoComplete="off"
                placeholder={available ? t('settings.engine.keyPlaceholderReplace') : t('settings.engine.keyPlaceholderPaste')}
                value={keyValue}
                onChange={e => onKeyChange(e.target.value)}
              />
              <Button type="submit" size="sm" variant="outline" className="h-8 shrink-0" disabled={busy || !keyValue.trim()}>
                {t('settings.engine.saveKey')}
              </Button>
            </div>
          </form>
        )}
        {p.id === 'lmstudio' && available === true && models.length === 0 && <p className="text-xs text-warning">{t('settings.engine.lmstudioNoModels')}</p>}
        {models.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-xs text-muted-foreground">{t('settings.engine.modelLabel')}</span>
            <div role="radiogroup" aria-label={t('settings.engine.modelLabel')} className="flex flex-wrap gap-1.5">
              {models.map(model => {
                const recommended = model === p.recommended
                return (
                  <Chip
                    key={model}
                    active={isCurrent && currentModel === model}
                    disabled={busy}
                    onClick={() => onChoose(model)}
                    title={recommended ? t('settings.engine.modelRecommendedTitle') : undefined}
                    className="font-mono"
                  >
                    {model}
                    {recommended && <Star className="size-3 fill-current" aria-hidden="true" />}
                  </Chip>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
  const extractionOk = health.extraction.available
  const embeddingsOk = health.embeddings.available
  const rows: Array<{ key: string; tone: 'ok' | 'warn' | 'danger'; text: string }> = [
    {
      key: 'extraction',
      tone: extractionOk ? 'ok' : 'danger',
      text: extractionOk
        ? t('settings.health.extractionReady', { provider: health.extraction.provider, model: health.extraction.model })
        : t('settings.health.extractionUnavailable', { reason: health.extraction.reason ?? t('settings.health.reasonUnknown') }),
    },
    {
      key: 'embeddings',
      tone: embeddingsOk ? 'ok' : 'warn',
      text: embeddingsOk
        ? t('settings.health.embeddingsReady', { provider: health.embeddings.provider, model: health.embeddings.model })
        : t('settings.health.embeddingsWarn', { reason: health.embeddings.reason ?? t('settings.health.embeddingsUnavailable') }),
    },
  ]
  if (health.wal_pending > 0) {
    rows.push({
      key: 'wal',
      tone: extractionOk ? 'warn' : 'danger',
      text:
        (health.wal_pending > 1 ? t('settings.health.walPendingPlural', { count }) : t('settings.health.walPending', { count })) +
        (extractionOk ? t('settings.health.walNext') : t('settings.health.walWaiting')),
    })
  }
  const worst = rows.some(r => r.tone === 'danger') ? 'danger' : rows.some(r => r.tone === 'warn') ? 'warn' : 'ok'
  return (
    <Card size="sm" className={cn(worst === 'danger' && 'ring-destructive/40', worst === 'warn' && 'ring-warning/40')} role="status">
      <CardContent className="flex flex-col gap-1.5">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t('settings.health.title')}</div>
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map(r => (
            <li key={r.key} className={cn('flex items-start gap-2', r.tone === 'ok' ? 'text-success' : r.tone === 'warn' ? 'text-warning' : 'text-destructive')}>
              {r.tone === 'ok' ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              ) : r.tone === 'warn' ? (
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              ) : (
                <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              )}
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------ service : contrôle

function ControlPanel({ onError }: { onError: (m: string) => void }) {
  const { t } = useT()
  const [state, setState] = useState<ControlState | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Une passation (redémarrage du daemon) sonde le service pendant ~20 s : si
  // l'écran est quitté entre-temps, on n'écrit plus dans un composant démonté.
  // Remis à false au (re)montage : StrictMode monte/démonte/remonte en dev.
  const gone = useRef(false)
  useEffect(() => {
    gone.current = false
    return () => {
      gone.current = true
    }
  }, [])

  useEffect(() => {
    getControl().then(setState).catch(() => setUnavailable(true))
  }, [])

  const toggleEnabled = useCallback(
    async (enabled: boolean) => {
      setBusy('enabled')
      setState(prev => (prev ? { ...prev, enabled } : prev)) // optimiste
      try {
        const v = await setEnabled(enabled)
        setState(prev => (prev ? { ...prev, enabled: v } : prev))
        toast.success(v ? t('settings.toast.resumed') : t('settings.toast.paused'))
      } catch (err) {
        onError(err instanceof ApiError ? err.message : t('settings.error.changeFailed'))
        getControl().then(setState).catch(() => {})
      } finally {
        setBusy(null)
      }
    },
    [onError, t],
  )

  /**
   * Après `handover: true` : le daemon s'arrête et revient (launchd ou direct).
   * On attend ~10 s bouton désactivé, puis on resonde GET /v1/admin/control
   * quelques fois — la logique de décision est dans lib/autostart.ts.
   */
  const awaitHandover = useCallback(async () => {
    await sleep(HANDOVER_WAIT_MS)
    for (let probe = 1; probe <= HANDOVER_MAX_PROBES; probe++) {
      if (gone.current) return
      try {
        const fresh = await getControl()
        if (gone.current) return
        setState(fresh)
        setNote(t('settings.control.handoverBack'))
        return
      } catch (err) {
        const next = afterHandoverProbeFailed(err, probe)
        if (next.kind !== 'retry') {
          if (!gone.current) setNote(t(next.noteKey))
          return
        }
        await sleep(HANDOVER_RETRY_EVERY_MS)
      }
    }
  }, [t])

  const toggleAutostart = useCallback(
    async (enabled: boolean) => {
      setBusy('autostart')
      setNote(null)
      try {
        const plan = planAutostartChange(await setAutostart(enabled), enabled)
        setState(prev => (prev ? { ...prev, autostart: plan.autostart } : prev))
        if (plan.restarting) {
          // Pas une erreur : le daemon redémarre, la page le dit calmement et attend.
          setNote(t(plan.noteKey))
          await awaitHandover()
        }
      } catch (err) {
        onError(err instanceof ApiError ? err.message : t('settings.error.changeFailed'))
        getControl().then(setState).catch(() => {})
      } finally {
        if (!gone.current) setBusy(null)
      }
    },
    [awaitHandover, onError, t],
  )

  if (unavailable) return null
  if (state === null) {
    return (
      <SectionCard title={t('settings.control.title')} className="mb-0">
        <Spinner />
      </SectionCard>
    )
  }

  const supervisorKey = supervisorNoteKey(state)

  return (
    <SectionCard
      title={t('settings.control.title')}
      actions={state.enabled ? <StatusBadge tone="ok">{t('settings.control.badgeOn')}</StatusBadge> : <StatusBadge tone="warn">{t('settings.control.badgeOff')}</StatusBadge>}
      className="mb-0"
    >
      <div className="divide-y">
        <SwitchRow
          id="ctl-enabled"
          title={t('settings.control.enabledTitle')}
          hint={state.enabled ? t('settings.control.enabledOn') : t('settings.control.enabledOff')}
          checked={state.enabled}
          disabled={busy === 'enabled'}
          onCheckedChange={v => void toggleEnabled(v)}
        />
        <SwitchRow
          id="ctl-autostart"
          title={t('settings.control.autostartTitle')}
          hint={
            <>
              {state.autostart.supported ? t('settings.control.autostartOn') : t('settings.control.autostartUnsupported')}
              {supervisorKey && (
                <>
                  <br />
                  {t(supervisorKey)}
                </>
              )}
            </>
          }
          checked={state.autostart.installed}
          disabled={busy === 'autostart' || !state.autostart.supported}
          onCheckedChange={v => void toggleAutostart(v)}
        />
      </div>
      {note && (
        <Alert className="mt-3" role="status">
          {busy === 'autostart' ? <Loader2 className="animate-spin" /> : <CircleCheck className="text-success" />}
          <AlertTitle>{note}</AlertTitle>
        </Alert>
      )}
    </SectionCard>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ------------------------------------------------------------ service : mise à jour

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

  const update = async () => {
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
  }

  return (
    <SectionCard
      title={t('settings.update.title')}
      description={
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {t('settings.update.versionLabel')} <strong className="text-foreground">{version.version}</strong>
          </span>
          {version.sha && (
            <span>
              · {t('settings.update.revision')} <code className="rounded bg-muted px-1 py-0.5 text-xs">{version.sha}</code>
            </span>
          )}
          {!version.is_git && <Badge variant="outline">{t('settings.update.frozen')}</Badge>}
        </span>
      }
      className="mb-0"
    >
      {version.is_git ? (
        <div className="flex flex-col gap-2">
          <Button className="self-start" disabled={busy} onClick={() => void update()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
            {busy ? t('settings.update.busy') : t('settings.update.button')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('settings.update.hint')}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('settings.update.notGit')}</p>
      )}
      {note && (
        <Alert className="mt-3" role="status">
          {busy ? <Loader2 className="animate-spin" /> : <CircleCheck className="text-success" />}
          <AlertTitle>{note}</AlertTitle>
        </Alert>
      )}
    </SectionCard>
  )
}

// ------------------------------------------------------------ service : synchro

function SyncPanel({ onError }: { onError: (m: string) => void }) {
  const { t } = useT()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [invite, setInvite] = useState<{ code: string; hub_lan: string | null } | null>(null)
  const [joinHub, setJoinHub] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    getSyncStatus().then(setStatus).catch(() => setUnavailable(true))
  }, [])
  useEffect(() => refresh(), [refresh])

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      onError(err instanceof ApiError ? err.message : t('settings.sync.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (unavailable) return null
  if (status === null) {
    return (
      <SectionCard title={t('settings.sync.title')} className="mb-0">
        <Spinner />
      </SectionCard>
    )
  }

  const configured = status.enabled && (status.role === 'hub' || status.hub)

  const peerColumns: DataColumn<SyncPeer>[] = [
    { id: 'name', header: t('settings.sync.col.machine'), cell: p => <span className="font-medium">{p.display_name}</span> },
    { id: 'role', header: t('settings.sync.col.role'), cell: p => <Badge variant="outline">{p.role === 'hub' ? t('settings.sync.roleHub') : t('settings.sync.roleSpoke')}</Badge> },
    {
      id: 'seen',
      header: t('settings.sync.col.seen'),
      cell: p =>
        p.revoked_at ? (
          <StatusBadge tone="muted">{t('settings.sync.revoked')}</StatusBadge>
        ) : (
          <span className="text-muted-foreground">{p.last_seen_at ? t('settings.sync.seenAt', { date: formatDate(p.last_seen_at) }) : t('settings.sync.neverSeen')}</span>
        ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('settings.sync.col.actions')}</span>,
      align: 'right',
      cell: p =>
        p.revoked_at ? null : (
          <ConfirmButton
            label={t('settings.sync.revoke')}
            title={t('settings.sync.revokeTitle')}
            description={t('settings.sync.revokeBody')}
            confirmLabel={t('settings.sync.revoke')}
            onConfirm={() =>
              void wrap(async () => {
                await syncRevoke(p.machine_id)
                toast.success(t('settings.sync.toast.revoked'))
                refresh()
              })
            }
          />
        ),
    },
  ]

  return (
    <SectionCard
      title={t('settings.sync.title')}
      description={
        <>
          {t('settings.sync.desc.before')}
          <strong className="text-foreground">{t('settings.sync.desc.private')}</strong>
          {t('settings.sync.desc.after')}
        </>
      }
      actions={
        configured ? (
          <StatusBadge tone="ok">{status.role === 'hub' ? t('settings.sync.roleHub') : t('settings.sync.roleSpoke')}</StatusBadge>
        ) : (
          <StatusBadge tone="muted">{t('settings.sync.badgeNotLinked')}</StatusBadge>
        )
      }
      className="mb-0"
    >
      {!configured ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t('settings.sync.notLinked')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Card size="sm" className="bg-muted/40 ring-0">
              <CardContent className="flex h-full flex-col gap-2">
                <div className="font-medium">{t('settings.sync.makeHubTitle')}</div>
                <p className="text-xs text-muted-foreground">{t('settings.sync.makeHubDesc')}</p>
                <Button
                  size="sm"
                  className="self-start"
                  disabled={busy}
                  onClick={() =>
                    void wrap(async () => {
                      const r = await syncInitHub('0.0.0.0:47600')
                      setNote(t('settings.sync.hubConfigured', { machine: r.machine_id }))
                      toast.success(t('settings.sync.toast.hub'))
                      refresh()
                    })
                  }
                >
                  {t('settings.sync.makeHubButton')}
                </Button>
              </CardContent>
            </Card>
            <Card size="sm" className="bg-muted/40 ring-0">
              <CardContent className="flex h-full flex-col gap-2">
                <div className="font-medium">{t('settings.sync.joinTitle')}</div>
                <p className="text-xs text-muted-foreground">{t('settings.sync.joinDesc')}</p>
                <form
                  className="flex flex-col gap-2"
                  onSubmit={e => {
                    e.preventDefault()
                    void wrap(async () => {
                      const r = await syncJoin(joinHub.trim(), joinCode.trim())
                      setNote(t('settings.sync.joined', { facts: r.facts, secrets: r.secrets }))
                      toast.success(t('settings.sync.toast.joined'))
                      refresh()
                    })
                  }}
                >
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="sync-hub">{t('settings.sync.hubAddressLabel')}</Label>
                    <Input id="sync-hub" placeholder={t('settings.sync.hubAddressPlaceholder')} value={joinHub} onChange={e => setJoinHub(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="sync-code">{t('settings.sync.inviteCodeLabel')}</Label>
                    <Input id="sync-code" placeholder={t('settings.sync.inviteCodePlaceholder')} value={joinCode} onChange={e => setJoinCode(e.target.value)} className="font-mono" />
                  </div>
                  <Button type="submit" size="sm" className="self-start" disabled={busy || !joinHub.trim() || !joinCode.trim()}>
                    {t('settings.sync.joinButton')}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t('settings.sync.roleLabel')} <strong className="text-foreground">{status.role === 'hub' ? t('settings.sync.roleHub') : t('settings.sync.roleSpoke')}</strong>
            {status.role === 'hub' && status.listen_lan ? ` · ${t('settings.sync.listen', { addr: status.listen_lan })}` : ''}
            {status.role === 'spoke' && status.hub ? ` · ${t('settings.sync.hubOf', { addr: status.hub })}` : ''}
            {' · '}
            {t('settings.sync.idLabel')} <code className="rounded bg-muted px-1 py-0.5 text-xs">{status.machine_id}</code>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void wrap(async () => {
                  const r = await syncNow()
                  setNote(t('settings.sync.syncDone', { pulled: r.pulled, pushed: r.pushed }))
                  toast.success(t('settings.sync.syncDone', { pulled: r.pulled, pushed: r.pushed }))
                })
              }
            >
              <RefreshCw aria-hidden="true" />
              {t('settings.sync.syncNow')}
            </Button>
            {status.role === 'hub' && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void wrap(async () => {
                    const inv = await syncInvite()
                    setInvite({ code: inv.code, hub_lan: inv.hub_lan })
                  })
                }
              >
                {t('settings.sync.invite')}
              </Button>
            )}
            {status.role === 'spoke' && (
              <ConfirmButton
                label={t('settings.sync.leave')}
                title={t('settings.sync.leaveTitle')}
                description={t('settings.sync.leaveBody')}
                confirmLabel={t('settings.sync.leave')}
                variant="destructive"
                onConfirm={() =>
                  void wrap(async () => {
                    await syncLeave()
                    toast.success(t('settings.sync.toast.left'))
                    refresh()
                  })
                }
              />
            )}
          </div>

          {invite && (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <p className="text-sm">{t('settings.sync.inviteIntro')}</p>
              <CommandBlock text={t('settings.sync.inviteHub', { addr: invite.hub_lan ?? t('settings.sync.inviteHubFallback') })} />
              <CommandBlock text={t('settings.sync.inviteCode', { code: invite.code })} copyLabel={t('settings.sync.copyCode')} />
              <p className="text-xs text-muted-foreground">{t('settings.sync.codeExpires')}</p>
            </div>
          )}

          {status.peers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">{t('settings.sync.peersTitle')}</h3>
              <DataTable columns={peerColumns} rows={status.peers} rowKey={p => p.machine_id} dense />
            </div>
          )}
        </div>
      )}

      {note && (
        <Alert className="mt-3" role="status">
          <CircleCheck className="text-success" />
          <AlertTitle>{note}</AlertTitle>
        </Alert>
      )}
    </SectionCard>
  )
}

// ------------------------------------------------------------ service : stockage

function StorageCard({ doctor }: { doctor: DoctorReport | null }) {
  const { t } = useT()
  const root = doctor?.storage_root ?? '~/.memoria/data'
  const moveCmd = 'memoria move --to /Volumes/MaCle/memoria'
  return (
    <SectionCard title={t('settings.storage.title')} className="mb-0">
      <div className="flex flex-col gap-3">
        <CommandBlock text={root} copyLabel={t('settings.storage.copyPath')} />
        <p className="text-sm text-muted-foreground">
          {t('settings.storage.desc.before')}
          <strong className="inline-flex items-center gap-1 text-foreground">
            <Usb className="size-3.5" aria-hidden="true" />
            {t('settings.storage.desc.usb')}
          </strong>
          {t('settings.storage.desc.after')}
        </p>
        <CommandBlock text={moveCmd} copyLabel={t('settings.storage.copyCommand')} />
        <p className="text-sm text-muted-foreground">
          {t('settings.storage.restart.before')}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">memoria start</code> {t('settings.storage.restart.after')}
        </p>
      </div>
    </SectionCard>
  )
}

// ------------------------------------------------------------ options

function OptionsPanel({ onError }: { onError: (m: string) => void }) {
  const { t } = useT()
  const [options, setOptions] = useState<Record<string, boolean> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    getOptions().then(setOptions).catch(() => setOptions(null))
  }, [])

  const toggle = useCallback(
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

  if (options === null) return <p className="text-sm text-muted-foreground">{t('settings.options.unavailable')}</p>
  return (
    <div className="divide-y">
      {OPTIONS.map(o => (
        <SwitchRow
          key={o}
          id={`opt-${o}`}
          title={t(`settings.option.${o}.label`)}
          hint={t(`settings.option.${o}.hint`)}
          checked={options[o] ?? false}
          disabled={busy === o}
          onCheckedChange={v => void toggle(o, v)}
        />
      ))}
    </div>
  )
}

// ------------------------------------------------------------ consommation

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
      <Card size="sm" className="ring-success/30" role="status">
        <CardContent className="flex items-center gap-3">
          <Lock className="size-5 shrink-0 text-success" aria-hidden="true" />
          <div>
            <div className="font-medium">{t('settings.cloud.title')}</div>
            <p className="text-sm text-muted-foreground">{t('settings.cloud.none')}</p>
          </div>
        </CardContent>
      </Card>
    )
  }
  const vars = { calls: formatNumber(cloud.calls), providers: cloud.providers.join(', '), chars: formatCompact(cloud.chars) }
  return (
    <Card size="sm" className="ring-warning/40" role="status">
      <CardContent className="flex items-start gap-3">
        <Cloud className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="font-medium">{t('settings.cloud.title')}</div>
          <p className="text-sm text-muted-foreground">
            {t(cloud.calls > 1 ? 'settings.cloud.summary.plural' : 'settings.cloud.summary.one', vars)}
            {cloud.last_ts ? ` ${t('settings.cloud.last', { date: formatDate(cloud.last_ts) })}` : ''}
          </p>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {cloud.rows.map(r => (
              <li key={`${r.provider}|${r.model}|${r.purpose}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                  {r.provider}/{r.model}
                </code>
                <span>· {t(`settings.usage.purpose.${r.purpose}`)} —</span>
                <span>{t('settings.cloud.row', { calls: formatNumber(r.calls), items: formatNumber(r.items), chars: formatCompact(r.chars) })}</span>
                {r.failures > 0 && <StatusBadge tone="warn">{t('settings.cloud.failures', { count: r.failures })}</StatusBadge>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('settings.cloud.note')}</p>
        </div>
      </CardContent>
    </Card>
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
  const columns: DataColumn<LlmUsageRow>[] = [
    {
      id: 'model',
      header: t('settings.usage.col.model'),
      cell: r => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <code className="text-xs">
            {r.provider}/{r.model}
          </code>
          {r.local && <Badge variant="outline">{t('settings.usage.local')}</Badge>}
        </span>
      ),
    },
    { id: 'purpose', header: t('settings.usage.col.purpose'), cell: r => t(`settings.usage.purpose.${r.purpose}`) },
    {
      id: 'calls',
      header: t('settings.usage.col.calls'),
      align: 'right',
      cell: r => (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          {formatNumber(r.calls)}
          {r.failures > 0 && <StatusBadge tone="warn">{t('settings.usage.failures', { count: r.failures })}</StatusBadge>}
        </span>
      ),
    },
    { id: 'in', header: t('settings.usage.col.in'), align: 'right', cell: r => <span className="tabular-nums">{fmtTokens(r.input_tokens)}</span> },
    {
      id: 'out',
      header: t('settings.usage.col.out'),
      align: 'right',
      cell: r => (
        <span className="tabular-nums">
          {fmtTokens(r.output_tokens)}
          {r.reasoning_tokens ? <span className="text-muted-foreground"> ({t('settings.usage.reasoning', { count: formatNumber(r.reasoning_tokens) })})</span> : null}
        </span>
      ),
    },
    {
      id: 'cost',
      header: t('settings.usage.col.cost'),
      align: 'right',
      cell: r => (
        <span className="tabular-nums">
          {r.local ? t('settings.usage.free') : r.estimated_cost_usd === null ? t('settings.usage.unknownCost') : `≈ ${fmtUsd(r.estimated_cost_usd)}`}
        </span>
      ),
    },
  ]

  let body: ReactNode
  if (loading && !report) body = <Spinner />
  else if (unavailable) body = <p className="text-sm text-muted-foreground">{t('settings.usage.unavailable')}</p>
  else if (!report || report.rows.length === 0) {
    body = (
      <>
        <CloudSends rows={[]} />
        <EmptyState title={t('settings.usage.empty.title')} body={t('settings.usage.empty.body')} />
      </>
    )
  } else {
    body = (
      <>
        <CloudSends rows={report.rows} />
        <DataTable columns={columns} rows={report.rows} rowKey={r => `${r.provider}|${r.model}|${r.purpose}`} dense />
        {totals && (
          <p className="text-sm tabular-nums">
            <strong>{t('settings.usage.total')}</strong> — {t('settings.usage.col.calls')} : {formatNumber(totals.calls)} · {t('settings.usage.col.in')} :{' '}
            {fmtTokens(totals.input_tokens)} · {t('settings.usage.col.out')} : {fmtTokens(totals.output_tokens)} · {t('settings.usage.col.cost')} :{' '}
            {totals.estimated_cost_usd === null ? t('settings.usage.unknownCost') : `≈ ${fmtUsd(totals.estimated_cost_usd)}`}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('settings.usage.note', { date: report.pricing_as_of })}
          {totals && totals.unmetered_calls > 0 ? ` ${t('settings.usage.unmetered', { count: totals.unmetered_calls })}` : ''}
        </p>
      </>
    )
  }

  return (
    <SectionCard title={t('settings.usage.title')} description={t('settings.usage.lead')} className="mb-0">
      <div className="flex flex-col gap-3">
        <Tabs value={period} onValueChange={v => setPeriod(v as LlmUsagePeriod)}>
          <TabsList className="h-auto w-full flex-wrap sm:w-fit" aria-label={t('settings.usage.periodLabel')}>
            {USAGE_PERIODS.map(p => (
              <TabsTrigger key={p} value={p}>
                {t(`settings.usage.period.${p}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {body}
      </div>
    </SectionCard>
  )
}
