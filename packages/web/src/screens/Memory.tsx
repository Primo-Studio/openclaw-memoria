/**
 * Mémoire — par agent, ou toutes les mémoires d'un coup : recherche dans les
 * souvenirs (GET /v1/admin/facts, q vide = derniers souvenirs ; GET
 * /v1/admin/search pour la recherche globale) et oubli définitif
 * (POST /v1/admin/forget {ids}), à l'unité ou par sélection.
 *
 * Écran migré sur shadcn : PageHeader, SectionCard « Recherche » (Select
 * d'agent + champ avec loupe), résultats en cartes MemFactCard, sélection
 * multiple + barre collante, AlertDialog avant tout oubli, toasts.
 *
 * Comportement :
 *  - les derniers souvenirs de l'agent s'affichent dès l'ouverture (plus
 *    d'écran vide « tapez un mot-clé ») ;
 *  - la recherche part toute seule 300 ms après la dernière frappe ; Entrée
 *    ou « Rechercher » la lance tout de suite ;
 *  - garde anti-course « la dernière requête gagne » (lib/sequence) : la
 *    recherche globale peut être lente, une réponse périmée ne doit jamais
 *    écraser la plus récente ;
 *  - un oubli qui échoue ou « ne prend pas » (0 supprimé côté service) est
 *    dit en toast et la liste reste intacte — on ne ment jamais sur ce qui a
 *    été effacé.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Bot, CheckSquare, Lock, RotateCcw, Search, Square, Users } from 'lucide-react'
import { toast } from 'sonner'
import { forgetFacts, getAgents, searchAll, searchFacts, type AdminFact, type AgentEntry } from '../api'
import { ALL_AGENTS, MemAgentPicker, MemNoAgentState } from '../components/MemAgentSelect'
import { MemBadgeButton, MemFactCard, MemMetaText, MemSensitivityBadge } from '../components/MemFactCard'
import { MemSearchInput } from '../components/MemSearchInput'
import { MemListCount } from '../components/MemListCount'
import { MemScreenLink } from '../components/MemScreenLink'
import { MemSelectionBar } from '../components/MemSelectionBar'
import { ConfirmButton, EmptyState, ErrorBanner, PageHeader, SectionCard, agentTypeLabel, formatDate, humanError, useLoad } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Label } from '../components/ui/label'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { categoryLabel, splitTopics } from '../lib/labels'
import { createSequence } from '../lib/sequence'
import { TOUCH_ROW_ACTION } from '../lib/touch'
import { cn } from '../lib/utils'

/** Souvenir affiché : optionnellement étiqueté de l'agent (recherche globale). */
type ShownFact = AdminFact & { agent_type?: string }

/** Délai avant de lancer la recherche après la dernière frappe. */
const SEARCH_DEBOUNCE_MS = 300

// `query` est gardée à chaque étape : « Réessayer » et le changement d'agent
// relancent la MÊME recherche au lieu de jeter les résultats.
type SearchState =
  | { status: 'loading'; query: string }
  | { status: 'error'; message: string; query: string }
  | { status: 'ready'; facts: ShownFact[]; query: string }

export function Memory() {
  const { t } = useT()
  const { state: agentsState, reload: reloadAgents } = useLoad(getAgents)

  return (
    <>
      <PageHeader title={t('memory.title')} description={t('memory.lead')} />

      {agentsState.status === 'loading' && <MemorySkeleton />}
      {agentsState.status === 'error' && <ErrorBanner message={agentsState.message} onRetry={reloadAgents} />}
      {agentsState.status === 'ready' &&
        (agentsState.data.length === 0 ? (
          <MemNoAgentState />
        ) : (
          <MemoryBrowser agents={agentsState.data} />
        ))}
    </>
  )
}

/** Squelette à la forme de l'écran (bloc recherche + trois cartes). */
function MemorySkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-4" role="status" aria-label={t('common.loading')}>
      <Skeleton className="h-28 w-full rounded-xl" />
      <ResultsSkeleton />
    </div>
  )
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map(i => (
        <Skeleton key={i} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  )
}

