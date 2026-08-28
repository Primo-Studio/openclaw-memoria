/**
 * Point d'entrée UNIQUE des primitives d'écran + helpers d'affichage.
 *
 * Les composants sont construits sur shadcn/ui (src/components/ui/*) : un
 * écran n'importe que d'ici (Spinner, ErrorBanner, EmptyState, ConfirmButton,
 * CopyButton, PageHeader, StatCard, DataTable, SectionCard) et, au besoin,
 * les briques shadcn elles-mêmes (Button, Card, Badge…). Voir UI-GUIDE.md.
 * Les helpers (formatage, humanError, useLoad, listPhase) sont inchangés.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, CircleAlert, Copy, Inbox, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '../api'
import { currentLocale, translate, useT } from '../i18n'
import { useShellSlots } from '../app/shell-context'
import { cn } from '../lib/utils'
import { Alert, AlertAction, AlertDescription, AlertTitle } from './ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog'
import { Button, type buttonVariants } from './ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
// Ré-exporté plus bas : les écrans n'importent QUE depuis ce fichier.
import { DataCards, type CardField } from './DataCards'
import type { VariantProps } from 'class-variance-authority'

// ------------------------------------------------------------------- helpers

// Formateurs Intl mis en cache par locale : en construire un à chaque rendu de
// ligne de tableau coûte cher, et la locale ne change qu'au choix de langue.
const dateFmts = new Map<string, Intl.DateTimeFormat>()
const dayFmts = new Map<string, Intl.DateTimeFormat>()
const numFmts = new Map<string, Intl.NumberFormat>()
const compactFmts = new Map<string, Intl.NumberFormat>()
const decimalFmts = new Map<string, Intl.NumberFormat>()

function cached<T>(cache: Map<string, T>, make: (locale: string) => T, variant = 0): T {
  const locale = currentLocale()
  const key = variant === 0 ? locale : `${locale}#${variant}`
  let fmt = cache.get(key)
  if (!fmt) {
    fmt = make(locale)
    cache.set(key, fmt)
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

/** Décimal à `digits` chiffres fixes dans la langue active (« 1,2 » / « 1.2 »). */
export function formatDecimal(n: number, digits: number): string {
  return cached(decimalFmts, l => new Intl.NumberFormat(l, { minimumFractionDigits: digits, maximumFractionDigits: digits }), digits).format(n)
}

/** Nombre compact (« 1,6 k » / « 1.6K ») — pour des volumes, pas des comptes exacts. */
export function formatCompact(n: number): string {
  return cached(compactFmts, l => new Intl.NumberFormat(l, { notation: 'compact', maximumFractionDigits: 1 })).format(n)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return translate('units.bytes', { n: formatNumber(bytes) })
  if (bytes < 1024 * 1024) return translate('units.kb', { n: formatNumber(Math.round(bytes / 1024)) })
  return translate('units.mb', { n: formatDecimal(bytes / (1024 * 1024), 1) })
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

/** Indicateur de chargement en ligne (role=status pour les lecteurs d'écran). */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  const { t } = useT()
  return (
    <div className={cn('flex items-center gap-2 py-2 text-sm text-muted-foreground', className)} role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  )
}

