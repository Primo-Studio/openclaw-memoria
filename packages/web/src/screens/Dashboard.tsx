/**
 * Tableau de bord — l'état de la mémoire en un coup d'œil :
 * santé (doctor), compteurs (stats), souvenirs en attente de traitement (WAL).
 */
import { getDoctor, getOverview, getStats, type AgentOverview, type DoctorReport, type Stats } from '../api'
import { ErrorBanner, Spinner, formatBytes, useLoad } from '../components/ui'

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  openclaw: 'OpenClaw',
}

const DB_KIND_LABELS: Record<string, string> = {
  registry: 'Registre',
  assistant: 'Mémoire d’agent',
  shared: 'Mémoire partagée',
}

export function Dashboard({ onConnect }: { onConnect: () => void }) {
  const { state, reload } = useLoad(async () => {
    const [stats, doctor, overview] = await Promise.all([getStats(), getDoctor(), getOverview().catch(() => [])])
    return { stats, doctor, overview }
  })

  return (
    <section>
      <header className="screen-head">
        <h1>Tableau de bord</h1>
        <button type="button" className="btn btn-ghost" onClick={reload}>
          Actualiser
        </button>
      </header>

      {state.status === 'loading' && <Spinner />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        <DashboardBody stats={state.data.stats} doctor={state.data.doctor} overview={state.data.overview} onConnect={onConnect} />
      )}
    </section>
  )
}

function DashboardBody({
  stats,
  doctor,
  overview,
  onConnect,
}: {
  stats: Stats
  doctor: DoctorReport
  overview: AgentOverview[]
  onConnect: () => void
}) {
  const walPending = doctor.databases.reduce((sum, db) => sum + (db.wal_pending ?? 0), 0)

  return (
    <>
      <HealthCard doctor={doctor} />

      <div className="stat-grid">
        <StatCard value={stats.facts} label="Souvenirs" hint="Tout ce que vos agents ont retenu" />
        <StatCard value={stats.instances} label="Agents" hint="Assistants reliés à cette mémoire" />
        <StatCard value={stats.databases} label="Espaces de mémoire" hint="Un espace par agent + les espaces partagés" />
        <StatCard
          value={walPending}
          label="En attente"
          hint={walPending === 0 ? 'Rien en file — tout est trié' : 'Souvenirs capturés, pas encore triés'}
          tone={walPending > 0 ? 'warn' : undefined}
        />
      </div>

      {stats.instances === 0 && (
        <div className="empty-state">
          <h2>Aucun agent connecté pour l’instant</h2>
          <p className="muted">Reliez votre premier assistant pour qu’il commence à se souvenir de vous.</p>
          <button type="button" className="btn btn-primary btn-big" onClick={onConnect}>
            Connecter votre premier agent
          </button>
        </div>
      )}

      {overview.length > 0 && (
        <div className="overview-block">
          <h2>Vos agents et ce qu’ils savent</h2>
          <div className="overview-grid">
            {overview.map(a => (
              <div key={a.instance} className="overview-card">
                <div className="overview-head">
                  <strong>{AGENT_LABELS[a.type] ?? a.type}</strong>
                </div>
                <div className="overview-stats">
                  <span><b>{a.facts}</b> souvenirs</span>
                  <span><b>{a.themes}</b> thèmes</span>
                  {a.procedures > 0 && <span><b>{a.procedures}</b> procédures</span>}
                </div>
                {a.expertise.length > 0 && (
                  <div className="overview-expertise">
                    <span className="muted">maîtrise :</span>
                    {a.expertise.map(d => <span key={d} className="badge badge-theme">{d}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <details className="storage-details">
        <summary>Détails du stockage</summary>
        <p className="muted">
          Vos souvenirs vivent dans <code>{doctor.storage_root}</code> — sur cette machine uniquement.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Emplacement</th>
              <th>Taille</th>
              <th>En attente</th>
            </tr>
          </thead>
          <tbody>
            {doctor.databases.map(db => (
              <tr key={db.path}>
                <td>{DB_KIND_LABELS[db.kind] ?? db.kind}</td>
                <td>
                  <code className="path">{db.path}</code>
                  {!db.exists && <span className="badge badge-warn">absente</span>}
                </td>
                <td>{db.exists ? formatBytes(db.size_bytes) : '—'}</td>
                <td>{db.wal_pending ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  )
}

function HealthCard({ doctor }: { doctor: DoctorReport }) {
  if (doctor.ok) {
    return (
      <div className="health-card health-ok">
        <span className="dot dot-ok" aria-hidden="true" />
        <div>
          <strong>Tout va bien</strong>
          <p className="muted">Stockage sain, aucune alerte.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="health-card health-warn">
      <span className="dot dot-warn" aria-hidden="true" />
      <div>
        <strong>À vérifier</strong>
        <ul className="warning-list">
          {doctor.warnings.map(w => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function StatCard({ value, label, hint, tone }: { value: number; label: string; hint: string; tone?: 'warn' }) {
  return (
    <div className={`stat-card${tone === 'warn' ? ' stat-warn' : ''}`}>
      <div className="stat-value">{value.toLocaleString('fr-FR')}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-hint muted">{hint}</div>
    </div>
  )
}
