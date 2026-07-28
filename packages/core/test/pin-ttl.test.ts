/**
 * Épinglage et expiration (retour bêta) : « épingler un souvenir important »,
 * « expiration/TTL ». C'étaient les deux seuls contrôles manquants côté
 * utilisateur — on pouvait tout oublier, rien retenir de force, et rien faire
 * périmer volontairement.
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
  root = mkdtempSync(join(tmpdir(), 'memoria-pin-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

const hier = new Date(Date.now() - 86_400_000).toISOString()
const demain = new Date(Date.now() + 86_400_000).toISOString()

describe('épinglage', () => {
  it('un fait épinglé passe devant un fait équivalent non épinglé', () => {
    const a = m.storeFact({ instance, content: 'Le déploiement du studio passe par Vercel', category: 'process' })
    m.storeFact({ instance, content: 'Le déploiement du studio passe par Netlify', category: 'process' })

    const avant = m.recall({ instance, query: 'déploiement studio' })
    expect(avant.items.length).toBe(2)

    expect(m.setPinned(instance, a.id, true)).toBe(true)
    const apres = m.recall({ instance, query: 'déploiement studio' })
    expect(apres.items[0]!.id).toBe(a.id)
  })

  it('désépingler est réversible et audité', () => {
    const f = m.storeFact({ instance, content: 'Un souvenir à épingler puis relâcher', category: 'general' })
    expect(m.setPinned(instance, f.id, true)).toBe(true)
    expect(m.setPinned(instance, f.id, false)).toBe(true)
    expect(m.setPinned(instance, 'fact-inexistant', true)).toBe(false)
  })
})

describe('expiration', () => {
  it('un fait expiré n’est PLUS rappelé — mais reste en base', () => {
    const f = m.storeFact({ instance, content: 'Le studio ferme du 15 au 25 août', category: 'general' })
    expect(m.recall({ instance, query: 'studio ferme août' }).items.length).toBe(1)

    m.setExpiry(instance, f.id, hier)
    expect(m.recall({ instance, query: 'studio ferme août' }).items.length).toBe(0)

    // Cesser de rappeler ≠ supprimer : l'historique est préservé.
    const stats = m.doctor().memory
    expect(stats.facts_total).toBe(1)
  })

  it('une expiration FUTURE ne change rien tant qu’elle n’est pas atteinte', () => {
    const f = m.storeFact({ instance, content: 'Configuration temporaire du serveur de test', category: 'config' })
    m.setExpiry(instance, f.id, demain)
    expect(m.recall({ instance, query: 'configuration serveur test' }).items.length).toBe(1)
  })

  it('lever l’expiration remet le souvenir en circulation', () => {
    const f = m.storeFact({ instance, content: 'Une décision provisoire sur le cache', category: 'decision' })
    m.setExpiry(instance, f.id, hier)
    expect(m.recall({ instance, query: 'décision provisoire cache' }).items.length).toBe(0)
    m.setExpiry(instance, f.id, null)
    expect(m.recall({ instance, query: 'décision provisoire cache' }).items.length).toBe(1)
  })

  it('une date invalide est REFUSÉE — pas silencieusement ignorée', () => {
    const f = m.storeFact({ instance, content: 'Un fait quelconque du studio', category: 'general' })
    expect(() => m.setExpiry(instance, f.id, 'pas-une-date')).toThrow(/invalide/)
  })
})
