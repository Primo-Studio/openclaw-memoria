/**
 * Thèmes — la « carte » de ce que sait Memoria, agent par agent, rangé par
 * SUJET. Chaque thème est une tuile dont la taille reflète son importance
 * (plus l'agent en sait, plus c'est gros). Cliquer un thème montre ses
 * souvenirs : on voit OÙ chaque chose est rangée. C'est la puissance de
 * Memoria, d'un coup d'œil.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getAgents,
  getTopics,
  getTopicFacts,
  type AdminFact,
  type AgentEntry,
  type Topic,
} from '../api'

export function Themes() {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState<string>('')
  const [topics, setTopics] = useState<Topic[] | null>(null)
  const [active, setActive] = useState<Topic | null>(null)
  const [facts, setFacts] = useState<AdminFact[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAgents()
      .then(a => {
        const real = a.filter(x => x.assistant_type !== 'generic' && !x.instance.revoked_at)
        setAgents(real)
        if (real.length > 0 && real[0]) setInstance(real[0].instance.id)
      })
      .catch(() => setError('Le service ne répond pas.'))
  }, [])

  useEffect(() => {
    if (!instance) return
    setTopics(null)
    setActive(null)
    setFacts(null)
    // On met en avant les thèmes consistants (≥2 souvenirs) ; les thèmes à 1
    // souvenir forment une longue queue qu'on n'affiche pas par défaut.
    getTopics(instance, 2)
      .then(setTopics)
      .catch(err => {
        setTopics([])
        if (err instanceof ApiError && err.status !== 404) setError(err.message)
      })
  }, [instance])

  const openTopic = useCallback(
    async (t: Topic) => {
      setActive(t)
      setFacts(null)
      try {
        setFacts(await getTopicFacts(instance, t.id))
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Chargement impossible.')
      }
    },
    [instance],
  )

  const maxImportance = useMemo(() => Math.max(1, ...(topics ?? []).map(t => t.importance_score)), [topics])

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Thèmes</h1>
          <p className="muted">Ce que chaque agent sait, rangé par sujet. Clique un thème pour voir ses souvenirs.</p>
        </div>
        {agents.length > 0 && (
          <select className="agent-select" value={instance} onChange={e => setInstance(e.target.value)}>
            {agents.map(a => (
              <option key={a.instance.id} value={a.instance.id}>
                {a.assistant_type}
              </option>
            ))}
          </select>
        )}
      </header>

      {error && <div className="error-banner">{error}</div>}

      {topics === null ? (
        <div className="spinner-row"><span className="spinner" aria-hidden /> Chargement…</div>
      ) : topics.length === 0 ? (
        <div className="empty-state">
          <p>Pas encore de thèmes pour cet agent.</p>
          <p className="muted">Les thèmes se forment à mesure que l’agent mémorise, ou après l’approbation des souvenirs importés.</p>
        </div>
      ) : (
        <div className="theme-cloud">
          {topics.map(t => {
            const scale = 0.85 + (t.importance_score / maxImportance) * 0.6
            return (
              <button
                key={t.id}
                type="button"
                className={`theme-tile${active?.id === t.id ? ' theme-active' : ''}`}
                style={{ fontSize: `${scale}rem` }}
                onClick={() => void openTopic(t)}
              >
                <span className="theme-name">{t.name}</span>
                <span className="theme-count">{t.fact_count}</span>
              </button>
            )
          })}
        </div>
      )}

      {active && (
        <div className="theme-detail">
          <h2>{active.name} <span className="muted">· {active.fact_count} souvenirs</span></h2>
          {active.keywords.length > 0 && (
            <div className="theme-keywords">{active.keywords.slice(0, 8).map(k => <span key={k} className="badge badge-muted">{k}</span>)}</div>
          )}
          {facts === null ? (
            <div className="spinner-row"><span className="spinner" aria-hidden /> …</div>
          ) : (
            <ul className="fact-list">
              {facts.map(f => (
                <li key={f.id} className="fact-card">
                  <p className="fact-content">{f.fact}</p>
                  <div className="fact-meta"><span className="badge badge-muted">{f.category}</span></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
