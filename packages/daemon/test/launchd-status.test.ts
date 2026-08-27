/**
 * « chargé » ≠ « en marche » : `launchctl print` rend 0 dès que le service est
 * connu de launchd — process mort (après `memoria stop`) ou boucle de crash
 * compris. autostartStatus lisait seulement ce code retour et rassurait
 * l'utilisateur (« installé (chargé) ») dans exactement ces situations.
 * Ici : launchd SIMULÉ par la sonde injectée — jamais de launchctl réel.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG_PATH, autostartStatus } from '@memoria/core'
import { daemonProgramArguments } from '../src/index.js'

/** Extrait réel de `launchctl print gui/501/fr.primo-studio.memoria` (27/08). */
const RUNNING = `gui/501/fr.primo-studio.memoria = {
\tactive count = 1
\tpath = /Users/x/Library/LaunchAgents/fr.primo-studio.memoria.plist
\ttype = LaunchAgent
\tstate = running
\tprogram = /Users/x/.nvm/versions/node/v22.22.2/bin/node
\tminimum runtime = 10
\texit timeout = 5
\truns = 9
\tpid = 20420
\tlast exit code = 0
\tsemaphores = {
\t\tsuccessful exit => 0
\t}
}
`

/** Même service, process mort et relancé 6 fois sur le verrou (exit 1). */
const CRASH_LOOP = `gui/501/fr.primo-studio.memoria = {
\tactive count = 0
\tstate = not running
\tminimum runtime = 10
\texit timeout = 5
\truns = 6
\tlast exit code = 1
}
`

function probe(printed: string | null, platform = 'darwin') {
  return {
    platform: () => platform,
    exists: () => true,
    printService: vi.fn(() => printed),
  }
}

describe('autostartStatus (launchd simulé)', () => {
  it('service en marche : loaded, running, pid et runs lus dans launchctl print', () => {
    const s = autostartStatus('fr.primo-studio.memoria', probe(RUNNING))
    expect(s).toMatchObject({ supported: true, installed: true, loaded: true, running: true, pid: 20420, runs: 9, last_exit_code: 0 })
  })

  it('service chargé mais process mort en boucle : loaded SANS running, runs et dernier code visibles', () => {
    const s = autostartStatus('fr.primo-studio.memoria', probe(CRASH_LOOP))
    expect(s).toMatchObject({ loaded: true, running: false, pid: null, runs: 6, last_exit_code: 1 })
  })

  it('service inconnu de launchd : loaded false, compteurs null', () => {
    const s = autostartStatus('fr.primo-studio.memoria', probe(null))
    expect(s).toMatchObject({ loaded: false, running: false, pid: null, runs: null, last_exit_code: null })
    expect(s.plistPath).toBe(join(homedir(), 'Library', 'LaunchAgents', 'fr.primo-studio.memoria.plist'))
  })

  it('hors macOS : non pris en charge, launchctl jamais interrogé', () => {
    const p = probe(RUNNING, 'linux')
    const s = autostartStatus('fr.primo-studio.memoria', p)
    expect(s).toMatchObject({ supported: false, loaded: false, running: false })
    expect(p.printService).not.toHaveBeenCalled()
  })
})

describe('daemonProgramArguments (arguments du LaunchAgent)', () => {
  it('config par défaut : node, bin, --storage-root, sans --config', () => {
    const args = daemonProgramArguments('/tmp/root', DEFAULT_CONFIG_PATH)
    expect(args[0]).toBe(process.execPath)
    expect(args[1]).toMatch(/bin\.js$/)
    expect(args.slice(2)).toEqual(['--storage-root', '/tmp/root'])
  })

  it('config personnalisée : --config transmis (sinon le daemon retombait sur ~/.memoria/config.toml)', () => {
    const args = daemonProgramArguments('/tmp/root', '/tmp/autre.toml')
    expect(args.slice(2)).toEqual(['--storage-root', '/tmp/root', '--config', '/tmp/autre.toml'])
  })
})
