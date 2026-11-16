/**
 * Routes du TRI DES SOUVENIRS : lecture des corps et des paramètres (liste
 * blanche, 400 lisible sur toute valeur hors grille), curseur de pagination,
 * traduction des refus du moteur en codes HTTP, et job de la passe sur les
 * messages de l'utilisateur.
 *
 * Le passage de tri lui-même tourne dans le moteur (`memoria.triage.start`) :
 * il rend la main dès le démarrage et cède la boucle d'événements entre deux
 * lots (ticket #27). Les routes ne font que relayer.
 *
 * Contrats (corps en snake_case, options du moteur en camelCase) :
 *   POST   /v1/admin/triage/run      → 202 TriageRunStatus (dry-run : `estimate`)
 *   GET    /v1/admin/triage/run      → TriageRunStatus
 *   DELETE /v1/admin/triage/run      → { cancelled }
 *   GET    /v1/admin/triage          → { items, next_cursor } (curseur opaque)
 *   GET    /v1/admin/triage/stats    → TriageStats
 *   POST   /v1/admin/triage/promote  → TriagePromoteResult
 *   POST   /v1/admin/triage/correct  → { updated } (404 si le fait est inconnu)
 *   POST   /v1/admin/triage/verdict  → { updated }
 *   POST|GET|DELETE /v1/admin/triage/messages → UserMessagesJobState
 *   POST|GET|DELETE /v1/admin/triage/styles   → StylesJobState
 *   POST   /v1/memory/ideas          → IdeasResult (jeton d'instance)
 *   POST   /v1/memory/styles         → StylesResult (jeton d'instance)
 */
import {
  GENRES,
  PORTEES,
  RUBRIQUES,
  SOUS_TYPES,
  TriageRefusedError,
  nowISO,
  type ActiveContext,
  type Auteur,
  type AuteurSource,
  type Genre,
  type IdeasFilter,
  type Memoria,
  type Portee,
  type Rubrique,
  type SousType,
  type StylesPassMode,
  type StylesPassOptions,
  type StylesProgress,
  type StylesQuery,
  type StylesReport,
  type TriageCorrection,
  type TriageCursor,
  type TriageListFilter,
  type TriagePromoteOptions,
  type TriageRefusalCode,
  type TriageRunOptions,
  type TriageStats,
  type TriageStopReason,
  type UserMessageSourceKind,
  type UserMessagesPassOptions,
  type UserMessagesProgress,
  type UserMessagesReport,
} from '@memoria/core'
import { HttpError } from './http-error.js'

/** Plafond d'une page de la liste d'administration. */
export const TRIAGE_LIST_MAX = 500
/** Taille de page par défaut. */
export const TRIAGE_LIST_DEFAULT = 50

/**
 * Refus du moteur → statut HTTP. `closed` : le daemon s'arrête (503).
 * `not-registered` : la passe sur les messages n'est pas branchée dans ce
 * build (501, une fonction absente, pas une panne).
 */
export const TRIAGE_REFUSAL_STATUS: Record<TriageRefusalCode, number> = {
  running: 409,
  paused: 423,
  'no-llm': 422,
  'price-unknown': 422,
  'bad-request': 400,
  closed: 503,
  'not-registered': 501,
  'not-found': 404,
}

function isRefusal(err: unknown): err is TriageRefusedError {
  return err instanceof TriageRefusedError || (err as { name?: string } | null)?.name === 'TriageRefusedError'
}

// ---------------------------------------------------------------- compteurs gardés

/** Durée de vie des compteurs du tri gardés par le daemon, hors passage. */
export const TRIAGE_STATS_TTL_MS = 30_000
/** Pendant un passage (ou une passe sur les messages) : les compteurs bougent à chaque lot. */
export const TRIAGE_STATS_RUNNING_TTL_MS = 5_000

export interface TriageStatsSource {
  /** Calcul des compteurs (découpé : il rend la main entre deux tranches). */
  compute(instance: string | undefined): Promise<TriageStats>
  /**
   * Empreinte de l'état des passages (identifiant, état, fin) : elle change au
   * départ et à la fin d'un passage, ce qui recalcule les compteurs (l'écran
   * relit les compteurs dès la fin d'un passage).
   */
  stamp(): { key: string; running: boolean }
}

