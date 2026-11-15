/**
 * Repérage des faits à trier (scan du passage, et estimation du dry-run) sur
 * une base déjà presque toute triée : la première page de 5 000 faits « à
 * trier » parcourait d'un seul tenant tous les faits déjà triés avant elle
 * (~400 ms de boucle figée à chaque lancement ou reprise, mesuré le 15/11).
 * Données fictives uniquement.
 */
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_LLM_FAILURES, SCAN_WINDOW } from '../src/triage/engine.js'
import { seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

/**
 * Multiplie un fait en attente par SQL (storeFact un par un serait trop lent).
 * Identifiants aléatoires comme les vrais (UUID) : des identifiants qui se
 * suivent rangeraient les lignes de tri côte à côte et cacheraient le coût
 * des lectures dispersées de la vraie base.
 */
function multiply(db: Database, id: string, n: number): void {
  const cols = (db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name)
  const sel = cols
    .map(c => (c === 'id' ? 'lower(hex(randomblob(16)))' : c === 'fact' ? `fact || ' (copie ' || n || ')'` : c === 'norm_hash' ? 'NULL' : c))
    .join(', ')
  db.prepare(
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${n})
     INSERT INTO facts (${cols.join(', ')}) SELECT ${sel} FROM facts, seq WHERE facts.id = ?`,
  ).run(id)
}

/**
 * Marque comme déjà triées les copies que `pendingSql` ne retient pas, avec un
 * mélange de genres proche de la vraie base (moitié d'éphémères, au plus 10 %
 * par genre durable) : chaque fait est son propre représentant.
 */
function markTriaged(db: Database, seed: string, pendingSql: string): number {
  return db
    .prepare(
      `INSERT INTO fact_triage (fact_id, genre, rubriques, entites, projet, titre, modele, conversation_at, amas_id, amas_size,
                                prompt_version, triaged_at, importance, durabilite)
       SELECT id,
              CASE rowid % 20 WHEN 10 THEN 'process' WHEN 11 THEN 'process' WHEN 12 THEN 'decision' WHEN 13 THEN 'decision'
                WHEN 14 THEN 'fait' WHEN 15 THEN 'fait' WHEN 16 THEN 'preference' WHEN 17 THEN 'savoir' WHEN 18 THEN 'lecon'
                WHEN 19 THEN 'idee' ELSE 'ephemere' END,
              '["projet"]', '["Lumen"]', 'Projet Fictif', NULL, 'ollama/tri-fictif', '2026-01-01T00:00:00.000Z', id, 1,
              'tri-v3', '2026-01-01T00:00:00.000Z', 2, 2
       FROM facts WHERE id != ? AND NOT (${pendingSql})`,
    )
    .run(seed).changes
}

/** Pire écart de la boucle d'événements pendant `fn` (sonde toutes les ms, plus le dernier morceau synchrone). */
async function worstGap<T>(fn: () => Promise<T>): Promise<{ result: T; worst: number }> {
  let last = performance.now()
  let worst = 0
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 1)
  try {
    const result = await fn()
    worst = Math.max(worst, performance.now() - last)
    return { result, worst }
  } finally {
    clearInterval(timer)
  }
}

describe('repérage sans boucle figée', () => {
  it('80 000 faits déjà triés et 400 à trier : dry-run puis vrai passage, jamais plus de 100 ms sans rendre la main', async () => {
    env = setupTriage()
    const db = env.db()
    const seed = seedPending(env, 'Le projet fictif du jardin partagé de la rue des Lilas avance : '.repeat(3))
    multiply(db, seed, 80_400)
    // 400 copies à trier, réparties dans toute la base (comme les faits en attente réels).
    const triaged = markTriaged(db, seed, 'rowid % 201 = 0')
    expect(triaged).toBe(80_000)
    // Le journal du remplissage n'appartient pas à ce qui est mesuré.
    db.pragma('wal_checkpoint(TRUNCATE)')

    const dry = await worstGap(() => env.m.triage.run({ dryRun: true }))
    expect(dry.result.estimate?.facts_pending).toBe(401)
    expect(dry.worst, `dry-run : ${dry.worst.toFixed(0)} ms`).toBeLessThan(100)

    const real = await worstGap(() => env.m.triage.run())
    expect(real.result.state).toBe('done')
    expect(real.result.facts_done).toBe(401)
    expect((db.prepare('SELECT COUNT(*) AS c FROM fact_triage').get() as { c: number }).c).toBe(80_401)
    expect(real.worst, `passage : ${real.worst.toFixed(0)} ms`).toBeLessThan(100)
  }, 180_000)
})

describe('repérage par fenêtres : mêmes faits, même ordre', () => {
  it('fenêtres entièrement triées et trou de rowid plus large qu’une fenêtre : chaque fait à trier est vu une fois', async () => {
    env = setupTriage()
    const db = env.db()
    const W = SCAN_WINDOW
    const seed = seedPending(env, 'Le projet fictif du jardin partagé de la rue des Lilas avance')
    multiply(db, seed, 5 * W) // rowid 2 à 5W + 1 (copie n au rowid n + 1)
    // Trou : plus d'une fenêtre entière sans aucun fait (oubli d'une plage).
    db.prepare('DELETE FROM facts WHERE rowid > ? AND rowid <= ?').run(2 * W, 3 * W + W / 2)
    const toTriage = [5, 4 * W + 10, 5 * W + 1] // première fenêtre, après le trou, dernier fait
    markTriaged(db, seed, `rowid IN (${toTriage.join(',')})`)
    // Un fait à renvoyer au LLM (1 échec), un autre abandonné (3 échecs), un remplacé, un effacé.
    const at = (rowid: number): string => (db.prepare('SELECT id FROM facts WHERE rowid = ?').get(rowid) as { id: string }).id
    const retry = 4 * W + 900
    db.prepare('UPDATE fact_triage SET genre = NULL, llm_failures = 1 WHERE fact_id = ?').run(at(retry))
    db.prepare(`UPDATE fact_triage SET genre = NULL, llm_failures = ${MAX_LLM_FAILURES} WHERE fact_id = ?`).run(at(retry + 1))
    db.prepare('DELETE FROM fact_triage WHERE fact_id IN (?, ?)').run(at(retry + 2), at(retry + 3))
    db.prepare('UPDATE facts SET superseded = 1 WHERE rowid = ?').run(retry + 2)
    db.prepare("UPDATE facts SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE rowid = ?").run(retry + 3)
    const before = (db.prepare('SELECT COUNT(*) AS c FROM fact_triage').get() as { c: number }).c

    const dry = await env.m.triage.run({ dryRun: true })
    expect(dry.estimate?.facts_pending).toBe(5) // la source, 3 copies, le renvoi

    const real = await env.m.triage.run()
    expect(real.state).toBe('done')
    expect(real.facts_done).toBe(5)
    for (const rowid of [1, ...toTriage, retry]) {
      const row = db.prepare('SELECT genre FROM fact_triage WHERE fact_id = ?').get(at(rowid)) as { genre: string | null } | undefined
      expect(row?.genre, `rowid ${rowid}`).toBe('fait')
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM fact_triage').get() as { c: number }).c).toBe(before + 4)
    // Chaque copie à trier part une seule fois au LLM (l'ordre d'envoi suit le chargement par lot, pas le repérage).
    const sent = env.llm.prompts.flatMap(p => [...p.matchAll(/\(copie (\d+)\)/g)].map(m => Number(m[1])))
    expect(sent.sort((a, b) => a - b)).toEqual([4, 4 * W + 9, 4 * W + 899, 5 * W])
  }, 60_000)

  it('un fait rangé pendant la cession qui suit la dernière fenêtre est trié dans le même passage', async () => {
    env = setupTriage()
    const db = env.db()
    for (let i = 0; i < 5; i++) seedPending(env, `Le fait fictif numéro ${i} du jardin partagé de la rue des Lilas`)
    // Juste après la première lecture « dormant » du repérage, un fait arrive (store_fact servi pendant la cession).
    const origPrepare = db.prepare.bind(db)
    let lateId: string | null = null
    ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const st = origPrepare(sql) as unknown as { all: (...a: unknown[]) => unknown[] }
      if (sql.includes('AS source_id') && sql.includes('LEFT JOIN fact_triage t')) {
        const origAll = st.all.bind(st)
        st.all = (...args: unknown[]) => {
          const r = origAll(...args)
          if (lateId === null && args.includes('dormant')) {
            lateId = ''
            setImmediate(() => {
              lateId = seedPending(env!, 'Un fait fictif arrivé pendant le repérage, à propos de la serre de Zorba')
            })
          }
          return r
        }
      }
      return st
    }
    try {
      const res = await env.m.triage.run()
      expect(res.state).toBe('done')
    } finally {
      ;(db as unknown as { prepare: unknown }).prepare = origPrepare
    }
    expect(lateId).toBeTruthy()
    const row = db.prepare('SELECT genre FROM fact_triage WHERE fact_id = ?').get(lateId) as { genre: string | null } | undefined
    expect(row?.genre ?? null).not.toBeNull()
  }, 60_000)
})
