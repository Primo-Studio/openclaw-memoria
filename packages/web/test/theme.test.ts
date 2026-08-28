/**
 * Résolution du thème (logique pure, sans DOM) : « Système » suit l'OS,
 * un choix explicite l'emporte, et `?theme=` force pour les captures.
 */
import { describe, expect, it } from 'vitest'
import { parseThemePref, resolveTheme, themeFromSearch } from '../src/lib/theme'

describe('thème', () => {
  it('parseThemePref : light/dark reconnus, tout le reste = system', () => {
    expect(parseThemePref('light')).toBe('light')
    expect(parseThemePref('dark')).toBe('dark')
    expect(parseThemePref(null)).toBe('system')
    expect(parseThemePref('auto')).toBe('system')
  })

  it('resolveTheme : system suit l’OS, un choix explicite l’emporte', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('themeFromSearch : ?theme=dark|light, sinon null', () => {
    expect(themeFromSearch('?theme=dark')).toBe('dark')
    expect(themeFromSearch('?x=1&theme=light')).toBe('light')
    expect(themeFromSearch('?theme=bleu')).toBeNull()
    expect(themeFromSearch('')).toBeNull()
  })
})
