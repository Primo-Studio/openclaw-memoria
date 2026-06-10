/**
 * App — coquille de navigation (4 écrans) + écran d'accueil quand
 * aucun token admin n'est présent (l'UI s'ouvre normalement via le CLI
 * `memoria`, qui passe le token dans l'URL).
 */
import { useState } from 'react'
import { hasToken } from './api'
import { Dashboard } from './screens/Dashboard'
import { Agents } from './screens/Agents'
import { Memory } from './screens/Memory'
import { Audit } from './screens/Audit'

type ScreenId = 'dashboard' | 'agents' | 'memory' | 'audit'

const NAV: Array<{ id: ScreenId; label: string }> = [
  { id: 'dashboard', label: 'Tableau de bord' },
  { id: 'agents', label: 'Agents' },
  { id: 'memory', label: 'Mémoire' },
  { id: 'audit', label: 'Journal' },
]

export function App() {
  // Le token est adopté avant le rendu (main.tsx) ; sa présence ne change plus ensuite.
  const [authed] = useState(hasToken)
  const [screen, setScreen] = useState<ScreenId>('dashboard')

  if (!authed) return <Welcome />

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          Memoria
          <span className="brand-sub">mémoire locale</span>
        </div>
        <nav className="nav" aria-label="Navigation principale">
          {NAV.map(item => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${screen === item.id ? ' nav-active' : ''}`}
              onClick={() => setScreen(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot muted">100 % local — rien ne quitte cette machine.</div>
      </aside>
      <main className="content">
        {screen === 'dashboard' && <Dashboard onConnect={() => setScreen('agents')} />}
        {screen === 'agents' && <Agents />}
        {screen === 'memory' && <Memory />}
        {screen === 'audit' && <Audit />}
      </main>
    </div>
  )
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand">Memoria</div>
        <h1>Votre mémoire locale vous attend</h1>
        <p>
          Pour ouvrir ce tableau de bord en toute sécurité, lancez la commande suivante dans votre
          terminal — elle ouvre cette page avec votre clé d’accès personnelle :
        </p>
        <pre className="command">memoria</pre>
        <p className="muted">
          Tout reste sur votre machine : cette interface ne parle qu’au service Memoria qui tourne en
          local.
        </p>
      </div>
    </div>
  )
}
