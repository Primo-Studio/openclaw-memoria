/**
 * `memoria export` inclut les scopes PARTAGÉS lisibles. Avant, exportMarkdown
 * n'ouvrait que la DB privée : les faits déclarés dans `user` (destination
 * nominale de « ce qu'un agent apprend SUR l'utilisateur ») ne figuraient
 * dans l'export d'aucun agent — « 0 souvenirs » alors que stats en comptait 2.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/index.js'

let root: string
let m: Memoria

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-export-shared-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
})
afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('exportMarkdown — scopes partagés', () => {
  it('la section « shared/user » contient le fait partagé ; le privé reste à la racine', () => {
    const a = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    m.storeFact({ instance: a, content: 'Fait privé de Claude' })
    m.storeFact({ instance: a, scope: 'user', content: 'Le studio déploie sur Vercel' })

    const out = join(root, 'exports', 'claude-code')
    const r = m.exportMarkdown(a, out, false)
    expect(r.facts).toBe(1)
    expect(r.shared_facts).toBe(1)
    expect(r.scopes).toEqual(['user'])

    const rel = r.files.map(f => relative(out, f)).sort()
    expect(rel).toContain('MEMORY.md')
    expect(rel).toContain(join('shared', 'user', 'MEMORY.md'))
    expect(readFileSync(join(out, 'MEMORY.md'), 'utf8')).toContain('Fait privé de Claude')
    expect(readFileSync(join(out, 'MEMORY.md'), 'utf8')).not.toContain('Vercel')
    expect(readFileSync(join(out, 'shared', 'user', 'MEMORY.md'), 'utf8')).toContain('Vercel')
  })

  it('un autre agent lecteur de « user » exporte aussi ce fait ; un scope non lisible n’apparaît pas', () => {
    const a = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const b = m.pairAssistant({ type: 'codex' }).assistant_instance_id
    m.storeFact({ instance: a, scope: 'user', content: 'Le studio déploie sur Vercel' })

    const r = m.exportMarkdown(b, join(root, 'exports', 'codex'), false)
    expect(r.facts).toBe(0)
    expect(r.shared_facts).toBe(1)

    // retirer la lecture de `user` à codex → plus rien de partagé dans son export
    const userScope = m.registry.getScopeByName('user')!
    const codexAssistant = m.registry.getInstance(b)!.assistant_id
    m.setScopeAccess(codexAssistant, userScope.id, { can_read: false, can_write: false })
    const r2 = m.exportMarkdown(b, join(root, 'exports', 'codex-2'), false)
    expect(r2.shared_facts).toBe(0)
    expect(r2.scopes).toEqual([])
  })
})
