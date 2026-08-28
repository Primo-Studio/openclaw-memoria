/**
 * Maintenance — le « ménage » de la mémoire réclamé en bêta : corriger un fait,
 * fusionner des doublons, repérer ce qui n'a jamais servi, oublier.
 *
 * Deux principes guident l'écran :
 *
 *  1. Rien n'est réécrit en place. Corriger CRÉE la version corrigée et marque
 *     l'ancienne remplacée par elle ; fusionner fait pointer les doublons sur le
 *     fait conservé. Le texte d'origine reste consultable, donc une mauvaise
 *     manipulation reste rattrapable. Seul « oublier » supprime réellement, et
 *     il est signalé comme définitif.
 *  2. La sélection sert aux DEUX opérations de masse (fusionner, oublier), donc
 *     l'écran dit toujours combien d'éléments sont sélectionnés et ce qui va
 *     leur arriver — jamais un bouton dont l'effet se devine.
 *
 * Écran migré sur shadcn : SectionCard « Recherche » (Select d'agent, source en
 * segmented control, champ avec loupe — plus de débordement à 390 px), cartes
 * MemFactCard, barre de sélection collante avec la règle de fusion lisible
 * AVANT de cliquer, AlertDialog pour fusionner comme pour oublier, toasts.
 * Mêmes appels : GET /v1/admin/facts | never_used, POST correct_fact,
 * merge_facts, forget. La recherche pendant la frappe (300 ms) et la garde
 * anti-course (lib/sequence) sont conservées.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckSquare, Merge, Pencil, Save, Search, Sparkles, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { correctFact, forgetFacts, getAgents, mergeFacts, neverUsedFacts, searchFacts, type AdminFact, type AgentEntry } from '../api'
import { MemAgentPicker, MemNoAgentState } from '../components/MemAgentSelect'
import { MemFactCard, MemMetaText, MemSensitivityBadge } from '../components/MemFactCard'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { MemSearchInput } from '../components/MemSearchInput'
import { MemListCount } from '../components/MemListCount'
import { MemSelectionBar } from '../components/MemSelectionBar'
import { ConfirmButton, EmptyState, ErrorBanner, PageHeader, SectionCard, formatDay, humanError, listPhase } from '../components/ui'
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
} from '../components/ui/alert-dialog'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { useT } from '../i18n'
import { categoryLabel } from '../lib/labels'
import { createSequence } from '../lib/sequence'

/** Délai avant de lancer la recherche après la dernière frappe. */
const SEARCH_DEBOUNCE_MS = 300

type Source = 'search' | 'never-used'

