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

function AuditTable({ entries, page, setPage }: { entries: AuditEntry[]; page: number; setPage: (p: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const slice = entries.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Acteur</th>
            <th>Action</th>
            <th>Espace</th>
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
