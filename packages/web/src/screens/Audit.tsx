/**
 * Audit — journal d'activité neutre (jamais de contenu, voir audit_log core).
 * Le daemon renvoie les 200 dernières entrées, pagination locale.
 */
import { useState } from 'react'
import { getAudit, type AuditEntry } from '../api'
import { EmptyState, ErrorBanner, Spinner, formatDate, useLoad } from '../components/ui'

const PAGE_SIZE = 25

const ACTION_LABELS: Record<string, string> = {
  pair_assistant: 'Connexion d’un agent préparée',
  complete_pairing: 'Agent connecté',
  revoke_instance: 'Agent révoqué',
  store_fact: 'Souvenir enregistré',
  recall: 'Souvenirs consultés',
  forget: 'Souvenirs oubliés',
}

const ACTOR_LABELS: Record<AuditEntry['actor_type'], string> = {
  assistant: 'Agent',
  user: 'Vous',
  system: 'Système',
}

export function Audit() {
  const { state, reload } = useLoad(getAudit)
  const [page, setPage] = useState(0)

  return (
    <section>
      <header className="screen-head">
        <h1>Journal d’activité</h1>
        <button type="button" className="btn btn-ghost" onClick={() => { setPage(0); reload() }}>
          Actualiser
        </button>
      </header>
      <p className="muted">
        Qui a fait quoi, et quand — sans jamais enregistrer le contenu de vos souvenirs.
      </p>

      {state.status === 'loading' && <Spinner />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <EmptyState title="Rien à signaler" body="Aucune activité enregistrée pour l’instant." />
        ) : (
          <AuditTable entries={state.data} page={page} setPage={setPage} />
        ))}
    </section>
  )
}

type SortKey = 'ts' | 'actor' | 'action' | 'scope'
type SortDir = 'asc' | 'desc'

/** Valeur de tri (texte comparable) pour une colonne donnée. */
function sortValue(e: AuditEntry, key: SortKey): string {
  switch (key) {
    case 'ts':
      return e.ts
    case 'actor':
      return `${ACTOR_LABELS[e.actor_type]} ${e.actor_id}`
    case 'action':
      return ACTION_LABELS[e.action] ?? e.action
    case 'scope':
      return e.scope_id ?? ''
  }
}

function AuditTable({ entries, page, setPage }: { entries: AuditEntry[]; page: number; setPage: (p: number) => void }) {
  // Tri par défaut : Date décroissante (le plus récent d'abord).
  const [sortKey, setSortKey] = useState<SortKey>('ts')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'ts' ? 'desc' : 'asc') // date : récent d'abord ; texte : A→Z
    }
    setPage(0)
  }

  const sorted = [...entries].sort((a, b) => {
    const cmp = sortValue(a, sortKey).localeCompare(sortValue(b, sortKey), 'fr', { numeric: true })
    return sortDir === 'asc' ? cmp : -cmp
  })

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const slice = sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)

  const columns: Array<{ key: SortKey; label: string }> = [
    { key: 'ts', label: 'Date' },
    { key: 'actor', label: 'Acteur' },
    { key: 'action', label: 'Action' },
    { key: 'scope', label: 'Espace' },
  ]
  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕')

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            {columns.map(col => (
              <th
                key={col.key}
                className="sortable"
                aria-sort={col.key === sortKey ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                onClick={() => toggleSort(col.key)}
              >
                {col.label}
                <span className="sort-arrow muted">{arrow(col.key)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slice.map(entry => (
            <tr key={entry.id}>
              <td className="nowrap">{formatDate(entry.ts)}</td>
              <td>
                {ACTOR_LABELS[entry.actor_type]}
                {entry.actor_type === 'assistant' && (
                  <code className="path"> {entry.actor_id.slice(0, 8)}</code>
                )}
              </td>
              <td>
                {ACTION_LABELS[entry.action] ?? entry.action}
                {entry.reason && <span className="muted"> · {entry.reason}</span>}
              </td>
              <td>{entry.scope_id ? <code className="path">{entry.scope_id.slice(0, 8)}</code> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="pager">
        <button type="button" className="btn btn-ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
          Précédent
        </button>
        <span className="muted">
          Page {current + 1} sur {pageCount}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={current >= pageCount - 1}
          onClick={() => setPage(current + 1)}
        >
          Suivant
        </button>
      </footer>
    </>
  )
}
