/**
 * Procédures — « comment faire les choses ». Les savoir-faire de chaque agent
 * (commandes, workflows), avec leur taux de réussite. Memoria apprend de
 * chaque exécution : ce qui marche remonte, ce qui rate est annoté.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getAgents, getProcedures, type AgentEntry, type Procedure } from '../api'

export function Procedures() {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState('')
  const [procedures, setProcedures] = useState<Procedure[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    setProcedures(null)
    try {
      setProcedures(await getProcedures(inst))
    } catch (err) {
      setProcedures([])
      if (err instanceof ApiError && err.status !== 404) setError(err.message)
    }
  }, [])

  useEffect(() => {
    if (instance) void load(instance)
  }, [instance, load])

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Procédures</h1>
          <p className="muted">Les savoir-faire de l’agent : comment il fait les choses, et ce qui marche le mieux.</p>
        </div>
        {agents.length > 0 && (
          <select className="agent-select" value={instance} onChange={e => setInstance(e.target.value)}>
            {agents.map(a => <option key={a.instance.id} value={a.instance.id}>{a.assistant_type}</option>)}
          </select>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      {procedures === null ? (
        <div className="spinner-row"><span className="spinner" aria-hidden /> Chargement…</div>
      ) : procedures.length === 0 ? (
        <div className="empty-state">
          <p>Pas encore de procédure pour cet agent.</p>
          <p className="muted">Les procédures se forment quand l’agent répète un savoir-faire (commande, workflow).</p>
        </div>
      ) : (
        <ul className="proc-list">
          {procedures.map(p => {
            const total = p.success_count + p.failure_count
            const rate = total > 0 ? Math.round((p.success_count / total) * 100) : null
            return (
              <li key={p.id} className="proc-card">
                <div className="proc-head">
                  <strong>{p.name}</strong>
                  {rate !== null && (
                    <span className={`proc-rate ${rate >= 70 ? 'rate-ok' : rate >= 40 ? 'rate-mid' : 'rate-low'}`}>
                      {rate}% de réussite ({total})
                    </span>
                  )}
                </div>
                {p.description && <p className="muted proc-desc">{p.description}</p>}
                {p.steps.length > 0 && (
                  <ol className="proc-steps">
                    {p.steps.slice(0, 6).map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