/** Erreur visible (jamais de mort silencieuse) + « Réessayer » si l'appelant sait relancer. */
export function ErrorBanner({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  const { t } = useT()
  return (
    <Alert variant="destructive" className={cn('my-3', className)}>
      <CircleAlert />
      <AlertTitle>{message}</AlertTitle>
      {onRetry && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

/** État vide : titre, explication, action facultative — centré, jamais un tableau vide muet. */
export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: string
  body?: string
  action?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  // POURQUOI `mx-auto max-w-xl` : sans borne, l'état vide s'étirait sur toute la
  // largeur du contenu (990 px sur bureau) — une grande boîte pâle et vide, qui
  // pèse plus lourd à l'écran que ce qu'elle a à dire. Bornée, elle se lit
  // comme un message, pas comme une zone de contenu manquante.
  return (
    <div className={cn('mx-auto flex w-full max-w-xl flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center', className)}>
      <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
        {icon ?? <Inbox className="size-5" />}
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/**
 * Copie dans le presse-papiers avec retour visuel (toast) ; l'échec est
 * visible aussi. Le timer de retour à l'icône « copier » est nettoyé au
 * démontage, et `mounted` est remis à true dans le setup de l'effet (sous
 * <StrictMode>, React 19 joue setup → cleanup → setup au montage).
 */
export function CopyButton({
  text,
  label,
  variant = 'outline',
  size = 'sm',
  className,
}: {
  text: string
  label?: string
  variant?: VariantProps<typeof buttonVariants>['variant']
  size?: VariantProps<typeof buttonVariants>['size']
  className?: string
}) {
  const { t } = useT()
  const [done, setDone] = useState(false)
  const timer = useRef<number | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const copy = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    navigator.clipboard.writeText(text).then(
      () => {
        toast.success(t('common.copied'))
        if (!mounted.current) return
        setDone(true)
        timer.current = window.setTimeout(() => setDone(false), 2000)
      },
      (err: unknown) => {
        console.warn('memoria-ui : copie presse-papiers refusée', err)
        toast.error(t('common.copy_failed'))
      },
    )
  }

  return (
    <Button type="button" variant={variant} size={size} className={className} onClick={copy}>
      {done ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {label ?? t('common.copy')}
    </Button>
  )
}

/**
 * Bouton à confirmation : ouvre une boîte de dialogue modale (AlertDialog)
 * au lieu de l'ancien double-clic armé 4 s — plus lisible pour un
 * non-technicien, et l'action destructrice est nommée deux fois.
 * `variant`/`size` stylent le bouton déclencheur ; l'action de confirmation
 * est toujours en style destructif.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled = false,
  title,
  description,
  variant = 'outline',
  size = 'sm',
  className,
}: {
  label: string
  confirmLabel?: string
  onConfirm: () => void
  disabled?: boolean
  /** Titre de la boîte (défaut : le libellé du bouton). */
  title?: string
  /** Explication (défaut : « action immédiate, irréversible »). */
  description?: string
  variant?: VariantProps<typeof buttonVariants>['variant']
  size?: VariantProps<typeof buttonVariants>['size']
  className?: string
}) {
  const { t } = useT()
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant={variant} size={size} className={className} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? label}</AlertDialogTitle>
          <AlertDialogDescription>{description ?? t('confirm.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel ?? t('common.confirm_action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * En-tête d'écran : titre (h1) + actions, PROJETÉS dans la barre supérieure
 * de la coquille (voir app/shell-context.ts). `description` et `children`
 * restent dans le flux, sous la barre. Hors coquille : rendu en ligne.
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string
  /** Phrase d'introduction. `ReactNode` et non `string` : certaines intros
   *  mettent un mot en gras — sans quoi l'écran est obligé de rendre son
   *  paragraphe lui-même en `children`, et il repasse APRÈS les actions. */
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  const slots = useShellSlots()
  // POURQUOI les actions quittent la barre supérieure sous 768 px : à 390 px, la
  // barre doit déjà porter le menu, la marque, le mode de capture et les
  // préférences. Avec « Actualiser » en plus, c'est le TITRE qui était rogné —
  // « Tableau de bord » devenait « T… », et on ne savait plus où on est. Les
  // actions descendent donc en tête de page, alignées à droite : elles restent
  // au premier écran, à portée de pouce, et la barre garde le titre entier.
  const compact = useMatchMedia('(max-width: 767.98px)')
  const titleNode = <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
  const actionsNode = actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null
  const inline = !slots
  const actionsInPage = actionsNode && (inline || compact)
  return (
    <>
      {slots?.titleEl && createPortal(titleNode, slots.titleEl)}
      {slots?.actionsEl && actionsNode && !compact && createPortal(actionsNode, slots.actionsEl)}
      {inline && <div className="mb-4">{titleNode}</div>}
      {/*
        POURQUOI la description AVANT les actions : quand les actions descendent
        en page (téléphone), les mettre en premier ouvrait chaque écran sur un
        bouton seul, calé à droite dans une bande à moitié vide, et repoussait
        sous la ligne de flottaison la phrase qui explique à quoi sert l'écran.
        On dit d'abord de quoi il s'agit, on propose d'agir ensuite.
      */}
      {description && <p className="mb-4 text-sm text-muted-foreground">{description}</p>}
      {actionsInPage && <div className="mb-4">{actionsNode}</div>}
      {children}
    </>
  )
}

/** Chiffre clé : valeur, libellé, aide, tonalité (warn = attention, ok = sain, danger = alerte). */
export function StatCard({
  value,
  label,
  hint,
  tone = 'default',
  icon,
  className,
}: {
  value: number | string
  label: string
  hint?: string
  tone?: 'default' | 'ok' | 'warn' | 'danger'
  icon?: ReactNode
  className?: string
}) {
  const toneClass = {
    default: 'text-foreground',
    ok: 'text-success',
    warn: 'text-warning',
    danger: 'text-destructive',
  }[tone]
  return (
    <Card size="sm" className={cn('gap-1', className)}>
      <CardContent className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/*
            UN SEUL dessin, partout : chiffre, libellé, aide, pastille d'icône
            facultative à droite. VARIANTE COMPACTE sous 640 px — le chiffre et
            son libellé passent sur la même ligne de base : en pleine largeur
            (écran Système), une tuile empilée mangeait 100 px de haut pour dire
            « 24 couches ». Compactée, elle en prend deux fois moins et l'écran
            reste lisible sans faire défiler.
          */}
          <div className="max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-2">
            <div className={cn('text-2xl font-semibold tabular-nums tracking-tight max-sm:text-xl', toneClass)}>
              {typeof value === 'number' ? formatNumber(value) : value}
            </div>
            <div className="mt-0.5 text-sm font-medium max-sm:mt-0">{label}</div>
          </div>
          {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
        </div>
        {icon && (
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md bg-muted', toneClass)} aria-hidden="true">
            {icon}
          </span>
        )}
      </CardContent>
    </Card>
  )
}

/** Bloc de contenu titré (Card) : titre, description, actions à droite, contenu. */
export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={cn('mb-4', className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {actions && <CardAction className="flex items-center gap-2">{actions}</CardAction>}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  )
}

// --------------------------------------------------------------- DataTable

export interface DataColumn<T> {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** En-tête cliquable (bouton) ; le tri lui-même est fait par l'appelant (onSort). */
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  className?: string
}

export interface DataSort {
  by: string
  dir: 'asc' | 'desc'
}

/**
 * Media query réactive. On S'ABONNE au changement plutôt que de mesurer une
 * fois : faire pivoter le téléphone doit suffire à repasser d'une forme à
 * l'autre. (Les bornes reprennent celles de Tailwind : sm = 640, md = 768.)
 */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches))
  useEffect(() => {
    const mq = window.matchMedia(query)
    const sync = () => setMatches(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return matches
}

/** Fenêtre étroite : sous la borne `sm` (640 px) — un téléphone, en pratique. */
export function useIsNarrow(): boolean {
  return useMatchMedia('(max-width: 639.98px)')
}

/**
 * Tableau de données : en-têtes triables = de vrais boutons (clavier, lecteur
 * d'écran, `aria-sort`), défilement horizontal signalé (voir `scroll-shadow-x`
 * dans index.css), état vide explicite. Le tri reste à l'appelant.
 *
 * SOUS 640 px, PAR DÉFAUT : une fiche par ligne au lieu du tableau.
 * POURQUOI : un tableau de 5 colonnes dans une carte de 326 px était coupé au
 * bord — sur Partage, deux agents sur trois n'existaient plus à l'écran ; sur
 * le Journal, la colonne « Action » était tranchée en plein mot. C'était le
 * défaut le plus grave de la revue mobile, et il revenait sur chaque nouvel
 * écran parce que chaque écran devait y penser. Il est donc réglé ICI, une
 * fois : un écran doit désormais demander explicitement `mobile="table"` pour
 * retrouver le tableau rogné.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  empty,
  dense = false,
  mobile = 'cards',
  className,
}: {
  columns: DataColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  sort?: DataSort
  onSort?: (next: DataSort) => void
  /** Contenu affiché quand `rows` est vide (défaut : « Aucune donnée »). */
  empty?: ReactNode
  dense?: boolean
  /** Forme sous 640 px : fiches (défaut) ou tableau défilant. */
  mobile?: 'cards' | 'table'
  className?: string
}) {
  const { t } = useT()
  const narrow = useIsNarrow()
  const alignClass = (a?: DataColumn<T>['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left')
  const toggle = (col: DataColumn<T>) => {
    if (!onSort) return
    const dir = sort?.by === col.id && sort.dir === 'asc' ? 'desc' : 'asc'
    onSort({ by: col.id, dir })
  }

  // Fiches : la première colonne identifie la ligne (titre), les autres
  // deviennent des paires libellé / valeur — donc AUCUNE colonne ne disparaît.
  const [first, ...rest] = columns
  if (narrow && mobile === 'cards' && first) {
    if (rows.length === 0) {
      return <p className="py-4 text-center text-sm text-muted-foreground">{empty ?? t('table.empty')}</p>
    }
    return (
      <DataCards
        rows={rows}
        rowKey={rowKey}
        className={className}
        title={row => first.cell(row)}
        fields={row => rest.map(col => ({ key: col.id, label: col.header, value: col.cell(row) }))}
      />
    )
  }

  return (
    <Table className={className}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map(col => {
            const active = sort?.by === col.id
            const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
            const label = typeof col.header === 'string' ? col.header : col.id
            return (
              <TableHead key={col.id} aria-sort={ariaSort} className={cn(alignClass(col.align), col.className)}>
                {col.sortable && onSort ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    // Plancher tactile explicite : `h-8` battrait la hauteur `sm` du
                    // variant, il faut donc re-poser le `max-sm:` ici.
                    className={cn('-ml-2 h-8 max-sm:h-11 gap-1 px-2 font-medium', active && 'text-primary')}
                    onClick={() => toggle(col)}
                    aria-label={t('table.sort', { column: label })}
                  >
                    {col.header}
                    {active ? (
                      sort.dir === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />
                    ) : (
                      <ArrowUpDown className="opacity-50" aria-hidden="true" />
                    )}
                  </Button>
                ) : (
                  col.header
                )}
              </TableHead>
            )
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns.length} className="py-6 text-center text-muted-foreground">
              {empty ?? t('table.empty')}
            </TableCell>
          </TableRow>
        ) : (
          rows.map(row => (
            <TableRow key={rowKey(row)}>
              {columns.map(col => (
                <TableCell key={col.id} className={cn(alignClass(col.align), dense && 'py-1', col.className)}>
                  {col.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

// Ré-export : un écran qui a besoin de la forme « fiches » hors DataTable
// (liste maison, colonnes composites) l'importe depuis ce fichier.
export { DataCards, type CardField }
