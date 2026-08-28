/**
 * `memoria doctor` enrichi (retours bêta) : « dernier rappel réussi, dernière
 * capture réussie, latence, doublons détectés, taille de la base ».
 *
 * Les métriques sont dérivées d'`audit_log` (format `clé=valeur`) et des DB de
 * contenu — aucune table de métriques dédiée, donc aucune migration.
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
  root = mkdtempSync(join(tmpdir(), 'memoria-doctor-'))
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

describe('doctor — kill-switch', () => {
  it('Memoria en pause → enabled:false, ok:false et un avertissement qui dit comment reprendre', () => {
    // LA cause n°1 de « mes agents ne se souviennent de rien » : le doctor
    // concluait « ✓ OK » sans un mot sur la pause.
    m.setEnabled(false)
    const r = m.doctor()
    expect(r.enabled).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.warnings.join('\n')).toMatch(/PAUSE/)
    expect(r.warnings.join('\n')).toContain('memoria enable')
  })

  it('Memoria active → enabled:true, aucun avertissement de pause', () => {
    const r = m.doctor()
    expect(r.enabled).toBe(true)
    expect(r.warnings.join('\n')).not.toMatch(/PAUSE/)
  })
})

describe('doctor — activité', () => {
  it('sans activité : compteurs à zéro, latence NON mesurée (≠ zéro)', () => {
    const r = m.doctor()
    expect(r.activity.recalls_24h).toBe(0)
    expect(r.activity.last_recall_at).toBeUndefined()
    // Distinction essentielle : afficher « 0 ms » laisserait croire à un recall
    // instantané alors que rien n'a été mesuré.
    expect(r.activity.recall_ms_avg).toBeUndefined()
  })

  it('un recall alimente compteur, horodatage et latence', () => {
    m.storeFact({ instance, content: 'Néto travaille depuis un Mac Studio', category: 'general' })
    m.recall({ instance, query: 'Mac Studio' })

    const r = m.doctor()
    expect(r.activity.recalls_24h).toBe(1)
    expect(r.activity.last_recall_at).toBeTruthy()
    expect(r.activity.recall_ms_avg).toBeGreaterThanOrEqual(0)
    expect(r.activity.recall_ms_p95).toBeGreaterThanOrEqual(0)
    // Le coût réel du contexte injecté, pas une estimation.
    expect(r.activity.recall_tokens_avg).toBeGreaterThan(0)
  })

  it('une capture est auditée — « la dernière capture a-t-elle réussi ? »', async () => {
    await m.captureTurn({ instance, messages: [{ role: 'user', content: 'Le studio ferme le 15 août.' }] })

    const r = m.doctor()
    expect(r.activity.captures_24h).toBe(1)
    expect(r.activity.last_capture_at).toBeTruthy()
    expect(r.activity.capture_ms_avg).toBeGreaterThanOrEqual(0)
  })
})

describe('doctor — état de la mémoire', () => {
  it('compte les faits, les supersédés et les jamais utilisés', () => {
    m.storeFact({ instance, content: 'Premier fait de référence', category: 'general' })
    m.storeFact({ instance, content: 'Second fait de référence', category: 'general' })

    const r = m.doctor()
    expect(r.memory.facts_total).toBe(2)
    expect(r.memory.facts_superseded).toBe(0)
    // Aucun n'a encore servi à répondre.
    expect(r.memory.facts_never_used).toBe(2)
  })

  it('compte les messages en attente d’extraction', async () => {
    // Aucun LLM d'extraction : les messages restent en WAL (comportement voulu).
    await m.captureTurn({ instance, messages: [{ role: 'user', content: 'Une information à mémoriser plus tard.' }] })

    const r = m.doctor()
    expect(r.memory.wal_pending).toBeGreaterThan(0)
    expect(r.memory.wal_stuck).toBe(0) // en attente ≠ bloqué
  })

  it('révisions en attente comptées et signalées en avertissement', () => {
    const ancien = m.storeFact({ instance, content: 'Le déploiement passe par Hello-Primo', category: 'process' })
    const nouveau = m.storeFact({ instance, content: 'Le déploiement passe par Vercel', category: 'process' })

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
         VALUES ('r1', ?, 'contradicted', ?, 'proposed', '2026-07-01T00:00:00Z')`,
      )
      .run(ancien.id, nouveau.id)

    const r = m.doctor()
    expect(r.memory.contradictions_pending).toBe(1)
    expect(r.memory.duplicates_pending).toBe(0)
    // Une dette d'arbitrage doit être VISIBLE : tant qu'elle traîne, les faits
    // contestés restent actifs.
    expect(r.warnings.join(' ')).toMatch(/révision/i)
    expect(r.ok).toBe(false)
  })

  it('sans table revision_proposals : aucun compte, aucun échec', () => {
    m.storeFact({ instance, content: 'Un fait quelconque du studio', category: 'general' })
    const r = m.doctor()
    expect(r.memory.contradictions_pending).toBe(0)
    expect(r.memory.duplicates_pending).toBe(0)
  })
})
