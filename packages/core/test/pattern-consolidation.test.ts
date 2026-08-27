/**
 * Bouton « Consolider » de l'écran Récurrences : l'UI promet « Confirme pour
 * le consolider ». Côté moteur, accepter un pattern ne changeait RIEN dans la
 * mémoire (status 'accepted' seulement) — et PatternEngine.consolidate, jamais
 * câblé, aurait supersédé TOUS les membres, canonique compris, sans remplaçant.
 * Ici : accepter = garder UN fait canonique actif, chaîner les autres dessus.
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
  root = mkdtempSync(join(tmpdir(), 'memoria-consolidate-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

const db = () => m['openContent'](m.paths.assistantDb(instance)).db

describe('decidePattern(accept) consolide réellement', () => {
  it('un seul fait canonique reste actif, les autres membres pointent dessus, aucun fait perdu', () => {
    const ids = [
      m.storeFact({ instance, content: 'Néto préfère les commits signés en français', category: 'preference' }),
      m.storeFact({ instance, content: 'Néto préfère des commits français bien signés', category: 'preference' }),
      m.storeFact({ instance, content: 'Préférence de Néto : commits signés français toujours', category: 'preference' }),
    ].map(f => f.id)
    expect(m.detectPatterns(instance, 3).proposed).toBe(1)
    const pattern = m.listPatterns(instance)[0]!

    const r = m.decidePattern(instance, pattern.id, 'accept')
    expect(r.ok).toBe(true)
    expect(r.superseded).toBe(2)

    const rows = db().prepare('SELECT id, superseded, superseded_by FROM facts').all() as Array<{ id: string; superseded: number; superseded_by: string | null }>
    expect(rows).toHaveLength(3) // rien n'est effacé
    const active = rows.filter(x => x.superseded === 0)
    expect(active).toHaveLength(1)
    expect(ids).toContain(active[0]!.id)
    for (const s of rows.filter(x => x.superseded === 1)) expect(s.superseded_by).toBe(active[0]!.id)

    // Le recall ne remonte plus que le canonique ; le pattern est sorti de la liste.
    expect(m.recall({ instance, query: 'commits signés français' }).items.map(i => i.id)).toEqual([active[0]!.id])
    expect(m.listPatterns(instance)).toHaveLength(0)
  })

  it('écarter (dismiss) ne touche à aucun fait', () => {
    for (const t of ['Néto préfère les commits signés en français', 'Néto préfère des commits français bien signés', 'Préférence de Néto : commits signés français toujours']) {
      m.storeFact({ instance, content: t, category: 'preference' })
    }
    m.detectPatterns(instance, 3)
    const pattern = m.listPatterns(instance)[0]!
    expect(m.decidePattern(instance, pattern.id, 'dismiss')).toEqual({ ok: true, superseded: 0 })
    expect((db().prepare('SELECT COUNT(*) AS c FROM facts WHERE superseded = 1').get() as { c: number }).c).toBe(0)
  })
})
