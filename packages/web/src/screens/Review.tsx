/**
 * Revue — souvenirs en attente (mode « revue d'abord » et imports en
 * quarantaine) : approuver = le souvenir devient actif, rejeter = effacé
 * définitivement. Tant qu'un souvenir attend ici, aucun agent ne le voit.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getReview, reviewDecision, type ReviewItem } from '../api'

export function Review() {
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setItems(await getReview())
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Le service ne répond pas.')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const decide = useCallback(
    async (ids: string[], decision: 'approve' | 'reject') => {
      setBusy(true)
      try {
        await reviewDecision(ids, decision)
        await refresh()
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Action impossible.')
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Revue</h1>
          <p className="muted">
            Souvenirs en attente de votre décision — invisibles pour les agents tant qu’ils ne sont
            pas approuvés.
          </p>
        </div>
        {items !== null && items.length > 1 && (
          <div className="review-bulk">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void decide(items.map(i => i.id), 'approve')}
            >
              Tout approuver ({items.length})
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Rejeter définitivement les ${items.length} souvenirs en attente ?`)) {
                  void decide(items.map(i => i.id), 'reject')
                }
              }}
            >
              Tout rejeter
            </button>
          </div>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      {items === null ? (
        <div className="spinner-row">
          <span className="spinner" aria-hidden />
          Chargement…
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>Rien à relire — tout est à jour. ✨</p>
          <p className="muted">
            Les souvenirs n’attendent ici que si la capture est en mode « revue d’abord », ou après
            un import.
          </p>
        </div>
      ) : (
        <ul className="fact-list">
          {items.map(item => (
            <li key={item.id} className="fact-card">
              <p className="fact-content">{item.content}</p>
              <div className="fact-meta">
                <span className="badge badge-muted">{item.category}</span>
                <span className="badge badge-muted">
                  {item.source_type === 'capture-review' ? 'capture' : 'import'}
                </span>
                <span className="muted">confiance {(item.confidence * 100).toFixed(0)} %</span>
                <span className="fact-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void decide([item.id], 'approve')}
                  >
                    Approuver
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => void decide([item.id], 'reject')}
                  >
                    Rejeter
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
