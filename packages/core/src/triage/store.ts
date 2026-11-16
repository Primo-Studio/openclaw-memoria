/**
 * Accès SQL à `fact_triage` (une base de contenu). Le statut « validé » n'est
 * jamais stocké : il se lit dans facts.lifecycle_state.
 */
import type { Database } from 'better-sqlite3'
import { toFtsQuery } from '../storage/content.js'
import { isSensitive } from './sensitive.js'
import type {
  AuteurPreuve,
  Genre,
  TriageCorrection,
  TriageCursor,
  TriageListFilter,
  TriageRow,
  TriageStats,
} from './types.js'

/** Colonnes écrites par un passage (jamais `verdict`, `corrected_at`, `corrected_fields`). */
const WRITE_COLUMNS = [
  'genre',
  'sous_type',
  'rubriques',
  'portee',
  'person_id',
  'auteur',
  'auteur_source',
  'auteur_preuve',
  'approuve_par_owner',
  'durabilite',
  'importance',
  'autonome',
  'projet',
  'titre',
  'citation',
  'entites',
  'conversation_at',
  'conversation_at_source',
  'origine',
  'amas_id',
  'amas_size',
  'same_as_active',
  'sensible',
  'secret_found',
  'raison',
  'modele',
  'prompt_version',
  'triaged_at',
  'llm_failures',
] as const

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const v = JSON.parse(value) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parsePreuve(value: unknown): AuteurPreuve | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    return JSON.parse(value) as AuteurPreuve
  } catch {
    return null
  }
}

/** Ligne SQL → TriageRow. */
export function rowFromDb(r: Record<string, unknown>): TriageRow {
  return {
    fact_id: String(r.fact_id),
    genre: (r.genre as Genre | null) ?? null,
    sous_type: (r.sous_type as TriageRow['sous_type']) ?? null,
    rubriques: parseJsonArray(r.rubriques) as TriageRow['rubriques'],
    portee: (r.portee as TriageRow['portee']) ?? null,
    person_id: (r.person_id as string | null) ?? null,
    auteur: (r.auteur as TriageRow['auteur']) ?? null,
    auteur_source: (r.auteur_source as TriageRow['auteur_source']) ?? 'inconnu',
    auteur_preuve: parsePreuve(r.auteur_preuve),
    approuve_par_owner: r.approuve_par_owner === 1,
    durabilite: (r.durabilite as number | null) ?? null,
    importance: (r.importance as number | null) ?? null,
    autonome: r.autonome === null || r.autonome === undefined ? null : r.autonome === 1,
    projet: (r.projet as string | null) ?? null,
    titre: (r.titre as string | null) ?? null,
    citation: (r.citation as string | null) ?? null,
    entites: parseJsonArray(r.entites),
    conversation_at: (r.conversation_at as string | null) ?? null,
    conversation_at_source: (r.conversation_at_source as TriageRow['conversation_at_source']) ?? 'inconnu',
    origine: (r.origine as TriageRow['origine']) ?? null,
    amas_id: (r.amas_id as string | null) ?? null,
    amas_size: (r.amas_size as number | null) ?? 1,
    same_as_active: (r.same_as_active as string | null) ?? null,
    sensible: r.sensible === 1,
    secret_found: r.secret_found === 1,
    verdict: (r.verdict as TriageRow['verdict']) ?? null,
    raison: (r.raison as string | null) ?? null,
    modele: (r.modele as string | null) ?? null,
    prompt_version: (r.prompt_version as string | null) ?? null,
    triaged_at: String(r.triaged_at),
    corrected_at: (r.corrected_at as string | null) ?? null,
    corrected_fields: parseJsonArray(r.corrected_fields),
    llm_failures: (r.llm_failures as number | null) ?? 0,
  }
}

