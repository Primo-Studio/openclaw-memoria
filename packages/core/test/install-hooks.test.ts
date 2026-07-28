/**
 * Installation du plugin de hooks dans une config OpenClaw.
 *
 * RÉGRESSION RÉELLE couverte ici : `plugins.allow` ABSENT signifie « tout
 * autoriser ». L'installateur la créait pour y mettre `memoria`, ce qui la
 * transformait en liste blanche EXCLUSIVE et coupait tous les autres plugins.
 * Observé en production : une gateway est passée de 12 plugins chargés à 2,
 * perdant son runtime d'agent au passage.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installOpenClawHooks } from '../src/index.js'

let ocDir: string
let srcDir: string

/** Faux dossier d'adaptateur : l'installateur exige dist/index.js + le manifeste. */
function fakeAdapter(dir: string): void {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.js'), 'export const register = () => {}\n')
  writeFileSync(join(dir, 'openclaw.plugin.json'), JSON.stringify({ id: 'memoria' }))
}

function writeConfig(cfg: unknown): void {
  writeFileSync(join(ocDir, 'openclaw.json'), JSON.stringify(cfg, null, 2))
}

function readConfig(): Record<string, never> {
  return JSON.parse(readFileSync(join(ocDir, 'openclaw.json'), 'utf8'))
}

const install = (): { ok: boolean; detail: string } =>
  installOpenClawHooks({ instanceId: 'inst-1', token: 'tok-1', openclawDir: ocDir, srcDir })

beforeEach(() => {
  ocDir = mkdtempSync(join(tmpdir(), 'oc-'))
  srcDir = mkdtempSync(join(tmpdir(), 'adapter-'))
  fakeAdapter(srcDir)
})

afterEach(() => {
  rmSync(ocDir, { recursive: true, force: true })
  rmSync(srcDir, { recursive: true, force: true })
})

describe('installOpenClawHooks — plugins.allow', () => {
  it('allow ABSENT : reste absent — ne pas transformer « tout » en « memoria seul »', () => {
    writeConfig({ plugins: { entries: { telegram: { enabled: true }, codex: {} } } })
    expect(install().ok).toBe(true)

    const cfg = readConfig() as never as { plugins: { allow?: string[]; entries: Record<string, unknown> } }
    expect(cfg.plugins.allow).toBeUndefined()
    // Les autres plugins survivent.
    expect(Object.keys(cfg.plugins.entries).sort()).toEqual(['codex', 'memoria', 'telegram'])
  })

  it('allow PRÉSENT : memoria y est ajouté, les autres conservés', () => {
    writeConfig({ plugins: { allow: ['telegram', 'codex'], entries: {} } })
    expect(install().ok).toBe(true)

    const cfg = readConfig() as never as { plugins: { allow: string[] } }
    expect(cfg.plugins.allow.sort()).toEqual(['codex', 'memoria', 'telegram'])
  })

  it('allow présent contenant déjà memoria : pas de doublon', () => {
    writeConfig({ plugins: { allow: ['memoria', 'telegram'], entries: {} } })
    install()
    expect((readConfig() as never as { plugins: { allow: string[] } }).plugins.allow.sort()).toEqual(['memoria', 'telegram'])
  })

  it('config vide : rien n’est inventé côté allow', () => {
    expect(install().ok).toBe(true)
    expect((readConfig() as never as { plugins: { allow?: string[] } }).plugins.allow).toBeUndefined()
  })
})

describe('installOpenClawHooks — reste de la config', () => {
  it('pose allowConversationAccess sans écraser le voisinage', () => {
    writeConfig({
      channels: { telegram: { enabled: true, name: 'Primo Posts' } },
      plugins: { entries: { 'memory-core': {} } },
    })
    install()
    const cfg = readConfig() as never as Record<string, never>
    const e = (cfg as never as { plugins: { entries: { memoria: { hooks: Record<string, boolean>; enabled: boolean } } } }).plugins.entries.memoria
    expect(e.enabled).toBe(true)
    expect(e.hooks['allowConversationAccess']).toBe(true)
    // Le reste de la config est intact.
    expect((cfg as never as { channels: { telegram: { name: string } } }).channels.telegram.name).toBe('Primo Posts')
  })

  it('sans token : refus explicite, aucune écriture', () => {
    writeConfig({ plugins: {} })
    const r = installOpenClawHooks({ instanceId: 'i', openclawDir: ocDir, srcDir })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/token/)
    expect((readConfig() as never as { plugins: { entries?: unknown } }).plugins.entries).toBeUndefined()
  })
})
