/**
 * App — coquille de navigation (5 écrans) + sélecteur de mode de capture
 * toujours visible (pause = exigence spec §13) + écran d'accueil quand
 * aucun token admin n'est présent (l'UI s'ouvre normalement via le CLI
 * `memoria`, qui passe le token dans l'URL).
 */
import { useCallback, useEffect, useState } from 'react'
import { getAgents, getCaptureMode, getReview, getVersion, hasToken, setCaptureMode, type CaptureMode } from './api'
import { useT, LANGS, type Lang } from './i18n'
import { humanError } from './components/ui'
import { hasLiveAgent } from './lib/agents'
import { parseThemePref, useThemePref } from './lib/theme'
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

type ScreenId =
  | 'dashboard' | 'agents' | 'memory' | 'themes' | 'patterns' | 'procedures'
  | 'review' | 'revisions' | 'maintenance' | 'sharing' | 'persons' | 'vault' | 'system' | 'audit' | 'settings' | 'docs'

// Les libellés viennent de l'i18n : nav.<id> (cf. messages/fr.ts).
const NAV_IDS: ScreenId[] = [
  'dashboard', 'agents', 'memory', 'themes', 'patterns', 'procedures',
  'review', 'revisions', 'maintenance', 'sharing', 'persons', 'vault', 'system', 'audit', 'settings', 'docs',
]

// P1 : deux groupes au lieu de 16 onglets à plat. « Essentiel » toujours
// visible ; « Avancé » replié par défaut (outils pour power-users).
const ESSENTIAL_IDS: ScreenId[] = ['dashboard', 'agents', 'memory', 'themes', 'review']
const ADVANCED_IDS: ScreenId[] = NAV_IDS.filter(id => !ESSENTIAL_IDS.includes(id))

/** Écran courant depuis le hash d'URL (#/memory) → bouton Précédent + rafraîchissement stables. */
function screenFromHash(): ScreenId {
  const h = window.location.hash.replace(/^#\/?/, '')
  return (NAV_IDS as string[]).includes(h) ? (h as ScreenId) : 'dashboard'
}

// Symbole de marque : « M » formé de nœuds reliés (cf. brand/ + public/favicon.svg).
// Hérite de la couleur d'accent via currentColor.
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M30 32 V68 M30 32 L50 55 L70 32 M70 32 V68" />
      </g>
      <g fill="currentColor">
        <circle cx={30} cy={32} r={7} />
        <circle cx={30} cy={68} r={6} />
        <circle cx={50} cy={55} r={7} />
        <circle cx={70} cy={32} r={7} />
        <circle cx={70} cy={68} r={6} />
      </g>
    </svg>
  )
}

// clés i18n : capture.<key> (label) + capture.hint.<key>
const MODES: Array<{ id: CaptureMode; key: 'auto' | 'review' | 'pause' }> = [
  { id: 'auto-private', key: 'auto' },
  { id: 'review-first', key: 'review' },
  { id: 'incognito', key: 'pause' },
]

export function App() {
  const { t } = useT()
  // Le token est adopté avant le rendu (main.tsx) ; sa présence ne change plus ensuite.
  const [authed] = useState(hasToken)
  const [screen, setScreen] = useState<ScreenId>(screenFromHash)
  // null = on ne sait pas encore (chargement) ; true = aucun agent réellement
  // connecté → onboarding (une instance « en attente » créée par un code de
  // pairing jamais collé ne compte pas, cf. lib/agents.ts).
  const [onboarding, setOnboarding] = useState<boolean | null>(null)
  const [reviewCount, setReviewCount] = useState(0)
  // Menu mobile (hamburger). Sous 720 px la barre latérale devenait une bande
  // horizontale à défilement où « Avancé » empilait 11 boutons et poussait le
  // sélecteur de capture hors écran. Ouvert = overlay vertical ; fermé = barre
  // compacte brand + capture + bouton. Sans effet sur bureau (CSS).
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    if (!authed) return
    getAgents()
      .then(agents => setOnboarding(!hasLiveAgent(agents)))
      .catch(() => setOnboarding(false))
  }, [authed])

  // Routeur par hash : le bouton Précédent/Suivant du navigateur fonctionne,
  // le rafraîchissement garde l'écran, les liens sont partageables.
  useEffect(() => {
    const onHash = () => setScreen(screenFromHash())
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
    setNavOpen(false)
  }, [])

  // Échap referme le menu mobile (comportement attendu d'un overlay).
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  if (!authed) return <div className="legacy-screen"><Welcome /></div>
  if (onboarding === null) return <div className="legacy-screen"><div className="welcome"><div className="spinner" aria-hidden /></div></div>
  if (onboarding) return <div className="legacy-screen"><Onboarding onDone={() => setOnboarding(false)} /></div>

  const navButton = (id: ScreenId) => (
    <button
      key={id}
      type="button"
      className={`nav-item${screen === id ? ' nav-active' : ''}`}
      aria-current={screen === id ? 'page' : undefined}
      onClick={() => go(id)}
    >
      {t(`nav.${id}`)}
      {id === 'review' && reviewCount > 0 && (
        <span className="nav-badge">{reviewCount > 500 ? '500+' : reviewCount}</span>
      )}
    </button>
  )

  return (
    <div className="legacy-screen">
      <a href="#main-content" className="skip-link">{t('a11y.skip')}</a>
      <div className="layout">
        <aside className={`sidebar${navOpen ? ' sidebar-open' : ''}`}>
          <div className="brand">
            <BrandMark />
            <div className="brand-text">
              Memoria
              <span className="brand-sub">{t('brand.sub')}</span>
            </div>
          </div>
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={navOpen}
            aria-controls="sidebar-menu"
            aria-label={t('a11y.menu')}
            onClick={() => setNavOpen(o => !o)}
          >
            <span aria-hidden="true">{navOpen ? '✕' : '☰'}</span>
          </button>
          {/* Le sélecteur de capture reste HORS du menu repliable : « toujours visible » (spec §13). */}
          <CaptureModeSwitch />
          <div className="sidebar-menu" id="sidebar-menu">
            <LangSwitch />
            <ThemeSwitch />
            <nav className="nav" aria-label={t('a11y.nav')}>
              {ESSENTIAL_IDS.map(navButton)}
              <details className="nav-advanced">
                <summary>{t('nav.advanced')}</summary>
                {ADVANCED_IDS.map(navButton)}
              </details>
            </nav>
            <div className="sidebar-foot muted">
              {t('foot.local')}
              <VersionFoot />
            </div>
          </div>
        </aside>
        <main className="content" id="main-content" tabIndex={-1}>
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
        </main>
      </div>
    </div>
  )
}

