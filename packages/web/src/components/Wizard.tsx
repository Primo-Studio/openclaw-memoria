/**
 * Wizard — coquille réutilisable pour un parcours en étapes (shadcn).
 * Stepper numéroté + barre de progression, titre de l'étape, corps, pied de
 * page avec Retour / Passer / Continuer (une seule action principale). La
 * logique métier reste dans l'écran appelant.
 */
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { useT } from '../i18n'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Progress } from './ui/progress'

export interface WizardStep {
  /** Identifiant stable de l'étape. */
  id: string
  /** Titre affiché en tête de l'étape. */
  title: string
  /** Libellé court pour le stepper (défaut : le titre). */
  short?: string
  /** Contenu de l'étape. */
  render: () => ReactNode
}

interface WizardProps {
  steps: WizardStep[]
  /** Index de l'étape courante (0-based). */
  current: number
  /** Demande d'aller à l'étape précédente. */
  onBack: () => void
  /** Demande d'aller à l'étape suivante. */
  onNext: () => void
  /** Action de fin (sur la dernière étape). */
  onFinish: () => void
  /** Action « passer » l'onboarding (optionnelle). */
  onSkip?: () => void
  /** Libellé du bouton « suivant » (peut varier selon l'étape). */
  nextLabel?: string
  /** Désactive le bouton suivant/terminer (étape incomplète, chargement…). */
  nextDisabled?: boolean
}

export function Wizard({ steps, current, onBack, onNext, onFinish, onSkip, nextLabel, nextDisabled }: WizardProps) {
  const { t } = useT()
  const step = steps[current]
  const isFirst = current === 0
  const isLast = current === steps.length - 1
  if (!step) return null

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {/* Stepper : numéro + libellé court (le libellé disparaît sous 640 px, le numéro reste). */}
        <ol className="flex items-center gap-1 sm:gap-2" aria-label={t('wizard.stepsLabel')}>
          {steps.map((s, i) => {
            const done = i < current
            const active = i === current
            return (
              <li key={s.id} className="flex min-w-0 items-center gap-1.5 sm:gap-2" aria-current={active ? 'step' : undefined}>
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    done && 'bg-primary text-primary-foreground',
                    active && 'bg-primary/10 text-primary ring-2 ring-primary',
                    !done && !active && 'bg-muted text-muted-foreground',
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn('hidden truncate text-xs sm:inline', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  {s.short ?? s.title}
                </span>
                {i < steps.length - 1 && <span className="mx-0.5 h-px w-3 shrink-0 bg-border sm:w-5" aria-hidden="true" />}
              </li>
            )
          })}
        </ol>
        <Progress value={((current + 1) / steps.length) * 100} aria-label={t('wizard.progress', { current: current + 1, total: steps.length })} />
        <p className="text-xs text-muted-foreground">{t('wizard.progress', { current: current + 1, total: steps.length })}</p>
      </div>

      <h1 className="text-xl font-semibold tracking-tight">{step.title}</h1>
      <div className="flex flex-col gap-3 text-sm">{step.render()}</div>

      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <div>
          {!isFirst && (
            <Button type="button" variant="ghost" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              {t('wizard.back')}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onSkip && !isLast && (
            <Button type="button" variant="ghost" onClick={onSkip}>
              {t('wizard.skip')}
            </Button>
          )}
          <Button type="button" disabled={nextDisabled} onClick={isLast ? onFinish : onNext}>
            {nextLabel ?? (isLast ? t('wizard.finish') : t('wizard.continue'))}
            {!isLast && <ArrowRight aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
