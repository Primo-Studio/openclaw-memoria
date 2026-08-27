/**
 * `memoria update` avec git/npm/redémarrage SIMULÉS (fonctions injectées) :
 * la commande n'avait aucun test d'exécution — seuls les helpers purs de
 * update.ts l'étaient.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NPM_MISSING_MESSAGE, type UpdateResult } from '@memoria/daemon'
import { UpdateCommand, buildCli } from '../src/index.js'

let root: string

function makeIo() {
  const outChunks: Buffer[] = []
  const errChunks: Buffer[] = []
  const stdout = new PassThrough()
  stdout.on('data', (c: Buffer) => outChunks.push(c))
  const stderr = new PassThrough()
  stderr.on('data', (c: Buffer) => errChunks.push(c))
  return {
    context: { stdin: new PassThrough(), stdout, stderr },
    out: () => Buffer.concat(outChunks).toString('utf8'),
    err: () => Buffer.concat(errChunks).toString('utf8'),
  }
}

const OK: UpdateResult = { ok: true, is_git: true, before: 'aaa', after: 'aaa', changed: false, rebuilt: false, log: '', message: 'Déjà à jour.' }

function command(result: UpdateResult, isGit = true): { cmd: UpdateCommand; restarts: string[] } {
  const cmd = buildCli().process(['update', '--storage-root', root, '--config', join(root, 'config.toml')]) as UpdateCommand
  const restarts: string[] = []
  cmd.currentVersionFn = async () => ({ version: '0.1.0', sha: isGit ? 'aaa' : null, is_git: isGit })
  cmd.pullAndBuildFn = async () => result
  cmd.scheduleRestartFn = r => {
    restarts.push(r)
  }
  return { cmd, restarts }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-update-cmd-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('memoria update', () => {
  it('« Déjà à jour » : code 0, aucun redémarrage', async () => {
    const { cmd, restarts } = command(OK)
    const io = makeIo()
    expect(await buildCli().run(cmd, io.context)).toBe(0)
    expect(io.out()).toContain('Déjà à jour')
    expect(io.out()).not.toContain('redémarre')
    expect(restarts).toEqual([])
  })

  it('build effectué : redémarrage planifié sur la racine résolue, annoncé', async () => {
    const { cmd, restarts } = command({ ...OK, after: 'bbb', changed: true, rebuilt: true, message: 'Mis à jour aaa → bbb.' })
    const io = makeIo()
    expect(await buildCli().run(cmd, io.context)).toBe(0)
    expect(restarts).toEqual([root])
    expect(io.out()).toContain('redémarre dans quelques secondes')
  })

  it('échec npm : message actionnable sur stderr, code 1, aucun redémarrage', async () => {
    const { cmd, restarts } = command({ ...OK, ok: false, message: `Échec de la mise à jour : ${NPM_MISSING_MESSAGE}` })
    const io = makeIo()
    expect(await buildCli().run(cmd, io.context)).toBe(1)
    expect(io.err()).toContain('npm est introuvable')
    expect(io.err()).not.toContain('    at ')
    expect(restarts).toEqual([])
  })

  it('installation non-git : refus net, code 1, pullAndBuild jamais appelé', async () => {
    const { cmd, restarts } = command(OK, false)
    let pulled = false
    cmd.pullAndBuildFn = async () => {
      pulled = true
      return OK
    }
    const io = makeIo()
    expect(await buildCli().run(cmd, io.context)).toBe(1)
    expect(io.err()).toContain('non-git')
    expect(pulled).toBe(false)
    expect(restarts).toEqual([])
  })
})