/**
 * Compteurs du tri gardés par instance. Le tableau de bord et l'écran Tri les
 * demandent à chaque ouverture, et l'écran interroge l'état du passage toutes
 * les secondes : avant, chaque GET de l'état vidait le cache pendant un
 * passage, et chaque GET des compteurs relançait tout le calcul.
 *  - hors passage : gardés TRIAGE_STATS_TTL_MS ; pendant : TRIAGE_STATS_RUNNING_TTL_MS ;
 *  - recalculés quand un passage démarre ou finit (empreinte) ;
 *  - vidés par `invalidate()` sur une action qui change le tri (lancement,
 *    validation, correction, marque faux, passe sur les messages) ;
 *  - un calcul en cours est partagé : deux GET simultanés n'en lancent qu'un.
 */
export class TriageStatsCache {
  private entries = new Map<string, { at: number; stamp: string; value: Promise<TriageStats> }>()

  constructor(
    private readonly source: TriageStatsSource,
    private readonly now: () => number = Date.now,
  ) {}

  get(instance: string | undefined): Promise<TriageStats> {
    const key = instance ?? ''
    const { key: stamp, running } = this.source.stamp()
    const ttl = running ? TRIAGE_STATS_RUNNING_TTL_MS : TRIAGE_STATS_TTL_MS
    const hit = this.entries.get(key)
    if (hit && hit.stamp === stamp && this.now() - hit.at < ttl) return hit.value
    const entry = { at: this.now(), stamp, value: this.source.compute(instance) }
    this.entries.set(key, entry)
    // Un calcul en échec n'est pas gardé.
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return entry.value
  }

  invalidate(): void {
    this.entries = new Map()
  }
}

/** Traduit un refus du tri (synchrone OU asynchrone) en HttpError ; le reste remonte tel quel. */
export async function mapTriageErrors<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isRefusal(err)) throw new HttpError(TRIAGE_REFUSAL_STATUS[err.code] ?? 400, err.message)
    throw err
  }
}

// ---------------------------------------------------------------- valeurs élémentaires

type Source = Record<string, unknown>

function present(src: Source, name: string): boolean {
  const v = src[name]
  return v !== undefined && v !== null && v !== ''
}

function str(src: Source, name: string, max = 500): string | undefined {
  if (!present(src, name)) return undefined
  const v = src[name]
  if (typeof v !== 'string') throw new HttpError(400, `${name} doit être une chaîne`)
  if (v.length > max) throw new HttpError(400, `${name} trop long (${max} caractères au plus)`)
  return v
}

/** Booléen strict : true/false, ou dans une URL « true », « false », « 1 », « 0 ». */
function bool(src: Source, name: string): boolean | undefined {
  if (!present(src, name)) return undefined
  const v = src[name]
  if (v === true || v === 'true' || v === '1') return true
  if (v === false || v === 'false' || v === '0') return false
  throw new HttpError(400, `${name} doit être un booléen (true | false)`)
}

