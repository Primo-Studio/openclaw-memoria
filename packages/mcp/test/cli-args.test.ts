/**
 * `memoria-mcp` — analyse des arguments SANS stack brute. L'aide annonçait
 * `connect --code … [--no-register]`, mais parseArgs déclarait `register`
 * sans forme négative : `--no-register` levait ERR_PARSE_ARGS_UNKNOWN_OPTION
 * hors de tout try → stack Node complète, exit 1. C'est la commande que
 * `memoria pair` demande de coller dans le chat d'un agent.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/cli-args.js'

describe('parseCliArgs', () => {
  it('connect --code X --no-register → register:false', () => {
    const r = parseCliArgs(['connect', '--code', 'ABCD-EFGH', '--no-register'])
    expect(r).toEqual({ kind: 'connect', code: 'ABCD-EFGH', register: false, storageRoot: undefined })
  })

  it('connect --code X --storage-root /x → register:true par défaut', () => {
    const r = parseCliArgs(['connect', '--code', 'ABCD-EFGH', '--storage-root', '/x'])
    expect(r).toEqual({ kind: 'connect', code: 'ABCD-EFGH', register: true, storageRoot: '/x' })
  })

  it('connect sans --code → erreur d’usage, code 2', () => {
    const r = parseCliArgs(['connect'])
    expect(r).toMatchObject({ kind: 'error', exitCode: 2 })
    expect((r as { message: string }).message).toContain('--code')
  })

  it('option inconnue → erreur d’usage propre (nom de l’option + rappel de l’aide), jamais de throw', () => {
    const r = parseCliArgs(['connect', '--code', 'X', '--bogus'])
    expect(r).toMatchObject({ kind: 'error', exitCode: 2 })
    expect((r as { message: string }).message).toContain('--bogus')
    expect((r as { message: string }).message).toContain('--help')
  })

  it('serve / disconnect / help / commande inconnue', () => {
    expect(parseCliArgs(['serve', '--instance', 'i-1'])).toEqual({ kind: 'serve', instanceId: 'i-1', storageRoot: undefined })
    expect(parseCliArgs(['serve'])).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseCliArgs(['disconnect'])).toEqual({ kind: 'disconnect', instanceId: undefined, storageRoot: undefined })
    expect(parseCliArgs([])).toEqual({ kind: 'help' })
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseCliArgs(['explode'])).toMatchObject({ kind: 'error', exitCode: 2 })
  })
})

describe('memoria-mcp (binaire réel)', () => {
  const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

  it('option inconnue → exit 2, message propre sur stderr, AUCUNE stack (et aucun daemon lancé)', () => {
    if (!existsSync(bin)) return // dist absent : `npm run typecheck` d'abord
    const r = spawnSync(process.execPath, [bin, 'connect', '--code', 'ABCD-EFGH', '--no-register', '--bogus'], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--bogus')
    expect(r.stderr).not.toContain('    at ')
    expect(r.stderr).not.toContain('ERR_PARSE_ARGS')
  })
})
