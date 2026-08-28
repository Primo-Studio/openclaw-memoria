/**
 * Choix du moteur de recherche sémantique (embeddings), partagé entre l'écran
 * Réglages et l'Onboarding. Deux moteurs réels : OpenAI (clé API, recommandé,
 * le plus simple) et Ollama local. Pour le local : scan de la machine, install
 * du modèle en 1 clic si la config le permet, sinon avertissement honnête.
 * (Le « login/OAuth » n'existe pas pour les embeddings — refusé côté moteur.)
 *
 * shadcn : deux cartes côte à côte (une colonne sous 640 px), Label + Input
 * pour la clé, StatusBadge pour l'état, Progress pour l'installation, toasts
 * pour les confirmations. `variant="plain"` = sans la carte englobante
 * (imbriqué dans une étape de l'onboarding).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Cloud, Download, Laptop, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
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
import { cn } from '../lib/utils'
import { StatusBadge } from './SetupBits'
import { ErrorBanner, SectionCard, formatNumber } from './ui'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Progress } from './ui/progress'

const LOCAL_EMBED_MODEL = 'nomic-embed-text'

export function EmbeddingsChooser({
  health,
  current,
  currentModel,
  onChanged,
  variant = 'card',
}: {
  health: LlmHealth
  current?: string
  currentModel?: string
  onChanged: () => void | Promise<void>
  variant?: 'card' | 'plain'
}) {
  const { t } = useT()
  const [caps, setCaps] = useState<MachineCaps | null>(null)
  const [capsError, setCapsError] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [pull, setPull] = useState<OllamaPullStatus | null>(null)
  const [pulling, setPulling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Garde `cancelled` : navigation rapide Réglages → autre écran → Réglages,
  // sinon la réponse tardive écrit dans un composant démonté (ou remonté).
  useEffect(() => {
    let cancelled = false
    getMachineCaps()
      .then(c => {
        if (!cancelled) setCaps(c)
      })
      .catch(() => {
        if (!cancelled) setCapsError(true)
      })
    return () => {
      cancelled = true
    }
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
                toast.success(t('settings.embed.toast.installed'))
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
        toast.success(t('settings.embed.toast.changed'))
        await onChanged()
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [onChanged, t],
  )

  const saveKey = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const k = key.trim()
      if (!k) return
      setBusy(true)
      setError(null)
      try {
        await setProviderKey('openai', k)
        setKey('')
        toast.success(t('settings.embed.toast.keySaved'))
        await onChanged()
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [key, onChanged, t],
  )

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
    caps?.verdict === 'great' ? 'settings.embed.capsGreat' : caps?.verdict === 'ok' ? 'settings.embed.capsOk' : 'settings.embed.capsWeak'

  const activeBadge = <Badge variant="secondary">{t('settings.embed.active')}</Badge>

  const body = (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {/* OpenAI — recommandé, le plus simple */}
        <Card size="sm" className={cn('bg-muted/40 ring-0', openaiActive && 'bg-primary/5 ring-1 ring-primary/40')}>
          <CardContent className="flex h-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Cloud className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium">{t('settings.embed.openai.label')}</span>
              <Badge>{t('settings.embed.badgeRecommended')}</Badge>
              {openaiActive && activeBadge}
              <StatusBadge tone={openaiOn ? 'ok' : 'warn'} className="ml-auto">
                {openaiOn ? t('onboarding.badge.ready') : t('onboarding.badge.config')}
              </StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.embed.openai.hint')}</p>
            {!openaiOn && (
              <form onSubmit={e => void saveKey(e)} className="flex flex-col gap-1.5">
                <Label htmlFor="embed-openai-key">{t('settings.embed.keyLabel')}</Label>
                <p className="text-xs text-warning">{t('settings.embed.openaiMissing')}</p>
                <div className="flex gap-2">
                  <Input
                    id="embed-openai-key"
                    type="password"
                    autoComplete="off"
                    placeholder={t('settings.embed.keyPlaceholder')}
                    value={key}
                    onChange={e => setKey(e.target.value)}
                  />
                  <Button type="submit" size="sm" className="h-8 shrink-0" disabled={busy || !key.trim()}>
                    {t('settings.embed.saveKey')}
                  </Button>
                </div>
              </form>
            )}
            <div className="pt-1">
              {openaiActive ? (
                <p className="text-xs text-success">{t('settings.embed.activeNote')}</p>
              ) : (
                <Button size="sm" variant={openaiOn ? 'default' : 'outline'} disabled={busy || !openaiOn} onClick={() => void choose('openai')}>
                  {t('settings.embed.use')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Local (Ollama) — avancé, selon la puissance de la machine */}
        <Card size="sm" className={cn('bg-muted/40 ring-0', ollamaActive && 'bg-primary/5 ring-1 ring-primary/40')}>
          <CardContent className="flex h-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Laptop className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium">{t('settings.embed.ollama.label')}</span>
              <Badge variant="outline">{t('settings.embed.badgeAdvanced')}</Badge>
              {ollamaActive && activeBadge}
              <StatusBadge tone={ollamaReady ? 'ok' : ollamaServerUp ? 'warn' : 'muted'} className="ml-auto">
                {ollamaReady ? t('onboarding.badge.ready') : ollamaServerUp ? t('onboarding.badge.config') : t('onboarding.badge.off')}
              </StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.embed.ollama.hint')}</p>

            {/* Verdict du scan machine */}
            {caps ? (
              <p className={cn('text-xs', recommendLocal ? 'text-muted-foreground' : 'text-warning')}>
                {t('settings.embed.caps', {
                  ram: String(caps.ram_gb),
                  cores: String(caps.cpu_cores),
                  arch: caps.apple_silicon ? 'Apple Silicon' : caps.arch,
                })}{' '}
                {t(capsVerdictKey)}
              </p>
            ) : capsError ? (
              <p className="text-xs text-muted-foreground">{t('settings.embed.capsUnknown')}</p>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                {t('settings.embed.scanning')}
              </p>
            )}

            {/* Progression d'installation */}
            {pull && pull.running && (
              <div className="flex flex-col gap-1" role="status">
                <p className="text-xs text-warning">{t('settings.embed.installing', { pct: pull.percent != null ? ` ${pull.percent} %` : '' })}</p>
                <Progress value={pull.percent ?? 2} className="h-1.5" />
              </div>
            )}

            <div className="flex flex-col gap-1.5 pt-1">
              {ollamaReady ? (
                ollamaActive ? (
                  <p className="text-xs text-success">{t('settings.embed.activeNote')}</p>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void choose('ollama')} className="self-start">
                    {t('settings.embed.use')}
                  </Button>
                )
              ) : !ollamaServerUp ? (
                <p className="text-xs text-warning">{t('settings.embed.ollamaAppMissing')}</p>
              ) : recommendLocal ? (
                <Button size="sm" disabled={busy || pulling} onClick={installLocal} className="self-start">
                  <Download aria-hidden="true" />
                  {t('settings.embed.installLocal')}
                </Button>
              ) : (
                <>
                  <p className="text-xs text-warning">{t('settings.embed.notRecommended')}</p>
                  <Button size="sm" variant="outline" disabled={busy || pulling} onClick={installLocal} className="self-start">
                    <Download aria-hidden="true" />
                    {t('settings.embed.installAnyway')}
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {typeof health.embeddings.pending === 'number' && health.embeddings.pending > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-warning" role="status">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {t('settings.embed.reindexing', { count: formatNumber(health.embeddings.pending) })}
        </p>
      )}
      {error && <ErrorBanner message={error} className="my-0" />}
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{t('settings.embed.reindexNote')}</p>
        <p>{t('settings.embed.noLogin')}</p>
        {current && (
          <p>
            {t('settings.embed.current')} <strong className="text-foreground">{current}</strong> / {currentModel ?? t('settings.engine.defaultModel')}
          </p>
        )}
      </div>
    </div>
  )

  if (variant === 'plain') {
    return (
      <section className="flex flex-col gap-3" aria-labelledby="embed-title">
        <div>
          <h2 id="embed-title" className="text-sm font-medium">
            {t('settings.embed.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('settings.embed.lead')}</p>
        </div>
        {body}
      </section>
    )
  }
  return (
    <SectionCard title={t('settings.embed.title')} description={t('settings.embed.lead')} className="mb-0">
      {body}
    </SectionCard>
  )
}