/** Entier borné (nombre JSON, ou chaîne d'URL). */
function int(src: Source, name: string, min: number, max: number): number | undefined {
  if (!present(src, name)) return undefined
  const raw = src[name]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} doit être un entier entre ${min} et ${max} (reçu : ${JSON.stringify(raw)})`)
  }
  return n
}

/** Montant ≥ 0 (dollars). */
function amount(src: Source, name: string): number | undefined {
  if (!present(src, name)) return undefined
  const raw = src[name]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, `${name} doit être un montant en dollars entre 0 et 1000 (reçu : ${JSON.stringify(raw)})`)
  return n
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new HttpError(400, `${name} inconnu : ${JSON.stringify(value)} (attendu : ${allowed.join(' | ')})`)
  }
  return value as T
}

function enumField<T extends string>(src: Source, name: string, allowed: readonly T[]): T | undefined {
  return present(src, name) ? oneOf(src[name], allowed, name) : undefined
}

/** Date ISO (normalisée en ISO Z pour la comparaison en texte de `conversation_at`). */
function isoDate(src: Source, name: string): string | undefined {
  const v = str(src, name, 40)
  if (v === undefined) return undefined
  const at = Date.parse(v)
  if (Number.isNaN(at)) throw new HttpError(400, `${name} invalide : « ${v} » (date ISO 8601 attendue, ex. 2026-01-31T00:00:00Z)`)
  return new Date(at).toISOString()
}

/** Genres : liste séparée par des virgules (URL) ou tableau / chaîne (JSON). */
function genres(src: Source, name = 'genre'): Genre | Genre[] | undefined {
  if (!present(src, name)) return undefined
  const raw = src[name]
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : null
  if (!list || list.length === 0) throw new HttpError(400, `${name} doit être un genre ou une liste de genres`)
  const out = list.map(g => oneOf(g, GENRES, name))
  return out.length === 1 ? out[0] : out
}

const AUTEUR_RE = /^(owner|inconnu|ia|person|ia:[a-z0-9_.-]{1,40}|person:[A-Za-z0-9_.:-]{1,80})$/

/** Filtre d'auteur : exact (`owner`, `ia:claude`, `person:<id>`) ou famille (`ia`, `person`). */
function auteurFilter(src: Source, name = 'auteur'): string | undefined {
  const v = str(src, name, 100)
  if (v === undefined) return undefined
  if (!AUTEUR_RE.test(v)) throw new HttpError(400, `${name} inconnu : « ${v} » (attendu : owner | inconnu | ia | ia:<agent> | person | person:<id>)`)
  return v
}

// ---------------------------------------------------------------- curseur

/** Curseur opaque rendu au client : base64url du JSON de TriageCursor. */
export function encodeTriageCursor(cursor: TriageCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : null
}

export function decodeTriageCursor(raw: string): TriageCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new HttpError(400, 'cursor invalide : reprends la valeur next_cursor rendue par la page précédente')
  }
  const c = parsed as Partial<TriageCursor> | null
  if (!c || typeof c !== 'object' || typeof c.conversation_at !== 'string' || typeof c.fact_id !== 'string' || c.fact_id === '') {
    throw new HttpError(400, 'cursor invalide : reprends la valeur next_cursor rendue par la page précédente')
  }
  return { conversation_at: c.conversation_at, fact_id: c.fact_id }
}

// ---------------------------------------------------------------- filtres et corps

/**
 * Filtre de liste, depuis les paramètres d'URL (GET) ou un objet JSON
 * (filtre de promotion). `person_id=owner` = le propriétaire (null).
 */
export function triageListFilterFrom(src: Source): TriageListFilter {
  const f: TriageListFilter = {}
  const g = genres(src)
  if (g !== undefined) f.genre = g
  const st = enumField<SousType>(src, 'sous_type', SOUS_TYPES)
  if (st) f.sous_type = st
  const a = auteurFilter(src)
  if (a) f.auteur = a
  const as = enumField<AuteurSource>(src, 'auteur_source', ['message', 'llm', 'inconnu'])
  if (as) f.auteur_source = as
  const r = enumField<Rubrique>(src, 'rubrique', RUBRIQUES)
  if (r) f.rubrique = r
  const p = enumField<Portee>(src, 'portee', PORTEES)
  if (p) f.portee = p
  const projet = str(src, 'projet', 120)
  if (projet !== undefined) f.projet = projet
  const imp = int(src, 'importance_min', 0, 3)
  if (imp !== undefined) f.importance_min = imp
  const q = str(src, 'q', 200)
  if (q !== undefined && q.trim() !== '') f.q = q
  const instance = str(src, 'instance', 100)
  if (instance !== undefined) f.instance = instance
  const validated = bool(src, 'validated')
  if (validated !== undefined) f.validated = validated
  if (present(src, 'person_id')) {
    const pid = str(src, 'person_id', 100)!
    f.person_id = pid === 'owner' ? null : pid
  } else if (src['person_id'] === null) {
    f.person_id = null
  }
  const members = bool(src, 'include_members')
  if (members !== undefined) f.include_members = members
  const faux = bool(src, 'include_faux')
  if (faux !== undefined) f.include_faux = faux
  const sensible = bool(src, 'sensible')
  if (sensible !== undefined) f.sensible = sensible
  const since = isoDate(src, 'since')
  if (since) f.since = since
  const until = isoDate(src, 'until')
  if (until) f.until = until
  return f
}

/** GET /v1/admin/triage : filtre, curseur et taille de page. */
export function triageListQuery(url: URL): { filter: TriageListFilter; cursor: TriageCursor | null; limit: number } {
  const src: Source = Object.fromEntries(url.searchParams.entries())
  const limit = int(src, 'limit', 1, TRIAGE_LIST_MAX) ?? TRIAGE_LIST_DEFAULT
  const cursorRaw = str(src, 'cursor', 2000)
  return { filter: triageListFilterFrom(src), cursor: cursorRaw ? decodeTriageCursor(cursorRaw) : null, limit }
}

/** Corps de POST /v1/admin/triage/run → options du moteur. */
export function triageRunOptionsFrom(body: Source): TriageRunOptions {
  const o: TriageRunOptions = {}
  const instance = str(body, 'instance', 100)
  if (instance !== undefined) o.instance = instance
  const dry = bool(body, 'dry_run')
  if (dry !== undefined) o.dryRun = dry
  const budget = amount(body, 'budget_usd')
  if (budget !== undefined) o.budgetUsd = budget
  const maxFacts = int(body, 'max_facts', 1, 10_000_000)
  if (maxFacts !== undefined) o.maxFacts = maxFacts
  const reclassify = bool(body, 'reclassify')
  if (reclassify !== undefined) o.reclassify = reclassify
  const concurrency = int(body, 'concurrency', 1, 4)
  if (concurrency !== undefined) o.concurrency = concurrency
  const batch = int(body, 'batch_size', 1, 50)
  if (batch !== undefined) o.batchSize = batch
  const resume = bool(body, 'resume')
  if (resume !== undefined) o.resume = resume
  return o
}

function stringIds(value: unknown, name: string, max = TRIAGE_LIST_MAX): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v): v is string => typeof v === 'string' && v.length > 0)) {
    throw new HttpError(400, `${name} doit être un tableau non vide d’identifiants`)
  }
  if (value.length > max) throw new HttpError(400, `${name} : ${max} identifiants au plus par appel`)
  return value
}

/** Corps de POST /v1/admin/triage/promote. */
export function triagePromoteFrom(body: Source): TriagePromoteOptions {
  const o: TriagePromoteOptions = {}
  if (present(body, 'fact_ids')) o.fact_ids = stringIds(body['fact_ids'], 'fact_ids')
  if (present(body, 'filter')) {
    const raw = body['filter']
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'filter doit être un objet (mêmes champs que la liste)')
    o.filter = triageListFilterFrom(raw as Source)
  }
  if (!o.fact_ids && !o.filter) throw new HttpError(400, 'fact_ids ou filter requis')
  const share = bool(body, 'share')
  if (share !== undefined) o.share = share
  const allow = bool(body, 'allow_sensitive')
  if (allow !== undefined) o.allow_sensitive = allow
  const max = int(body, 'max', 1, TRIAGE_LIST_MAX)
  if (max !== undefined) o.max = max
  return o
}

const AUTEUR_VALUE_RE = /^(owner|inconnu|ia:[a-z0-9_.-]{1,40}|person:[A-Za-z0-9_.:-]{1,80})$/

/** Corps de POST /v1/admin/triage/correct (au moins un champ à corriger). */
export function triageCorrectionFrom(body: Source): TriageCorrection {
  const factId = str(body, 'fact_id', 100)
  if (!factId) throw new HttpError(400, 'fact_id requis')
  const c: TriageCorrection = { fact_id: factId }
  if (present(body, 'genre')) c.genre = oneOf(body['genre'], GENRES, 'genre')
  if ('sous_type' in body) c.sous_type = body['sous_type'] === null ? null : oneOf(body['sous_type'], SOUS_TYPES, 'sous_type')
  if (present(body, 'auteur')) {
    const a = body['auteur']
    if (typeof a !== 'string' || !AUTEUR_VALUE_RE.test(a)) {
      throw new HttpError(400, `auteur inconnu : ${JSON.stringify(a)} (attendu : owner | inconnu | ia:<agent> | person:<id>)`)
    }
    c.auteur = a as Auteur
  }
  if (present(body, 'rubriques')) {
    const r = body['rubriques']
    if (!Array.isArray(r)) throw new HttpError(400, 'rubriques doit être un tableau')
    c.rubriques = [...new Set(r.map(x => oneOf(x, RUBRIQUES, 'rubrique')))]
  }
  if ('portee' in body) c.portee = body['portee'] === null ? null : oneOf(body['portee'], PORTEES, 'portee')
  if ('projet' in body) c.projet = body['projet'] === null ? null : (str(body, 'projet', 120) ?? null)
  if ('titre' in body) c.titre = body['titre'] === null ? null : (str(body, 'titre', 200) ?? null)
  const imp = int(body, 'importance', 0, 3)
  if (imp !== undefined) c.importance = imp
  if ('person_id' in body) c.person_id = body['person_id'] === null ? null : (str(body, 'person_id', 100) ?? null)
  const sensible = bool(body, 'sensible')
  if (sensible !== undefined) c.sensible = sensible
  if (Object.keys(c).length === 1) {
    throw new HttpError(400, 'rien à corriger : genre, sous_type, auteur, rubriques, portee, projet, titre, importance, person_id ou sensible')
  }
  return c
}

/** Corps de POST /v1/admin/triage/verdict : `verdict` vaut « faux » ou null (retirer la marque). */
export function triageVerdictFrom(body: Source): { factIds: string[]; verdict: 'faux' | null } {
  const factIds = stringIds(body['fact_ids'], 'fact_ids')
  if (!('verdict' in body)) throw new HttpError(400, 'verdict requis : "faux", ou null pour retirer la marque')
  const v = body['verdict']
  if (v !== null && v !== 'faux') throw new HttpError(400, `verdict inconnu : ${JSON.stringify(v)} (attendu : "faux" ou null)`)
  return { factIds, verdict: v }
}

/** Contexte actif d'un agent (relayé tel quel, comme le rappel). */
function activeContextFrom(body: Source): ActiveContext | undefined {
  const raw = body['active_context']
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ActiveContext) : undefined
}

/** Corps de POST /v1/memory/ideas, sur LISTE BLANCHE (aucun drapeau interne : ni dormants, ni sensibles). */
export function ideasInputFrom(body: Source): { filter: IdeasFilter; activeContext: ActiveContext | undefined } {
  const filter: IdeasFilter = {}
  const g = genres(body)
  if (g !== undefined) filter.genre = g
  const st = enumField<SousType>(body, 'sous_type', SOUS_TYPES)
  if (st) filter.sous_type = st
  const a = auteurFilter(body)
  if (a) filter.auteur = a
  const projet = str(body, 'projet', 120)
  if (projet !== undefined) filter.projet = projet
  const q = str(body, 'q', 200)
  if (q !== undefined && q.trim() !== '') filter.q = q
  const imp = int(body, 'importance_min', 0, 3)
  if (imp !== undefined) filter.importance_min = imp
  const limit = int(body, 'limit', 1, 200)
  if (limit !== undefined) filter.limit = limit
  return { filter, activeContext: activeContextFrom(body) }
}

/** Corps de POST /v1/memory/styles. `person_id` absent ou null : le propriétaire. */
export function stylesQueryFrom(body: Source): StylesQuery {
  const q: StylesQuery = {}
  if (present(body, 'person_id')) q.person_id = str(body, 'person_id', 100)!
  else if (body['person_id'] === null) q.person_id = null
  const ctx = activeContextFrom(body)
  if (ctx) q.active_context = ctx
  const limit = int(body, 'limit', 1, 50)
  if (limit !== undefined) q.limit = limit
  return q
}

const MESSAGE_SOURCES: readonly UserMessageSourceKind[] = ['claude-code', 'chatgpt', 'codex-history']

/** Corps de POST /v1/admin/triage/messages. */
export function userMessagesOptionsFrom(body: Source): UserMessagesPassOptions {
  const o: UserMessagesPassOptions = {}
  const dry = bool(body, 'dry_run')
  if (dry !== undefined) o.dryRun = dry
  const budget = amount(body, 'budget_usd')
  if (budget !== undefined) o.budgetUsd = budget
  if (present(body, 'sources')) {
    const s = body['sources']
    if (!Array.isArray(s) || s.length === 0) throw new HttpError(400, 'sources doit être un tableau non vide')
    o.sources = [...new Set(s.map(x => oneOf(x, MESSAGE_SOURCES, 'source')))]
  }
  const since = isoDate(body, 'since')
  if (since) o.since = since
  const max = int(body, 'max_messages', 1, 1_000_000)
  if (max !== undefined) o.maxMessages = max
  return o
}

const STYLES_MODES: readonly StylesPassMode[] = ['owner', 'person']
const STYLES_SOURCES: ReadonlyArray<NonNullable<StylesPassOptions['sources']>[number]> = ['claude-code', 'codex-history']

/**
 * Corps de POST /v1/admin/triage/styles : `mode` obligatoire ; `person_id`
 * obligatoire en mode person et refusé en mode owner ; `sources` (owner) et
 * `instance` (person) en option.
 */
export function stylesOptionsFrom(body: Source): StylesPassOptions {
  if (!present(body, 'mode')) throw new HttpError(400, 'mode requis (owner | person)')
  const mode = oneOf(body['mode'], STYLES_MODES, 'mode')
  const o: StylesPassOptions = { mode }
  const personId = str(body, 'person_id', 100)
  if (mode === 'person') {
    if (!personId) throw new HttpError(400, 'person_id requis en mode person')
    o.person_id = personId
  } else if (personId !== undefined) throw new HttpError(400, 'person_id seulement en mode person')
  const dry = bool(body, 'dry_run')
  if (dry !== undefined) o.dryRun = dry
  const budget = amount(body, 'budget_usd')
  if (budget !== undefined) o.budgetUsd = budget
  const since = isoDate(body, 'since')
  if (since) o.since = since
  const force = bool(body, 'force')
  if (force !== undefined) o.force = force
  if (present(body, 'sources')) {
    if (mode !== 'owner') throw new HttpError(400, 'sources seulement en mode owner')
    const s = body['sources']
    if (!Array.isArray(s) || s.length === 0) throw new HttpError(400, 'sources doit être un tableau non vide')
    o.sources = [...new Set(s.map(x => oneOf(x, STYLES_SOURCES, 'source')))]
  }
  const instance = str(body, 'instance', 100)
  if (instance !== undefined) {
    if (mode !== 'person') throw new HttpError(400, 'instance seulement en mode person')
    o.instance = instance
  }
  return o
}

// ---------------------------------------------------------------- jobs des passes annexes (messages, styles)

export type UserMessagesJobStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'

/** État d'une passe annexe (GET de sa route). En mémoire : repart à `idle` au redémarrage. */
export interface PassJobState<P, R> {
  status: UserMessagesJobStatus
  dry_run: boolean
  started_at: string | null
  finished_at: string | null
  progress: P | null
  report: R | null
  /** Refus du moteur (code) si la passe a été refusée après son lancement. */
  refusal: TriageRefusalCode | null
  error: string | null
}

/** État de la passe sur les messages (GET /v1/admin/triage/messages). */
export type UserMessagesJobState = PassJobState<UserMessagesProgress, UserMessagesReport>
/** État de la passe styles (GET /v1/admin/triage/styles). */
export type StylesJobState = PassJobState<StylesProgress, StylesReport>

export function idleUserMessagesJob(): UserMessagesJobState {
  return idlePassJob()
}

function idlePassJob<P, R>(): PassJobState<P, R> {
  return { status: 'idle', dry_run: false, started_at: null, finished_at: null, progress: null, report: null, refusal: null, error: null }
}

/**
 * Un seul passage à la fois ; état lisible à tout moment. Le moteur n'a pas de
 * séparation « démarrer / attendre » pour ces passes : le job garde la
 * promesse et la termine TOUJOURS (`.then` + `.catch`), jamais de rejet non
 * géré qui tuerait le daemon.
 */
class PassJob<O extends { dryRun?: boolean; onProgress?: (p: P) => void }, P, R extends { stopped: TriageStopReason | null }> {
  private state: PassJobState<P, R> = idlePassJob()

  constructor(
    private readonly busyMessage: string,
    private readonly launch: (memoria: Memoria, opts: O) => Promise<R>,
  ) {}

  get running(): boolean {
    return this.state.status === 'running'
  }

  current(): PassJobState<P, R> {
    return { ...this.state }
  }

  start(memoria: Memoria, opts: O): PassJobState<P, R> {
    if (this.running) throw new HttpError(409, this.busyMessage)
    const job: PassJobState<P, R> = { ...idlePassJob<P, R>(), status: 'running', dry_run: opts.dryRun === true, started_at: nowISO() }
    this.state = job
    let promise: Promise<R>
    try {
      promise = this.launch(memoria, { ...opts, onProgress: (p: P) => (job.progress = { ...p }) })
    } catch (err) {
      promise = Promise.reject(err)
    }
    void promise
      .then(report => {
        job.report = report
        job.status = report.stopped === 'cancelled' || report.stopped === 'closed' ? 'cancelled' : 'done'
      })
      .catch((err: unknown) => {
        job.status = 'error'
        job.refusal = isRefusal(err) ? err.code : null
        job.error = (err as Error)?.message ?? String(err)
      })
      .finally(() => {
        job.finished_at = nowISO()
      })
    return { ...job }
  }
}

/** Job de la passe sur les messages (POST|GET|DELETE /v1/admin/triage/messages). */
export class UserMessagesJob extends PassJob<UserMessagesPassOptions, UserMessagesProgress, UserMessagesReport> {
  constructor() {
    super('une passe sur les messages est déjà en cours (GET /v1/admin/triage/messages)', (memoria, opts) => memoria.triage.runUserMessages(opts))
  }
}

/** Job de la passe styles (POST|GET|DELETE /v1/admin/triage/styles). */
export class StylesJob extends PassJob<StylesPassOptions, StylesProgress, StylesReport> {
  constructor() {
    super('une passe styles est déjà en cours (GET /v1/admin/triage/styles)', (memoria, opts) => memoria.triage.runStyles(opts))
  }
}
