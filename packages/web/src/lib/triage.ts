/**
 * Règles PURES de l'écran Tri des souvenirs (testables hors navigateur) :
 * onglets, filtre envoyé au service, auteur lisible, date approximative,
 * nom court de la conversation source.
 */
import { TRIAGE_GENRES, type TriageFilter, type TriageGenre, type TriageRubrique, type TriageSousType, type TriageStats } from '../api'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Onglets : un par genre, plus les souvenirs sensibles (jamais envoyés à une IA, à revoir à la main). */
export type TriageTab = TriageGenre | 'sensible'
export const TRIAGE_TABS: readonly TriageTab[] = [...TRIAGE_GENRES, 'sensible']

export type AuthorChoice = 'all' | 'owner' | 'ia' | 'person' | 'inconnu'
export type StatusChoice = 'all' | 'pending' | 'validated'
export type PeriodChoice = 'all' | '7d' | '30d' | '90d' | '365d'

/** Filtres de l'écran (valeurs des listes déroulantes ; « all » = pas de filtre). */
export interface TriageScreenFilters {
  q: string
  auteur: AuthorChoice
  status: StatusChoice
  sous_type: TriageSousType | 'all'
  rubrique: TriageRubrique | 'all'
  projet: string
  period: PeriodChoice
  importance: 'all' | '1' | '2' | '3'
}

export const EMPTY_TRIAGE_FILTERS: TriageScreenFilters = {
  q: '',
  auteur: 'all',
  status: 'all',
  sous_type: 'all',
  rubrique: 'all',
  projet: '',
  period: 'all',
  importance: 'all',
}

const PERIOD_DAYS: Record<Exclude<PeriodChoice, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }

/**
 * Filtre envoyé à GET /v1/admin/triage. L'onglet « sensible » ne filtre pas
 * par genre (un souvenir sensible n'est jamais classé : il ne part pas au
 * LLM) ; le sous-type n'a de sens que pour les idées.
 */
export function triageFilterFor(tab: TriageTab, f: TriageScreenFilters, now: number = Date.now()): TriageFilter {
  // Un souvenir sensible n'apparaît que dans son onglet, même s'il porte un genre (passe sur les messages, redite).
  const out: TriageFilter = tab === 'sensible' ? { sensible: true } : { genre: [tab], sensible: false }
  if (f.q.trim()) out.q = f.q.trim()
  if (f.auteur !== 'all') out.auteur = f.auteur
  if (f.status !== 'all') out.validated = f.status === 'validated'
  if (tab === 'idee' && f.sous_type !== 'all') out.sous_type = f.sous_type
  if (f.rubrique !== 'all') out.rubrique = f.rubrique
  if (f.projet.trim()) out.projet = f.projet.trim()
  if (f.period !== 'all') out.since = new Date(now - PERIOD_DAYS[f.period] * 86_400_000).toISOString()
  if (f.importance !== 'all') out.importance_min = Number(f.importance)
  return out
}

/** Nombre affiché sur un onglet (souvenirs non marqués faux, redites comprises). */
export function tabCount(stats: TriageStats | null, tab: TriageTab): number | null {
  if (!stats) return null
  if (tab === 'sensible') return stats.sensible
  return stats.by_genre[tab]?.total ?? 0
}

/** Souvenirs triés qui attendent une validation (hors éphémère : du bruit de travail, pas à valider). */
export function pendingToValidate(stats: TriageStats): number {
  return Object.entries(stats.by_genre)
    .filter(([genre]) => genre !== 'ephemere')
    .reduce((n, [, c]) => n + c.pending, 0)
}

export type AuthorFamily = 'owner' | 'ia' | 'person' | 'inconnu'

export function authorFamily(auteur: string | null): AuthorFamily {
  if (auteur === 'owner') return 'owner'
  if (auteur?.startsWith('ia:')) return 'ia'
  if (auteur?.startsWith('person:')) return 'person'
  return 'inconnu'
}

// Noms de marque des agents (invariants dans les 5 langues).
const AI_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gpt: 'ChatGPT',
  grok: 'Grok',
  openclaw: 'OpenClaw',
  koda: 'Koda',
  cursor: 'Cursor',
}

/** « Moi », « IA · Claude », le nom d'une personne de l'équipe, ou « auteur inconnu ». */
export function authorLabel(t: Translate, auteur: string | null, persons: ReadonlyMap<string, string>): string {
  switch (authorFamily(auteur)) {
    case 'owner':
      return t('triage.author.owner')
    case 'ia': {
      const name = AI_NAMES[auteur!.slice(3)]
      return name ? t('triage.author.ai', { agent: name }) : t('triage.author.ai_other')
    }
    case 'person':
      return persons.get(auteur!.slice(7)) ?? t('triage.author.person_other')
    default:
      return t('triage.author.unknown')
  }
}

/**
 * Date de conversation « approximative » : hors fichier, archive, métadonnées
 * de l'export et date de création d'un fait direct, la date vient de l'import
 * ou de l'état du fichier, pas de la conversation elle-même.
 */
export function isApproximateDate(source: string): boolean {
  return !['fichier', 'archive', 'metadata', 'creation'].includes(source)
}

/** Nom court d'une conversation source (dernier segment du chemin). Le chemin entier reste en infobulle. */
export function sourceName(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
