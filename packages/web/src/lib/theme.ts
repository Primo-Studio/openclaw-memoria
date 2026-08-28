/**
 * Thème de l'interface — UNE source de vérité : l'attribut `data-theme` de
 * <html>, TOUJOURS résolu en `light` ou `dark` (jamais absent).
 *
 * POURQUOI résoudre « Système » côté JS plutôt qu'avec `prefers-color-scheme`
 * en CSS : les jetons (styles/tokens.css) et la variante `dark:` de Tailwind
 * sont pilotés par cet attribut ; avoir DEUX mécanismes (media query + attribut)
 * donnait des écrans mi-clairs mi-sombres (capture Néto 27/08). Ici, une
 * préférence (`system` | `light` | `dark`) est lue, résolue avec matchMedia,
 * écrite sur <html>, et le mode système suit les changements de l'OS.
 *
 * Les fonctions pures (resolveTheme, parseThemePref, themeFromSearch) sont
 * testées sans DOM ; le reste ne touche `document` qu'à l'appel.
 */
import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** Clé localStorage historique (conservée : les préférences existantes restent valides). */
export const THEME_STORAGE_KEY = 'memoria-theme'

export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  return systemDark ? 'dark' : 'light'
}

/**
 * Forçage par l'URL : `?theme=dark|light`. Sert aux captures d'écran
 * automatisées (scripts/ui-preview.mjs) et au débogage — la valeur est
 * adoptée comme préférence pour que le sélecteur de thème reste cohérent.
 */
export function themeFromSearch(search: string): ResolvedTheme | null {
  const v = new URLSearchParams(search.replace(/^\?/, '')).get('theme')
  return v === 'dark' || v === 'light' ? v : null
}

// ------------------------------------------------------------------ DOM

const listeners = new Set<() => void>()
let pref: ThemePref = 'system'
let resolved: ResolvedTheme = 'light'
let installed = false

function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

function apply(): void {
  resolved = resolveTheme(pref, systemDark())
  document.documentElement.setAttribute('data-theme', resolved)
  for (const l of listeners) l()
}

function readStoredPref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

/**
 * À appeler UNE fois avant le premier rendu : lit l'URL puis la préférence,
 * pose l'attribut, et suit l'OS tant que la préférence est « Système ».
 */
export function installThemeController(): void {
  if (installed) return
  installed = true
  const forced = themeFromSearch(window.location.search)
  if (forced) setThemePref(forced)
  else pref = readStoredPref()
  apply()
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    if (pref === 'system') apply()
  })
}

export function setThemePref(next: ThemePref): void {
  pref = next
  try {
    if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    /* localStorage indisponible : la préférence vaut pour la session */
  }
  if (installed) apply()
}

export function getThemePref(): ThemePref {
  return pref
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Préférence courante (system/light/dark) + setter — pour le sélecteur. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const p = useSyncExternalStore(subscribe, getThemePref, () => 'system' as ThemePref)
  return [p, setThemePref]
}

/** Thème EFFECTIF (light/dark) — pour les composants qui en ont besoin (toasts). */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => 'light' as ResolvedTheme)
}
