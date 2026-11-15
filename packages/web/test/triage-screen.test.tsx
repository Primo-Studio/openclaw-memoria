/**
 * Écran Tri des souvenirs : règles pures (filtre envoyé, auteur lisible, date
 * approximative, montants), client HTTP (curseur opaque, DELETE pour
 * l'arrêt, partage), et rendu d'une ligne (tout ce qui permet de juger un
 * souvenir). Rendu statique côté node, sans navigateur ni réseau. Données fictives.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelTriageRun, getTriageList, promoteTriage, triageQuery, type TriageItem, type TriageStats } from '../src/api'
import { I18nProvider } from '../src/i18n'
import { de } from '../src/messages/de'
import { en } from '../src/messages/en'
import { es } from '../src/messages/es'
import { fr } from '../src/messages/fr'
import { pt } from '../src/messages/pt'
import { authorLabel, EMPTY_TRIAGE_FILTERS, isApproximateDate, pendingToValidate, sourceName, tabCount, triageFilterFor } from '../src/lib/triage'
import { estimateText, TriageCard, usd } from '../src/screens/Triage'

const html = (node: ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>)
const anyLang = (key: string) => [fr, en, es, pt, de].map(c => c[key]!)
const interpolate = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]))
/** Vrai si `out` contient la clé rendue dans l'une des 5 langues (le test ne dépend pas de la langue du poste). */
const hasText = (out: string, key: string, vars: Record<string, string | number> = {}) => anyLang(key).some(v => out.includes(interpolate(v, vars)))

afterEach(() => {
  vi.unstubAllGlobals()
})

const ITEM: TriageItem = {
  fact_id: 'f-1',
  text: 'Créer une application qui aide les jardins partagés à planifier leurs semis.',
  category: 'general',
  genre: 'idee',
  sous_type: 'app',
  rubriques: ['app'],
  person_id: null,
  auteur: 'ia:claude',
  auteur_source: 'message',
  approuve_par_owner: false,
  importance: 3,
  projet: 'Jardins partagés',
  titre: 'App de planification des semis',
  citation: null,
  entites: ['Lumen', 'Orion', 'Vega', 'Atlas'],
  conversation_at: '2026-09-03T08:12:00.000Z',
  conversation_at_source: 'import',
  amas_size: 3,
  sensible: false,
  verdict: null,
  llm_failures: 0,
  validated: false,
  source_db: 'assistants/i/memory.sqlite',
  instance_id: 'i',
  source_path: '/tmp/demo/projects/-demo/session-semis.jsonl',
}

describe('filtre envoyé au service', () => {
  it('onglet de genre, auteur, statut, sous-type (idées seulement), période, importance', () => {
    const now = Date.parse('2026-11-14T00:00:00.000Z')
    const f = triageFilterFor('idee', { ...EMPTY_TRIAGE_FILTERS, q: ' semis ', auteur: 'ia', status: 'pending', sous_type: 'app', period: '30d', importance: '2' }, now)
    expect(f).toEqual({ genre: ['idee'], sensible: false, q: 'semis', auteur: 'ia', validated: false, sous_type: 'app', since: '2026-10-15T00:00:00.000Z', importance_min: 2 })
    // Sous-type ignoré hors idées ; un onglet de genre ne montre jamais un sensible ; onglet « sensibles » : aucun genre.
    expect(triageFilterFor('decision', { ...EMPTY_TRIAGE_FILTERS, sous_type: 'app' })).toEqual({ genre: ['decision'], sensible: false })
    expect(triageFilterFor('sensible', EMPTY_TRIAGE_FILTERS)).toEqual({ sensible: true })
  })

  it('paramètres d’URL : liste de genres, curseur rendu tel quel (opaque), champs vides omis', () => {
    expect(triageQuery({ genre: ['idee', 'decision'], validated: false, projet: '  ' }, { cursor: 'eyJhIjoxfQ', limit: 50 })).toBe(
      '?genre=idee%2Cdecision&validated=false&limit=50&cursor=eyJhIjoxfQ',
    )
    expect(triageQuery({})).toBe('')
  })

  it('compteurs : onglet par genre ou sensibles ; « à valider » hors éphémère', () => {
    const stats = {
      sensible: 4,
      by_genre: { idee: { total: 6, validated: 1, pending: 5 }, ephemere: { total: 9, validated: 0, pending: 9 }, decision: { total: 2, validated: 0, pending: 2 } },
    } as unknown as TriageStats
    expect(tabCount(stats, 'idee')).toBe(6)
    expect(tabCount(stats, 'sensible')).toBe(4)
    expect(tabCount(stats, 'lecon')).toBe(0)
    expect(tabCount(null, 'idee')).toBeNull()
    expect(pendingToValidate(stats)).toBe(7)
  })
})

