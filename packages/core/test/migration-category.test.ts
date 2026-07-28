/**
 * Migration v3 — `erreur` → `error` (issue #1).
 *
 * L'enjeu n'est pas l'orthographe : `facts.category` sert de DOMAINE d'expertise
 * (FeedbackEngine). Deux valeurs pour un même concept = deux domaines dont les
 * niveaux ne se cumulent plus. On teste donc les faits ET l'expertise, dont le
 * cas de FUSION (les deux domaines déjà présents), où un simple UPDATE
 * violerait la contrainte UNIQUE sur `domain`.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { contentMigrations } from '../src/storage/content-schema.js'
import { feedbackMigrations } from '../src/cognition/feedback.js'
import { runMigrations } from '../src/storage/migrations.js'

/** DB en mémoire au schéma v1+v2 seulement — la v3 est appliquée par le test. */
function dbBeforeV3(): Database.Database {
  const db = new Database(':memory:')
  runMigrations(
    db,
    contentMigrations.filter(m => m.version < 3),
  )
  return db
}

function applyV3(db: Database.Database): void {
  runMigrations(db, contentMigrations)
}

function insertFact(db: Database.Database, id: string, category: string): void {
  db.prepare(
    `INSERT INTO facts (id, fact, category, scope_id, created_at, updated_at)
     VALUES (?, ?, ?, 'scope-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(id, `énoncé ${id}`, category)
}

function insertExpertise(db: Database.Database, id: string, domain: string, level: number, evidence: number): void {
  db.prepare(
    'INSERT INTO expertise (id, domain, level, evidence_count, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, domain, level, evidence, '2026-01-01T00:00:00Z')
}

describe('migration v3 — catégorie erreur → error', () => {
  it('renomme les faits sans toucher aux autres catégories', () => {
    const db = dbBeforeV3()
    insertFact(db, 'f1', 'erreur')
    insertFact(db, 'f2', 'erreur')
    insertFact(db, 'f3', 'preference')
    insertFact(db, 'f4', 'savoir') // catégorie legacy française : NON concernée

    applyV3(db)

    const rows = db.prepare('SELECT id, category FROM facts ORDER BY id').all() as Array<{ id: string; category: string }>
    expect(rows).toEqual([
      { id: 'f1', category: 'error' },
      { id: 'f2', category: 'error' },
      { id: 'f3', category: 'preference' },
      { id: 'f4', category: 'savoir' },
    ])
    db.close()
  })

  it('renomme le domaine d’expertise quand lui seul existe', () => {
    const db = dbBeforeV3()
    runMigrations(db, feedbackMigrations)
    insertExpertise(db, 'e1', 'erreur', 0.4, 3)

    applyV3(db)

    const rows = db.prepare('SELECT domain, level, evidence_count FROM expertise').all()
    expect(rows).toEqual([{ domain: 'error', level: 0.4, evidence_count: 3 }])
    db.close()
  })

  it('FUSIONNE quand les deux domaines coexistent (UNIQUE sur domain)', () => {
    const db = dbBeforeV3()
    runMigrations(db, feedbackMigrations)
    insertExpertise(db, 'e-fr', 'erreur', 0.6, 4)
    insertExpertise(db, 'e-en', 'error', 0.2, 5)

    expect(() => applyV3(db)).not.toThrow()

    const rows = db.prepare('SELECT domain, level, evidence_count FROM expertise').all()
    // Niveau le plus élevé conservé, preuves additionnées, une seule ligne.
    expect(rows).toEqual([{ domain: 'error', level: 0.6, evidence_count: 9 }])
    db.close()
  })

  it('ne casse pas si la table expertise n’existe pas encore (couche appliquée plus tard)', () => {
    const db = dbBeforeV3()
    insertFact(db, 'f1', 'erreur')

    expect(() => applyV3(db)).not.toThrow()
    expect((db.prepare("SELECT COUNT(*) c FROM facts WHERE category = 'error'").get() as { c: number }).c).toBe(1)
    db.close()
  })

  it('est idempotente (re-run sans effet)', () => {
    const db = dbBeforeV3()
    insertFact(db, 'f1', 'erreur')
    applyV3(db)
    expect(runMigrations(db, contentMigrations)).toBe(0)
    expect((db.prepare("SELECT COUNT(*) c FROM facts WHERE category = 'error'").get() as { c: number }).c).toBe(1)
    db.close()
  })
})

describe('prompts LLM — issue #1 : consignes en anglais', () => {
  it('aucun prompt système ne force une sortie française', async () => {
    // On relit les sources : un prompt est une chaîne, pas une valeur exportée.
    const { readFileSync } = await import('node:fs')
    const files = [
      'src/engine/capture.ts',
      'src/engine/memoria.ts',
      'src/cognition/entities.ts',
      'src/cognition/topics.ts',
      'src/cognition/contradiction.ts',
      'src/cognition/dialectic.ts',
      'src/migration/import-transcripts.ts',
    ]
    for (const f of files) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      // On ignore les COMMENTAIRES : ces fichiers sont documentés en français,
      // et c'est très bien — seul ce qui part au modèle compte.
      const code = src
        .split('\n')
        .filter(l => {
          const t = l.trim()
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
        })
        .join('\n')
      // Un prompt qui impose la langue de sortie est précisément ce que
      // l'issue #1 reproche : les petits modèles s'y amorcent et fuient.
      expect(code, `${f} impose « en français » à un modèle`).not.toMatch(/en français/i)
      expect(code, `${f} attend un verdict « OUI »`).not.toMatch(/« OUI »/)
    }
  })

  it('l’énumération de catégories du prompt d’extraction est entièrement anglaise', async () => {
    const { readFileSync } = await import('node:fs')
    for (const f of ['src/engine/capture.ts', 'src/migration/import-transcripts.ts']) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      expect(src).toContain('preference|decision|config|error|process|general')
      expect(src).not.toContain('config|erreur|process')
    }
  })

  it('les prompts d’extraction exigent de NE PAS traduire les faits', async () => {
    const { readFileSync } = await import('node:fs')
    for (const f of ['src/engine/capture.ts', 'src/migration/import-transcripts.ts']) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      // Sans cette règle, un prompt anglais fait traduire les souvenirs —
      // pire que le mot français qui fuit.
      expect(src, `${f} ne protège pas la langue des faits`).toMatch(/SAME LANGUAGE/)
      expect(src).toMatch(/Never translate/i)
    }
  })
})
