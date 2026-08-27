/**
 * Petits composants partagés + helpers d'affichage.
 * Volontairement légers : pas de framework UI, juste du CSS maison.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../api'
import { currentLocale, translate, useT } from '../i18n'

// ------------------------------------------------------------------- helpers

// Formateurs Intl mis en cache par locale : en construire un à chaque rendu de
// ligne de tableau coûte cher, et la locale ne change qu'au choix de langue.
const dateFmts = new Map<string, Intl.DateTimeFormat>()
const dayFmts = new Map<string, Intl.DateTimeFormat>()
const numFmts = new Map<string, Intl.NumberFormat>()
const compactFmts = new Map<string, Intl.NumberFormat>()

function cached<T>(cache: Map<string, T>, make: (locale: string) => T): T {
  const locale = currentLocale()
  let fmt = cache.get(locale)
  if (!fmt) {
    fmt = make(locale)
    cache.set(locale, fmt)
  }
  return fmt
}

/** Date + heure dans la langue de l'interface (avant : locale française figée). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : cached(dateFmts, l => new Intl.DateTimeFormat(l, { dateStyle: 'medium', timeStyle: 'short' })).format(d)
}

/** Date seule (jour), même règle de locale. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : cached(dayFmts, l => new Intl.DateTimeFormat(l, { dateStyle: 'medium' })).format(d)
}

/** Entier avec séparateurs de milliers de la langue active. */
export function formatNumber(n: number): string {
  return cached(numFmts, l => new Intl.NumberFormat(l, { maximumFractionDigits: 0 })).format(n)
}

/** Nombre compact (« 1,6 k » / « 1.6K ») — pour des volumes, pas des comptes exacts. */
export function formatCompact(n: number): string {
  return cached(compactFmts, l => new Intl.NumberFormat(l, { notation: 'compact', maximumFractionDigits: 1 })).format(n)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return translate('units.bytes', { n: formatNumber(bytes) })
  if (bytes < 1024 * 1024) return translate('units.kb', { n: formatNumber(Math.round(bytes / 1024)) })
  const mb = bytes / (1024 * 1024)
  return translate('units.mb', {
    n: new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(mb),
  })
}

// Libellés de marque (invariants) ; les types « génériques » passent par l'i18n.
const AGENT_TYPE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  cursor: 'Cursor',
  robot: 'Robot',
}

/** Libellé d'un type d'agent — UNE seule table pour tous les écrans. */
export function agentTypeLabel(type: string): string {
  if (type === 'generic') return translate('agent.generic')
  // Le daemon étiquette « partagé » les faits de l'espace commun (recherche globale).
  if (type === 'partagé' || type === 'shared') return translate('agent.shared')
  return AGENT_TYPE_LABELS[type] ?? type
}

// Noms de fournisseurs de modèles (marques, invariants).
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

/** Traduit une erreur technique en message lisible — jamais de jargon brut. */
export function humanError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return translate('error.session_expired')
    if (err.status === 404) return translate('error.not_available')
    return err.message
  }
  if (err instanceof TypeError) {
    return translate('error.no_response')
  }
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------- chargement

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

/**
 * Hook de chargement standard : loading → ready | error (+ reload).
 * Toute erreur est loggée ET affichée — pas de mort silencieuse.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): {
  state: LoadState<T>
  reload: () => void
} {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    loaderRef.current().then(
      data => {
        if (!cancelled) setState({ status: 'ready', data })
      },
      (err: unknown) => {
        if (cancelled) return
        console.warn('memoria-ui : chargement échoué', err)
        setState({ status: 'error', message: humanError(err) })
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps maîtrisées par l'appelant
  }, [tick, ...deps])

  return { state, reload: () => setTick(t => t + 1) }
}

/**
 * Phase d'affichage d'une liste chargée « à la main » (items null = pas encore
 * reçu). Sans ça, un échec du premier chargement laissait items à null → le
 * spinner « Chargement… » tournait pour toujours SOUS la bannière d'erreur.
 */
export type ListPhase = 'loading' | 'failed' | 'empty' | 'ready'

export function listPhase<T>(items: readonly T[] | null, error: string | null): ListPhase {
  if (items === null) return error ? 'failed' : 'loading'
  return items.length === 0 ? 'empty' : 'ready'
}

// --------------------------------------------------------------- composants

export function Spinner({ label }: { label?: string }) {
  const { t } = useT()
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label ?? t('common.loading')}</span>
    </div>
  )
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useT()
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  )
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {body && <p className="muted">{body}</p>}
      {action}
    </div>
  )
}

/**
 * Copie dans le presse-papiers avec retour visuel ; l'échec est visible aussi.
 * Le retour à « idle » n'est armé qu'APRÈS la réponse du presse-papiers (sinon
 * un « Échec » tardif pouvait ne jamais s'afficher) et le timer est nettoyé
 * au démontage (pas de setState sur composant démonté).
 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useT()
  const [feedback, setFeedback] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<number | null>(null)
  const mounted = useRef(true)

  useEffect(
    () => () => {
      mounted.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    navigator.clipboard
      .writeText(text)
      .then(
        () => 'done' as const,
        (err: unknown) => {
          console.warn('memoria-ui : copie presse-papiers refusée', err)
          return 'failed' as const
        },
      )
      .then(result => {
        if (!mounted.current) return
        setFeedback(result)
        timer.current = window.setTimeout(() => setFeedback('idle'), 2000)
      })
  }

  return (
    <button type="button" className="btn btn-ghost" onClick={copy}>
      {feedback === 'done' ? t('common.copied') : feedback === 'failed' ? t('common.copy_failed') : (label ?? t('common.copy'))}
    </button>
  )
}

/**
 * Bouton à confirmation en deux temps (pas de window.confirm) :
 * 1er clic = armé pendant 4 s, 2e clic = action.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled = false,
}: {
  label: string
  confirmLabel?: string
  onConfirm: () => void
  disabled?: boolean
}) {
  const { t } = useT()
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const click = () => {
    if (!armed) {
      setArmed(true)
      timer.current = window.setTimeout(() => setArmed(false), 4000)
      return
    }
    if (timer.current !== null) window.clearTimeout(timer.current)
    setArmed(false)
    onConfirm()
  }

  return (
    <button type="button" className={`btn ${armed ? 'btn-danger' : 'btn-ghost'}`} onClick={click} disabled={disabled}>
      {armed ? (confirmLabel ?? t('common.confirm')) : label}
    </button>
  )
}
