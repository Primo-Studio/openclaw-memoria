/**
 * Maintenance de la mémoire (retours bêta) : « fusionner deux faits, corriger
 * un fait, voir les doublons, afficher les mémoires jamais utilisées ».
 *
 * Règle commune, héritée de RevisionEngine : on ne réécrit JAMAIS un contenu en
 * place. Corriger et fusionner passent par la supersession, ce qui garde la
 * chaîne navigable et l'erreur rattrapable.
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
  root = mkdtempSync(join(tmpdir(), 'memoria-maint-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

/** Lit les colonnes brutes que `Fact` n'expose pas. */
function raw(id: string): { superseded: number; superseded_by: string | null; pinned: number } {
  const db = (m as unknown as { registry: { dbForInstance(i: string): { path: string } } }).registry.dbForInstance(instance)!
  const store = (m as unknown as { openContent(p: string): { db: import('better-sqlite3').Database } }).openContent(db.path)
  return store.db.prepare('SELECT superseded, superseded_by, pinned FROM facts WHERE id = ?').get(id) as never
}

describe('correctFact', () => {
  it('crée la version corrigée et chaîne l’ancienne dessus', () => {
    const old = m.storeFact({ instance, content: 'Le déploiement passe par Hello-Primo', category: 'process' })
    const { replacement } = m.correctFact(instance, old.id, 'Le déploiement passe par Vercel')

    expect(replacement).toBeTruthy()
    expect(replacement!.fact).toBe('Le déploiement passe par Vercel')
    // L'ancien texte n'est pas écrasé : il reste lisible et traçable.
    const before = raw(old.id)
    expect(before.superseded).toBe(1)
    expect(before.superseded_by).toBe(replacement!.id)
    // Seule la correction remonte au recall.
    const items = m.recall({ instance, query: 'déploiement' }).items
    expect(items.map(i => i.id)).toEqual([replacement!.id])
  })

  it('la correction hérite de l’épinglage — corriger ne doit pas déclasser', () => {
    const old = m.storeFact({ instance, content: 'Une règle importante à conserver', category: 'preference' })
    m.setPinned(instance, old.id, true)
    const { replacement } = m.correctFact(instance, old.id, 'Une règle importante, reformulée')
    expect(raw(replacement!.id).pinned).toBe(1)
  })

  it('refuse un contenu vide et ignore un fait déjà supersédé', () => {
    const f = m.storeFact({ instance, content: 'Un fait quelconque du studio', category: 'general' })
    expect(() => m.correctFact(instance, f.id, '   ')).toThrow(/vide/)
    m.correctFact(instance, f.id, 'Version corrigée du fait')
    expect(m.correctFact(instance, f.id, 'Deuxième correction').replacement).toBeNull()
  })
})

describe('mergeFacts', () => {
  it('supersède les doublons vers le fait conservé', () => {
    const keep = m.storeFact({ instance, content: 'Memoria tourne sur l’iMac du studio', category: 'config' })
    const d1 = m.storeFact({ instance, content: 'Memoria tourne sur l’iMac', category: 'config' })
    const d2 = m.storeFact({ instance, content: 'Memoria est installé sur l’iMac du studio', category: 'config' })

    const { merged } = m.mergeFacts(instance, keep.id, [d1.id, d2.id])
    expect(merged.sort()).toEqual([d1.id, d2.id].sort())
    expect(raw(d1.id).superseded_by).toBe(keep.id)
    expect(raw(keep.id).superseded).toBe(0)
  })

  it('REFUSE de fusionner vers un fait supersédé — chaîne cassée interdite', () => {
    const a = m.storeFact({ instance, content: 'Premier fait de référence du studio', category: 'general' })
    const b = m.storeFact({ instance, content: 'Second fait de référence du studio', category: 'general' })
    m.correctFact(instance, a.id, 'Premier fait corrigé')
    // C'est exactement le bug legacy 'split:' : pointer vers un fait mort.
    expect(() => m.mergeFacts(instance, a.id, [b.id])).toThrow(/absent ou supersédé/)
  })

  it('fusionner un fait avec lui-même ne fait rien', () => {
    const a = m.storeFact({ instance, content: 'Un fait isolé du studio', category: 'general' })
    expect(m.mergeFacts(instance, a.id, [a.id]).merged).toEqual([])
  })
})

describe('neverUsedFacts', () => {
  it('liste les candidats au ménage, en épargnant les épinglés', () => {
    const a = m.storeFact({ instance, content: 'Un fait jamais utilisé du studio', category: 'general' })
    const b = m.storeFact({ instance, content: 'Un autre fait jamais utilisé', category: 'general' })
    m.setPinned(instance, b.id, true)

    const jamais = m.neverUsedFacts(instance)
    expect(jamais.map(f => f.id)).toEqual([a.id])
  })
})
