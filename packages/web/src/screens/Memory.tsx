/**
 * Mémoire — par agent : recherche dans ses souvenirs (GET /v1/admin/facts,
 * route câblée à l'intégration ; q vide = derniers souvenirs) et oubli
 * définitif fait par fait (POST /v1/admin/forget {ids}).
 */
import { useState, type FormEvent } from 'react'
import { forgetFacts, getAgents, searchFacts, type AdminFact, type AgentEntry } from '../api'
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

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; facts: AdminFact[]; query: string }

export function Memory() {
  const { state: agentsState, reload: reloadAgents } = useLoad(getAgents)

  return (
    <section>
      <header className="screen-head">
        <h1>Mémoire</h1>
      </header>

      {agentsState.status === 'loading' && <Spinner />}
      {agentsState.status === 'error' && <ErrorBanner message={agentsState.message} onRetry={reloadAgents} />}
      {agentsState.status === 'ready' &&
        (agentsState.data.length === 0 ? (
          <EmptyState
            title="Aucun agent, donc aucune mémoire"
            body="Connectez d’abord un agent depuis l’onglet « Agents » : ses souvenirs apparaîtront ici."
          />
        ) : (
          <MemoryBrowser agents={agentsState.data} />
        ))}
    </section>
  )
}

function MemoryBrowser({ agents }: { agents: AgentEntry[] }) {
  const active = agents.filter(a => a.instance.revoked_at === null)
  const first = active[0] ?? agents[0]
  const [instanceId, setInstanceId] = useState(first ? first.instance.id : '')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })

  const runSearch = (q: string) => {
    setSearch({ status: 'loading' })
    searchFacts(instanceId, q).then(
      facts => setSearch({ status: 'ready', facts, query: q }),
      (err: unknown) => {
        console.warn('memoria-ui : recherche mémoire échouée', err)
        setSearch({ status: 'error', message: humanError(err) })
      },
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    runSearch(query.trim())
  }

  const forget = (fact: AdminFact) => {
    forgetFacts([fact.id]).then(
      deleted => {
        if (deleted === 0) {
          console.warn(`memoria-ui : oubli sans effet pour ${fact.id}`)
        }
        setSearch(prev =>
          prev.status === 'ready' ? { ...prev, facts: prev.facts.filter(f => f.id !== fact.id) } : prev,
        )
      },
      (err: unknown) => {
        console.warn('memoria-ui : oubli échoué', err)
        setSearch({ status: 'error', message: humanError(err) })
      },
    )
  }

  return (
    <>
      <form className="memory-controls" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Agent</span>
          <select
            value={instanceId}
            onChange={e => {
              setInstanceId(e.target.value)
              setSearch({ status: 'idle' })
            }}
          >
            {agents.map(({ instance, assistant_type }) => (
              <option key={instance.id} value={instance.id}>
                {agentTypeLabel(assistant_type)} — {instance.machine_id}
                {instance.revoked_at !== null ? ' (déconnecté)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-grow">
          <span className="field-label">Rechercher dans sa mémoire</span>
          <input
            type="search"
            value={query}
            placeholder="Un mot-clé, un sujet, un nom de projet…"
            onChange={e => setQuery(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={instanceId === ''}>
          Rechercher
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
          Tout afficher
        </button>
      </form>

      {search.status === 'idle' && (
        <p className="muted">Tapez un mot-clé puis « Rechercher », ou « Tout afficher » pour voir les derniers souvenirs.</p>
      )}
      {search.status === 'loading' && <Spinner label="Recherche…" />}
      {search.status === 'error' && <ErrorBanner message={search.message} />}
      {search.status === 'ready' &&
        (search.facts.length === 0 ? (
          <EmptyState
            title="Rien trouvé"
            body={
              search.query === ''
                ? 'Cet agent n’a encore aucun souvenir. Travaillez avec lui : sa mémoire se remplira toute seule.'
                : `Aucun souvenir ne correspond à « ${search.query} ».`
            }
          />
        ) : (
          <ul className="fact-list">
            {search.facts.map(fact => (
              <li key={fact.id} className="fact-card">
                <p className="fact-content">{fact.fact}</p>
                <div className="fact-meta">
                  {(fact.topics ?? []).map(t => (
                    <span key={t} className="badge badge-theme" title="thème">{t}</span>
                  ))}
                  <span className="badge badge-muted">{fact.category}</span>
                  <span className="badge badge-muted">{scopeLabel(fact)}</span>
                  <span className="muted">{formatDate(fact.created_at)}</span>
                  <span className="fact-actions">
                    <ConfirmButton label="Oublier" confirmLabel="Oublier définitivement ?" onConfirm={() => forget(fact)} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ))}
    </>
  )
}

/** Libellé lisible du scope — jamais d'identifiant brut quand on peut l'éviter. */
function scopeLabel(fact: AdminFact): string {
  const name = fact.scope_name ?? fact.scope_id
  if (name.startsWith('private:')) return 'Privé'
  if (name === 'user') return 'Partagé avec tous vos agents'
  return name.length > 24 ? `${name.slice(0, 24)}…` : name
}
