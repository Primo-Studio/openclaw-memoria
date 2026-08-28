/**
 * Trousseau qui REFUSE l'écriture (verrouillé, autorisation annulée sous
 * launchd/sandbox) : la VALEUR du secret ne doit apparaître NI dans l'erreur
 * levée, NI dans un log, NI sur le disque en clair. Avant : execFileSync
 * remontait la ligne de commande complète (`… -w <valeur>`) dans err.message,
 * que le daemon journalisait ET renvoyait au client en 500.
 *
 * Décision produit : Trousseau refusé → repli sur le coffre AES local avec
 * avertissement (sans valeur) ; si le repli échoue aussi → échec bruyant, sans
 * valeur. Aucun vrai `security` n'est appelé ici : un faux binaire en tmpdir.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AesVaultProvider, KeychainMacProvider, Memoria, type SecretProvider } from '../src/index.js'

// Concaténation : jamais un jeton qui ressemble à un vrai secret en littéral.
const VALUE = 'sk-proj-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn'
const STDERR = 'security: SecKeychainItemCreateFromContent (<default>): The authorization was canceled by the user.'

let dir: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-keychain-fail-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

/** Faux `security` : échoue toujours en imitant le refus d'autorisation. */
function fakeSecurityBin(): string {
  const bin = join(dir, 'security')
  writeFileSync(bin, `#!/bin/sh\necho "${STDERR}" >&2\nexit 1\n`)
  chmodSync(bin, 0o755)
  return bin
}

/** Tous les fichiers sous `root` qui contiennent la valeur en clair. */
function filesContaining(root: string, needle: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (readFileSync(p).includes(needle)) out.push(p)
    }
  }
  walk(root)
  return out
}

/** Coffre qui refuse tout (simule un Trousseau verrouillé) — `kind` paramétrable. */
function refusingProvider(kind: string): SecretProvider {
  return {
    kind,
    isAvailable: () => true,
    set: (name: string, value: string) => {
      // Comme execFileSync : le message d'origine contient l'argv complet.
      throw new Error(`Command failed: /usr/bin/security add-generic-password -U -s memoria -a ${name} -w ${value}\n${STDERR}`)
    },
    get: () => null,
    delete: () => {},
    locationFor: (name: string) => `${kind}:memoria/${name}`,
  }
}

describe('KeychainMacProvider — erreur assainie', () => {
  it('set() qui échoue lève une erreur SANS la valeur, avec le statut et le stderr de `security`', () => {
    const provider = new KeychainMacProvider({ service: 'memoria-test', bin: fakeSecurityBin() })
    let caught: Error | null = null
    try {
      provider.set('openai-1', VALUE)
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(VALUE)
    expect(caught!.message).toContain('authorization was canceled')
    expect(caught!.message).toContain('status 1')
    // Pas l'objet d'execFileSync (il porte spawnargs = argv avec la valeur).
    expect((caught as unknown as { spawnargs?: unknown }).spawnargs).toBeUndefined()
  })
})

describe('Memoria — Trousseau refusé', () => {
  it('storeFact : repli sur le coffre AES local, avertissement sans valeur, fait stocké rédigé', () => {
    const root = join(dir, 'data')
    const m = Memoria.init({
      storageRoot: root,
      configPath: join(dir, 'config.toml'),
      llm: { extraction: null },
      secretProvider: refusingProvider('keychain-macos'),
    })
    try {
      const a = m.pairAssistant({ type: 'claude-code' })
      const fact = m.storeFact({ instance: a.assistant_instance_id, content: `ma clé OpenAI est ${VALUE}` })
      expect(fact.fact).not.toContain(VALUE)
      expect(fact.fact).toMatch(/\[secret:/)

      // La valeur est au coffre AES (chiffrée), retrouvable par son nom.
      const refs = m.listSecrets()
      expect(refs).toHaveLength(1)
      expect(refs[0]!.location).toMatch(/^vault:/)
      const vault = new AesVaultProvider(m.paths.secretsDir)
      expect(vault.get(refs[0]!.name)).toBe(VALUE)

      // Avertissement clair, mais JAMAIS la valeur.
      const warnings = warnSpy.mock.calls.map(c => c.map(String).join(' '))
      expect(warnings.some(w => w.includes('coffre AES'))).toBe(true)
      expect(warnings.join('\n')).not.toContain(VALUE)
      // Rien en clair sur le disque (DB, config, vault chiffré…).
      expect(filesContaining(root, VALUE)).toEqual([])
    } finally {
      m.close()
    }
  })

  it('captureTurn : même repli, la valeur n’atteint ni le WAL ni les logs', async () => {
    const root = join(dir, 'data')
    const m = Memoria.init({
      storageRoot: root,
      configPath: join(dir, 'config.toml'),
      llm: { extraction: null },
      secretProvider: refusingProvider('keychain-macos'),
    })
    try {
      const a = m.pairAssistant({ type: 'claude-code' })
      const r = await m.captureTurn({
        instance: a.assistant_instance_id,
        messages: [{ role: 'user', content: `voici ma clé ${VALUE} garde-la` }],
      })
      expect(r.appended).toBe(1)
      expect(filesContaining(root, VALUE)).toEqual([])
      expect(warnSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')).not.toContain(VALUE)
      expect(m.listSecrets()[0]!.location).toMatch(/^vault:/)
    } finally {
      m.close()
    }
  })

  it('sans repli possible (le coffre AES lui-même refuse) → échec BRUYANT, sans la valeur', () => {
    const m = Memoria.init({
      storageRoot: join(dir, 'data'),
      configPath: join(dir, 'config.toml'),
      llm: { extraction: null },
      secretProvider: refusingProvider('aes-vault'),
    })
    try {
      const a = m.pairAssistant({ type: 'claude-code' })
      let caught: Error | null = null
      try {
        m.storeFact({ instance: a.assistant_instance_id, content: `ma clé OpenAI est ${VALUE}` })
      } catch (err) {
        caught = err as Error
      }
      expect(caught).not.toBeNull()
      expect(caught!.message).toContain('mise au coffre')
      expect(caught!.message).not.toContain(VALUE)
      // Le fait n'a PAS été écrit (pas de secret perdu en silence, pas de fait tronqué).
      expect(m.stats().facts).toBe(0)
    } finally {
      m.close()
    }
  })
})
