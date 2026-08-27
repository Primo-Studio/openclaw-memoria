/**
 * Profil LLM mémoïsé « à vie » : le daemon est lancé par launchd AVANT
 * l'application Ollama. Si Ollama était éteint au démarrage, `extraction`
 * valait null pour toute la vie du processus (chaque capture → defer no-llm),
 * pendant que llmHealth (résolution fraîche) affichait « Extraction prête ».
 * Un utilisateur non technicien voyait tout vert et une file « en attente
 * d'extraction » qui ne se vidait jamais. Ici : fetch simulé, aucun réseau.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Memoria } from '../src/index.js'

let root: string
let m: Memoria
let instance: string
let ollamaUp = false

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  ollamaUp = false
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url)
    if (!ollamaUp) throw new TypeError('fetch failed')
    if (u.includes('/api/tags')) return jsonResponse({ models: [{ name: 'qwen2.5:3b' }] })
    if (u.includes('/api/chat')) {
      return jsonResponse({ message: { content: JSON.stringify({ facts: [{ fact: 'Néto utilise Resolve pour le montage vidéo', category: 'preference', confidence: 0.9 }] }) } })
    }
    throw new Error(`URL inattendue dans le test : ${u}`)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  root = mkdtempSync(join(tmpdir(), 'memoria-profile-'))
  // Pas d'override `llm` : résolution automatique (profil 100-local → Ollama).
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), secretsVault: 'aes-vault' })
  m.profileRetryMs = 0 // en prod : 60 s ; ici on veut la relance immédiate
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Ollama indisponible au boot puis disponible', () => {
  it('la capture suivante extrait (plus de defer) et hasExtraction suit la réalité', async () => {
    expect(await m.hasExtraction()).toBe(false)
    const first = await m.captureTurn({ instance, messages: [{ role: 'user', content: "J'utilise Resolve pour le montage." }] })
    expect(first.deferred).toBe(1)
    expect(first.facts_created).toBe(0)

    ollamaUp = true
    expect(await m.hasExtraction()).toBe(true)
    const second = await m.captureTurn({ instance, messages: [{ role: 'user', content: "J'utilise Resolve pour le montage." }] })
    expect(second.deferred).toBe(0)
    expect(second.facts_created).toBe(1)
    expect(m.walPendingTotal()).toBe(0) // l'entrée du 1er tour a été rejouée aussi
  })

  it('llmHealth et le pipeline sont cohérents : ce que l’UI affiche est ce que la capture utilise', async () => {
    m.profileRetryMs = 60_000 // pas de relance par délai : c'est llmHealth qui doit réaligner
    expect(await m.hasExtraction()).toBe(false)
    ollamaUp = true
    const health = await m.llmHealth()
    expect(health.extraction.available).toBe(true)
    expect(await m.hasExtraction()).toBe(true)
    const cap = await m.captureTurn({ instance, messages: [{ role: 'user', content: "J'utilise Resolve pour le montage." }] })
    expect(cap.facts_created).toBe(1)
  })
})
