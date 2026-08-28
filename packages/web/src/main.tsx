import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { adoptTokenFromHash } from './api'
import { App } from './App'
import { I18nProvider } from './i18n'
import { installThemeController } from './lib/theme'
import './index.css'

// Adoption du token AVANT le premier rendu : l'URL est nettoyée immédiatement.
adoptTokenFromHash()

// Thème résolu (light/dark) sur <html> AVANT le rendu — le script inline de
// index.html a déjà posé l'attribut pour éviter tout flash ; ici on installe
// le suivi (préférence, ?theme=, changements de l'OS en mode Système).
installThemeController()

const container = document.getElementById('root')
if (!container) throw new Error('memoria-ui : élément #root introuvable dans index.html')

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
