/**
 * Récurrences — « Memoria a remarqué que… ». Les choses que tu dis/fais de
 * façon récurrente, repérées et regroupées. Tu confirmes (Memoria en fait un
 * souvenir consolidé) ou tu écartes. Rien n'est appliqué sans ton accord.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getAgents, getPatterns, decidePattern, type AgentEntry, type Pattern } from '../api'

const KIND_LABEL: Record<string, string> = {
  preference: 'Préférence',
  habit: 'Habitude',
  convention: 'Convention',
  fact: 'Récurrence',
}

export function Patterns() {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState('')
  const [patterns, setPatterns] = useState<Pattern[] | null>(null)
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
    setPatterns(null)
    try {
      setPatterns(await getPatterns(inst))
    } catch (err) {
      setPatterns([])
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
        await decidePattern(instance, id, decision)
        await load(instance)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Action impossible.')
      } finally {
        setBusy(false)
      }
    },
    [instance, load],
  )

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Récurrences</h1>
          <p className="muted">Ce que Memoria remarque de récurrent chez toi. Confirme pour le consolider, ou écarte.</p>
        </div>
        {agents.length > 0 && (
          <select className="agent-select" value={instance} onChange={e => setInstance(e.target.value)}>
            {agents.map(a => <option key={a.instance.id} value={a.instance.id}>{a.assistant_type}</option>)}
          </select>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      {patterns === null ? (
        <div className="spinner-row"><span className="spinner" aria-hidden /> Analyse…</div>
      ) : patterns.length === 0 ? (
        <div className="empty-state">
          <p>Rien de récurrent détecté pour l’instant.</p>
          <p className="muted">Memoria repère les choses qui reviennent (≥ 3 fois) à mesure que la mémoire grandit.</p>
        </div>
      ) : (
        <ul className="pattern-list">
          {patterns.map(p => (
            <li key={p.id} className="pattern-card">
              <div className="pattern-head">
                <span className="badge badge-accent">{KIND_LABEL[p.kind] ?? 'Récurrence'}</span>
                <span className="muted">vu {p.occurrences} fois</span>
              </div>
              <p className="pattern-label">{p.label}</p>
              <p className="pattern-canonical muted">« {p.canonical_fact} »</p>
              <div className="pattern-actions">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(p.id, 'accept')}>
                  Consolider
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decide(p.id, 'dismiss')}>
                  Écarter
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
