/**
 * L'estimation (dry-run, et le calcul qui précède chaque passage) passe le
 * filtre sensible sur chaque fait en attente. Page de 5 000 faits d'un seul
 * tenant : ~350 ms de boucle figée sur la vraie base (15/11). Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

/** Multiplie un fait en attente par SQL (storeFact un par un serait trop lent). */
function multiply(id: string, n: number): void {
  const db = env.db()
  const cols = (db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name)
  const sel = cols
    .map(c => (c === 'id' ? `'copie-' || n` : c === 'fact' ? `fact || ' (copie ' || n || ')'` : c === 'norm_hash' ? 'NULL' : c))
    .join(', ')
  db.prepare(
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${n})
     INSERT INTO facts (${cols.join(', ')}) SELECT ${sel} FROM facts, seq WHERE facts.id = ?`,
  ).run(id)
}

describe('estimation sans boucle figée', () => {
  it('6 000 faits longs : jamais plus de 100 ms sans rendre la main', async () => {
    env = setupTriage({ embedder: null })
    const long = 'Le projet fictif du jardin partagé de la rue des Lilas avance : '.repeat(7)
    multiply(seedPending(env, long), 6000)
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    try {
      const s = await env.m.triage.run({ dryRun: true })
      expect(s.estimate?.facts_pending).toBeGreaterThanOrEqual(6000)
    } finally {
      clearInterval(timer)
    }
    expect(worst).toBeLessThan(100)
  }, 60_000)
})
