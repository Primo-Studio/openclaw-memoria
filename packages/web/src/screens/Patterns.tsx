/**
 * Récurrences — « Memoria a remarqué que… ». Les choses que tu dis/fais de
 * façon récurrente, repérées et regroupées. Tu confirmes (Memoria en fait un
 * souvenir consolidé) ou tu écartes. Rien n'est appliqué sans ton accord.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getAgents, getPatterns, decidePattern, type AgentEntry, type Pattern } from '../api'
import { useT } from '../i18n'
import { EmptyState, ErrorBanner, Spinner, agentTypeLabel, humanError, listPhase } from '../components/ui'
import { analyzableAgents } from '../lib/agents'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const KIND_KEY: Record<string, string> = {
  preference: 'patterns.kind_preference',
  habit: 'patterns.kind_habit',
  convention: 'patterns.kind_convention',
  fact: 'patterns.kind_fact',
}

/** Libellé traduit du type de récurrence (repli sur « Récurrence »). */
function kindLabel(t: Translate, kind: string): string {
  return t(KIND_KEY[kind] ?? 'patterns.kind_default')
}

export function Patterns() {
  const { t } = useT()
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState('')
  const [patterns, setPatterns] = useState<Pattern[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
    setPatterns(null)
    try {
      setPatterns(await getPatterns(inst))
    } catch (err) {
      // 404 = vieux service sans la route : état vide, pas une panne.
      if (err instanceof ApiError && err.status === 404) setPatterns([])
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

  const phase = listPhase(patterns, error)

  const decide = useCallback(
    async (id: string, decision: 'accept' | 'dismiss') => {
      setBusy(true)
      try {
        await decidePattern(instance, id, decision)
        await load(instance)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('patterns.action_failed'))
      } finally {
        setBusy(false)
      }
    },
    [instance, load, t],
  )

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>{t('patterns.title')}</h1>
          <p className="muted">{t('patterns.lead')}</p>
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
        <Spinner label={t('patterns.analyzing')} />
      ) : phase === 'failed' || patterns === null ? null : patterns.length === 0 ? (
        <div className="empty-state">
          <p>{t('patterns.empty_title')}</p>
          <p className="muted">{t('patterns.empty_body')}</p>
        </div>
      ) : (
        <ul className="pattern-list">
          {patterns.map(p => (
            <li key={p.id} className="pattern-card">
              <div className="pattern-head">
                <span className="badge badge-accent">{kindLabel(t, p.kind)}</span>
                <span className="muted">{t('patterns.seen_times', { count: p.occurrences })}</span>
              </div>
              <p className="pattern-label">{p.label}</p>
              <p className="pattern-canonical muted">« {p.canonical_fact} »</p>
              <div className="pattern-actions">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(p.id, 'accept')}>
                  {t('patterns.consolidate')}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decide(p.id, 'dismiss')}>
                  {t('patterns.dismiss')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
