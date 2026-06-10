/**
 * App — coquille de navigation (5 écrans) + sélecteur de mode de capture
 * toujours visible (pause = exigence spec §13) + écran d'accueil quand
 * aucun token admin n'est présent (l'UI s'ouvre normalement via le CLI
 * `memoria`, qui passe le token dans l'URL).
 */
import { useCallback, useEffect, useState } from 'react'
import { getAgents, getCaptureMode, hasToken, setCaptureMode, type CaptureMode } from './api'
import { Dashboard } from './screens/Dashboard'
import { Agents } from './screens/Agents'
import { Memory } from './screens/Memory'
import { Review } from './screens/Review'
import { Themes } from './screens/Themes'
import { Patterns } from './screens/Patterns'
import { Sharing } from './screens/Sharing'
import { Audit } from './screens/Audit'
import { Onboarding } from './screens/Onboarding'
import { Settings } from './screens/Settings'

type ScreenId = 'dashboard' | 'agents' | 'memory' | 'themes' | 'patterns' | 'review' | 'sharing' | 'audit' | 'settings'

const NAV: Array<{ id: ScreenId; label: string }> = [
  { id: 'dashboard', label: 'Tableau de bord' },
  { id: 'agents', label: 'Agents' },
  { id: 'memory', label: 'Mémoire' },
  { id: 'themes', label: 'Thèmes' },
  { id: 'patterns', label: 'Récurrences' },
  { id: 'review', label: 'Revue' },
  { id: 'sharing', label: 'Partage' },
  { id: 'audit', label: 'Journal' },
  { id: 'settings', label: 'Réglages' },
]

const MODES: Array<{ id: CaptureMode; label: string; hint: string }> = [
  { id: 'auto-private', label: 'Capture auto', hint: 'Les agents mémorisent en privé automatiquement.' },
  { id: 'review-first', label: 'Revue d’abord', hint: 'Chaque souvenir attend votre validation (écran Revue).' },
  { id: 'incognito', label: 'Pause', hint: 'Plus aucune capture — rien n’est écrit nulle part.' },
]

export function App() {
  // Le token est adopté avant le rendu (main.tsx) ; sa présence ne change plus ensuite.
  const [authed] = useState(hasToken)
  const [screen, setScreen] = useState<ScreenId>('dashboard')
  // null = on ne sait pas encore (chargement) ; true = 0 agent → onboarding.
  const [onboarding, setOnboarding] = useState<boolean | null>(null)

  useEffect(() => {
    if (!authed) return
    getAgents()
      .then(agents => setOnboarding(agents.length === 0))
      .catch(() => setOnboarding(false))
  }, [authed])

  if (!authed) return <Welcome />
  if (onboarding === null) return <div className="welcome"><div className="spinner" aria-hidden /></div>
  if (onboarding) return <Onboarding onDone={() => setOnboarding(false)} />

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
        <CaptureModeSwitch />
        <div className="sidebar-foot muted">100 % local — rien ne quitte cette machine.</div>
      </aside>
      <main className="content">
        {screen === 'dashboard' && <Dashboard onConnect={() => setScreen('agents')} />}
        {screen === 'agents' && <Agents />}
        {screen === 'memory' && <Memory />}
        {screen === 'themes' && <Themes />}
        {screen === 'patterns' && <Patterns />}
        {screen === 'review' && <Review />}
        {screen === 'sharing' && <Sharing />}
        {screen === 'audit' && <Audit />}
        {screen === 'settings' && <Settings />}
      </main>
    </div>
  )
}

/** Pause/capture toujours accessible, quel que soit l'écran (spec §13). */
function CaptureModeSwitch() {
  const [mode, setMode] = useState<CaptureMode | null>(null)

  useEffect(() => {
    getCaptureMode()
      .then(setMode)
      .catch(() => setMode(null))
  }, [])

  const change = useCallback((next: CaptureMode) => {
    setMode(next) // optimiste — l'échec remet l'état réel
    setCaptureMode(next).catch(() => {
      getCaptureMode()
        .then(setMode)
        .catch(() => setMode(null))
    })
  }, [])

  if (mode === null) return null

  const current = MODES.find(m => m.id === mode)
  return (
    <div className="capture-switch">
      <span className="field-label">Capture</span>
      <div className="capture-options" role="radiogroup" aria-label="Mode de capture">
        {MODES.map(m => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            title={m.hint}
            className={`capture-option${mode === m.id ? ' capture-active' : ''}${m.id === 'incognito' && mode === m.id ? ' capture-paused' : ''}`}
            onClick={() => change(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {current && <p className="muted capture-hint">{current.hint}</p>}
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
