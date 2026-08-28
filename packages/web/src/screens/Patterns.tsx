/**
 * Récurrences — « Memoria a remarqué que… ». Les choses que tu dis/fais de
 * façon récurrente, repérées et regroupées. Tu confirmes (Memoria en fait un
 * souvenir consolidé) ou tu écartes. Rien n'est appliqué sans ton accord.
 *
 * Migré sur shadcn : PageHeader (sélecteur d'agent), SectionCard, une carte
 * par récurrence (badge de type, occurrences, confiance, fait canonique en
 * citation), Consolider / Écarter (AlertDialog), toasts, squelette, états
 * vide / erreur — voir UI-GUIDE.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, Repeat, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, decidePattern, getPatterns, type Pattern } from '../api'
import { useAnalyzableAgents } from '../components/CogAgentSelect'
import { MemAgentPicker, MemNoAgentState } from '../components/MemAgentSelect'
import { CogConfirmButton } from '../components/CogConfirm'
import { EmptyState, ErrorBanner, PageHeader, SectionCard, formatNumber, humanError, listPhase } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const KIND_KEY: Record<string, string> = {
  preference: 'patterns.kind_preference',
  habit: 'patterns.kind_habit',
  convention: 'patterns.kind_convention',
  fact: 'patterns.kind_fact',
}

/** Libellé traduit du type de récurrence (repli sur « Récurrence »). */
function kindLabel(t: Translate, kind: string): string {
  return t(KIND_KEY[kind] ?? 'patterns.kind_default')
}

/** Confiance en pourcentage entier (le moteur donne un ratio 0–1). */
function confidencePercent(confidence: number): number {
  const pct = confidence <= 1 ? confidence * 100 : confidence
  return Math.max(0, Math.min(100, Math.round(pct)))
}

export function Patterns() {
  const { t } = useT()
  const ag = useAnalyzableAgents()
  const [patterns, setPatterns] = useState<Pattern[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Identifiant de la récurrence en cours de décision (spinner sur SON bouton).
  const [busyId, setBusyId] = useState<string | null>(null)
  // Instance dont on attend la liste : un résultat arrivé après un changement
  // d'agent est ignoré (sinon la liste de l'ancien agent s'affichait).
  const wanted = useRef('')

  const load = useCallback(async (inst: string, silent = false) => {
    wanted.current = inst
    if (!silent) setPatterns(null)
    try {
      const list = await getPatterns(inst)
      if (wanted.current === inst) setPatterns(list)
    } catch (err) {
      if (wanted.current !== inst) return
      // 404 = vieux service sans la route : état vide, pas une panne.
      if (err instanceof ApiError && err.status === 404) setPatterns([])
      else setError(err instanceof ApiError ? err.message : humanError(err))
    }
  }, [])

  useEffect(() => {
    if (!ag.instance) return
    setError(null)
    void load(ag.instance)
  }, [ag.instance, ag.tick, load])

  const decide = useCallback(
    async (p: Pattern, decision: 'accept' | 'dismiss') => {
      setBusyId(p.id)
      try {
        await decidePattern(ag.instance, p.id, decision)
        // La carte disparaît tout de suite ; la liste est resynchronisée sans
        // repasser par le squelette.
        setPatterns(cur => (cur ? cur.filter(x => x.id !== p.id) : cur))
        toast.success(t(decision === 'accept' ? 'patterns.consolidated_toast' : 'patterns.dismissed_toast'))
        await load(ag.instance, true)
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : t('patterns.action_failed'))
      } finally {
        setBusyId(null)
      }
    },
    [ag.instance, load, t],
  )

  const phase = listPhase(patterns, error)
  const bannerError = ag.error ?? error

  return (
    <>
      <PageHeader
        title={t('patterns.title')}
        description={t('patterns.lead')}
      >
        {/* Le sélecteur d'agent vit ICI sur les six écrans par agent : sous la
            phrase d'intro, jamais dans la barre supérieure (à 390 px il y
            écrasait le titre de l'écran). */}
        <MemAgentPicker id="patterns-agent" agents={ag.agents} value={ag.instance} onChange={ag.setInstance} />
      </PageHeader>

      {bannerError && <ErrorBanner message={bannerError} onRetry={ag.retry} />}

      {ag.noAgent ? (
        <MemNoAgentState className="mx-auto w-full max-w-xl sm:py-8" />
      ) : phase === 'loading' ? (
        <PatternsSkeleton />
      ) : phase === 'failed' || patterns === null ? null : patterns.length === 0 ? (
        <EmptyState icon={<Repeat className="size-5" />} title={t('patterns.empty_title')} body={t('patterns.empty_body')} className="mx-auto w-full max-w-xl sm:py-8" />
      ) : (
        <SectionCard
          title={t('patterns.list_title')}
          description={t('patterns.list_hint')}
          actions={<Badge variant="secondary" className="tabular-nums">{formatNumber(patterns.length)}</Badge>}
          className="mb-0"
          contentClassName="grid gap-3 md:grid-cols-2"
        >
          {patterns.map(p => (
            <PatternCard key={p.id} pattern={p} busy={busyId !== null} acting={busyId === p.id} onDecide={decision => void decide(p, decision)} />
          ))}
        </SectionCard>
      )}
    </>
  )
}

/** Squelette : l'analyse à la demande peut prendre une seconde, la page garde sa forme. */
function PatternsSkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={t('patterns.analyzing')}>
      <Skeleton className="h-10 w-full rounded-xl" />
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map(i => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

function PatternCard({
  pattern,
  busy,
  acting,
  onDecide,
}: {
  pattern: Pattern
  /** Une décision est en cours quelque part : on bloque toutes les cartes. */
  busy: boolean
  /** C'est CETTE carte qui attend sa décision. */
  acting: boolean
  onDecide: (decision: 'accept' | 'dismiss') => void
}) {
  const { t } = useT()
  return (
    <Card size="sm" className="bg-muted/40 ring-0">
      <CardContent className="flex h-full flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge>{kindLabel(t, pattern.kind)}</Badge>
          <span>{t('patterns.seen_times', { count: formatNumber(pattern.occurrences) })}</span>
          <span aria-hidden="true">·</span>
          <span>{t('patterns.confidence', { percent: confidencePercent(pattern.confidence) })}</span>
        </div>
        <p className="leading-snug font-medium">{pattern.label}</p>
        <blockquote className="border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">{pattern.canonical_fact}</blockquote>
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onDecide('accept')} data-testid="pattern-accept">
            {acting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check className="text-success" aria-hidden="true" />}
            {t('patterns.consolidate')}
          </Button>
          <CogConfirmButton
            variant="ghost"
            size="sm"
            icon={<X aria-hidden="true" />}
            label={t('patterns.dismiss')}
            title={t('patterns.dismiss_title')}
            description={t('patterns.dismiss_body')}
            confirmLabel={t('patterns.dismiss')}
            disabled={busy}
            onConfirm={() => onDecide('dismiss')}
            testId="pattern-dismiss"
          />
        </div>
      </CardContent>
    </Card>
  )
}
