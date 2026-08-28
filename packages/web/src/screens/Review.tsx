/**
 * Revue — souvenirs en attente (mode « revue d'abord » et imports en
 * quarantaine) : approuver = le souvenir devient actif, rejeter = effacé
 * définitivement. Tant qu'un souvenir attend ici, aucun agent ne le voit.
 *
 * Écran migré sur shadcn : PageHeader (Actualiser dans la barre supérieure ;
 * « Tout approuver » / « Tout rejeter » en tête de liste, où il y a la place
 * sur mobile), cartes MemFactCard avec case à cocher,
 * barre de sélection collante pour traiter un lot, AlertDialog avant tout
 * rejet (c'est un effacement), toasts, trois états (chargement / erreur /
 * vide). Mêmes appels : GET /v1/admin/review, POST /v1/admin/review/<décision>.
 *
 * HIÉRARCHIE DES ACTIONS (une seule action pleine à l'écran) : « Tout
 * approuver » (les six d'un coup) est le seul bouton orange plein ;
 * l'« Approuver » d'une ligne est un contour ; « Rejeter » reste discret mais
 * rouge. Ce qui sépare « ce souvenir » de « les six », c'est le poids visuel,
 * jamais l'apparition ou la disparition d'un bouton.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, CheckSquare, ClipboardCheck, Sparkles, Square } from 'lucide-react'
import { toast } from 'sonner'
import { getReview, reviewDecision, type ReviewItem } from '../api'
import { MemFactCard, MemMetaText } from '../components/MemFactCard'
import { MemListCount } from '../components/MemListCount'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { MemSelectionBar } from '../components/MemSelectionBar'
import { ConfirmButton, EmptyState, ErrorBanner, PageHeader, formatDate, humanError, listPhase } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { categoryLabel, splitTopics } from '../lib/labels'
import { TOUCH_ROW_ACTION } from '../lib/touch'
import { cn } from '../lib/utils'

type Decision = 'approve' | 'reject'

export function Review() {
  const { t } = useT()
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      setItems(await getReview())
      setError(null)
    } catch (err) {
      console.warn('memoria-ui : revue illisible', err)
      setError(humanError(err))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // La sélection ne garde que les souvenirs encore en attente après un rechargement.
  useEffect(() => {
    if (items === null) return
    const visible = new Set(items.map(i => i.id))
    setSelected(prev => {
      const next = new Set([...prev].filter(id => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  const decide = useCallback(
    async (ids: string[], decision: Decision) => {
      if (ids.length === 0) return
      setBusy(true)
      try {
        const updated = await reviewDecision(ids, decision)
        toast.success(
          decision === 'approve'
            ? updated > 1
              ? t('review.approved_plural', { count: updated })
              : t('review.approved')
            : updated > 1
              ? t('review.rejected_plural', { count: updated })
              : t('review.rejected'),
        )
        await refresh()
      } catch (err) {
        // L'échec d'une décision ne remplace pas la liste par une bannière :
        // les souvenirs sont toujours en attente, on le dit en toast.
        console.warn('memoria-ui : décision de revue refusée', err)
        toast.error(t('review.action_failed_detail', { message: humanError(err) }))
      } finally {
        setBusy(false)
      }
    },
    [refresh, t],
  )

  const phase = listPhase(items, error)
  const list = items ?? []
  const allSelected = list.length > 0 && list.every(i => selected.has(i.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map(i => i.id)))
  const setOne = (id: string, on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <>
      <PageHeader
        title={t('review.title')}
        description={t('review.lead')}
        actions={<MemRefreshButton label={t('common.refresh')} onClick={() => void refresh()} disabled={refreshing || busy} spinning={refreshing} />}
      />

      <MemSelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" className={TOUCH_ROW_ACTION} disabled={busy} onClick={() => void decide([...selected], 'approve')}>
          <Check aria-hidden="true" />
          {t('review.approve_selected')}
        </Button>
        <ConfirmButton
          variant="destructive"
          className={TOUCH_ROW_ACTION}
          label={t('review.reject_selected')}
          title={selected.size > 1 ? t('review.reject_selected_title', { count: selected.size }) : t('review.reject_one_title')}
          description={t('review.reject_body')}
          confirmLabel={t('review.reject_confirm')}
          disabled={busy}
          onConfirm={() => void decide([...selected], 'reject')}
        />
      </MemSelectionBar>

      {phase === 'loading' && <ReviewSkeleton />}
      {phase === 'failed' && error && <ErrorBanner message={error} onRetry={() => void refresh()} />}
      {phase === 'empty' && (
        <EmptyState icon={<Sparkles className="size-5" />} title={t('review.empty_title')} body={t('review.empty_body')} />
      )}
      {phase === 'ready' && (
        <section aria-label={t('review.list_label')}>
          {/* Une erreur de rechargement laisse la dernière liste connue visible, avec la bannière au-dessus. */}
          {error && <ErrorBanner message={error} onRetry={() => void refresh()} />}
          <MemListCount label={list.length > 1 ? t('fact.count_plural', { count: list.length }) : t('fact.count', { count: list.length })}>
            {/* Actions de masse ici, pas dans la barre supérieure : à 390 px elles y écrasaient le titre.
                `w-full … justify-end sm:w-auto` : au retour à la ligne sous 640 px, le groupe prend
                toute la largeur et reste aligné sur le MÊME axe droit — sinon « Tout rejeter »
                retombait seul à gauche, ce qui se lisait comme un bug de mise en page. */}
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
              <Button type="button" variant="ghost" size="sm" className={TOUCH_ROW_ACTION} onClick={toggleAll} disabled={busy}>
                {allSelected ? <Square aria-hidden="true" /> : <CheckSquare aria-hidden="true" />}
                {allSelected ? t('selection.unselect_all') : t('selection.select_all')}
              </Button>
              {/* Ces actions restent visibles même pendant une sélection : « Tout
                  approuver (6) » et « Approuver la sélection (2) » ne font PAS la même
                  chose, et faire disparaître une rangée de boutons au premier clic sur
                  une case ferait sauter la liste sous le doigt. La distinction se joue
                  sur le poids visuel (plein vs contour), pas sur l'apparition. */}
              {list.length > 1 && (
                <>
                  <Button size="sm" className={TOUCH_ROW_ACTION} disabled={busy} onClick={() => void decide(list.map(i => i.id), 'approve')}>
                    <Check aria-hidden="true" />
                    {t('review.approve_all', { count: list.length })}
                  </Button>
                  <ConfirmButton
                    variant="destructive"
                    className={TOUCH_ROW_ACTION}
                    label={t('review.reject_all')}
                    title={t('review.reject_all_confirm', { count: list.length })}
                    description={t('review.reject_body')}
                    confirmLabel={t('review.reject_confirm')}
                    disabled={busy}
                    onConfirm={() => void decide(list.map(i => i.id), 'reject')}
                  />
                </>
              )}
            </div>
          </MemListCount>
          <ul className="flex flex-col gap-3">
            {list.map(item => {
              const topics = splitTopics(item.topics)
              return (
              <li key={item.id}>
                <MemFactCard
                  selected={selected.has(item.id)}
                  onSelectedChange={on => setOne(item.id, on)}
                  selectLabel={t('selection.select')}
                  disabled={busy}
                  meta={
                    <>
                      {topics.shown.map(topic => (
                        <Badge key={topic} variant="outline" title={t('review.badge_topic_title')}>
                          {topic}
                        </Badge>
                      ))}
                      {topics.hidden.length > 0 && (
                        <Badge variant="outline" title={t('fact.topics_more_title', { list: topics.hidden.join(', ') })}>
                          {t('fact.topics_more', { count: topics.hidden.length })}
                        </Badge>
                      )}
                      {/* La catégorie vient de la base en anglais (« general », « decision ») :
                          on l'affiche traduite, sans jamais inventer de mot pour une valeur inconnue. */}
                      <Badge variant="secondary">{categoryLabel(t, item.category)}</Badge>
                      <Badge variant="outline">{item.source_type === 'capture-review' ? t('review.source_capture') : t('review.source_import')}</Badge>
                      {/* Confiance et date dans UNE seule rangée de métadonnées :
                          deux MemMetaText pleine largeur feraient deux lignes sous 640 px. */}
                      <MemMetaText>
                        {t('review.confidence', { percent: (item.confidence * 100).toFixed(0) })}
                        {' · '}
                        {formatDate(item.created_at)}
                      </MemMetaText>
                    </>
                  }
                  actions={
                    <>
                      {/* Contour, pas orange plein : le seul bloc plein de l'écran est
                          « Tout approuver », l'action de masse. Six « Approuver » pleins
                          en colonne à droite écrasaient les souvenirs à juger, et rien
                          ne distinguait plus « ce souvenir » de « les six ». */}
                      <Button variant="outline" size="sm" className={TOUCH_ROW_ACTION} disabled={busy} onClick={() => void decide([item.id], 'approve')}>
                        <Check aria-hidden="true" />
                        {t('review.approve')}
                      </Button>
                      <ConfirmButton
                        variant="ghost"
                        className={cn('text-destructive hover:text-destructive', TOUCH_ROW_ACTION)}
                        label={t('review.reject')}
                        title={t('review.reject_one_title')}
                        description={t('review.reject_body')}
                        confirmLabel={t('review.reject_confirm')}
                        disabled={busy}
                        onConfirm={() => void decide([item.id], 'reject')}
                      />
                    </>
                  }
                >
                  {item.content}
                </MemFactCard>
              </li>
              )
            })}
          </ul>
        </section>
      )}
    </>
  )
}

/** Squelette : trois cartes à la forme des souvenirs en attente. */
function ReviewSkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={t('common.loading')}>
      <Skeleton className="h-5 w-40" />
      {[0, 1, 2].map(i => (
        <Skeleton key={i} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  )
}
