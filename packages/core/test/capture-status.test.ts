/**
 * Statut de capture (retour bêta) : « memoria_capture_turn a expiré après
 * environ 120 secondes ; il faudrait un statut consultable — en attente,
 * traité, échoué, retry prévu — avec un identifiant de capture ».
 *
 * Dérivé du WAL et de l'audit, sans table ni colonne ajoutée.
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
  root = mkdtempSync(join(tmpdir(), 'memoria-capstat-'))
  // Pas de LLM d'extraction : les entrées restent PENDING (comportement voulu).
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('captureTurn → wal_ids', () => {
  it('rend un reçu : un identifiant par message écrit', async () => {
    const r = await m.captureTurn({
      instance,
      messages: [
        { role: 'user', content: 'Le studio ferme le 15 août.' },
        { role: 'assistant', content: 'Noté, aucune mise en prod sur cette période.' },
      ],
    })
    expect(r.appended).toBe(2)
    expect(r.wal_ids).toHaveLength(2)
    expect(r.wal_ids.every(id => Number.isInteger(id))).toBe(true)
  })
})

describe('captureStatus', () => {
  it('sans LLM : les messages sont EN ATTENTE, pas perdus', async () => {
    const r = await m.captureTurn({ instance, messages: [{ role: 'user', content: 'Une information à retenir plus tard.' }] })
    const s = m.captureStatus(instance, r.wal_ids)
    expect(s.pending).toBe(1)
    expect(s.failed).toBe(0)
    expect(s.entries[0]).toMatchObject({ wal_id: r.wal_ids[0], status: 'pending', attempts: 0 })
  })

  it('un id inconnu est réputé TRAITÉ — le cleanup ne purge que le traité', () => {
    // Sinon un appelant verrait « pending » éternellement sur une entrée
    // simplement nettoyée, et re-capturerait en créant un doublon.
    const s = m.captureStatus(instance, [999_999])
    expect(s.entries[0]).toMatchObject({ wal_id: 999_999, status: 'done' })
    expect(s.done).toBe(1)
  })

  it('liste vide → résultat vide, jamais d’erreur', () => {
    expect(m.captureStatus(instance, [])).toEqual({ entries: [], pending: 0, retrying: 0, done: 0, failed: 0 })
  })

  it('instance inconnue → résultat vide, pas de fuite d’exception', () => {
    expect(m.captureStatus('instance-inexistante', [1, 2]).entries).toEqual([])
  })
})