function toDbParams(row: TriageRow): Record<string, unknown> {
  return {
    fact_id: row.fact_id,
    genre: row.genre,
    sous_type: row.sous_type,
    rubriques: JSON.stringify(row.rubriques),
    portee: row.portee,
    person_id: row.person_id,
    auteur: row.auteur,
    auteur_source: row.auteur_source,
    auteur_preuve: row.auteur_preuve ? JSON.stringify(row.auteur_preuve) : null,
    approuve_par_owner: row.approuve_par_owner ? 1 : 0,
    durabilite: row.durabilite,
    importance: row.importance,
    autonome: row.autonome === null ? null : row.autonome ? 1 : 0,
    projet: row.projet,
    titre: row.titre,
    citation: row.citation,
    entites: JSON.stringify(row.entites),
    conversation_at: row.conversation_at,
    conversation_at_source: row.conversation_at_source,
    origine: row.origine,
    amas_id: row.amas_id,
    amas_size: row.amas_size,
    same_as_active: row.same_as_active,
    sensible: row.sensible ? 1 : 0,
    secret_found: row.secret_found ? 1 : 0,
    verdict: row.verdict,
    raison: row.raison,
    modele: row.modele,
    prompt_version: row.prompt_version,
    triaged_at: row.triaged_at,
    corrected_at: row.corrected_at,
    corrected_fields: JSON.stringify(row.corrected_fields),
    llm_failures: row.llm_failures,
  }
}

/** Ligne vide (tous champs à leur défaut) pour un fait. */
export function emptyRow(factId: string, triagedAt: string): TriageRow {
  return {
    fact_id: factId,
    genre: null,
    sous_type: null,
    rubriques: [],
    portee: null,
    person_id: null,
    auteur: null,
    auteur_source: 'inconnu',
    auteur_preuve: null,
    approuve_par_owner: false,
    durabilite: null,
    importance: null,
    autonome: null,
    projet: null,
    titre: null,
    citation: null,
    entites: [],
    conversation_at: null,
    conversation_at_source: 'inconnu',
    origine: null,
    amas_id: null,
    amas_size: 1,
    same_as_active: null,
    sensible: false,
    secret_found: false,
    verdict: null,
    raison: null,
    modele: null,
    prompt_version: null,
    triaged_at: triagedAt,
    corrected_at: null,
    corrected_fields: [],
    llm_failures: 0,
  }
}

/**
 * Écrit des lignes (à appeler dans une transaction). Une ligne CORRIGÉE à la
 * main n'est jamais réécrite ; `verdict` et la trace de correction non plus.
 */
export function upsertTriageRows(db: Database, rows: readonly TriageRow[]): void {
  if (rows.length === 0) return
  const cols = ['fact_id', ...WRITE_COLUMNS, 'verdict', 'corrected_at', 'corrected_fields']
  const stmt = db.prepare(
    `INSERT INTO fact_triage (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})
     ON CONFLICT(fact_id) DO UPDATE SET ${WRITE_COLUMNS.map(c => `${c} = excluded.${c}`).join(', ')}
     WHERE fact_triage.corrected_at IS NULL`,
  )
  for (const row of rows) stmt.run(toDbParams(row))
}