describe('libellés', () => {
  const t = (key: string, vars?: Record<string, string | number>) => interpolate(fr[key] ?? key, vars ?? {})
  it('auteur : moi, une IA nommée, une personne de l’équipe, inconnu', () => {
    const persons = new Map([['p-1', 'Camille Fictive']])
    expect(authorLabel(t, 'owner', persons)).toBe('Moi')
    expect(authorLabel(t, 'ia:claude', persons)).toBe('IA · Claude')
    expect(authorLabel(t, 'ia:autre', persons)).toBe('Une IA')
    expect(authorLabel(t, 'person:p-1', persons)).toBe('Camille Fictive')
    expect(authorLabel(t, 'person:p-2', persons)).toBe('Quelqu’un de l’équipe')
    expect(authorLabel(t, null, persons)).toBe('Auteur inconnu')
  })

  it('date approximative hors fichier, archive, export et création ; nom court de la source', () => {
    expect(isApproximateDate('fichier')).toBe(false)
    expect(isApproximateDate('creation')).toBe(false)
    expect(isApproximateDate('import')).toBe(true)
    expect(isApproximateDate('etat')).toBe(true)
    expect(sourceName('/a/b/session.jsonl')).toBe('session.jsonl')
    expect(sourceName(null)).toBeNull()
  })

  it('confirmation du lancement : coût et modèle, ou « tout est déjà trié » quand rien ne partirait', () => {
    const e = { facts_pending: 1200, facts_active: 10, facts_sensible: 8, facts_to_embed: 0, llm_facts_max: 1192, llm_calls_max: 60, cost_usd: 0.07, provider: 'openai', model: 'gpt-4o-mini', budget_usd: 5, within_budget: true }
    const text = estimateText(t, e)
    expect(text).toContain('gpt-4o-mini')
    expect(text).toMatch(/0[,.]070 \$/)
    expect(text).toContain('60')
    expect(estimateText(t, { ...e, facts_pending: 0 })).toBe(fr['triage.estimate.nothing'])
  })

  it('montants : une petite dépense ne s’affiche jamais « 0,00 »', () => {
    expect(usd(t, 0.0043)).not.toMatch(/^0[,.]00\b/)
    expect(usd(t, 0.0043)).toMatch(/0[,.]0043/)
    expect(usd(t, 4.13)).toMatch(/4[,.]13/)
    expect(usd(t, null)).toBe('coût inconnu')
  })
})

describe('client HTTP du tri', () => {
  const stub = () => {
    const store = new Map([['memoria.admin_token', 'jeton-admin']])
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], next_cursor: null, cancelled: true, promoted: 1, shared: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
  }

  it('liste : GET avec le filtre ; arrêt : DELETE ; valider et partager : un seul POST promote avec share', async () => {
    const calls = stub()
    await getTriageList({ genre: ['idee'] }, { cursor: 'abc_-' })
    expect(calls[0]![0]).toBe('/v1/admin/triage?genre=idee&cursor=abc_-')
    expect(calls[0]![1].method).toBe('GET')
    expect(await cancelTriageRun()).toBe(true)
    expect(calls[1]![0]).toBe('/v1/admin/triage/run')
    expect(calls[1]![1].method).toBe('DELETE')
    await promoteTriage(['f-1'], { share: true })
    expect(calls[2]![0]).toBe('/v1/admin/triage/promote')
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ fact_ids: ['f-1'], share: true })
  })
})

describe('ligne du tri', () => {
  it('montre titre, texte, statut, auteur vérifié, « dit N fois », entités (+N), date approximative et source', () => {
    const out = html(<TriageCard item={ITEM} persons={new Map()} onValidate={() => {}} onShare={() => {}} onCorrect={() => {}} onFalse={() => {}} />)
    expect(out).toContain('App de planification des semis')
    expect(out).toContain('jardins partagés à planifier leurs semis')
    expect(hasText(out, 'triage.status.pending')).toBe(true)
    expect(hasText(out, 'triage.author.ai', { agent: 'Claude' })).toBe(true)
    expect(hasText(out, 'triage.author_source.message')).toBe(true)
    expect(hasText(out, 'triage.said_times', { count: 3 })).toBe(true)
    for (const e of ['Lumen', 'Orion', 'Vega']) expect(out).toContain(e)
    expect(out).not.toContain('>Atlas<')
    expect(out).toContain('+1')
    expect(hasText(out, 'triage.date_approx')).toBe(true)
    expect(hasText(out, 'triage.source', { name: 'session-semis.jsonl' })).toBe(true)
    expect(out).toContain('title="/tmp/demo/projects/-demo/session-semis.jsonl"')
    expect(hasText(out, 'triage.action.validate')).toBe(true)
    expect(hasText(out, 'triage.action.share')).toBe(true)
    expect(hasText(out, 'triage.action.mark_false')).toBe(true)
  })

  it('style d’une autre personne : dit de qui il s’agit', () => {
    const out = html(<TriageCard item={{ ...ITEM, genre: 'style', sous_type: null, titre: null, person_id: 'p-1' }} persons={new Map([['p-1', 'Camille Fictive']])} />)
    expect(hasText(out, 'triage.concerns', { name: 'Camille Fictive' })).toBe(true)
    const owner = html(<TriageCard item={{ ...ITEM, genre: 'style', sous_type: null, titre: null, person_id: null }} persons={new Map()} />)
    expect(owner).not.toContain('Camille Fictive')
  })

  it('validé : plus de bouton « Valider » ; sensible : « Pas sensible », jamais « Partager »', () => {
    const validated = html(<TriageCard item={{ ...ITEM, validated: true }} persons={new Map()} onValidate={() => {}} onShare={() => {}} />)
    expect(anyLang('triage.action.validate').some(v => validated.includes(`</svg>${v}</button>`))).toBe(false)
    expect(hasText(validated, 'triage.status.validated')).toBe(true)
    const sensitive = html(
      <TriageCard
        item={{ ...ITEM, genre: null, sous_type: null, titre: null, auteur: null, sensible: true }}
        persons={new Map()}
        onValidate={() => {}}
        onShare={() => {}}
        onNotSensitive={() => {}}
      />,
    )
    expect(hasText(sensitive, 'triage.action.not_sensitive')).toBe(true)
    expect(hasText(sensitive, 'triage.sensitive_badge')).toBe(true)
    expect(hasText(sensitive, 'triage.action.share')).toBe(false)
  })
})
