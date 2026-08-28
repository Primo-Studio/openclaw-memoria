/**
 * App — authentification (token admin passé par le CLI `memoria`), onboarding
 * quand aucun agent n'est relié, routeur par hash, et coquille de navigation
 * (app/Shell.tsx).
 */
import { useCallback, useEffect, useState } from 'react'
import { getAgents, getReview, hasToken } from './api'
import { Spinner } from './components/ui'
import { Toaster } from './components/ui/sonner'
import { hasLiveAgent } from './lib/agents'
import { screenFromHash, type ScreenId } from './app/nav'
import { Shell } from './app/Shell'
import { Welcome } from './app/Welcome'
import { Dashboard } from './screens/Dashboard'
import { Agents } from './screens/Agents'
import { Memory } from './screens/Memory'
import { Review } from './screens/Review'
import { Themes } from './screens/Themes'
import { Patterns } from './screens/Patterns'
import { Procedures } from './screens/Procedures'
import { Revisions } from './screens/Revisions'
import { Maintenance } from './screens/Maintenance'
import { Sharing } from './screens/Sharing'
import { Persons } from './screens/Persons'
import { Vault } from './screens/Vault'
import { System } from './screens/System'
import { Audit } from './screens/Audit'
import { Onboarding } from './screens/Onboarding'
import { Settings } from './screens/Settings'
import { Docs } from './screens/Docs'

export function App() {
  // Le token est adopté avant le rendu (main.tsx) ; sa présence ne change plus ensuite.
  const [authed] = useState(hasToken)
  const [screen, setScreen] = useState<ScreenId>(() => screenFromHash(window.location.hash))
  // null = on ne sait pas encore (chargement) ; true = aucun agent réellement
  // connecté → onboarding (une instance « en attente » créée par un code de
  // pairing jamais collé ne compte pas, cf. lib/agents.ts).
  const [onboarding, setOnboarding] = useState<boolean | null>(null)
  const [reviewCount, setReviewCount] = useState(0)

  useEffect(() => {
    if (!authed) return
    getAgents()
      .then(agents => setOnboarding(!hasLiveAgent(agents)))
      .catch(() => setOnboarding(false))
  }, [authed])

  // Routeur par hash : le bouton Précédent/Suivant du navigateur fonctionne,
  // le rafraîchissement garde l'écran, les liens sont partageables.
  useEffect(() => {
    const onHash = () => setScreen(screenFromHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Badge « en attente » sur Revue (nombre de souvenirs à valider).
  useEffect(() => {
    if (!authed) return
    const load = () => getReview().then(items => setReviewCount(items.length)).catch(() => {})
    load()
    const id = window.setInterval(load, 20000)
    return () => window.clearInterval(id)
  }, [authed])

  const go = useCallback((id: ScreenId) => {
    window.location.hash = '#/' + id
  }, [])

  if (!authed) {
    return (
      <>
        <Welcome />
        <Toaster position="bottom-right" />
      </>
    )
  }
  if (onboarding === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (onboarding) {
    // Onboarding : rendu hors coquille (il n'y a pas encore d'agent à naviguer).
    return (
      <>
        <Onboarding onDone={() => setOnboarding(false)} />
        <Toaster position="bottom-right" />
      </>
    )
  }

  const content = (
    <>
      {screen === 'dashboard' && <Dashboard onConnect={() => go('agents')} onConfigure={() => go('settings')} />}
      {screen === 'agents' && <Agents onOpenReview={() => go('review')} />}
      {screen === 'memory' && <Memory />}
      {screen === 'themes' && <Themes />}
      {screen === 'patterns' && <Patterns />}
      {screen === 'procedures' && <Procedures />}
      {screen === 'review' && <Review />}
      {screen === 'revisions' && <Revisions />}
      {screen === 'maintenance' && <Maintenance />}
      {screen === 'sharing' && <Sharing />}
      {screen === 'persons' && <Persons />}
      {screen === 'vault' && <Vault />}
      {screen === 'system' && <System />}
      {screen === 'audit' && <Audit />}
      {screen === 'settings' && <Settings />}
      {screen === 'docs' && <Docs />}
    </>
  )
  return (
    <>
      <Shell screen={screen} onNavigate={go} reviewCount={reviewCount}>
        {content}
      </Shell>
      <Toaster position="bottom-right" />
    </>
  )
}