/** Lignes de tri existantes pour des faits (toutes colonnes). */
export function readTriageRows(db: Database, factIds: readonly string[]): TriageRow[] {
  if (factIds.length === 0) return []
  const rows = db
    .prepare('SELECT * FROM fact_triage WHERE fact_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(factIds)) as Array<Record<string, unknown>>
  return rows.map(rowFromDb)
}

/** Recopie brute de lignes `fact_triage` et `fact_triage_vectors` (partage : la ligne suit le fait). */
export function copyTriageRows(from: Database, to: Database, factIds: readonly string[]): number {
  if (factIds.length === 0) return 0
  const ids = JSON.stringify(factIds)
  const rows = from.prepare('SELECT * FROM fact_triage WHERE fact_id IN (SELECT value FROM json_each(?))').all(ids) as Array<
    Record<string, unknown>
  >
  const vectors = from
    .prepare('SELECT * FROM fact_triage_vectors WHERE fact_id IN (SELECT value FROM json_each(?))')
    .all(ids) as Array<Record<string, unknown>>
  const present = new Set(
    (to.prepare('SELECT id FROM facts WHERE id IN (SELECT value FROM json_each(?))').all(ids) as Array<{ id: string }>).map(r => r.id),
  )
  const tx = to.transaction(() => {
    let n = 0
    for (const r of rows) {
      if (!present.has(String(r.fact_id))) continue
      const cols = Object.keys(r)
      to.prepare(`INSERT OR REPLACE INTO fact_triage (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(r)
      n++
    }
    for (const v of vectors) {
      if (!present.has(String(v.fact_id))) continue
      to.prepare('INSERT OR REPLACE INTO fact_triage_vectors (fact_id, model, dimensions, vector) VALUES (@fact_id, @model, @dimensions, @vector)').run(v)
    }
    return n
  })
  return tx()
}

// ---------------------------------------------------------------- liste

interface ListQuery {
  where: string[]
  params: unknown[]
}

/** Conditions SQL d'un filtre de liste (alias t = fact_triage, f = facts). */
export function filterConditions(filter: TriageListFilter): ListQuery {
  const where: string[] = [
    'f.superseded = 0',
    'f.deleted_at IS NULL',
    "f.lifecycle_state IN ('active','dormant')",
  ]
  const params: unknown[] = []
  const genres = filter.genre === undefined ? [] : Array.isArray(filter.genre) ? filter.genre : [filter.genre]
  if (genres.length > 0) {
    where.push(`t.genre IN (${genres.map(() => '?').join(',')})`)
    params.push(...genres)
  }
  if (filter.sous_type) {
    where.push('t.sous_type = ?')
    params.push(filter.sous_type)
  }
  if (filter.auteur) {
    if (filter.auteur === 'ia' || filter.auteur === 'person') {
      where.push('t.auteur LIKE ?')
      params.push(`${filter.auteur}:%`)
    } else {
      where.push('t.auteur = ?')
      params.push(filter.auteur)
    }
  }
  if (filter.auteur_source) {
    where.push('t.auteur_source = ?')
    params.push(filter.auteur_source)
  }
  if (filter.rubrique) {
    where.push('EXISTS (SELECT 1 FROM json_each(t.rubriques) WHERE value = ?)')
    params.push(filter.rubrique)
  }
  if (filter.portee) {
    where.push('t.portee = ?')
    params.push(filter.portee)
  }
  if (filter.projet) {
    where.push("LOWER(COALESCE(t.projet, '')) LIKE ?")
    params.push(`%${filter.projet.toLowerCase()}%`)
  }
  if (typeof filter.importance_min === 'number') {
    where.push('t.importance >= ?')
    params.push(filter.importance_min)
  }
  if (filter.validated === true) where.push("f.lifecycle_state = 'active'")
  if (filter.validated === false) where.push("f.lifecycle_state = 'dormant'")
  if (filter.person_id !== undefined) {
    if (filter.person_id === null) where.push('t.person_id IS NULL')
    else {
      where.push('t.person_id = ?')
      params.push(filter.person_id)
    }
  }
  if (!filter.include_members) where.push('(t.amas_id IS NULL OR t.amas_id = t.fact_id)', 't.same_as_active IS NULL')
  if (!filter.include_faux) where.push('t.verdict IS NULL')
  if (filter.sensible === true) where.push('t.sensible = 1')
  if (filter.sensible === false) where.push('t.sensible = 0')
  if (filter.since) {
    where.push('t.conversation_at >= ?')
    params.push(filter.since)
  }
  if (filter.until) {
    where.push('t.conversation_at <= ?')
    params.push(filter.until)
  }
  if (filter.q) {
    const match = toFtsQuery(filter.q)
    if (match) {
      where.push('f.rowid IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?)')
      params.push(match)
    } else where.push('0')
  }
  return { where, params }
}

export interface ListRow {
  row: TriageRow
  text: string
  category: string
  lifecycle_state: string
  assistant_instance_id: string | null
  source_path: string | null
}

/** Une page d'une base, triée par (conversation_at, fact_id) décroissants, après le curseur. */
export function listPage(db: Database, filter: TriageListFilter, cursor: TriageCursor | null, limit: number): ListRow[] {
  const { where, params } = filterConditions(filter)
  if (cursor) {
    where.push("(COALESCE(t.conversation_at, ''), t.fact_id) < (?, ?)")
    params.push(cursor.conversation_at, cursor.fact_id)
  }
  const rows = db
    .prepare(
      `SELECT t.*, f.fact AS f_text, f.category AS f_category, f.lifecycle_state AS f_lifecycle,
              f.assistant_instance_id AS f_instance,
              (SELECT s.source_path FROM memory_import_items i JOIN memory_sources s ON s.id = i.source_id
                WHERE i.target_memory_id = f.id LIMIT 1) AS f_source_path
       FROM fact_triage t JOIN facts f ON f.id = t.fact_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(t.conversation_at, '') DESC, t.fact_id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>
  return rows.map(r => ({
    row: rowFromDb(r),
    text: String(r.f_text),
    category: String(r.f_category),
    lifecycle_state: String(r.f_lifecycle),
    assistant_instance_id: (r.f_instance as string | null) ?? null,
    source_path: (r.f_source_path as string | null) ?? null,
  }))
}

// ---------------------------------------------------------------- statistiques

const LIVE = "f.superseded = 0 AND f.deleted_at IS NULL AND f.lifecycle_state IN ('active','dormant')"

/** Drapeaux d'une ligne de tri, calculés en SQL (une seule lecture de la table). */
const FLAG_MEMBER = 1
const FLAG_TWIN = 2
const FLAG_FAUX = 4
const FLAG_SENSIBLE = 8
const FLAG_FAILED = 16
const FLAG_AMAS_HEAD = 32
/** Cachée par le filtre par défaut de la liste (membre d'amas, redite d'un actif, marquée faux). */
const HIDDEN_BY_DEFAULT = FLAG_MEMBER | FLAG_TWIN | FLAG_FAUX

/**
 * UNE lecture de `fact_triage` (tranche de rowid) groupée par genre, état,
 * famille d'auteur et drapeaux : quelques centaines de groupes au plus, d'où
 * tous les compteurs se déduisent. Avant : une dizaine de COUNT sur toute la
 * table, environ 580 ms de SQL bloquant sur 70 000 faits.
 */
const STATS_SLICE_SQL = `SELECT t.genre AS genre, f.lifecycle_state AS state,
    CASE WHEN t.auteur IS NULL THEN 'null' WHEN t.auteur LIKE 'ia:%' THEN 'ia' WHEN t.auteur LIKE 'person:%' THEN 'person'
         ELSE t.auteur END AS a,
    ((t.amas_id IS NOT NULL AND t.amas_id != t.fact_id) * ${FLAG_MEMBER}
      + (t.same_as_active IS NOT NULL) * ${FLAG_TWIN}
      + (t.verdict IS NOT NULL) * ${FLAG_FAUX}
      + (t.sensible = 1) * ${FLAG_SENSIBLE}
      + (t.genre IS NULL AND t.sensible = 0 AND t.llm_failures > 0) * ${FLAG_FAILED}
      + (t.amas_id IS NOT NULL AND t.amas_id = t.fact_id AND t.amas_size > 1) * ${FLAG_AMAS_HEAD}) AS flags,
    COUNT(*) AS n
  FROM fact_triage t CROSS JOIN facts f ON f.id = t.fact_id
  WHERE t.rowid >= ? AND t.rowid < ? AND ${LIVE}
  GROUP BY 1, 2, 3, 4`

const FACTS_SLICE_SQL = `SELECT COUNT(*) AS n FROM facts f WHERE f.rowid >= ? AND f.rowid < ? AND ${LIVE}`

/** Lignes de tri lues par tranche dans `addStatsAsync` (environ 15 ms de SQL sur un Mac récent). */
export const STATS_SLICE_ROWS = 10_000

interface StatsGroup {
  genre: string | null
  state: string
  a: string
  flags: number
  n: number
}

function addGroups(into: TriageStats, groups: StatsGroup[]): void {
  for (const g of groups) {
    const has = (flag: number): boolean => (g.flags & flag) !== 0
    into.triaged += g.n
    // Mêmes lignes que l'onglet : la liste par défaut ne montre ni les
    // membres d'amas, ni les redites d'un actif, ni les faux.
    const shown = (g.flags & HIDDEN_BY_DEFAULT) === 0
    if (has(FLAG_SENSIBLE) && shown) into.sensible += g.n
    if (has(FLAG_FAILED)) into.failed += g.n
    if (has(FLAG_FAUX)) into.faux += g.n
    if (has(FLAG_TWIN)) into.same_as_active += g.n
    if (has(FLAG_AMAS_HEAD)) into.amas += g.n
    if (has(FLAG_MEMBER)) into.redites += g.n
    if (g.genre !== null && shown) {
      const entry = (into.by_genre[g.genre] ??= { total: 0, validated: 0, pending: 0 })
      entry.total += g.n
      if (g.state === 'active') entry.validated += g.n
      else entry.pending += g.n
    }
    into.by_auteur[g.a] = (into.by_auteur[g.a] ?? 0) + g.n
  }
}

function maxRowid(db: Database, table: 'facts' | 'fact_triage'): number {
  return Number((db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() as { m: number | null }).m ?? 0)
}

/** Ajoute les statistiques d'une base à `into` (synchrone : une lecture de chaque table). */
export function addStats(db: Database, into: TriageStats): void {
  into.facts_total += (db.prepare(FACTS_SLICE_SQL).get(0, maxRowid(db, 'facts') + 1) as { n: number }).n
  addGroups(into, db.prepare(STATS_SLICE_SQL).all(0, maxRowid(db, 'fact_triage') + 1) as StatsGroup[])
}

/**
 * Comme addStats, par tranches de rowid, en rendant la main à la boucle
 * d'événements entre deux tranches (ticket #27 : le daemon ne se fige jamais
 * plus de ~200 ms). Aucune transaction ne couvre les tranches : un passage en
 * cours peut décaler les compteurs de quelques lignes, jamais les bloquer.
 */
export async function addStatsAsync(
  db: Database,
  into: TriageStats,
  opts: { sliceRows?: number; yieldFn?: () => Promise<void> } = {},
): Promise<void> {
  const size = Math.max(1, Math.floor(opts.sliceRows ?? STATS_SLICE_ROWS))
  const pause = opts.yieldFn ?? ((): Promise<void> => new Promise(resolve => setImmediate(resolve)))
  const facts = db.prepare(FACTS_SLICE_SQL)
  const factsMax = maxRowid(db, 'facts')
  // Le comptage des faits ne lit que l'index (lifecycle_state, superseded) et la ligne : tranches doubles.
  for (let lo = 0; lo <= factsMax; lo += size * 2) {
    into.facts_total += (facts.get(lo, lo + size * 2) as { n: number }).n
    await pause()
  }
  const slice = db.prepare(STATS_SLICE_SQL)
  const triageMax = maxRowid(db, 'fact_triage')
  for (let lo = 0; lo <= triageMax; lo += size) {
    addGroups(into, slice.all(lo, lo + size) as StatsGroup[])
    await pause()
  }
}

export function emptyStats(): TriageStats {
  return {
    facts_total: 0,
    triaged: 0,
    untriaged: 0,
    sensible: 0,
    failed: 0,
    faux: 0,
    same_as_active: 0,
    amas: 0,
    redites: 0,
    by_genre: {},
    by_auteur: {},
  }
}

// ---------------------------------------------------------------- corrections

/** Correction à la main. Rend false si le fait n'a pas de ligne de tri dans cette base. */
export function applyCorrection(db: Database, correction: TriageCorrection, now: string): boolean {
  const existing = db.prepare('SELECT corrected_fields FROM fact_triage WHERE fact_id = ?').get(correction.fact_id) as
    | { corrected_fields: string }
    | undefined
  const fact = db.prepare('SELECT fact FROM facts WHERE id = ?').get(correction.fact_id) as { fact: string } | undefined
  if (!fact) return false
  const sets: string[] = []
  const params: Record<string, unknown> = { fact_id: correction.fact_id, now }
  const fields: string[] = []
  const put = (col: string, value: unknown): void => {
    sets.push(`${col} = @${col}`)
    params[col] = value
    fields.push(col)
  }
  if (correction.genre !== undefined) put('genre', correction.genre)
  if (correction.sous_type !== undefined) put('sous_type', correction.sous_type)
  if (correction.auteur !== undefined) put('auteur', correction.auteur)
  if (correction.rubriques !== undefined) put('rubriques', JSON.stringify(correction.rubriques))
  if (correction.portee !== undefined) put('portee', correction.portee)
  if (correction.projet !== undefined) put('projet', correction.projet)
  if (correction.titre !== undefined) put('titre', correction.titre)
  if (correction.importance !== undefined) put('importance', Math.max(0, Math.min(3, Math.round(correction.importance))))
  if (correction.person_id !== undefined) put('person_id', correction.person_id)
  // Faux positif du filtre sensible levé à la main : le fait redevient validable
  // normalement (il ne repart pas au LLM : une ligne corrigée n'est jamais réécrite).
  if (correction.sensible !== undefined) put('sensible', correction.sensible ? 1 : 0)
  if (fields.length === 0) return false
  if (!existing) {
    // Fait jamais trié : la ligne naît ici, et une ligne corrigée n'est jamais
    // réécrite par un passage. Le filtre sensible local décide donc tout de
    // suite (paie, santé, mot de passe…), sinon le fait serait validable et
    // rappelé comme un fait ordinaire. Une correction qui porte `sensible`
    // l'emporte (UPDATE ci-dessous) ; la valeur calculée n'est pas une correction.
    db.prepare("INSERT INTO fact_triage (fact_id, triaged_at, auteur_source, sensible) VALUES (?, ?, 'inconnu', ?)").run(
      correction.fact_id,
      now,
      isSensitive(fact.fact) ? 1 : 0,
    )
  }
  const merged = [...new Set([...(existing ? JSON.parse(existing.corrected_fields || '[]') as string[] : []), ...fields])]
  params.corrected_fields = JSON.stringify(merged)
  db.prepare(
    `UPDATE fact_triage SET ${sets.join(', ')}, corrected_at = @now, corrected_fields = @corrected_fields WHERE fact_id = @fact_id`,
  ).run(params)
  return true
}

// ---------------------------------------------------------------- passe styles

/** Largeur (en rowid) d'une fenêtre du parcours des sources du mode person (même mesure que le repérage du moteur). */
export const STYLE_SOURCES_WINDOW = 2000

/**
 * Faits triés candidats d'une fenêtre de rowid (alias f = facts, t =
 * fact_triage) : ni oubliés, ni remplacés, ni archivés, sensibilité normale,
 * genre connu hors `ephemere`, ni faux, ni sensibles, ni tirés par la passe
 * styles (`prompt_version` du 3e paramètre), dans un scope lisible (liste JSON
 * du 4e paramètre), sans client (filtre dur du rappel : le style écrit n'a pas
 * de client, il serait lisible dans tous les contextes). L'expiration, les
 * rubriques et le nom cité se vérifient ensuite en JS (l'expiration avec
 * Date.parse, comme le rappel : en SQL, la date serait comparée comme du texte).
 */
const STYLE_SOURCES_SQL = `SELECT f.id AS id, f.fact AS fact, f.created_at AS created_at, f.expires_at AS expires_at,
       t.conversation_at AS conversation_at, t.conversation_at_source AS at_source, t.rubriques AS rubriques
  FROM facts f JOIN fact_triage t ON t.fact_id = f.id
  WHERE f.rowid > ? AND f.rowid <= ?
    AND f.superseded = 0 AND f.deleted_at IS NULL AND f.lifecycle_state IN ('active','dormant')
    AND f.sensitivity = 'normal'
    AND t.genre IS NOT NULL AND t.genre != 'ephemere'
    AND t.verdict IS NULL AND t.sensible = 0
    AND (t.prompt_version IS NULL OR t.prompt_version != ?)
    AND f.scope_id IN (SELECT value FROM json_each(?))
    AND (f.client_org_id IS NULL OR f.client_org_id = '')`

/**
 * Parcours des sources du mode person dans une base, par fenêtres de rowid
 * bornées, en rendant la main entre deux fenêtres (ticket #27). Comme le
 * repérage du moteur, chaque fenêtre s'arrête au max relu après la cession :
 * un fait ajouté pendant le parcours est vu.
 */
export async function scanStyleSourcesAsync(
  db: Database,
  opts: {
    match: (text: string) => boolean
    excludePromptVersion: string
    /** Scopes lisibles dans cette base (resolveReadTargets) : un fait hors de ces scopes n'est jamais lu. */
    scopeIds: readonly string[]
    /** Horloge de l'expiration (ms) ; défaut maintenant. */
    now?: number
    stop?: () => boolean
    window?: number
    yieldFn?: () => Promise<void>
  },
): Promise<{ facts: Array<{ id: string; text: string; at: string; at_source: string; rubriques: string[] }>; scanned: number }> {
  const size = Math.max(1, Math.floor(opts.window ?? STYLE_SOURCES_WINDOW))
  const pause = opts.yieldFn ?? ((): Promise<void> => new Promise(resolve => setImmediate(resolve)))
  const stmt = db.prepare(STYLE_SOURCES_SQL)
  const scopes = JSON.stringify(opts.scopeIds)
  const now = opts.now ?? Date.now()
  const out: Array<{ id: string; text: string; at: string; at_source: string; rubriques: string[] }> = []
  let scanned = 0
  for (let last = 0, top = maxRowid(db, 'facts'); last < top; top = maxRowid(db, 'facts')) {
    const hi = Math.min(last + size, top)
    const rows = stmt.all(last, hi, opts.excludePromptVersion, scopes) as Array<{
      id: string
      fact: string
      created_at: string
      expires_at: string | null
      conversation_at: string | null
      at_source: string
      rubriques: string
    }>
    scanned += rows.length
    for (const r of rows) {
      // Expiré : jamais envoyé (même règle que passesRecallHardFilters).
      if (r.expires_at && Date.parse(r.expires_at) <= now) continue
      if (!opts.match(r.fact)) continue
      let rubriques: string[] = []
      try {
        const parsed = JSON.parse(r.rubriques || '[]') as unknown
        if (Array.isArray(parsed)) rubriques = parsed.filter((x): x is string => typeof x === 'string')
      } catch {
        /* rubriques illisibles : traitées comme vides, le filtre sensible reste appliqué */
      }
      out.push({
        id: r.id,
        text: r.fact,
        at: r.conversation_at ?? r.created_at,
        at_source: r.conversation_at ? r.at_source : 'creation',
        rubriques,
      })
    }
    last = hi
    await pause()
    if (opts.stop?.()) break
  }
  return { facts: out, scanned }
}

/** État d'une période de la passe styles (null : jamais traitée). */
export function readStyleState(
  db: Database,
  stateKey: string,
): { items: number; last_at: string | null; closed: boolean; facts: number; prompt_version: string; updated_at: string } | null {
  const r = db.prepare('SELECT items, last_at, closed, facts, prompt_version, updated_at FROM style_pass_state WHERE state_key = ?').get(stateKey) as
    | { items: number; last_at: string | null; closed: number; facts: number; prompt_version: string; updated_at: string }
    | undefined
  return r ? { ...r, closed: r.closed === 1 } : null
}

export function writeStyleState(
  db: Database,
  stateKey: string,
  info: { mode: string; person_id: string | null; period: string; items: number; last_at: string | null; closed: boolean; facts: number; prompt_version: string },
  now: string,
): void {
  db.prepare(
    `INSERT INTO style_pass_state (state_key, mode, person_id, period, items, last_at, closed, facts, prompt_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(state_key) DO UPDATE SET items = excluded.items, last_at = excluded.last_at, closed = excluded.closed,
       facts = excluded.facts, prompt_version = excluded.prompt_version, updated_at = excluded.updated_at`,
  ).run(stateKey, info.mode, info.person_id, info.period, info.items, info.last_at, info.closed ? 1 : 0, info.facts, info.prompt_version, now)
}
