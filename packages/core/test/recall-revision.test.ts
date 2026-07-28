/**
 * Supersession VISIBLE au recall (retours bêta) :
 * « quand une procédure change, l'ancien fait ne devrait plus ressortir comme
 * s'il était encore valable ».
 *
 * Le core détecte les contradictions (`RevisionEngine.propose`) mais ne
 * supersède QU'après validation humaine (`accept`). Entre les deux, le fait
 * corrigé et sa correction coexistent au recall — indiscernables jusqu'ici.
 * On ne masque rien automatiquement : on marque.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/index.js'

let root: string
let m: Memoria
let instance: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-rev-'))
  m = Memoria.init({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: null },
    secretsVault: 'aes-vault',
  })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

/** Insère une proposition de révision non tranchée, comme le ferait `propose()`. */
function proposeContradiction(factId: string, replacementId: string): void {
  const db = (m as unknown as { registry: { dbForInstance(i: string): { path: string } } }).registry.dbForInstance(instance)!
  const store = (m as unknown as { openContent(p: string): { db: import('better-sqlite3').Database } }).openContent(db.path)
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS revision_proposals (
      id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, kind TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', replacement_fact_id TEXT,
      status TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL
    )`)
  store.db
    .prepare(
      `INSERT INTO revision_proposals (id, fact_id, kind, replacement_fact_id, status, created_at)
       VALUES (?, ?, 'contradicted', ?, 'proposed', '2026-07-01T00:00:00Z')`,
    )
    .run(`rev-${factId}`, factId, replacementId)
}

describe('recall — souvenirs contestés', () => {
  it('marque le fait contesté SANS le retirer du recall', () => {
    const ancien = m.storeFact({ instance, content: 'Le déploiement du studio passe par Hello-Primo', category: 'process' })
    const nouveau = m.storeFact({ instance, content: 'Le déploiement du studio passe désormais par Vercel', category: 'process' })
    proposeContradiction(ancien.id, nouveau.id)

    const res = m.recall({ instance, query: 'déploiement studio' })
    const contested = res.items.find(i => i.id === ancien.id)

    // Toujours présent : masquer sur un faux positif enterrerait un fait valide.
    expect(contested, 'le fait contesté doit rester remonté').toBeDefined()
    expect(contested?.revision).toEqual({ kind: 'contradicted', replacement_fact_id: nouveau.id })

    // Le remplaçant, lui, n'est pas contesté.
    expect(res.items.find(i => i.id === nouveau.id)?.revision).toBeUndefined()
  })

  it('une proposition déjà tranchée ne marque plus rien', () => {
    const ancien = m.storeFact({ instance, content: 'Le café du studio vient de Colombie', category: 'general' })
    const nouveau = m.storeFact({ instance, content: 'Le café du studio vient désormais du Brésil', category: 'general' })
    proposeContradiction(ancien.id, nouveau.id)

    const db = (m as unknown as { registry: { dbForInstance(i: string): { path: string } } }).registry.dbForInstance(instance)!
    const store = (m as unknown as { openContent(p: string): { db: import('better-sqlite3').Database } }).openContent(db.path)
    store.db.prepare("UPDATE revision_proposals SET status = 'dismissed'").run()

    const res = m.recall({ instance, query: 'café studio' })
    expect(res.items.find(i => i.id === ancien.id)?.revision).toBeUndefined()
  })

  it('aucune table revision_proposals → recall normal, jamais d’échec', () => {
    // Couche 18 appliquée paresseusement : la table peut ne jamais exister.
    m.storeFact({ instance, content: 'Un fait sans aucune révision en base', category: 'general' })
    const res = m.recall({ instance, query: 'fait révision' })
    expect(res.items.length).toBeGreaterThan(0)
    expect(res.items.every(i => i.revision === undefined)).toBe(true)
  })
})
