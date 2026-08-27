import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { adoptTokenFromHash } from './api'
import { App } from './App'
import { I18nProvider } from './i18n'
import './styles.css'

// Adoption du token AVANT le premier rendu : l'URL est nettoyée immédiatement.
adoptTokenFromHash()

// Applique le thème choisi AVANT le rendu (évite le flash) ; absent = suit le système.
try {
  const th = localStorage.getItem('memoria-theme')
  if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th)
} catch {
  /* localStorage indisponible : on suit le thème système */
}

const container = document.getElementById('root')
if (!container) throw new Error('memoria-ui : élément #root introuvable dans index.html')

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
