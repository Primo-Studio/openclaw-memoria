/**
 * Index plein texte des SEULS faits rappelables (`facts_recall_fts`, migration
 * 100 ; règle n°27, 15/11). Sur la base de Claude Code, 98 % des faits sont en
 * attente de tri : le rappel faisait son MATCH sur les 74 000 faits, calculait
 * bm25 et lisait chaque ligne, puis jetait les faits en attente (378 à 441 ms
 * de boucle figée par memoria_recall). Données fictives.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContentStore, Memoria } from '../src/index.js'
import { RECALL_FTS_STATE_KEY } from '../src/storage/content-schema.js'
import { seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv | undefined
let dir: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  env?.close()
  env = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Multiplie un fait par SQL (storeFact un par un serait trop lent), colonnes surchargeables. */
function multiply(db: Database, id: string, n: number, set: Record<string, string> = {}): void {
  const cols = (db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name)
  const sel = cols
    .map(c => set[c] ?? (c === 'id' ? `'copie-' || n || '-' || facts.id` : c === 'fact' ? `fact || ' (copie ' || n || ')'` : c === 'norm_hash' ? 'NULL' : c))
    .join(', ')
  db.prepare(
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${n})
     INSERT INTO facts (${cols.join(', ')}) SELECT ${sel} FROM facts, seq WHERE facts.id = ?`,
  ).run(id)
}

function storeOf(e: TriageEnv, instance = e.instance): ContentStore {
  return (e.m as unknown as { openContent(p: string): ContentStore }).openContent(e.m.registry.dbForInstance(instance)!.path)
}

/**
 * ORACLE : pour chaque jeton, les faits que MATCH trouve dans l'index de rappel
 * sont exactement ceux que l'index complet trouve parmi les actifs non
 * supersédés ; et l'index ne contient pas une ligne de plus.
 */
function expectRecallIndexExact(db: Database, tokens: string[]): void {
  const inRecall = db.prepare('SELECT rowid AS r FROM facts_recall_fts WHERE facts_recall_fts MATCH ? ORDER BY rowid')
  const expected = db.prepare(
    `SELECT f.rowid AS r FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
     WHERE facts_fts MATCH ? AND f.lifecycle_state = 'active' AND f.superseded = 0 ORDER BY f.rowid`,
  )
  for (const t of tokens) {
    const m = `"${t}"`
    expect((inRecall.all(m) as Array<{ r: number }>).map(r => r.r), `jeton « ${t} »`).toEqual(
      (expected.all(m) as Array<{ r: number }>).map(r => r.r),
    )
  }
  const indexed = (db.prepare('SELECT COUNT(*) AS c FROM facts_recall_fts_docsize').get() as { c: number }).c
  const recallable = (db.prepare("SELECT COUNT(*) AS c FROM facts WHERE lifecycle_state = 'active' AND superseded = 0").get() as { c: number }).c
  expect(indexed).toBe(recallable)
  // Un 'delete' sur un fait absent (ou une double insertion) ne change pas les
  // résultats du MATCH : il fausse le total de lignes de FTS5, donc bm25. Ce
  // total est le premier varint de l'enregistrement des moyennes (id 1).
  expect(ftsTotalRows(db, 'facts_recall_fts'), 'total de lignes de FTS5').toBe(indexed)
  // Cohérence interne de l'index (sans comparaison au contenu : `facts` contient
  // aussi les faits en attente, une comparaison échouerait par construction).
  db.prepare("INSERT INTO facts_recall_fts(facts_recall_fts) VALUES ('integrity-check')").run()
}

/** nTotalRow de FTS5 : varint SQLite en tête de `<table>_data` id 1 (absent = index vide). */
function ftsTotalRows(db: Database, table: string): number {
  const row = db.prepare(`SELECT block FROM ${table}_data WHERE id = 1`).get() as { block: Buffer } | undefined
  if (!row) return 0
  let v = 0
  for (let i = 0; i < 9; i++) {
    const b = row.block[i]!
    if (i === 8) return v * 256 + b
    v = v * 128 + (b & 0x7f)
    if ((b & 0x80) === 0) return v
  }
  return v
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('rappel plein texte : index des faits rappelables', () => {
  it('un fait actif dont les mots remplissent 3 000 faits en attente est rappelé, en tête', () => {
    env = setupTriage({ embedder: null })
    const active = env.m.storeFact({
      instance: env.instance,
      content: 'Le déploiement du projet Lumière passe par la branche principale puis Vercel',
    })
    const other = env.m.storeFact({ instance: env.instance, content: 'Le projet Orion garde sa propre branche de recette' })
    const pending = seedPending(env, 'Rappel : déploiement du projet Lumière, branche principale et Vercel, à confirmer')
    multiply(env.db(), pending, 3000)

    const r = env.m.recall({ instance: env.instance, query: 'déploiement projet Lumière branche principale Vercel' })

    expect(r.items[0]?.id).toBe(active.id)
    // Aucun fait en attente ne sort, et rien n'est perdu parmi les actifs.
    expect(new Set(r.items.map(i => i.id))).toEqual(new Set([active.id, other.id]))
    // Le MATCH du rappel ne voit que les deux actifs, pas les 3 001 en attente.
    expect((env.db().prepare('SELECT COUNT(*) AS c FROM facts_recall_fts_docsize').get() as { c: number }).c).toBe(2)
  })

  it('boucle : 20 000 faits en attente aux mots fréquents, un rappel ne fige pas la boucle 100 ms', async () => {
    env = setupTriage({ embedder: null })
    const long = 'Le projet du jardin partagé avance : la réunion de quartier, le budget et le calendrier sont à revoir avec la mairie. '.repeat(4)
    multiply(env.db(), seedPending(env, long), 20_000)
    const actives = [
      'Le budget du jardin partagé est voté par la mairie en mars',
      'La réunion de quartier du jardin se tient le premier jeudi du mois',
      'Le calendrier des plantations du projet est affiché au local',
    ].map(content => env!.m.storeFact({ instance: env!.instance, content }).id)
    // Sur une base de test chaude, l'ancien MATCH sur les 20 000 passe aussi
    // sous 100 ms (16 ms contre 4 ms mesurés le 15/11) ; sur la vraie base, à
    // cache froid, il en coûtait 378 à 441. Ce qui distingue : le MATCH du
    // rappel ne doit porter que sur l'index des 3 faits rappelables.
    const store = storeOf(env)
    const matchSql: string[] = []
    const prepare = store.db.prepare.bind(store.db)
    vi.spyOn(store.db, 'prepare').mockImplementation(((sql: string) => {
      if (/\bMATCH\b/.test(sql) && /\bfacts_(recall_)?fts\b/.test(sql)) matchSql.push(sql)
      return prepare(sql)
    }) as typeof store.db.prepare)

    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    let took = 0
    let ids: string[] = []
    try {
      await sleep(20)
      const t0 = performance.now()
      ids = env.m.recall({ instance: env.instance, query: 'projet jardin partagé réunion quartier budget calendrier mairie' }).items.map(i => i.id)
      took = performance.now() - t0
      await sleep(20) // le minuteur doit tourner APRÈS l'appel pour mesurer l'écart
    } finally {
      clearInterval(timer)
    }
    expect(new Set(ids)).toEqual(new Set(actives))
    expect(took).toBeLessThan(100)
    expect(worst).toBeLessThan(100)
    expect(matchSql.length).toBeGreaterThan(0)
    for (const sql of matchSql) {
      expect(sql).toMatch(/facts_recall_fts MATCH/)
      expect(sql).not.toMatch(/\bfacts_fts\b/)
    }
    expect((store.db.prepare('SELECT COUNT(*) AS c FROM facts_recall_fts_docsize').get() as { c: number }).c).toBe(3)
  }, 60_000)

  it('oracle : l’index suit les vraies transitions (revue, tri, oubli, supersession, masquage, synchro)', () => {
    env = setupTriage({ embedder: null })
    const e = env
    const store = storeOf(e)
    const db = e.db()
    const tokens = ['serveur', 'tourne', 'scaleway', 'ovh', 'hetzner', 'vercel', 'fly', 'render', 'masque', 'infra', 'config', 'koyeb', 'netlify']
    const put = (content: string) => e.m.storeFact({ instance: e.instance, content }).id
    const a = put('Le serveur de recette tourne chez Scaleway')
    const d = put('Le serveur de démonstration tourne chez Vercel')
    const f = put('Le serveur de test tourne chez Fly')
    const g = put('Le serveur des maquettes tourne chez Render')
    const b = seedPending(e, 'Le serveur de production tourne chez OVH')
    const c = seedPending(e, 'Le serveur de secours tourne chez Hetzner')
    const k = seedPending(e, 'Le serveur des essais tourne chez Koyeb')
    expectRecallIndexExact(db, tokens)

    // Revue : validation (en attente → actif) et rejet (effacement).
    const items = e.m.listReview({ limit: 500 })
    const itemOf = (factId: string) => items.find(i => i.fact_id === factId)!.id
    e.m.reviewDecision([itemOf(b)], 'accepted')
    e.m.reviewDecision([itemOf(c)], 'rejected')
    expectRecallIndexExact(db, tokens)

    // Tri : activation directe d'un fait en attente (même requête que le tri).
    db.prepare("UPDATE facts SET lifecycle_state = 'active', updated_at = ? WHERE id = ?").run(new Date().toISOString(), k)
    // Oubli (effacement dur) d'un actif.
    e.m.forget({ ids: [d] })
    // Supersession (requête du tri), puis masquage d'un secret dans un actif.
    db.prepare('UPDATE facts SET superseded = 1, superseded_by = ?, updated_at = ? WHERE id = ?').run(a, new Date().toISOString(), f)
    db.prepare('UPDATE facts SET fact = ?, norm_hash = NULL, updated_at = ? WHERE id = ?').run(
      'Le serveur de recette tourne chez [masqué]',
      new Date().toISOString(),
      a,
    )
    // Catégorie et tags d'un actif (colonnes indexées), et mise à jour sans effet.
    db.prepare(`UPDATE facts SET category = 'config', tags = '["infra"]' WHERE id = ?`).run(b)
    db.prepare("UPDATE facts SET lifecycle_state = 'active' WHERE id = ?").run(b)
    expectRecallIndexExact(db, tokens)
    // Le texte masqué et le fait oublié ne laissent aucune trace dans l'index de rappel.
    for (const gone of ['scaleway', 'vercel']) {
      expect((db.prepare('SELECT COUNT(*) AS c FROM facts_recall_fts WHERE facts_recall_fts MATCH ?').get(`"${gone}"`) as { c: number }).c).toBe(0)
    }

    // Sensibilité : hors de l'index, filtrée au WHERE sur la ligne courante.
    db.prepare("UPDATE facts SET sensitivity = 'critical' WHERE id = ?").run(g)
    expect(store.searchFacts('serveur Render').map(h => h.row.id)).not.toContain(g)
    expect(store.searchFacts('serveur Render', { maxSensitivity: 'critical' }).map(h => h.row.id)).toContain(g)

    // Synchro : tombstone d'un actif, fait reçu actif puis repassé en attente.
    const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(b) as Record<string, unknown>
    store.applyTombstone({ id: b, deleted_at: new Date().toISOString(), origin_machine_id: 'autre', origin_rev: 9, updated_at: new Date().toISOString() })
    const synced = {
      id: 'synchro-1', fact: 'Le serveur partagé tourne chez Netlify', category: 'general', fact_type: 'statement', confidence: 0.9,
      source: 'sync', scope_id: String(row['scope_id']), sensitivity: 'normal', visibility: 'shared', tags: '[]', entity_ids: '[]',
      lifecycle_state: 'active', superseded: 0, superseded_by: null, origin_machine_id: 'autre', origin_rev: 1, content_hash: null,
      deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    store.upsertSyncedFact(synced)
    expectRecallIndexExact(db, tokens)
    store.upsertSyncedFact({ ...synced, lifecycle_state: 'dormant', origin_rev: 2 })
    expectRecallIndexExact(db, tokens)
    store.upsertSyncedFact({ ...synced, fact: 'Le serveur partagé tourne chez Netlify et Koyeb', lifecycle_state: 'active', origin_rev: 3 })
    expectRecallIndexExact(db, tokens)
  })

  it('migration sur une base existante : remplissage par tranches, écritures pendant le remplissage justes', () => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-recall-fts-'))
    const path = join(dir, 'memory.sqlite')
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    let store = new ContentStore(path)
    store.db.transaction(() => {
      for (let i = 0; i < 1500; i++) {
        store.insertFact({
          fact: `Fait ${i} du lot ${words[i % 5]} et ${words[(i + 2) % 5]}`,
          scope_id: 'private:test',
          lifecycle_state: i % 5 === 4 ? 'dormant' : 'active',
        })
      }
    })()
    // Base d'AVANT la migration 100 : ni index de rappel, ni déclencheurs, ni état.
    store.db.exec(`
      DROP TRIGGER facts_recall_ai; DROP TRIGGER facts_recall_ad; DROP TRIGGER facts_recall_au;
      DROP TABLE facts_recall_fts;
      DELETE FROM schema_migrations WHERE version = 100;
    `)
    store.db.prepare('DELETE FROM meta WHERE key = ?').run(RECALL_FTS_STATE_KEY)
    store.close()

    // Réouverture : migration rejouée, UNE tranche de 100 à l'ouverture.
    store = new ContentStore(path, { recallIndex: { chunk: 100, openBudgetMs: 0 } })
    const db = store.db
    expect(store.isRecallIndexReady()).toBe(false)
    expect((db.prepare('SELECT COUNT(*) AS c FROM facts_recall_fts_docsize').get() as { c: number }).c).toBe(100)
    const cursor = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get(RECALL_FTS_STATE_KEY) as { value: string }).value)
    const rowidOf = (id: string) => (db.prepare('SELECT rowid AS r FROM facts WHERE id = ?').get(id) as { r: number }).r
    const ids = (db.prepare('SELECT id, lifecycle_state AS s, rowid AS r FROM facts ORDER BY rowid').all() as Array<{ id: string; s: string; r: number }>)
    const before = ids.filter(x => x.r <= cursor)
    const after = ids.filter(x => x.r > cursor)
    const activeBefore = before.filter(x => x.s === 'active')
    const activeAfter = after.filter(x => x.s === 'active')
    const dormantBefore = before.filter(x => x.s === 'dormant')
    const dormantAfter = after.filter(x => x.s === 'dormant')

    const setText = db.prepare('UPDATE facts SET fact = ? WHERE id = ?')
    const setState = db.prepare('UPDATE facts SET lifecycle_state = ? WHERE id = ?')
    const supersede = db.prepare('UPDATE facts SET superseded = 1 WHERE id = ?')
    setText.run('Fait réécrit déjà indexé omega', activeBefore[0]!.id) // indexé : supprimé puis réindexé
    setText.run('Fait réécrit pas encore indexé omega', activeAfter[0]!.id) // pas encore indexé : indexé tout de suite
    setState.run('dormant', activeBefore[1]!.id) // indexé → retiré
    setState.run('dormant', activeAfter[1]!.id) // pas encore indexé → rien à retirer, la tranche le sautera
    setState.run('active', dormantBefore[0]!.id) // avant le curseur : la tranche ne repassera pas, le déclencheur l'indexe
    setState.run('active', dormantAfter[0]!.id)
    supersede.run(activeAfter[2]!.id)
    store.hardDeleteFacts([activeBefore[2]!.id, activeAfter[3]!.id])
    store.insertFact({ fact: 'Fait tout neuf omega alpha', scope_id: 'private:test' })

    // Trois tranches de plus, puis d'autres écritures autour du nouveau curseur.
    for (let i = 0; i < 3; i++) expect(store.advanceRecallIndex(0)).toBe(false)
    const cursor2 = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get(RECALL_FTS_STATE_KEY) as { value: string }).value)
    expect(cursor2).toBeGreaterThan(cursor)
    const near = ids.filter(x => x.s === 'active' && x.r > cursor2).slice(0, 3)
    expect(near).toHaveLength(3)
    expect(rowidOf(near[0]!.id)).toBeGreaterThan(cursor2)
    setText.run('Fait réécrit juste après le curseur omega', near[0]!.id)
    setState.run('dormant', near[1]!.id)
    setState.run('active', near[1]!.id) // aller-retour avant que la tranche ne passe
    store.hardDeleteFacts([near[2]!.id])
    setText.run('Fait réécrit après le passage de la tranche omega', activeAfter[5]!.id)

    // Rappel : mêmes faits que l'index complet filtré par l'état, pendant le
    // remplissage (ancien chemin, le rappel n'écrit pas) puis après.
    const expectSearchExact = (q: string) => {
      const got = new Set(store.searchFacts(q, { limit: 5000 }).map(h => h.row.id))
      const want = new Set(
        (db
          .prepare(
            `SELECT f.id FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
             WHERE facts_fts MATCH ? AND f.lifecycle_state = 'active' AND f.superseded = 0`,
          )
          .all(`"${q}"`) as Array<{ id: string }>).map(r => r.id),
      )
      expect(got, q).toEqual(want)
    }
    expectSearchExact('omega')
    expectSearchExact('gamma')
    expect(store.isRecallIndexReady()).toBe(false)

    let steps = 4 // l'ouverture et les trois tranches ci-dessus
    while (!store.advanceRecallIndex(0)) steps++
    expect(steps).toBeGreaterThan(5)
    expect(store.isRecallIndexReady()).toBe(true)
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get(RECALL_FTS_STATE_KEY) as { value: string }).value).toBe('ready')
    expectRecallIndexExact(db, [...words, 'omega', 'fait', 'neuf', 'reecrit', 'curseur', 'tranche'])
    expectSearchExact('omega')
    expectSearchExact('gamma')
    expectSearchExact('beta')
    store.close()

    // Une base prête le reste à la réouverture, sans retravail.
    store = new ContentStore(path, { recallIndex: { chunk: 1, openBudgetMs: 0 } })
    expect(store.isRecallIndexReady()).toBe(true)
    store.close()
  })

  it('pas de tranche dans une transaction englobante (un retour arrière ne laisse pas un index faux)', () => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-recall-fts-'))
    const path = join(dir, 'memory.sqlite')
    let store = new ContentStore(path)
    for (let i = 0; i < 30; i++) store.insertFact({ fact: `Fait ${i} sigma`, scope_id: 'private:test' })
    store.db.exec('DROP TRIGGER facts_recall_ai; DROP TRIGGER facts_recall_ad; DROP TRIGGER facts_recall_au; DROP TABLE facts_recall_fts; DELETE FROM schema_migrations WHERE version = 100;')
    store.db.prepare('DELETE FROM meta WHERE key = ?').run(RECALL_FTS_STATE_KEY)
    store.close()
    store = new ContentStore(path, { recallIndex: { chunk: 10, openBudgetMs: 0 } })
    expect(() =>
      store.db.transaction(() => {
        expect(store.advanceRecallIndex(1000)).toBe(false) // refusé : pas de tranche ici
        expect(store.searchFacts('sigma', { limit: 100 })).toHaveLength(30) // ancien chemin, juste
        throw new Error('retour arrière')
      })(),
    ).toThrow('retour arrière')
    expect(store.isRecallIndexReady()).toBe(false)
    expect(store.searchFacts('sigma', { limit: 100 })).toHaveLength(30)
    expect(store.advanceRecallIndex(1000)).toBe(true)
    expect(store.isRecallIndexReady()).toBe(true)
    expect(store.searchFacts('sigma', { limit: 100 })).toHaveLength(30)
    expectRecallIndexExact(store.db, ['sigma', 'fait'])
    store.close()
  })

  it('le moteur finit en tâche de fond un remplissage que l’ouverture n’a pas bouclé', async () => {
    env = setupTriage({ embedder: null })
    for (let i = 0; i < 20; i++) env.m.storeFact({ instance: env.instance, content: `Note de chantier ${i} sur la toiture` })
    const db = env.db()
    db.exec('DROP TRIGGER facts_recall_ai; DROP TRIGGER facts_recall_ad; DROP TRIGGER facts_recall_au; DROP TABLE facts_recall_fts; DELETE FROM schema_migrations WHERE version = 100;')
    db.prepare('DELETE FROM meta WHERE key = ?').run(RECALL_FTS_STATE_KEY)
    const root = env.root
    const target = env.m.registry.dbForInstance(env.instance)!.path
    env.m.close()
    // Ouverture de CETTE base qui ne remplit rien (budget épuisé, simulé) : le
    // moteur doit reprendre seul, sans attendre un rappel.
    const real = ContentStore.prototype.advanceRecallIndex
    let calls = 0
    const spy = vi.spyOn(ContentStore.prototype, 'advanceRecallIndex').mockImplementation(function (this: ContentStore, budget: number) {
      if (this.path !== target) return real.call(this, budget)
      calls++
      return calls === 1 ? false : real.call(this, budget)
    })
    const m = Memoria.init({ storageRoot: join(root, 'data'), configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
    env = { ...env, m, close: () => { m.close(); rmSync(root, { recursive: true, force: true }) } }
    const store = storeOf(env)
    expect(calls).toBe(1)
    expect(store.isRecallIndexReady()).toBe(false)
    for (let i = 0; i < 40 && !store.isRecallIndexReady(); i++) await sleep(25)
    expect(store.isRecallIndexReady()).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(2)
    spy.mockRestore()
    expectRecallIndexExact(store.db, ['toiture', 'chantier'])
    expect(m.recall({ instance: env.instance, query: 'chantier toiture' }).items.length).toBeGreaterThan(0)
  })
})
