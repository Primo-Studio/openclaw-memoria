/**
 * Mémoire — par agent : recherche dans ses souvenirs (GET /v1/admin/facts,
 * route câblée à l'intégration ; q vide = derniers souvenirs) et oubli
 * définitif fait par fait (POST /v1/admin/forget {ids}).
 */
import { useRef, useState, type FormEvent } from 'react'
import { forgetFacts, getAgents, searchAll, searchFacts, type AdminFact, type AgentEntry } from '../api'
import {
  ConfirmButton,
  EmptyState,
  ErrorBanner,
  Spinner,
  agentTypeLabel,
  formatDate,
  humanError,
  useLoad,
} from '../components/ui'
import { useT } from '../i18n'
import { createSequence } from '../lib/sequence'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Souvenir affiché : optionnellement étiqueté de l'agent (recherche globale). */
type ShownFact = AdminFact & { agent_type?: string }

const ALL = '__all__'

// `query` est gardée à chaque étape : « Réessayer » et le changement d'agent
// relancent la MÊME recherche au lieu de jeter les résultats.
type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'error'; message: string; query: string }
  | { status: 'ready'; facts: ShownFact[]; query: string }

export function Memory() {
  const { t } = useT()
  const { state: agentsState, reload: reloadAgents } = useLoad(getAgents)

  return (
    <section>
      <header className="screen-head">
        <h1>{t('memory.title')}</h1>
      </header>

      {agentsState.status === 'loading' && <Spinner />}
      {agentsState.status === 'error' && <ErrorBanner message={agentsState.message} onRetry={reloadAgents} />}
      {agentsState.status === 'ready' &&
        (agentsState.data.length === 0 ? (
          <EmptyState
            title={t('memory.no_agent_title')}
            body={t('memory.no_agent_body')}
          />
        ) : (
          <MemoryBrowser agents={agentsState.data} />
        ))}
    </section>
  )
}

function MemoryBrowser({ agents }: { agents: AgentEntry[] }) {
  const { t } = useT()
  const active = agents.filter(a => a.instance.revoked_at === null)
  const first = active[0] ?? agents[0]
  const [instanceId, setInstanceId] = useState(first ? first.instance.id : '')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })
  const [notice, setNotice] = useState<string | null>(null)
  // anti-course : « Tout afficher » puis un badge thème → seule la dernière
  // requête partie peut remplir la liste (globalSearch peut être lent).
  const seq = useRef(createSequence())

  const runSearch = (q: string, inst: string = instanceId) => {
    const id = seq.current.next()
    setSearch({ status: 'loading', query: q })
    const p = inst === ALL ? searchAll(q) : searchFacts(inst, q)
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
  }

  const changeAgent = (inst: string) => {
    setInstanceId(inst)
    // on garde la recherche en cours : mêmes mots, autre agent
    if (search.status !== 'idle') runSearch(search.query, inst)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    runSearch(query.trim())
  }

  // P1 : cliquer un badge (thème/catégorie) filtre = relance une recherche dessus.
  const filterBy = (value: string) => {
    setQuery(value)
    runSearch(value)
  }

  const forget = (fact: AdminFact) => {
    forgetFacts([fact.id]).then(
      deleted => {
        if (deleted === 0) {
          // Le service n'a rien supprimé : NE PAS retirer la ligne (sinon on
          // ment à l'utilisateur), et signaler que l'oubli n'a pas pris.
          console.warn(`memoria-ui : oubli sans effet pour ${fact.id}`)
          setNotice(t('memory.forget_no_effect'))
          return
        }
        setNotice(null)
        setSearch(prev =>
          prev.status === 'ready' ? { ...prev, facts: prev.facts.filter(f => f.id !== fact.id) } : prev,
        )
      },
      (err: unknown) => {
        // L'échec d'un oubli ne doit PAS remplacer la liste par une bannière :
        // l'utilisateur garderait l'impression que tout a été effacé et
        // perdrait sa recherche. Le canal `notice` est fait pour ça.
        console.warn('memoria-ui : oubli échoué', err)
        setNotice(humanError(err))
      },
    )
  }

  return (
    <>
      <form className="memory-controls" onSubmit={submit}>
        <label className="field">
          <span className="field-label">{t('memory.field_agent')}</span>
          <select value={instanceId} onChange={e => changeAgent(e.target.value)}>
            <option value={ALL}>{t('memory.all_memories')}</option>
            {agents.map(({ instance, assistant_type }) => (
              <option key={instance.id} value={instance.id}>
                {agentTypeLabel(assistant_type)} — {instance.machine_id}
                {instance.revoked_at !== null ? t('memory.disconnected_suffix') : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-grow">
          <span className="field-label">{instanceId === ALL ? t('memory.search_all_label') : t('memory.search_one_label')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('memory.search_placeholder')}
            onChange={e => setQuery(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={instanceId === ''}>
          {t('memory.search_button')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={instanceId === ''}
          onClick={() => {
            setQuery('')
            runSearch('')
          }}
        >
          {t('memory.show_all')}
        </button>
      </form>

      {notice && <p className="warn" role="status">{notice}</p>}
      {search.status === 'idle' && (
        <p className="muted">{t('memory.hint')}</p>
      )}
      {search.status === 'loading' && <Spinner label={t('memory.searching')} />}
      {search.status === 'error' && <ErrorBanner message={search.message} onRetry={() => runSearch(search.query)} />}
      {search.status === 'ready' &&
        (search.facts.length === 0 ? (
          <EmptyState
            title={t('memory.empty_title')}
            body={
              search.query === ''
                ? t('memory.empty_body_all')
                : t('memory.empty_body_query', { query: search.query })
            }
          />
        ) : (
          <>
          <p className="muted result-count">
            {search.facts.length > 1
              ? t('memory.count_plural', { count: String(search.facts.length) })
              : t('memory.count', { count: String(search.facts.length) })}
          </p>
          <ul className="fact-list">
            {search.facts.map(fact => (
              <li key={fact.id} className="fact-card">
                <p className="fact-content">{fact.fact}</p>
                <div className="fact-meta">
                  {fact.agent_type && (
                    <span className="badge badge-ok" title={t('memory.badge_agent_source')}>{agentTypeLabel(fact.agent_type)}</span>
                  )}
                  {(fact.topics ?? []).map(topic => (
                    <button key={topic} type="button" className="badge badge-theme badge-btn" title={t('memory.badge_topic_filter')} onClick={() => filterBy(topic)}>{topic}</button>
                  ))}
                  <button type="button" className="badge badge-muted badge-btn" title={t('memory.badge_category_filter')} onClick={() => filterBy(fact.category)}>{fact.category}</button>
                  <span className="badge badge-muted">{scopeLabel(t, fact)}</span>
                  <span className="muted">{formatDate(fact.created_at)}</span>
                  <span className="fact-actions">
                    <ConfirmButton label={t('memory.forget')} confirmLabel={t('memory.forget_confirm')} onConfirm={() => forget(fact)} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          </>
        ))}
    </>
  )
}

/** Libellé lisible du scope — jamais d'identifiant brut quand on peut l'éviter. */
function scopeLabel(t: Translate, fact: AdminFact): string {
  const name = fact.scope_name ?? fact.scope_id
  if (name.startsWith('private:')) return t('memory.scope_private')
  if (name === 'user') return t('memory.scope_shared')
  return name.length > 24 ? `${name.slice(0, 24)}…` : name
}
