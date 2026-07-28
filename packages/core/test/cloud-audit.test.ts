/**
 * Journal des envois cloud (retour bêta, confidentialité).
 *
 * Deux invariants tenus par ces tests :
 *  - un provider LOCAL n'est pas enveloppé (rien ne sort, rien à déclarer) ;
 *  - le journal ne contient JAMAIS le contenu envoyé, seulement des volumes.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditEmbeddings, auditExtraction, formatCloudSend, isCloudProvider, Memoria, type CloudSend } from '../src/index.js'

const SECRET = 'Néto habite au 12 rue des Lilas et son mot de passe wifi est Hunter2Hunter2'

function fakeLlm(name: string) {
  return {
    name,
    model: 'm-1',
    isAvailable: async () => true,
    complete: async () => '{"facts":[]}',
  }
}

function fakeEmbed(name: string) {
  return {
    name,
    model: 'e-1',
    dimensions: 3,
    isAvailable: async () => true,
    embed: async (texts: string[]) => texts.map(() => Float32Array.from([0, 0, 0])),
  }
}

describe('isCloudProvider', () => {
  it('distingue ce qui sort de la machine de ce qui reste', () => {
    expect(isCloudProvider('openai')).toBe(true)
    expect(isCloudProvider('openrouter')).toBe(true)
    expect(isCloudProvider('anthropic')).toBe(true)
    expect(isCloudProvider('ollama')).toBe(false)
    expect(isCloudProvider('lmstudio')).toBe(false)
  })
})

describe('enveloppe d’audit', () => {
  it('un provider LOCAL est renvoyé tel quel — aucune indirection, aucun journal', () => {
    const sends: CloudSend[] = []
    const local = fakeLlm('ollama')
    expect(auditExtraction(local, s => sends.push(s))).toBe(local)
    const localEmbed = fakeEmbed('ollama')
    expect(auditEmbeddings(localEmbed, s => sends.push(s))).toBe(localEmbed)
    expect(sends).toHaveLength(0)
  })

  it('un provider CLOUD est journalisé : volume, pas contenu', async () => {
    const sends: CloudSend[] = []
    const p = auditExtraction(fakeLlm('openai'), s => sends.push(s))
    await p.complete({ prompt: SECRET, system: 'sys' })

    expect(sends).toHaveLength(1)
    const s = sends[0]!
    expect(s).toMatchObject({ provider: 'openai', model: 'm-1', purpose: 'extraction', items: 1, ok: true })
    expect(s.chars).toBe(SECRET.length + 3)
    // Un journal de confidentialité qui recopierait la donnée serait une fuite
    // de plus, pas une garantie.
    expect(JSON.stringify(s)).not.toContain('Hunter2')
    expect(JSON.stringify(s)).not.toContain('rue des Lilas')
  })

  it('les embeddings comptent chaque texte envoyé', async () => {
    const sends: CloudSend[] = []
    const p = auditEmbeddings(fakeEmbed('openai'), s => sends.push(s))
    await p.embed(['aa', 'bbb'])
    expect(sends[0]).toMatchObject({ purpose: 'embeddings', items: 2, chars: 5, ok: true })
  })

  it('un envoi RATÉ est journalisé quand même — les données sont parties', async () => {
    const sends: CloudSend[] = []
    const p = auditExtraction(
      { ...fakeLlm('openai'), complete: async () => { throw new Error('HTTP 429') } },
      s => sends.push(s),
    )
    await expect(p.complete({ prompt: 'x' })).rejects.toThrow('429')
    expect(sends[0]).toMatchObject({ ok: false, items: 1 })
  })

  it('formatCloudSend produit un `clé=valeur` reparsable, sans contenu', () => {
    const line = formatCloudSend({ provider: 'openai', model: 'gpt-5-mini', purpose: 'extraction', items: 1, chars: 4210, ms: 900, ok: true })
    expect(line).toBe('provider=openai model=gpt-5-mini purpose=extraction items=1 chars=4210 ms=900 ok=true')
  })
})

describe('doctor — section cloud', () => {
  let root: string
  let m: Memoria

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memoria-cloud-'))
    m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  })
  afterEach(() => {
    m.close()
    rmSync(root, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('sans envoi : section vide — et c’est la garantie recherchée', () => {
    const r = m.doctor()
    expect(r.cloud.sends_24h).toEqual([])
    expect(r.cloud.chars_24h).toBe(0)
    expect(r.cloud.last_send_at).toBeUndefined()
  })

  it('agrège par fournisseur/modèle/finalité', () => {
    const registry = (m as unknown as { registry: { audit(e: Record<string, unknown>): void } }).registry
    const log = (reason: string): void =>
      registry.audit({ actor_type: 'system', actor_id: 'llm', action: 'cloud_send', target_id_hash: null, scope_id: null, reason })

    log('provider=openai model=gpt-5-mini purpose=extraction items=1 chars=1000 ms=800 ok=true')
    log('provider=openai model=gpt-5-mini purpose=extraction items=1 chars=500 ms=700 ok=false')
    log('provider=openai model=text-embedding-3-small purpose=embeddings items=16 chars=3000 ms=400 ok=true')

    const c = m.doctor().cloud
    expect(c.chars_24h).toBe(4500)
    // Tri par volume décroissant : le plus gros émetteur en premier.
    expect(c.sends_24h[0]).toMatchObject({ model: 'text-embedding-3-small', purpose: 'embeddings', calls: 1, items: 16, chars: 3000 })
    expect(c.sends_24h[1]).toMatchObject({ model: 'gpt-5-mini', calls: 2, chars: 1500, failures: 1 })
    expect(c.last_send_at).toBeTruthy()
  })
})
