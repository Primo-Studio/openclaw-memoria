/**
 * Procédures — « comment faire les choses ». Les savoir-faire de chaque agent
 * (commandes, workflows), avec leur taux de réussite. Memoria apprend de
 * chaque exécution : ce qui marche remonte, ce qui rate est annoté.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getAgents, getProcedures, type AgentEntry, type Procedure } from '../api'
import { useT } from '../i18n'
import { EmptyState, ErrorBanner, Spinner, agentTypeLabel, humanError, listPhase } from '../components/ui'
import { analyzableAgents } from '../lib/agents'

export function Procedures() {
  const { t } = useT()
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState('')
  const [procedures, setProcedures] = useState<Procedure[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Aucun agent analysable (ex. seul « Autre agent (MCP) ») → état vide explicite.
  const [noAgent, setNoAgent] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    getAgents()
      .then(a => {
        const real = analyzableAgents(a)
        setAgents(real)
        setNoAgent(real.length === 0)
        if (real[0]) setInstance(real[0].instance.id)
      })
      .catch(err => setError(err instanceof ApiError ? err.message : humanError(err)))
  }, [tick])

  const load = useCallback(async (inst: string) => {
    setProcedures(null)
    try {
      setProcedures(await getProcedures(inst))
    } catch (err) {
      // 404 = vieux service sans la route : état vide, pas une panne.
      if (err instanceof ApiError && err.status === 404) setProcedures([])
      else setError(err instanceof ApiError ? err.message : humanError(err))
    }
  }, [])

  useEffect(() => {
    if (instance) void load(instance)
  }, [instance, load, tick])

  const retry = useCallback(() => {
    setError(null)
    setTick(n => n + 1)
  }, [])

  const phase = listPhase(procedures, error)

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>{t('procedures.title')}</h1>
          <p className="muted">{t('procedures.lead')}</p>
        </div>
        {agents.length > 0 && (
          <select className="agent-select" value={instance} onChange={e => setInstance(e.target.value)}>
            {agents.map(a => <option key={a.instance.id} value={a.instance.id}>{agentTypeLabel(a.assistant_type)}</option>)}
          </select>
        )}
      </header>

      {error && <ErrorBanner message={error} onRetry={retry} />}

      {noAgent ? (
        <EmptyState title={t('memory.no_agent_title')} body={t('memory.no_agent_body')} />
      ) : phase === 'loading' ? (
        <Spinner />
      ) : phase === 'failed' || procedures === null ? null : procedures.length === 0 ? (
        <div className="empty-state">
          <p>{t('procedures.empty_title')}</p>
          <p className="muted">{t('procedures.empty_body')}</p>
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
                      {t('procedures.success_rate', { rate, total })}
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
