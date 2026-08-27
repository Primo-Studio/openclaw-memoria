/**
 * Tests scripts/install-memoria.sh : syntaxe (`sh -n`), garde anti-écrasement
 * (modifications locales → refus du reset --hard), avertissement Node non-LTS.
 * Le script lit MEMORIA_REPO_DIR / MEMORIA_HOME / HOME depuis l'environnement
 * (défauts inchangés pour l'utilisateur) — c'est ce qui le rend testable ici
 * sans toucher au vrai $HOME ni au réseau : la garde sort AVANT npm install.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../../scripts/install-memoria.sh', import.meta.url))

let home: string

/** Lance le script dans un HOME jetable, avec PATH/env surchargés. */
function runScript(env: Record<string, string> = {}, pathPrefix?: string) {
  const path = pathPrefix ? `${pathPrefix}:${process.env['PATH'] ?? ''}` : (process.env['PATH'] ?? '')
  const res = spawnSync('sh', [SCRIPT], {
    env: { HOME: home, PATH: path, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

/** Dépôt git avec une modification locale stagée (status --porcelain non vide). */
function makeDirtyRepo(): string {
  const repo = join(home, 'openclaw-memoria')
  mkdirSync(repo, { recursive: true })
  const git = (...a: string[]) =>
    spawnSync('git', ['-C', repo, ...a], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  expect(git('init', '-q').status).toBe(0)
  writeFileSync(join(repo, 'modif-locale.txt'), 'travail en cours\n', 'utf8')
  expect(git('add', 'modif-locale.txt').status).toBe(0)
  return repo
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memoria-install-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * Parcours COMPLET (étapes 3-8) avec tous les outils simulés dans un PATH
 * jetable : git (clone = init), npm (no-op), node (version + exécution du
 * CLI journalisée), uname (OS choisi), xcode-select, open. Aucun réseau, aucun
 * vrai daemon, aucun launchctl. Ce que l'on vérifie : QUELLES commandes
 * `memoria` le script enchaîne — le bug était là.
 */
function fakeTools(os: 'Darwin' | 'Linux'): { bin: string; calls: string; data: string } {
  const bin = join(home, 'fake-bin')
  const data = join(home, 'data')
  const calls = join(home, 'memoria-calls.log')
  mkdirSync(bin, { recursive: true })
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, 'utf8')
    chmodSync(join(bin, name), 0o755)
  }
  tool('uname', `echo ${os}`)
  tool('xcode-select', 'exit 0')
  tool('open', 'exit 0')
  tool('xdg-open', 'exit 0')
  tool('npm', 'exit 0')
  // `git clone … DEST` → dossier avec .git ; les autres sous-commandes n'arrivent pas (dépôt neuf).
  tool('git', 'if [ "$1" = clone ]; then for a in "$@"; do d="$a"; done; mkdir -p "$d/.git"; exit 0; fi; exit 0')
  // node : -v / -p pour les vérifications ; sinon c'est le CLI (bin.js <cmd…>) → journal + daemon.json simulé.
  tool(
    'node',
    [
      'case "$1" in',
      '  -v) echo v22.22.2; exit 0 ;;',
      '  -p) case "$2" in *split*) echo 22 ;; *port*) echo 4242 ;; *admin_token*) echo tok ;; *) echo undefined ;; esac; exit 0 ;;',
      'esac',
      `shift; echo "$*" >> "${calls}"`,
      `case "$1 $2" in "autostart on"|"start "*) mkdir -p "${data}"; echo '{"port":4242,"admin_token":"tok","pid":1}' > "${data}/daemon.json" ;; esac`,
      'exit 0',
    ].join('\n'),
  )
  return { bin, calls, data }
}

describe('install-memoria.sh — parcours complet (outils simulés)', () => {
  it('macOS : init puis « autostart on » (qui démarre le daemon sous launchd) — JAMAIS « start » avant', () => {
    const { bin, calls, data } = fakeTools('Darwin')
    const { status, stdout, stderr } = runScript({ MEMORIA_REPO_DIR: join(home, 'repo'), MEMORIA_HOME: data, MEMORIA_BIN_DIR: join(home, 'lbin'), MEMORIA_ZSHRC: join(home, '.zshrc') }, bin)
    expect(stderr).toBe('')
    expect(status).toBe(0)
    const seq = readFileSync(calls, 'utf8').trim().split('\n')
    expect(seq).toEqual(['init', 'autostart on'])
    expect(stdout).toContain('Memoria est installé et lancé')
    expect(stdout).toContain('démarre tout seul au prochain allumage')
  })

  it('Linux : init puis « start », pas de launchd', () => {
    const { bin, calls, data } = fakeTools('Linux')
    const { status, stdout } = runScript({ MEMORIA_REPO_DIR: join(home, 'repo'), MEMORIA_HOME: data, MEMORIA_BIN_DIR: join(home, 'lbin'), MEMORIA_ZSHRC: join(home, '.zshrc') }, bin)
    expect(status).toBe(0)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['init', 'start'])
    expect(stdout).toContain('macOS uniquement')
  })
})

describe('install-memoria.sh', () => {
  it('syntaxe valide (sh -n)', () => {
    const res = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' })
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })

  it('garde anti-écrasement : modifications locales → refus + conseil memoria update, exit 1', () => {
    const repo = makeDirtyRepo()
    const { status, stderr } = runScript({ MEMORIA_REPO_DIR: repo })
    expect(status).toBe(1)
    expect(stderr).toContain('Des modifications locales existent')
    expect(stderr).toContain('memoria update')
  })

  it('Node impair (non-LTS) : avertit sans bloquer, recommande Node 22 LTS', () => {
    // Faux `node` v21 en tête de PATH ; le dépôt sale fait sortir le script
    // juste après (garde) — aucun npm install, aucun réseau.
    const fakeBin = join(home, 'fake-bin')
    mkdirSync(fakeBin, { recursive: true })
    const fakeNode = join(fakeBin, 'node')
    writeFileSync(
      fakeNode,
      '#!/bin/sh\ncase "$1" in\n  -v) echo "v21.7.0" ;;\n  -p) case "$2" in *split*) echo 21 ;; *) echo undefined ;; esac ;;\nesac\n',
      'utf8',
    )
    chmodSync(fakeNode, 0o755)
    const repo = makeDirtyRepo()
    const { status, stdout, stderr } = runScript({ MEMORIA_REPO_DIR: repo }, fakeBin)
    expect(stdout).toContain('non-LTS')
    expect(stdout).toContain('Node 22 LTS')
    expect(stdout).toContain('Node v21.7.0 OK') // a continué malgré l'avertissement
    expect(status).toBe(1) // sortie par la garde anti-écrasement, pas par le check Node
    expect(stderr).toContain('Des modifications locales existent')
  })

  it('Node trop vieux (< 20) : erreur bloquante', () => {
    const fakeBin = join(home, 'fake-bin')
    mkdirSync(fakeBin, { recursive: true })
    const fakeNode = join(fakeBin, 'node')
    writeFileSync(
      fakeNode,
      '#!/bin/sh\ncase "$1" in\n  -v) echo "v18.20.0" ;;\n  -p) case "$2" in *split*) echo 18 ;; *) echo undefined ;; esac ;;\nesac\n',
      'utf8',
    )
    chmodSync(fakeNode, 0o755)
    const { status, stderr } = runScript({}, fakeBin)
    expect(status).toBe(1)
    expect(stderr).toContain('requiert Node 20+')
  })
})