function MemoryBrowser({ agents }: { agents: AgentEntry[] }) {
  const { t } = useT()
  const active = agents.filter(a => a.instance.revoked_at === null)
  const first = active[0] ?? agents[0]
  const [instanceId, setInstanceId] = useState(first ? first.instance.id : ALL_AGENTS)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>({ status: 'loading', query: '' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // anti-course : « Tout afficher » puis un badge thème → seule la dernière
  // requête partie peut remplir la liste (la recherche globale peut être lente).
  const seq = useRef(createSequence())
  // Dernière recherche réellement lancée : le debounce ne relance pas ce qui
  // vient de partir (frappe puis Entrée, ou ouverture puis premier effet).
  const lastRun = useRef<{ query: string; instance: string } | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query

  const runSearch = useCallback((q: string, inst: string) => {
    const id = seq.current.next()
    lastRun.current = { query: q, instance: inst }
    setSearch({ status: 'loading', query: q })
    const p = inst === ALL_AGENTS ? searchAll(q) : searchFacts(inst, q)
    p.then(
      facts => {
        if (seq.current.isCurrent(id)) setSearch({ status: 'ready', facts, query: q })
      },
      (err: unknown) => {
        if (!seq.current.isCurrent(id)) return
        console.warn('memoria-ui : recherche mémoire échouée', err)
        setSearch({ status: 'error', message: humanError(err), query: q })
      },
    )
  }, [])

  // Ouverture et changement d'agent : mêmes mots, autre mémoire. La sélection
  // est vidée — elle désignait des souvenirs qui ne sont plus à l'écran.
  useEffect(() => {
    setSelected(new Set())
    runSearch(queryRef.current.trim(), instanceId)
  }, [instanceId, runSearch])

  // Recherche pendant la frappe : un appel par mot, pas un par caractère.
  useEffect(() => {
    const q = query.trim()
    const alreadyRun = () => lastRun.current?.query === q && lastRun.current.instance === instanceId
    if (alreadyRun()) return
    const id = window.setTimeout(() => {
      if (!alreadyRun()) runSearch(q, instanceId)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [query, instanceId, runSearch])

  // Ce qu'on voit est ce qu'on oublie : la sélection ne garde que les
  // souvenirs encore affichés après une nouvelle recherche.
  useEffect(() => {
    if (search.status !== 'ready') return
    const visible = new Set(search.facts.map(f => f.id))
    setSelected(prev => {
      const next = new Set([...prev].filter(id => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [search])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    runSearch(query.trim(), instanceId)
  }

  const showAll = () => {
    setQuery('')
    runSearch('', instanceId)
  }

  // Cliquer un badge (thème/catégorie) filtre = relance une recherche dessus.
  const filterBy = (value: string) => {
    setQuery(value)
    runSearch(value, instanceId)
  }

  const setOne = (id: string, on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const forget = async (ids: string[]) => {
    setBusy(true)
    try {
      const deleted = await forgetFacts(ids)
      if (deleted === 0) {
        // Le service n'a rien supprimé : NE PAS retirer les cartes (sinon on
        // ment à l'utilisateur), et dire que l'oubli n'a pas pris.
        console.warn(`memoria-ui : oubli sans effet pour ${ids.join(', ')}`)
        toast.error(t('memory.forget_no_effect'))
        return
      }
      toast.success(deleted > 1 ? t('memory.forgotten_plural', { count: deleted }) : t('memory.forgotten'))
      if (deleted === ids.length) {
        const gone = new Set(ids)
        setSearch(prev => (prev.status === 'ready' ? { ...prev, facts: prev.facts.filter(f => !gone.has(f.id)) } : prev))
      } else if (lastRun.current) {
        // Oubli partiel : on ne sait pas lesquels ont survécu → on recharge
        // la liste plutôt que d'en inventer une.
        runSearch(lastRun.current.query, lastRun.current.instance)
      }
    } catch (err) {
      // L'échec d'un oubli ne remplace PAS la liste par une bannière :
      // l'utilisateur garderait l'impression que tout a été effacé.
      console.warn('memoria-ui : oubli échoué', err)
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  const facts = search.status === 'ready' ? search.facts : []
  const allSelected = facts.length > 0 && facts.every(f => selected.has(f.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(facts.map(f => f.id)))

  return (
    <>
      {/* Le sélecteur d'agent vit hors de la carte, juste sous la phrase
          d'intro : le MÊME emplacement que sur les cinq autres écrans par
          agent. Dans la carte, il se cherchait des yeux à chaque onglet. */}
      <MemAgentPicker id="memory-agent" agents={agents} value={instanceId} onChange={setInstanceId} allOption />

      <SectionCard title={t('memory.search.title')}>
        {/* Une colonne sous 640 px (rien ne déborde), le champ et les boutons sur la même ligne à partir de lg. */}
        <form onSubmit={submit} className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="memory-query">{instanceId === ALL_AGENTS ? t('memory.search_all_label') : t('memory.search_one_label')}</Label>
            <MemSearchInput id="memory-query" value={query} placeholder={t('memory.search_placeholder')} onChange={e => setQuery(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit">
              <Search aria-hidden="true" />
              {t('memory.search_button')}
            </Button>
            <Button type="button" variant="ghost" onClick={showAll}>
              <RotateCcw aria-hidden="true" />
              {t('memory.show_all')}
            </Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">{t('memory.hint')}</p>
        {/* Mémoire sert à relire et à oublier ; la correction d'une phrase vit
            dans Maintenance. Sans ce renvoi, l'utilisateur qui voulait réparer
            un souvenir ne trouvait ici que le bouton qui l'efface. */}
        <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {t('memory.repair_hint')}
          <MemScreenLink screen="maintenance" label={t('common.open_screen', { screen: t('nav.maintenance') })} />
        </p>
      </SectionCard>

      <MemSelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <ConfirmButton
          variant="destructive"
          className={TOUCH_ROW_ACTION}
          label={t('memory.forget_selected')}
          title={selected.size > 1 ? t('memory.forget_selected_title', { count: selected.size }) : t('memory.forget_one_title')}
          description={selected.size > 1 ? t('memory.forget_selected_body') : t('memory.forget_one_body')}
          confirmLabel={t('memory.forget_confirm')}
          disabled={busy}
          onConfirm={() => void forget([...selected])}
        />
      </MemSelectionBar>

      {search.status === 'loading' && <ResultsSkeleton />}
      {search.status === 'error' && <ErrorBanner message={search.message} onRetry={() => runSearch(search.query, instanceId)} />}
      {search.status === 'ready' &&
        (facts.length === 0 ? (
          <EmptyState
            icon={<Search className="size-5" />}
            title={t('memory.empty_title')}
            body={search.query === '' ? t('memory.empty_body_all') : t('memory.empty_body_query', { query: search.query })}
            action={
              search.query !== '' && (
                <Button variant="outline" onClick={showAll}>
                  <RotateCcw aria-hidden="true" />
                  {t('memory.show_all')}
                </Button>
              )
            }
          />
        ) : (
          <section aria-label={t('memory.results_label')}>
            <MemListCount
              label={facts.length > 1 ? t('fact.count_plural', { count: facts.length }) : t('fact.count', { count: facts.length })}
              hint={search.query === '' ? undefined : t('memory.results_for', { query: search.query })}
            >
              <Button type="button" variant="ghost" size="sm" className={TOUCH_ROW_ACTION} onClick={toggleAll} disabled={busy}>
                {allSelected ? <Square aria-hidden="true" /> : <CheckSquare aria-hidden="true" />}
                {allSelected ? t('selection.unselect_all') : t('selection.select_all')}
              </Button>
            </MemListCount>
            <ul className="flex flex-col gap-3">
              {facts.map(fact => {
                const topics = splitTopics(fact.topics)
                return (
                <li key={fact.id}>
                  <MemFactCard
                    selected={selected.has(fact.id)}
                    onSelectedChange={on => setOne(fact.id, on)}
                    selectLabel={t('selection.select')}
                    disabled={busy}
                    meta={
                      <>
                        {fact.agent_type && (
                          <Badge variant="secondary" title={t('memory.badge_agent_source')}>
                            <Bot aria-hidden="true" />
                            {agentTypeLabel(fact.agent_type)}
                          </Badge>
                        )}
                        {topics.shown.map(topic => (
                          <MemBadgeButton key={topic} title={t('memory.badge_topic_filter')} onClick={() => filterBy(topic)}>
                            {topic}
                          </MemBadgeButton>
                        ))}
                        {topics.hidden.length > 0 && (
                          <Badge variant="outline" title={t('fact.topics_more_title', { list: topics.hidden.join(', ') })}>
                            {t('fact.topics_more', { count: topics.hidden.length })}
                          </Badge>
                        )}
                        {/* AFFICHAGE traduit, FILTRE sur la valeur brute : la recherche
                            interroge la base, qui ne connaît que « preference » — traduire
                            l'argument de filterBy() ne ramènerait plus rien. */}
                        <MemBadgeButton variant="secondary" title={t('memory.badge_category_filter')} onClick={() => filterBy(fact.category)}>
                          {categoryLabel(t, fact.category)}
                        </MemBadgeButton>
                        <ScopeBadge fact={fact} />
                        <MemSensitivityBadge sensitivity={fact.sensitivity} />
                        <MemMetaText>{formatDate(fact.created_at)}</MemMetaText>
                      </>
                    }
                    actions={
                      /* `max-sm:-ml-3` : sous 640 px la rangée d'actions passe à la
                         ligne et s'aligne à gauche, mais le bouton fantôme porte
                         12 px de marge intérieure (ajoutés pour la cible tactile
                         de 44 px). Son libellé démarrait donc 13 px à droite du
                         texte du souvenir, de ses pastilles et de sa date —
                         mesuré : texte à x=56, libellé à x=69. Le décalage
                         négatif remet le libellé sur l'axe sans rien retirer à la
                         zone tactile. */
                      <ConfirmButton
                        variant="ghost"
                        className={cn('text-destructive hover:text-destructive max-sm:-ml-3', TOUCH_ROW_ACTION)}
                        label={t('memory.forget')}
                        title={t('memory.forget_one_title')}
                        description={t('memory.forget_one_body')}
                        confirmLabel={t('memory.forget_confirm')}
                        disabled={busy}
                        onConfirm={() => void forget([fact.id])}
                      />
                    }
                  >
                    {fact.fact}
                  </MemFactCard>
                </li>
                )
              })}
            </ul>
          </section>
        ))}
    </>
  )
}

/** Identifiant opaque (UUID) : ne dit rien à l'utilisateur, on ne l'affiche pas. */
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i

/**
 * Espace du souvenir — jamais d'identifiant brut. Le service ne renvoie
 * qu'un `scope_id` (UUID) pour les souvenirs privés : dans ce cas, pas de
 * badge du tout ; « Partagé » ressort d'autant mieux quand il s'applique.
 */
function ScopeBadge({ fact }: { fact: AdminFact }) {
  const { t } = useT()
  const name = fact.scope_name ?? fact.scope_id
  if (name.startsWith('private:')) {
    return (
      <Badge variant="outline">
        <Lock aria-hidden="true" />
        {t('memory.scope_private')}
      </Badge>
    )
  }
  if (name === 'user') {
    return (
      <Badge variant="outline">
        <Users aria-hidden="true" />
        {t('memory.scope_shared')}
      </Badge>
    )
  }
  if (OPAQUE_ID.test(name)) return null
  return <Badge variant="outline">{name.length > 24 ? `${name.slice(0, 24)}…` : name}</Badge>
}
