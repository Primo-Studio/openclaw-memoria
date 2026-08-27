/**
 * Maintenance — le « ménage » de la mémoire réclamé en bêta : corriger un fait,
 * fusionner des doublons, repérer ce qui n'a jamais servi, oublier.
 *
 * Deux principes guident l'écran :
 *
 *  1. Rien n'est réécrit en place. Corriger CRÉE la version corrigée et marque
 *     l'ancienne remplacée par elle ; fusionner fait pointer les doublons sur le
 *     fait conservé. Le texte d'origine reste consultable, donc une mauvaise
 *     manipulation reste rattrapable. Seul « oublier » supprime réellement, et
 *     il est signalé comme définitif.
 *  2. La sélection sert aux DEUX opérations de masse (fusionner, oublier), donc
 *     l'écran dit toujours combien d'éléments sont sélectionnés et ce qui va
 *     leur arriver — jamais un bouton dont l'effet se devine.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  correctFact,
  forgetFacts,
  getAgents,
  mergeFacts,
  neverUsedFacts,
  searchFacts,
  type AdminFact,
  type AgentEntry,
} from '../api'
import { useT } from '../i18n'
import { EmptyState, ErrorBanner, Spinner, humanError, listPhase } from '../components/ui'

type Source = 'search' | 'never-used'

export function Maintenance() {
  const { t } = useT()
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [instance, setInstance] = useState<string>('')
  const [source, setSource] = useState<Source>('search')
  const [query, setQuery] = useState('')
  const [facts, setFacts] = useState<AdminFact[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Aucun agent actif → état vide explicite au lieu d'un spinner sans fin.
  const [noAgent, setNoAgent] = useState(false)
  const [tick, setTick] = useState(0)

  const fail = useCallback(
    (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : err instanceof TypeError ? humanError(err) : fallback),
    [],
  )

  useEffect(() => {
    getAgents()
      .then(list => {
        const active = list.filter(a => a.instance.revoked_at === null)
        setAgents(active)
        setNoAgent(active.length === 0)
        if (active[0]) setInstance(active[0].instance.id)
      })
      .catch(err => fail(err, t('maintenance.agents_failed')))
  }, [fail, t, tick])

  const load = useCallback(async () => {
    if (!instance) return
    setError(null)
    setSelected(new Set())
    try {
      setFacts(source === 'never-used' ? await neverUsedFacts(instance) : await searchFacts(instance, query))
    } catch (err) {
      // facts reste tel quel : listPhase() affiche l'erreur, pas un faux « vide ».
      fail(err, t('maintenance.load_failed'))
    }
  }, [instance, source, query, fail, t])

  useEffect(() => {
    void load()
  }, [load, tick])

  const retry = useCallback(() => {
    setError(null)
    setTick(n => n + 1)
  }, [])

  const phase = listPhase(facts, error)

  const toggle = (id: string): void =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Enveloppe commune : occupe l'UI, remonte l'erreur, recharge à la fin. */
  const run = useCallback(
    async (fn: () => Promise<string>, fallback: string) => {
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        setNotice(await fn())
        await load()
      } catch (err) {
        fail(err, fallback)
      } finally {
        setBusy(false)
      }
    },
    [load, fail],
  )

  const saveCorrection = (): void => {
    if (!editing || !editing.text.trim()) return
    const { id, text } = editing
    setEditing(null)
    void run(async () => {
      const replacement = await correctFact(instance, id, text.trim())
      return replacement ? t('maintenance.corrected') : t('maintenance.correct_noop')
    }, t('maintenance.correct_failed'))
  }

  /** Fusion : le PREMIER sélectionné est conservé, les autres pointent sur lui. */
  const merge = (): void => {
    const ids = [...selected]
    if (ids.length < 2) return
    const [keep, ...rest] = ids
    void run(async () => {
      const merged = await mergeFacts(instance, keep!, rest)
      return t('maintenance.merged', { count: merged.length })
    }, t('maintenance.merge_failed'))
  }

  const forget = (): void => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!confirm(t('maintenance.forget_confirm', { count: ids.length }))) return
    void run(async () => t('maintenance.forgotten', { count: await forgetFacts(ids) }), t('maintenance.forget_failed'))
  }

  const keepId = [...selected][0]

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>{t('maintenance.title')}</h1>
          <p className="muted">{t('maintenance.lead')}</p>
        </div>
      </header>

      <div className="toolbar">
        <select value={instance} onChange={e => setInstance(e.target.value)} aria-label={t('maintenance.agent')}>
          {agents.map(({ instance: inst, assistant_type }) => (
            <option key={inst.id} value={inst.id}>
              {assistant_type}
            </option>
          ))}
        </select>

        <select value={source} onChange={e => setSource(e.target.value as Source)} aria-label={t('maintenance.source')}>
          <option value="search">{t('maintenance.source_search')}</option>
          <option value="never-used">{t('maintenance.source_never_used')}</option>
        </select>

        {source === 'search' && (
          <input
            type="search"
            value={query}
            placeholder={t('maintenance.search_placeholder')}
            onChange={e => setQuery(e.target.value)}
          />
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={retry} />}
      {notice && <div className="info-banner">{notice}</div>}

      {selected.size > 0 && (
        <div className="review-bulk">
          <span className="muted">{t('maintenance.selected', { count: selected.size })}</span>
          <button type="button" className="btn" disabled={busy || selected.size < 2} onClick={merge}>
            {t('maintenance.merge')}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={forget}>
            {t('maintenance.forget')}
          </button>
        </div>
      )}

      {/* La règle de fusion doit être lisible AVANT de cliquer, pas découverte après. */}
      {selected.size >= 2 && <p className="muted">{t('maintenance.merge_hint')}</p>}

      {noAgent ? (
        <EmptyState title={t('memory.no_agent_title')} body={t('memory.no_agent_body')} />
      ) : phase === 'loading' ? (
        <Spinner />
      ) : phase === 'failed' || facts === null ? null : facts.length === 0 ? (
        <div className="empty-state">
          <p>{t(source === 'never-used' ? 'maintenance.empty_never_used' : 'maintenance.empty_search')}</p>
        </div>
      ) : (
        <ul className="fact-list">
          {facts.map(f => (
            <li key={f.id} className="fact-card">
              <label className="fact-select">
                <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} disabled={busy} />
                {editing?.id === f.id ? (
                  <textarea
                    className="fact-edit"
                    value={editing.text}
                    rows={3}
                    autoFocus
                    onChange={e => setEditing({ id: f.id, text: e.target.value })}
                  />
                ) : (
                  <p className="fact-content">{f.fact}</p>
                )}
              </label>

              <div className="fact-meta">
                {(f.topics ?? []).map(topic => (
                  <span key={topic} className="badge badge-theme">
                    {topic}
                  </span>
                ))}
                <span className="badge badge-muted">{f.category}</span>
                {f.id === keepId && selected.size >= 2 && (
                  <span className="badge">{t('maintenance.badge_keep')}</span>
                )}
                <span className="muted">{f.created_at.slice(0, 10)}</span>

                <span className="fact-actions">
                  {editing?.id === f.id ? (
                    <>
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={saveCorrection}>
                        {t('maintenance.save')}
                      </button>
                      <button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>
                        {t('maintenance.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setEditing({ id: f.id, text: f.fact })}
                    >
                      {t('maintenance.correct')}
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
