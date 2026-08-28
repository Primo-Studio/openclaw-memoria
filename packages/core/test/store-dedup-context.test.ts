/**
 * Revue finale 27/08 : le dédoublonnage EXACT de storeFact renvoyait n'importe
 * quel fait non supersédé du scope — expiré, ou isolé sous un autre client —
 * et jetait la déclaration en silence (l'agent recevait l'id d'un fait
 * invisible : fait perdu, vérités divergentes entre agents).
 *
 * Règle : un doublon exact n'en est un que s'il est RAPPELABLE dans le même
 * contexte. Expiré → réveillé ; autre client/projet → fait distinct.
 * + policy : pas d'écriture `user` par défaut pour un agent de canal (openclaw).
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
  root = mkdtempSync(join(tmpdir(), 'memoria-dedup-ctx-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

const TEXT = 'La CI du site Primo tourne sur GitHub Actions'

describe('storeFact — doublon exact et contexte', () => {
  it('redéclarer un fait EXPIRÉ le réveille (rappelable à nouveau), sans le dupliquer', () => {
    const first = m.storeFact({ instance, content: TEXT, category: 'infra' })
    expect(m.setExpiry(instance, first.id, '2020-01-01T00:00:00.000Z')).toBe(true)
    expect(m.recall({ instance, query: 'CI Primo GitHub' }).items).toHaveLength(0)

    const again = m.storeFact({ instance, content: TEXT, category: 'infra' })
    expect(again.id).toBe(first.id)
    expect(again.expires_at).toBeNull()
    expect(m.recall({ instance, query: 'CI Primo GitHub' }).items.some(i => i.id === first.id)).toBe(true)
  })

  it('même texte sous un AUTRE client/projet = fait distinct, pas une redite', () => {
    const a = m.storeFact({ instance, content: TEXT, category: 'infra', client_org_id: 'velmar' })
    const b = m.storeFact({ instance, content: TEXT, category: 'infra', project_id: 'primo-site' })
    expect(b.id).not.toBe(a.id)
    expect(a.client_org_id).toBe('velmar')
    expect(b.project_id).toBe('primo-site')
    // et le même texte, même contexte → bien dédoublonné
    const a2 = m.storeFact({ instance, content: TEXT, category: 'infra', client_org_id: 'velmar' })
    expect(a2.id).toBe(a.id)
  })

  it('correctFact vers le texte d’un fait expiré : la correction est visible (pas un remplaçant fantôme)', () => {
    const old = m.storeFact({ instance, content: TEXT, category: 'infra' })
    m.setExpiry(instance, old.id, '2020-01-01T00:00:00.000Z')
    const current = m.storeFact({ instance, content: 'La CI du site Primo tourne sur GitLab', category: 'infra' })
    const { replacement } = m.correctFact(instance, current.id, TEXT)
    expect(replacement).not.toBeNull()
    expect(replacement!.expires_at).toBeNull()
    const found = m.recall({ instance, query: 'CI Primo GitHub' }).items
    expect(found.some(i => i.id === replacement!.id)).toBe(true)
    expect(found.some(i => i.id === current.id)).toBe(false)
  })
})

describe('forget dry_run — matched honnête', () => {
  it('avec des ids : compte les faits présents, pas ids × nombre de bases', () => {
    m.pairAssistant({ type: 'codex' })
    m.pairAssistant({ type: 'generic' })
    const f = m.storeFact({ instance, content: 'Néto préfère les réponses courtes', category: 'preference' })
    const dry = m.forget({ ids: [f.id], dry_run: true })
    expect(dry.matched).toBe(1)
    expect(dry.deleted).toBe(0)
    expect(m.forget({ ids: ['id-fantome'], dry_run: true }).matched).toBe(0)
  })
})

describe('policy `user` par défaut', () => {
  it('claude-code / codex peuvent écrire dans user ; un agent de canal openclaw reste en lecture', () => {
    const userScope = m.registry.getScopeByName('user')!
    const claude = m.registry.getInstance(instance)!
    expect(m.registry.getPolicy(claude.assistant_id, userScope.id)?.can_write).toBe(true)

    const bot = m.pairAssistant({ type: 'openclaw' })
    const botInstance = m.registry.getInstance(bot.assistant_instance_id)!
    expect(m.registry.getPolicy(botInstance.assistant_id, userScope.id)?.can_write).toBe(false)
    expect(() => m.storeFact({ instance: bot.assistant_instance_id, content: 'Faux fait injecté', scope: 'user' })).toThrow(/can_write/)
  })
})
