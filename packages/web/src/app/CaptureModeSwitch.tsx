/**
 * Mode de capture (Auto / Revue d'abord / Pause) — l'interrupteur principal du
 * produit : il décide si les agents mémorisent, mémorisent sous validation, ou
 * ne mémorisent rien. Il doit être visible et compréhensible PARTOUT (spec §13).
 *
 * Deux formes, un seul état (voir app/capture-mode.ts) :
 *  - `CaptureModeSwitch` : segmented control en pied de barre latérale (bureau
 *    et tiroir mobile) ;
 *  - `CaptureModeMenu`   : bouton libellé dans la barre supérieure, pour les
 *    écrans étroits où la barre latérale est repliée dans un tiroir. POURQUOI :
 *    tant qu'il ne vivait qu'en pied de barre latérale, l'interrupteur le plus
 *    important du produit était INVISIBLE au téléphone — il fallait ouvrir le
 *    menu et faire défiler jusqu'en bas pour savoir si Memoria enregistrait.
 *
 * « Toujours visible » vaut aussi en panne : une lecture impossible affiche le
 * problème + « Réessayer » (jamais un contrôle qui disparaît sans un mot), un
 * changement refusé remet l'état réel ET le dit.
 */
import { ChevronDown, Eye, Pause, Zap, type LucideIcon } from 'lucide-react'
import type { CaptureMode } from '../api'
import { Button } from '../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useT } from '../i18n'
import { cn } from '../lib/utils'
import { changeCaptureMode, retryCaptureMode, useCaptureModeState } from './capture-mode'

// clés i18n : capture.short.<key> (segment), capture.<key> (long), capture.hint.<key>
const MODES: Array<{ id: CaptureMode; key: 'auto' | 'review' | 'pause'; icon: LucideIcon }> = [
  { id: 'auto-private', key: 'auto', icon: Zap },
  { id: 'review-first', key: 'review', icon: Eye },
  { id: 'incognito', key: 'pause', icon: Pause },
]

export function CaptureModeSwitch({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useT()
  const { mode, error, noticeRaw } = useCaptureModeState()

  if (mode === null) {
    if (error === null) return null // premier chargement en cours
    return (
      <div className="px-1">
        {!collapsed && <p className="text-xs text-destructive" role="alert">{t('capture.unavailable')}</p>}
        <Button variant="outline" size="sm" className="mt-1 w-full" onClick={retryCaptureMode}>
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
                  onClick={() => changeCaptureMode(m.id)}
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
      {!collapsed && noticeRaw && (
        <p className="mt-1 px-1 text-[11px] leading-snug text-warning" role="status">
          {t('capture.change_failed', { message: noticeRaw })}
        </p>
      )}
    </div>
  )
}

/**
 * Forme compacte pour la barre supérieure : un bouton qui DIT le mode en cours
 * (icône + mot), et ouvre la liste des trois modes avec, sous chacun, ce qu'il
 * fait. Le mode « Pause » se signale en jaune : mémoire à l'arrêt, ça se voit.
 */
export function CaptureModeMenu({ className }: { className?: string }) {
  const { t } = useT()
  const { mode, error, noticeRaw } = useCaptureModeState()

  if (mode === null) {
    if (error === null) return null
    return (
      <Button variant="outline" size="sm" className={className} onClick={retryCaptureMode} title={t('capture.unavailable')}>
        {t('common.retry')}
      </Button>
    )
  }

  const current = MODES.find(m => m.id === mode)
  if (!current) return null
  const Icon = current.icon
  const paused = mode === 'incognito'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('gap-1.5', paused && 'border-warning/50 text-warning', className)}
          aria-label={t('capture.current', { mode: t(`capture.${current.key}`) })}
        >
          <Icon aria-hidden="true" />
          <span>{t(`capture.short.${current.key}`)}</span>
          <ChevronDown className="opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t('capture.title')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={v => changeCaptureMode(v as CaptureMode)}>
          {MODES.map(m => {
            const ItemIcon = m.icon
            return (
              <DropdownMenuRadioItem key={m.id} value={m.id} className="items-start gap-2 py-1.5">
                <ItemIcon className="mt-0.5" aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{t(`capture.${m.key}`)}</span>
                  <span className="text-xs text-muted-foreground">{t(`capture.hint.${m.key}`)}</span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        {noticeRaw && (
          <p className="px-1.5 py-1 text-xs leading-snug text-warning" role="status">
            {t('capture.change_failed', { message: noticeRaw })}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
