/**
 * Le doctor doit dire quand AUCUN moteur d'IA n'est configuré.
 *
 * Constaté le 28/08 sur une installation neuve de test : `memoria doctor`
 * concluait « État : ✓ OK » alors que rien n'était mémorisé — Memoria
 * journalise bien les conversations, mais sans moteur d'extraction elle n'en
 * tire aucun souvenir. Pour quelqu'un qui vient d'installer, la seule commande
 * de diagnostic affirmait donc que tout allait bien pendant que le produit ne
 * faisait pas son travail. C'est exactement la « mort silencieuse » que ce
 * projet refuse.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/index.js'

let root: string
let m: Memoria | null = null

function open(configToml?: string): Memoria {
  root = mkdtempSync(join(tmpdir(), 'memoria-doctor-engine-'))
  const configPath = join(root, 'config.toml')
  if (configToml) writeFileSync(configPath, configToml)
  m = Memoria.init({ storageRoot: join(root, 'data'), configPath, llm: { extraction: null }, secretsVault: 'aes-vault' })
  return m
}

afterEach(() => {
  m?.close()
  m = null
  rmSync(root, { recursive: true, force: true })
})

describe('doctor — moteur d’IA', () => {
  it('installation neuve sans moteur : ce n’est PAS « OK », et le rapport le dit', () => {
    const report = open().doctor()
    expect(report.engine.configured).toBe(false)
    expect(report.engine.extraction_provider).toBeNull()
    expect(report.ok).toBe(false)
    expect(report.warnings.some(w => /moteur d’IA configuré/i.test(w))).toBe(true)
    // et l'avertissement dit où aller, pas seulement ce qui ne va pas
    expect(report.warnings.some(w => w.includes('Réglages'))).toBe(true)
  })

  it('moteur d’extraction ET d’embeddings configurés : aucun avertissement de moteur', () => {
    const report = open(`storage_path = "${join(root ?? '', 'data')}"

[llm]
profile = "custom"

[llm.extraction]
provider = "openai"
model = "gpt-4o-mini"

[llm.embeddings]
provider = "openai"
model = "text-embedding-3-small"
`).doctor()
    expect(report.engine).toMatchObject({
      configured: true,
      extraction_provider: 'openai',
      extraction_model: 'gpt-4o-mini',
      embeddings_provider: 'openai',
    })
    expect(report.warnings.some(w => /moteur/i.test(w))).toBe(false)
  })

  it('extraction sans embeddings : la recherche par le sens est annoncée inactive', () => {
    const report = open(`[llm]
profile = "custom"

[llm.extraction]
provider = "ollama"
model = "qwen2.5:3b"
`).doctor()
    expect(report.engine.configured).toBe(true)
    expect(report.engine.embeddings_provider).toBeNull()
    expect(report.warnings.some(w => /embeddings/i.test(w) && /mots-clés/i.test(w))).toBe(true)
  })
})
