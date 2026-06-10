/**
 * Révisions — le « ménage » de la mémoire. Memoria repère les souvenirs qui se
 * contredisent ou font doublon, et PROPOSE de les ranger : garder le plus
 * récent, écarter l'ancien. Rien n'est modifié sans ta validation.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  decideRevision,
  getAgents,
  getRevisions,
  proposeRevisions,
  type AgentEntry,
  type RevisionProposal,
} from '../api'

const KIND_LABEL: Record<string, string> = {
  contradicted: 'Contradiction',
  duplicate: 'Doublon',
  obsolete: 'Obsolète',
}

export function Revisions() {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState('')
  const [items, setItems] = useState<RevisionProposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getAgents()
      .then(a => {
        const real = a.filter(x => x.assistant_type !== 'generic' && !x.instance.revoked_at)
        setAgents(real)
        if (real[0]) setInstance(real[0].instance.id)
      })
      .catch(() => setError('Le service ne répond pas.'))
  }, [])

  const load = useCallback(async (inst: string) => {
    setItems(null)
    try {
      // déclenche une analyse fraîche puis liste
      await proposeRevisions(inst).catch(() => 0)
      setItems(await getRevisions(inst))
    } catch (err) {
      setItems([])
      if (err instanceof ApiError && err.status !== 404) setError(err.message)
    }
  }, [])

  useEffect(() => {
    if (instance) void load(instance)
  }, [instance, load])

  const decide = useCallback(
    async (id: string, decision: 'accept' | 'dismiss') => {
      setBusy(true)
      try {
        await decideRevision(instance, id, decision)
        setItems(prev => (prev ? prev.filter(i => i.id !== id) : prev))
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Action impossible.')
      } finally {
        setBusy(false)
      }
    },
    [instance],
  )

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Révisions</h1>
          <p className="muted">Le ménage de la mémoire : souvenirs qui se contredisent ou font doublon.</p>
        </div>
        {agents.length > 0 && (
          <select className="agent-select" value={instance} onChange={e => setInstance(e.target.value)}>
            {agents.map(a => <option key={a.instance.id} value={a.instance.id}>{a.assistant_type}</option>)}
          </select>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      {items === null ? (
        <div className="spinner-row"><span className="spinner" aria-hidden /> Analyse de la mémoire…</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>Mémoire saine — rien à ranger. ✨</p>
          <p className="muted">Memoria propose une révision quand deux souvenirs se contredisent ou se répètent.</p>
        </div>
      ) : (
        <ul className="pattern-list">
          {items.map(r => (
            <li key={r.id} className="pattern-card">
              <div className="pattern-head">
                <span className="badge badge-accent">{KIND_LABEL[r.kind] ?? r.kind}</span>
              </div>
              <p className="pattern-canonical muted">{r.reason}</p>
              <div className="pattern-actions">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(r.id, 'accept')}>
                  Ranger (garder le récent)
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decide(r.id, 'dismiss')}>
                  Laisser
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
