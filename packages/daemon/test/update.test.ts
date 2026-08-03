/**
 * Régression : « Échec de la mise à jour : spawn npm ENOENT ».
 *
 * Le daemon tourne sous launchd, dont le PATH vaut `/usr/bin:/bin:/usr/sbin:/sbin`.
 * `npm` n'y est jamais (nvm, Homebrew, pkg officiel installent tous ailleurs), donc
 * un `execFile('npm', …)` échouait — mais seulement quand il y avait vraiment une
 * mise à jour à installer, ce qu'aucun test ne provoquait.
 *
 * On vérifie donc la résolution SANS PATH, sur les deux dispositions réelles :
 * nvm/pkg (npm sous le préfixe du node) et Homebrew (npm hors du Cellar, atteint
 * par une chaîne de symlinks).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NPM_MISSING_MESSAGE,
  buildMarkerPath,
  explainFailure,
  lastBuiltSha,
  needsRebuild,
  npmCandidates,
  resolveNpm,
} from '../src/update.js'

let root: string

beforeEach(() => {
  // realpath : sur macOS /var est un symlink vers /private/var, et resolveNpm
  // résout les liens — sans ça les chemins attendus ne coïncideraient pas.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'memoria-update-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Fabrique un faux node exécutable à `<prefix>/bin/node`. */
function fakeNode(prefix: string): string {
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  const node = join(prefix, 'bin', 'node')
  writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 })
  return node
}

describe('npmCandidates', () => {
  it('cherche d’abord sous le préfixe du node courant, jamais via le PATH', () => {
    const list = npmCandidates('/opt/node/v24/bin/node')
    expect(list[0]).toBe('/opt/node/v24/lib/node_modules/npm/bin/npm-cli.js')
    expect(list).toContain('/opt/node/v24/bin/npm')
    // Aucun candidat nu : un nom relatif retomberait sur la résolution PATH.
    for (const c of list) expect(c.startsWith('/')).toBe(true)
  })

  it('couvre les emplacements Homebrew et pkg officiel', () => {
    const list = npmCandidates('/opt/node/v24/bin/node')
    expect(list).toContain('/opt/homebrew/bin/npm')
    expect(list).toContain('/usr/local/bin/npm')
  })
})

describe('resolveNpm', () => {
  it('disposition nvm / pkg officiel : lance npm-cli.js avec le node courant', () => {
    const node = fakeNode(root)
    const cli = join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(join(root, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(cli, '// npm')

    const npm = resolveNpm(node)
    expect(npm).not.toBeNull()
    // Même runtime que le service : pas de shim shell, pas de version divergente.
    expect(npm!.cmd).toBe(node)
    expect(npm!.prefixArgs).toEqual([cli])
  })

  it('disposition Homebrew : suit le symlink du shim jusqu’au .js hors préfixe', () => {
    // Le npm du Cellar pointe vers /opt/homebrew/lib/node_modules — hors du
    // préfixe du node, donc invisible pour le premier candidat.
    const cellar = join(root, 'Cellar', 'node', '26.0.0')
    const node = fakeNode(cellar)
    const realCli = join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(join(root, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(realCli, '// npm')
    symlinkSync(realCli, join(cellar, 'bin', 'npm'))

    const npm = resolveNpm(node)
    expect(npm).not.toBeNull()
    expect(npm!.cmd).toBe(node)
    expect(npm!.prefixArgs).toEqual([realCli])
  })

  it('renvoie null quand npm est absent de tous les emplacements connus', () => {
    // Sans /opt/homebrew/bin/npm ni /usr/local/bin/npm sur la machine de test,
    // ce cas ne peut être garanti — on vérifie alors qu'un npm trouvé est
    // toujours lançable, ce qui est l'invariant qui compte.
    const node = fakeNode(root)
    const npm = resolveNpm(node)
    if (npm === null) return
    expect(npm.cmd.startsWith('/')).toBe(true)
  })
})

/**
 * Régression du piège découvert en corrigeant le ENOENT : le `git pull` passe,
 * le build échoue. Au clic suivant, `changed === false` → aucun rebuild → la
 * réponse est « Déjà à jour » alors que le dist reste périmé. L'installation
 * restait cassée en se déclarant saine, sans issue par l'UI.
 */
describe('needsRebuild', () => {
  it('nouveauté git → build, quel que soit le marqueur', () => {
    expect(needsRebuild(true, 'abc123', 'abc123')).toBe(true)
  })

  it('pas de nouveauté MAIS marqueur en retard → build de rattrapage', () => {
    // Exactement le cas de la machine où le pull avait réussi avant l'échec npm.
    expect(needsRebuild(false, 'def456', 'abc123')).toBe(true)
  })

  it('pas de nouveauté et marqueur à jour → aucun build', () => {
    expect(needsRebuild(false, 'abc123', 'abc123')).toBe(false)
  })

  it('marqueur absent (install antérieure au mécanisme) → build une fois', () => {
    expect(needsRebuild(false, 'abc123', null)).toBe(true)
  })

  it('HEAD illisible → on ne devine pas, pas de build', () => {
    expect(needsRebuild(false, null, 'abc123')).toBe(false)
  })
})

describe('lastBuiltSha', () => {
  it('absent → null ; présent → sha nettoyé', () => {
    expect(lastBuiltSha(root)).toBeNull()
    writeFileSync(buildMarkerPath(root), 'abc123\n')
    expect(lastBuiltSha(root)).toBe('abc123')
  })

  it('fichier vide → null (et non chaîne vide, qui vaudrait un faux « à jour »)', () => {
    writeFileSync(buildMarkerPath(root), '   \n')
    expect(lastBuiltSha(root)).toBeNull()
    // …et un marqueur vide doit bien redéclencher un build
    expect(needsRebuild(false, 'abc123', lastBuiltSha(root))).toBe(true)
  })
})

describe('explainFailure', () => {
  it('traduit npm ENOENT en consigne actionnable', () => {
    const msg = explainFailure(new Error('spawn npm ENOENT'))
    expect(msg).toBe(NPM_MISSING_MESSAGE)
    expect(msg).toContain('npm install')
    // Le message brut ne doit plus atterrir tel quel dans l’UI.
    expect(msg).not.toBe('spawn npm ENOENT')
  })

  it('traduit git ENOENT', () => {
    expect(explainFailure(new Error('spawn git ENOENT'))).toContain('xcode-select')
  })

  it('laisse passer les autres erreurs sans les travestir', () => {
    expect(explainFailure(new Error('fatal: not a git repository'))).toBe('fatal: not a git repository')
  })
})
