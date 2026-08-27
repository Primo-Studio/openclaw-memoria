/**
 * Enregistrement MCP auprès des hôtes (Claude Code / OpenClaw) avec CLI INJECTÉE.
 *
 * Avant : registerOpenClaw/unregisterOpenClaw/registerClaudeCode appelaient
 * directement execFileSync('openclaw' | 'claude', …). Les tests lançaient donc
 * le VRAI binaire OpenClaw de la machine (test le plus lent de la suite, ~4,4 s)
 * et, sur une machine où un serveur « memoria » est déclaré, `openclaw mcp unset`
 * l'aurait retiré pour de bon. Ici : un espion à la place du binaire, un faux
 * ~/.openclaw en tmpdir, et JAMAIS de vrai CLI ni de vrai HOME.
 *
 * Commandes vérifiées contre OpenClaw 2026.6.5 (dist/mcp-cli-*.js) :
 * `openclaw mcp set <name> <json>` et `openclaw mcp unset <name>` existent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerClaudeCode,
  registerOpenClaw,
  serveInvocation,
  unregisterClaudeCode,
  unregisterOpenClaw,
} from '../src/register.js'

let base: string
let oc: string // faux ~/.openclaw
let src: string // faux dossier adaptateur

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'memoria-register-cli-'))
  oc = join(base, '.openclaw')
  src = join(base, 'adapter')
  mkdirSync(join(src, 'dist'), { recursive: true })
  writeFileSync(join(src, 'dist', 'index.js'), 'export function register(){}')
  writeFileSync(join(src, 'openclaw.plugin.json'), JSON.stringify({ id: 'memoria' }))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** Espion de CLI : enregistre chaque commande, échoue sur demande. */
function spyCli(opts: { present?: boolean; failOn?: (bin: string, args: string[]) => boolean } = {}) {
  const calls: Array<{ bin: string; args: string[] }> = []
  return {
    calls,
    hasCli: vi.fn(() => opts.present ?? true),
    exec: vi.fn((bin: string, args: string[]) => {
      calls.push({ bin, args })
      if (opts.failOn?.(bin, args)) throw new Error(`exit 1 (${bin} ${args.join(' ')})`)
    }),
  }
}

describe('registerOpenClaw — CLI injectée, jamais le vrai binaire', () => {
  it('enregistre le serveur MCP via « openclaw mcp set memoria <json> » + installe les hooks', () => {
    const cli = spyCli()
    const r = registerOpenClaw('koda-1', { ...cli, token: 'tok', openclawDir: oc, srcDir: src })

    expect(cli.hasCli).toHaveBeenCalledWith('openclaw')
    expect(cli.calls).toEqual([
      { bin: 'openclaw', args: ['mcp', 'set', 'memoria', JSON.stringify(serveInvocation('koda-1'))] },
    ])
    expect(r.registered).toBe(true)
    expect(r.detail).toMatch(/enregistré dans OpenClaw/)
    expect(r.detail).toMatch(/hooks installés/)
    expect(existsSync(join(oc, 'extensions', 'memoria', 'dist', 'index.js'))).toBe(true)
  })

  it('CLI absente → aucune exécution, instruction manuelle dans detail, hooks quand même installés', () => {
    const cli = spyCli({ present: false })
    const r = registerOpenClaw('koda-1', { ...cli, token: 'tok', openclawDir: oc, srcDir: src })
    expect(cli.exec).not.toHaveBeenCalled()
    expect(r.detail).toMatch(/CLI openclaw absente — MCP manuel : openclaw mcp set memoria/)
    expect(r.registered).toBe(true) // les hooks (le vrai cœur) suffisent
  })

  it('« mcp set » en échec ET hooks impossibles (pas de token) → registered=false, les DEUX causes visibles', () => {
    // Avant, `registered: mcpOk || hooks.ok` pouvait masquer un échec CLI ; ici
    // rien ne réussit et le résultat doit le dire, jamais de mort silencieuse.
    const cli = spyCli({ failOn: (_bin, args) => args[1] === 'set' })
    const r = registerOpenClaw('koda-1', { ...cli, openclawDir: oc, srcDir: src })
    expect(r.registered).toBe(false)
    expect(r.detail).toMatch(/openclaw mcp set échoué \(exit 1/)
    expect(r.detail).toMatch(/hooks non installés : pas de token/)
  })
})

describe('unregisterOpenClaw — CLI injectée', () => {
  it('retire le serveur via « openclaw mcp unset memoria » et nettoie plugin + config', () => {
    mkdirSync(oc, { recursive: true })
    writeFileSync(join(oc, 'openclaw.json'), JSON.stringify({ model: 'x', plugins: { allow: ['memoria'], entries: { memoria: { enabled: true } } } }))
    registerOpenClaw('i', { ...spyCli(), token: 't', openclawDir: oc, srcDir: src })

    const cli = spyCli()
    const r = unregisterOpenClaw({ ...cli, openclawDir: oc })
    expect(cli.calls).toEqual([{ bin: 'openclaw', args: ['mcp', 'unset', 'memoria'] }])
    expect(r.registered).toBe(false)
    expect(r.detail).toMatch(/retiré d’OpenClaw/)
    expect(existsSync(join(oc, 'extensions', 'memoria'))).toBe(false)
    const cfg = JSON.parse(readFileSync(join(oc, 'openclaw.json'), 'utf8'))
    expect(cfg.model).toBe('x')
    expect(cfg.plugins.entries.memoria).toBeUndefined()
    expect(cfg.plugins.allow).not.toContain('memoria')
  })

  it('« mcp unset » en échec (serveur jamais déclaré) → le nettoyage des hooks continue', () => {
    registerOpenClaw('i', { ...spyCli(), token: 't', openclawDir: oc, srcDir: src })
    const cli = spyCli({ failOn: (_bin, args) => args[1] === 'unset' })
    const r = unregisterOpenClaw({ ...cli, openclawDir: oc })
    expect(r.detail).toMatch(/openclaw mcp unset échoué/)
    expect(r.detail).toMatch(/hooks « memoria » retirés/)
    expect(existsSync(join(oc, 'extensions', 'memoria'))).toBe(false)
  })
})

describe('registerClaudeCode / unregisterClaudeCode — CLI injectée', () => {
  it('remove (toléré en échec) puis add --scope user avec « -- » avant la commande serve', () => {
    // `claude mcp remove` sort en erreur quand memoria n'est pas encore déclaré :
    // c'est le cas nominal d'une première connexion, il ne doit rien bloquer.
    const cli = spyCli({ failOn: (_bin, args) => args[1] === 'remove' })
    const r = registerClaudeCode('claude-1', cli)
    const inv = serveInvocation('claude-1')
    expect(cli.calls).toEqual([
      { bin: 'claude', args: ['mcp', 'remove', '--scope', 'user', 'memoria'] },
      { bin: 'claude', args: ['mcp', 'add', '--scope', 'user', 'memoria', '--', inv.command, ...inv.args] },
    ])
    expect(r).toEqual({ host: 'claude-code', registered: true, detail: expect.stringMatching(/ajouté à Claude Code/) })
  })

  it('unregister → « claude mcp remove --scope user memoria »', () => {
    const cli = spyCli()
    const r = unregisterClaudeCode(cli)
    expect(cli.calls).toEqual([{ bin: 'claude', args: ['mcp', 'remove', '--scope', 'user', 'memoria'] }])
    expect(r.registered).toBe(false)
    expect(r.detail).toMatch(/retiré de Claude Code/)
  })
})
