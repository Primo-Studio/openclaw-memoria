/**
 * `memoria move` de bout en bout : après le déplacement, TOUT doit suivre.
 * Bug : db_registry gardait les chemins ABSOLUS de l'ancien emplacement et
 * rien ne les recalculait au boot (le commentaire de moveStorage le promettait
 * à tort). Recall/storeFact marchaient (chemins recalculés via storagePaths),
 * mais stats répondait 0, doctor « enregistrée mais absente du disque », et
 * `memoria forget` (RGPD, « partout ») annonçait 0 supprimé alors que le fait
 * restait rappelable.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria, moveStorage } from '../src/index.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-move-rebase-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('déplacement de la racine → registre des bases réaligné au boot', () => {
  it('stats, doctor, revue et forget voient la mémoire déplacée (privée ET partagée)', () => {
    const from = join(dir, 'data')
    const to = join(dir, 'usb', 'memoria')
    const configPath = join(dir, 'config.toml')

    const m = Memoria.init({ storageRoot: from, configPath, llm: { extraction: null }, secretsVault: 'aes-vault' })
    const instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const privateFact = m.storeFact({ instance, content: 'Fait test numéro 3 sur Acme' })
    m.storeFact({ instance, scope: 'user', content: 'Le studio déploie sur Vercel' })
    m.setCaptureMode('review-first')
    m.declareFact({ instance, content: 'Fait en attente de revue' })
    expect(m.stats()).toMatchObject({ facts: 3, databases: 2 })
    m.close()

    moveStorage({ from, to, configPath })
    expect(existsSync(from)).toBe(false)

    const m2 = Memoria.init({ configPath, llm: { extraction: null }, secretsVault: 'aes-vault' })
    try {
      expect(m2.paths.root).toBe(to)
      // registre : plus AUCUN chemin sous l'ancienne racine, tous existants
      const dbs = m2.registry.listDbs()
      expect(dbs.every(d => d.path.startsWith(to))).toBe(true)
      expect(dbs.every(d => existsSync(d.path))).toBe(true)
      expect(dbs.filter(d => d.kind === 'registry')).toHaveLength(1)

      expect(m2.stats()).toMatchObject({ facts: 3, databases: 2 })
      const report = m2.doctor()
      expect(report.databases.every(d => d.exists)).toBe(true)
      expect(report.warnings.join('\n')).not.toContain('absente du disque')
      expect(m2.listReview()).toHaveLength(1)

      // forget par id : supprime VRAIMENT (et le recall ne le retrouve plus)
      expect(m2.forget({ ids: [privateFact.id] })).toEqual({ deleted: 1, matched: 1 })
      expect(m2.recall({ instance, query: 'Acme numéro 3' }).items).toHaveLength(0)
      expect(m2.forget({ query: 'Vercel', confirm_bulk: true }).deleted).toBe(1)
      expect(m2.stats().facts).toBe(1)
    } finally {
      m2.close()
    }
  })

  it('un aller-retour laisse le registre propre (idempotent, pas de doublon)', () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    const configPath = join(dir, 'config.toml')
    const m = Memoria.init({ storageRoot: a, configPath, llm: { extraction: null }, secretsVault: 'aes-vault' })
    const instance = m.pairAssistant({ type: 'codex' }).assistant_instance_id
    m.storeFact({ instance, content: 'Un fait' })
    m.close()

    moveStorage({ from: a, to: b, configPath })
    Memoria.init({ configPath, llm: { extraction: null }, secretsVault: 'aes-vault' }).close()
    moveStorage({ from: b, to: a, configPath })
    const back = Memoria.init({ configPath, llm: { extraction: null }, secretsVault: 'aes-vault' })
    try {
      expect(back.registry.listDbs()).toHaveLength(2) // registre + DB privée, pas un de plus
      expect(back.stats().facts).toBe(1)
    } finally {
      back.close()
    }
  })
})
