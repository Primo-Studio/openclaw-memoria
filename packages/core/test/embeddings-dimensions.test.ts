/**
 * `llm.embeddings.dimensions` : les dimensions sont GRAVÉES avec chaque vecteur
 * — « une valeur fausse corrompt la base ». Le moteur refuse donc tout ce qui
 * n'est pas un entier plausible, au lieu de l'écrire tel quel dans config.toml.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/index.js'

let root: string
let m: Memoria

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-dims-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
})
afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('setEmbeddingsProvider — dimensions', () => {
  it('chaîne, flottant, hors bornes → erreur explicite, config intacte', () => {
    for (const bad of ['abc', 1.5, 0, -3, 12, 100_000]) {
      expect(() => m.setEmbeddingsProvider('openai', 'maison-v1', bad as unknown as number)).toThrow(/dimensions/)
    }
    const cfg = join(root, 'config.toml')
    expect(existsSync(cfg) ? readFileSync(cfg, 'utf8') : '').not.toContain('dimensions')
  })

  it('entier plausible → persisté', () => {
    m.setEmbeddingsProvider('openai', 'maison-v1', 512)
    expect(readFileSync(join(root, 'config.toml'), 'utf8')).toContain('dimensions = 512')
    expect(m.getLlmProfile().embeddings).toMatchObject({ provider: 'openai', model: 'maison-v1', dimensions: 512 })
  })
})