export function Maintenance() {
  const { t } = useT()
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState<string>('')
  // POURQUOI « jamais utilisés » par défaut : ouvert sur « recherche », cet
  // écran affichait EXACTEMENT la même liste des mêmes souvenirs que Mémoire,
  // sous une deuxième entrée de menu. Il s'ouvre donc sur ce que Mémoire ne
  // montre pas — les souvenirs dormants — et la recherche reste à un clic.
  const [source, setSource] = useState<Source>('never-used')
  const [query, setQuery] = useState('')
  // Valeur réellement recherchée : `query` suit la frappe, `debouncedQuery`
  // ne bouge qu'après SEARCH_DEBOUNCE_MS de silence — un GET par mot, pas
  // un par caractère.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const seq = useRef(createSequence())
  const [facts, setFacts] = useState<AdminFact[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Aucun agent actif → état vide explicite au lieu d'un spinner sans fin.
  const [noAgent, setNoAgent] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    getAgents()
      .then(list => {
        const active = list.filter(a => a.instance.revoked_at === null)
        setAgents(active)
        setNoAgent(active.length === 0)
        if (active[0]) setInstance(prev => prev || active[0]!.instance.id)
      })
      .catch((err: unknown) => {
        console.warn('memoria-ui : agents illisibles', err)
        setError(err instanceof TypeError ? humanError(err) : t('maintenance.agents_failed'))
      })
  }, [t, tick])

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [query])

  // La sélection ne se vide qu'en changeant d'agent ou de source : affiner la
  // recherche après avoir coché des doublons ne doit pas tout perdre.
  useEffect(() => {
    setSelected(new Set())
    setEditing(null)
  }, [instance, source])

  const load = useCallback(async () => {
    if (!instance) return
    setError(null)
    const id = seq.current.next()
    try {
      const list = source === 'never-used' ? await neverUsedFacts(instance) : await searchFacts(instance, debouncedQuery)
      if (!seq.current.isCurrent(id)) return // réponse périmée : une requête plus récente est partie
      setFacts(list)
    } catch (err) {
      if (!seq.current.isCurrent(id)) return
      // facts reste tel quel : listPhase() affiche l'erreur, pas un faux « vide ».
      console.warn('memoria-ui : souvenirs illisibles', err)
      setError(err instanceof TypeError ? humanError(err) : t('maintenance.load_failed'))
    }
  }, [instance, source, debouncedQuery, t])

  useEffect(() => {
    void load()
  }, [load, tick])

  const retry = useCallback(() => {
    setError(null)
    setTick(n => n + 1)
  }, [])

  const phase = listPhase(facts, error)
  const list = facts ?? []

  const setOne = (id: string, on: boolean): void =>
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const allSelected = list.length > 0 && list.every(f => selected.has(f.id))
  const toggleAll = () =>
    setSelected(prev => {
      if (allSelected) return new Set([...prev].filter(id => !list.some(f => f.id === id)))
      return new Set([...prev, ...list.map(f => f.id)])
    })

  /** Enveloppe commune : occupe l'UI, dit le résultat en toast, recharge à la fin. */
  const run = useCallback(
    async (fn: () => Promise<string>, fallback: string) => {
      setBusy(true)
      try {
        toast.success(await fn())
        // l'opération a consommé la sélection (fusionnés / oubliés) → on repart à zéro
        setSelected(new Set())
        await load()
      } catch (err) {
        // L'échec d'une action ne cache pas la liste : les souvenirs sont toujours là, on le dit en toast.
        console.warn('memoria-ui : action de maintenance refusée', err)
        toast.error(err instanceof TypeError ? humanError(err) : `${fallback} ${humanError(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const saveCorrection = (): void => {
    if (!editing || !editing.text.trim()) return
    const { id, text } = editing
    setEditing(null)
    void run(async () => {
      const replacement = await correctFact(instance, id, text.trim())
      return replacement ? t('maintenance.corrected') : t('maintenance.correct_noop')
    }, t('maintenance.correct_failed'))
  }

  /** Fusion : le PREMIER sélectionné est conservé, les autres pointent sur lui. */
  const merge = (): void => {
    const ids = [...selected]
    if (ids.length < 2) return
    const [keep, ...rest] = ids
    void run(async () => {
      const merged = await mergeFacts(instance, keep!, rest)
      return t('maintenance.merged', { count: merged.length })
    }, t('maintenance.merge_failed'))
  }

  const forget = (): void => {
    const ids = [...selected]
    if (ids.length === 0) return
    void run(async () => t('maintenance.forgotten', { count: await forgetFacts(ids) }), t('maintenance.forget_failed'))
  }

  const keepId = [...selected][0]
  // Souvenirs cochés mais hors de la liste affichée (autre recherche) : on le dit.
  const hidden = [...selected].filter(id => !list.some(f => f.id === id)).length

  return (
    <>
      <PageHeader
        title={t('maintenance.title')}
        description={t('maintenance.lead')}
        actions={
          <MemRefreshButton
            label={t('common.refresh')}
            onClick={retry}
            disabled={!instance || phase === 'loading'}
            spinning={phase === 'loading'}
          />
        }
      />

      {/* Même emplacement et même libellé que sur les cinq autres écrans par agent. */}
      <MemAgentPicker id="maintenance-agent" agents={agents} value={instance} onChange={setInstance} disabled={busy} />

      {!noAgent && (
        <SectionCard title={t('maintenance.search.title')}>
          {/* Une colonne sous 640 px, puis source + champ côte à côte à partir de lg. */}
          <div className="grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)]">
            <div className="flex flex-col gap-1.5">
              <Label id="maintenance-source-label">{t('maintenance.source')}</Label>
              <Tabs value={source} onValueChange={v => setSource(v as Source)}>
                <TabsList aria-labelledby="maintenance-source-label" className="w-full sm:w-auto">
                  <TabsTrigger value="search">
                    <Search aria-hidden="true" />
                    {t('maintenance.source_search')}
                  </TabsTrigger>
                  <TabsTrigger value="never-used">
                    <Sparkles aria-hidden="true" />
                    {t('maintenance.source_never_used')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex flex-col gap-1.5">
              {source === 'search' ? (
                <>
                  <Label htmlFor="maintenance-query">{t('memory.search_one_label')}</Label>
                  <MemSearchInput id="maintenance-query" value={query} placeholder={t('maintenance.search_placeholder')} onChange={e => setQuery(e.target.value)} />
                </>
              ) : (
                /* `mt-auto` et non `self-end` : dans une colonne flex, `self-end`
                   aligne sur l'axe TRANSVERSAL, donc à droite — la phrase partait
                   se poser au bout de la ligne du label « Source », loin des
                   onglets qu'elle explique. `mt-auto` la pousse vraiment en bas
                   de la colonne, à hauteur des onglets. */
                <p className="text-sm text-muted-foreground lg:mt-auto lg:pb-1.5">{t('maintenance.never_used_hint')}</p>
              )}
            </div>
          </div>
        </SectionCard>
      )}

      <MemSelectionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        hint={
          selected.size >= 2
            ? hidden > 0
              ? `${t('maintenance.merge_hint')} ${t('maintenance.hidden_selected', { count: hidden })}`
              : t('maintenance.merge_hint')
            : hidden > 0
              ? t('maintenance.hidden_selected', { count: hidden })
              : undefined
        }
      >
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={busy || selected.size < 2}>
              <Merge aria-hidden="true" />
              {t('maintenance.merge')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('maintenance.merge_title', { count: selected.size })}</AlertDialogTitle>
              <AlertDialogDescription>{t('maintenance.merge_body')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={merge}>{t('maintenance.merge')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ConfirmButton
          variant="destructive"
          label={t('maintenance.forget')}
          title={selected.size > 1 ? t('memory.forget_selected_title', { count: selected.size }) : t('memory.forget_one_title')}
          description={selected.size > 1 ? t('memory.forget_selected_body') : t('memory.forget_one_body')}
          confirmLabel={t('memory.forget_confirm')}
          disabled={busy}
          onConfirm={forget}
        />
      </MemSelectionBar>

      {error && <ErrorBanner message={error} onRetry={retry} />}

      {noAgent ? (
        <MemNoAgentState />
      ) : phase === 'loading' ? (
        <div className="flex flex-col gap-3" role="status" aria-label={t('common.loading')}>
          {[0, 1, 2].map(i => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : phase === 'failed' ? null : phase === 'empty' ? (
        <EmptyState
          icon={source === 'never-used' ? <Sparkles className="size-5" /> : <Search className="size-5" />}
          title={t(source === 'never-used' ? 'maintenance.empty_never_used' : 'maintenance.empty_search')}
          action={
            // Aucun souvenir dormant : l'écran ne reste pas vide et muet, il
            // propose l'autre entrée de l'atelier.
            source === 'never-used' ? (
              <Button variant="outline" onClick={() => setSource('search')}>
                <Search aria-hidden="true" />
                {t('maintenance.empty_never_used_action')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <section aria-label={t('maintenance.list_label')}>
          <MemListCount label={list.length > 1 ? t('fact.count_plural', { count: list.length }) : t('fact.count', { count: list.length })}>
            <Button type="button" variant="ghost" size="sm" onClick={toggleAll} disabled={busy}>
              {allSelected ? <Square aria-hidden="true" /> : <CheckSquare aria-hidden="true" />}
              {allSelected ? t('selection.unselect_all') : t('selection.select_all')}
            </Button>
          </MemListCount>
          <ul className="flex flex-col gap-3">
            {list.map(f => {
              const isEditing = editing?.id === f.id
              return (
                <li key={f.id}>
                  <MemFactCard
                    selected={selected.has(f.id)}
                    onSelectedChange={on => setOne(f.id, on)}
                    selectLabel={t('selection.select')}
                    disabled={busy}
                    meta={
                      <>
                        {(f.topics ?? []).map(topic => (
                          <Badge key={topic} variant="outline">
                            {topic}
                          </Badge>
                        ))}
                        <Badge variant="secondary">{categoryLabel(t, f.category)}</Badge>
                        {f.id === keepId && selected.size >= 2 && <Badge>{t('maintenance.badge_keep')}</Badge>}
                        <MemSensitivityBadge sensitivity={f.sensitivity} />
                        <MemMetaText>{formatDay(f.created_at)}</MemMetaText>
                      </>
                    }
                    actions={
                      isEditing ? (
                        <>
                          <Button size="sm" disabled={busy || !editing.text.trim()} onClick={saveCorrection}>
                            <Save aria-hidden="true" />
                            {t('maintenance.save')}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>
                            <X aria-hidden="true" />
                            {t('maintenance.cancel')}
                          </Button>
                        </>
                      ) : (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing({ id: f.id, text: f.fact })}>
                          <Pencil aria-hidden="true" />
                          {t('maintenance.correct')}
                        </Button>
                      )
                    }
                  >
                    {isEditing ? (
                      <Textarea
                        value={editing.text}
                        rows={3}
                        autoFocus
                        aria-label={t('maintenance.edit_label')}
                        onChange={e => setEditing({ id: f.id, text: e.target.value })}
                      />
                    ) : (
                      f.fact
                    )}
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
