/**
 * Mode de capture (Auto / Revue d'abord / Pause) — segmented control TOUJOURS
 * visible en bas de la barre latérale, quel que soit l'écran (spec §13).
 * « Toujours » vaut aussi en cas de panne : un échec de lecture du mode
 * affiche le problème + « Réessayer » (jamais un contrôle qui disparaît sans
 * un mot), un échec de changement remet l'état réel ET le dit.
 */
import { useCallback, useEffect, useState } from 'react'
import { Eye, Pause, Zap, type LucideIcon } from 'lucide-react'
import { getCaptureMode, setCaptureMode, type CaptureMode } from '../api'
import { humanError } from '../components/ui'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useT } from '../i18n'
import { cn } from '../lib/utils'

// clés i18n : capture.short.<key> (segment), capture.<key> (long), capture.hint.<key>
const MODES: Array<{ id: CaptureMode; key: 'auto' | 'review' | 'pause'; icon: LucideIcon }> = [
  { id: 'auto-private', key: 'auto', icon: Zap },
  { id: 'review-first', key: 'review', icon: Eye },
  { id: 'incognito', key: 'pause', icon: Pause },
]

export function CaptureModeSwitch({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useT()
  const [mode, setMode] = useState<CaptureMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Message éphémère après un changement refusé (role=status, pas d'alerte bloquante).
  const [notice, setNotice] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    getCaptureMode()
      .then(m => {
        if (cancelled) return
        setMode(m)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.warn('memoria-ui : mode de capture illisible', err)
        setError(humanError(err))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  const change = useCallback(
    (next: CaptureMode) => {
      setNotice(null)
      setMode(next) // optimiste — l'échec remet l'état réel ET le dit
      setCaptureMode(next).catch((err: unknown) => {
        console.warn('memoria-ui : changement de mode de capture refusé', err)
        setNotice(t('capture.change_failed', { message: humanError(err) }))
        getCaptureMode()
          .then(setMode)
          .catch(() => setTick(x => x + 1))
      })
    },
    [t],
  )

  if (mode === null) {
    if (error === null) return null // premier chargement en cours
    return (
      <div className="px-1">
        {!collapsed && <p className="text-xs text-destructive" role="alert">{t('capture.unavailable')}</p>}
        <Button variant="outline" size="sm" className="mt-1 w-full" onClick={() => setTick(x => x + 1)}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  const current = MODES.find(m => m.id === mode)
  const paused = mode === 'incognito'
  return (
    <div>
      {!collapsed && (
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('capture.title')}</span>
          {paused && <span className="size-2 rounded-full bg-warning" aria-hidden="true" />}
        </div>
      )}
      <div
        role="radiogroup"
        aria-label={t('capture.title')}
        className={cn('flex gap-0.5 rounded-lg bg-muted p-0.5', collapsed && 'flex-col')}
      >
        {MODES.map(m => {
          const active = mode === m.id
          const Icon = m.icon
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t(`capture.${m.key}`)}
                  onClick={() => change(m.id)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    active
                      ? cn('bg-background shadow-sm', paused ? 'text-warning' : 'text-foreground')
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{t(`capture.short.${m.key}`)}</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent side={collapsed ? 'right' : 'top'}>
                <span className="font-medium">{t(`capture.${m.key}`)}</span> — {t(`capture.hint.${m.key}`)}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      {!collapsed && current && (
        <p className="mt-1.5 px-1 text-[11px] leading-snug text-muted-foreground">{t(`capture.hint.${current.key}`)}</p>
      )}
      {!collapsed && notice && (
        <p className="mt-1 px-1 text-[11px] leading-snug text-warning" role="status">{notice}</p>
      )}
    </div>
  )
}
