/**
 * Partage (spec §11) : deux outils.
 *  1. Matrice « qui peut lire quoi » : pour chaque scope partagé, coche les
 *     agents autorisés en lecture.
 *  2. Faits sur toi à partager : pour chaque agent, Memoria propose les faits
 *     qui parlent de l'utilisateur (identité/préférences) ; tu choisis ceux à
 *     remonter vers la mémoire partagée « user » (tous les agents y accèdent).
 * Rien n'est partagé sans ton clic — Memoria propose, tu décides.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  getAgents,
  getIdentityCandidates,
  getScopes,
  setPolicy,
  shareFacts,
  type AgentEntry,
  type AssistantInfo,
  type IdentityCandidate,
  type ScopeAccess,
} from '../api'

export function Sharing() {
  const [scopes, setScopes] = useState<ScopeAccess[] | null>(null)
  const [assistants, setAssistants] = useState<AssistantInfo[]>([])
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([getScopes(), getAgents()])
      setScopes(s.scopes.filter(sc => sc.type !== 'private' && sc.type !== 'legacy_to_review'))
      setAssistants(s.assistants)
      setAgents(a)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Le service ne répond pas.')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = useCallback(
    async (assistantId: string, scope: ScopeAccess, next: boolean) => {
      setBusy(true)
      try {
        await setPolicy(assistantId, scope.id, { can_read: next })
        await refresh()
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Modification impossible.')
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
          <h1>Partage</h1>
          <p className="muted">
            Chaque agent a sa mémoire privée. Ici, tu décides ce qui est commun — et qui y accède.
          </p>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="settings-block">
        <h2>Qui peut lire quoi</h2>
        {scopes === null ? (
          <div className="spinner-row"><span className="spinner" aria-hidden /> Chargement…</div>
        ) : scopes.length === 0 ? (
          <p className="muted">Aucune mémoire partagée pour l’instant.</p>
        ) : (
          <table className="share-matrix">
            <thead>
              <tr>
                <th>Mémoire partagée</th>
                <th>Faits</th>
                {assistants.map(a => (
                  <th key={a.id} title={a.type}>{a.display_name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scopes.map(scope => (
                <tr key={scope.id}>
                  <td><strong>{scopeLabel(scope)}</strong></td>
                  <td className="muted">{scope.facts}</td>
                  {assistants.map(a => {
                    const allowed = scope.readers.includes(a.id)
                    return (
                      <td key={a.id} className="share-cell">
                        <input
                          type="checkbox"
                          checked={allowed}
                          disabled={busy}
                          aria-label={`${a.display_name} peut lire ${scopeLabel(scope)}`}
                          onChange={e => void toggle(a.id, scope, e.target.checked)}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-block">
        <h2>Faits sur toi à partager</h2>
        <p className="muted">
          Memoria a repéré, dans la mémoire de chaque agent, des faits qui te concernent. Partage-les
          vers la mémoire commune « user » pour que tous tes agents les connaissent.
        </p>
        {agents.filter(a => a.assistant_type !== 'generic').map(a => (
          <IdentityPanel key={a.instance.id} agent={a} onShared={() => void refresh()} onError={setError} />
        ))}
      </div>
    </section>
  )
}

function IdentityPanel({
  agent,
  onShared,
  onError,
}: {
  agent: AgentEntry
  onShared: () => void
  onError: (m: string) => void
}) {
  const [candidates, setCandidates] = useState<IdentityCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const c = await getIdentityCandidates(agent.instance.id)
      setCandidates(c)
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Chargement impossible.')
    }
  }, [agent.instance.id, onError])

  const share = useCallback(async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      await shareFacts([...selected], 'user')
      setSelected(new Set())
      await load()
      onShared()
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Partage impossible.')
    } finally {
      setBusy(false)
    }
  }, [selected, load, onShared, onError])

  return (
    <div className="identity-panel">
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          setOpen(o => !o)
          if (!open && candidates === null) void load()
        }}
      >
        {open ? '▾' : '▸'} {agent.assistant_type} — faits sur toi
      </button>
      {open && (
        candidates === null ? (
          <div className="spinner-row"><span className="spinner" aria-hidden /> Analyse…</div>
        ) : candidates.length === 0 ? (
          <p className="muted">Aucun fait identité repéré pour cet agent.</p>
        ) : (
          <>
            <ul className="fact-list">
              {candidates.map(c => (
                <li key={c.id} className="fact-card identity-card">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={e => {
                        const next = new Set(selected)
                        if (e.target.checked) next.add(c.id)
                        else next.delete(c.id)
                        setSelected(next)
                      }}
                    />
                    <span>{c.content}</span>
                  </label>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => void share()}>
              Partager {selected.size > 0 ? `(${selected.size})` : ''} vers « user »
            </button>
          </>
        )
      )}
    </div>
  )
}

function scopeLabel(scope: ScopeAccess): string {
  switch (scope.type) {
    case 'user':
      return 'Sur l’utilisateur'
    case 'org':
      return 'Entreprise'
    case 'client':
      return `Client : ${scope.name}`
    case 'project':
      return `Projet : ${scope.name}`
    case 'shared_topic':
      return `Sujet : ${scope.name}`
    default:
      return scope.name
  }
}