/** Sélecteur de thème (clair / sombre / système) — barre latérale. */
function ThemeSwitch() {
  const { t } = useT()
  const [theme, setTheme] = useThemePref()
  return (
    <div className="lang-switch">
      <label className="field-label" htmlFor="theme-select">{t('theme.title')}</label>
      <select id="theme-select" className="lang-select" value={theme} onChange={e => setTheme(parseThemePref(e.target.value))}>
        <option value="system">{t('theme.system')}</option>
        <option value="light">{t('theme.light')}</option>
        <option value="dark">{t('theme.dark')}</option>
      </select>
    </div>
  )
}

/**
 * Pause/capture toujours accessible, quel que soit l'écran (spec §13).
 * « Toujours » vaut aussi en cas de panne : avant, un échec de lecture du mode
 * rendait `null` — le contrôle de pause disparaissait sans un mot, et un échec
 * de changement remettait l'ancien état sans feedback (clic « ignoré »).
 */
function CaptureModeSwitch() {
  const { t } = useT()
  const [mode, setMode] = useState<CaptureMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Message éphémère après un changement refusé (role=status, pas d'alerte bloquante).
  const [notice, setNotice] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    getCaptureMode()
      .then(m => {
        if (cancelled) return
        setMode(m)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.warn('memoria-ui : mode de capture illisible', err)
        setError(humanError(err))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  const change = useCallback((next: CaptureMode) => {
    setNotice(null)
    setMode(next) // optimiste — l'échec remet l'état réel ET le dit
    setCaptureMode(next).catch((err: unknown) => {
      console.warn('memoria-ui : changement de mode de capture refusé', err)
      setNotice(t('capture.change_failed', { message: humanError(err) }))
      getCaptureMode()
        .then(setMode)
        .catch(() => setTick(x => x + 1))
    })
  }, [t])

  if (mode === null) {
    if (error === null) return null // premier chargement en cours
    return (
      <div className="capture-switch">
        <span className="field-label">{t('capture.title')}</span>
        <p className="muted capture-hint" role="alert">{t('capture.unavailable')}</p>
        <button type="button" className="btn btn-ghost" onClick={() => setTick(x => x + 1)}>
          {t('common.retry')}
        </button>
      </div>
    )
  }

  const current = MODES.find(m => m.id === mode)
  return (
    <div className="capture-switch">
      <span className="field-label">{t('capture.title')}</span>
      <div className="capture-options" role="radiogroup" aria-label={t('capture.title')}>
        {MODES.map(m => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            title={t(`capture.hint.${m.key}`)}
            className={`capture-option${mode === m.id ? ' capture-active' : ''}${m.id === 'incognito' && mode === m.id ? ' capture-paused' : ''}`}
            onClick={() => change(m.id)}
          >
            {t(`capture.${m.key}`)}
          </button>
        ))}
      </div>
      {current && <p className="muted capture-hint capture-help">{t(`capture.hint.${current.key}`)}</p>}
      {notice && <p className="warn capture-hint" role="status">{notice}</p>}
    </div>
  )
}

/** Sélecteur de langue de l'interface (barre latérale). */
function LangSwitch() {
  const { t, lang, setLang } = useT()
  return (
    <div className="lang-switch">
      <label className="field-label" htmlFor="lang-select">{t('lang.title')}</label>
      <select
        id="lang-select"
        className="lang-select"
        value={lang}
        onChange={e => setLang(e.target.value as Lang)}
      >
        {LANGS.map(l => (
          <option key={l.code} value={l.code}>
            {l.flag} {l.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Version installée, affichée discrètement en pied de barre latérale. */
function VersionFoot() {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getVersion()
      .then(v => {
        if (!cancelled) setLabel(v.sha ? `v${v.version} · ${v.sha}` : `v${v.version}`)
      })
      .catch(() => {
        if (!cancelled) setLabel(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (!label) return null
  return <div className="sidebar-version">{label}</div>
}

/**
 * Premier écran vu quand le token manque — lui aussi passe par les 5 catalogues
 * (il était 100 % français en dur, à rebours de la règle « 5 langues dès la V1 »).
 */
function Welcome() {
  const { t } = useT()
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand">Memoria</div>
        <h1>{t('welcome.title')}</h1>
        <p>{t('welcome.body')}</p>
        <pre className="command">memoria</pre>
        <p className="muted">{t('welcome.local')}</p>
      </div>
    </div>
  )
}
