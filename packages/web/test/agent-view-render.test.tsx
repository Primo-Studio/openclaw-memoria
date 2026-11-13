/**
 * Écran « Ce que voit l'IA » : structure HTML rendue (accessibilité, pause).
 * Rendu statique côté node, sans navigateur ni réseau. Données fictives.
 *
 * POURQUOI un rendu : ces défauts (onglets sans panneau, dl invalide, colonne
 * vidée en pause) ne se voient pas dans la logique pure, seulement dans le
 * balisage produit.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { normalizeRecallPreview } from '../src/api'
import { I18nProvider } from '../src/i18n'
import { de } from '../src/messages/de'
import { en } from '../src/messages/en'
import { es } from '../src/messages/es'
import { fr } from '../src/messages/fr'
import { pt } from '../src/messages/pt'
import { AgentColumn, SummaryLine, ViewSwitch } from '../src/screens/AgentView'

const html = (node: ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>)

/** Le libellé dans n'importe laquelle des 5 langues : le test ne dépend pas de la langue du poste. */
const anyLang = (key: string) => [fr, en, es, pt, de].map(c => c[key]!)

const memory = { id: 'o1', kind: 'fact', content: 'Le site Orion est hébergé chez Brumehost', category: 'decision', score: 0.8, created_at: '2026-01-01T00:00:00Z' }

describe('choix de la vue', () => {
  it('est un groupe NOMMÉ de boutons à bascule, sans onglet qui pointe vers un panneau absent', () => {
    const out = html(<ViewSwitch view="exact" onChange={() => {}} />)
    expect(out).toMatch(/<div role="group" aria-label="[^"]+"/)
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(1)
    expect(out).not.toContain('role="tab"')
    expect(out).not.toContain('role="tablist"')
    expect(out).not.toContain('aria-controls')
  })
})

describe('résumé de colonne', () => {
  it('dl valide : un seul div entre dl et dt/dd', () => {
    const preview = normalizeRecallPreview({ result: { items: [memory] }, renderings: [{ id: 'mcp', native: true, text: 'x', tokens: 3 }] }, { instance: 'inst-1', query: 'q' })
    const out = html(<SummaryLine preview={preview} />)
    expect(out.match(/<dt/g)).toHaveLength(4)
    expect(out).not.toMatch(/<div[^>]*><div/)
    expect(out).toMatch(/<dl[^>]*><div[^>]*><dt/)
  })
})

describe('colonne en pause', () => {
  const paused = normalizeRecallPreview(
    {
      disabled: true,
      result: { items: [memory] },
      renderings: [{ id: 'mcp', native: true, text: '{"items":[],"total_found":0,"tokens":0,"disabled":true}', tokens: 14 }],
    },
    { instance: 'inst-1', query: 'q' },
  )

  it('vue lisible : montre, sous un bandeau, ce que l’agent recevrait à la reprise', () => {
    const out = html(<AgentColumn name="Agent Atlas" run={{ status: 'ready', preview: paused }} view="readable" onRetry={() => {}} />)
    expect(anyLang('agentview.paused.resume').some(label => out.includes(label))).toBe(true)
    expect(out).toContain('Le site Orion est hébergé chez Brumehost')
    // Pas de chiffre de tokens : il compterait la réponse « en pause ».
    expect(out.match(/<dt/g)).toHaveLength(3)
  })

  it('vue brute : montre le texte réellement reçu pendant la pause', () => {
    const out = html(<AgentColumn name="Agent Atlas" run={{ status: 'ready', preview: paused }} view="exact" onRetry={() => {}} />)
    expect(anyLang('agentview.paused.exact').some(label => out.includes(label))).toBe(true)
    expect(out).toContain('&quot;disabled&quot;:true')
    expect(out).not.toContain('Le site Orion est hébergé chez Brumehost')
  })
})

describe('catalogues', () => {
  it('portugais : accords au féminin (« memórias »)', () => {
    expect(pt['agentview.dropped.title']).toBe('Descartadas: {count}')
    expect(pt['agentview.status.duplicate']).toBe('Possível duplicada')
    expect(pt['agentview.origin.declared']).toBe('Dita por ti')
    expect(pt['agentview.origin.extracted']).toBe('Recolhida numa conversa')
    expect(pt['agentview.origin.inferred']).toBe('Deduzida')
    expect(pt['agentview.origin.confirmed']).toBe('Confirmada')
  })

  it('espagnol : accord au pluriel (« recuerdos »)', () => {
    expect(es['agentview.dropped.title']).toBe('Descartados: {count}')
  })

  it('espagnol et portugais : le rappel n’est pas appelé « recherche » (terme réservé au plein texte)', () => {
    for (const catalog of [es, pt]) {
      const texts = Object.entries(catalog).filter(([key]) => key.startsWith('agentview.') || key.startsWith('docs.tabs.agentview.'))
      expect(texts.length).toBeGreaterThan(50)
      for (const [, text] of texts) expect(text).not.toMatch(/búsqueda|buscando|pesquisa|procurar/i)
    }
  })
})
