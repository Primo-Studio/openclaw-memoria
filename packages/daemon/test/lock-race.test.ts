/**
 * Verrou singleton `daemon.lock` : deux daemons ne doivent JAMAIS coexister
 * sur la même mémoire.
 *
 * Bug observé : `acquireLock` faisait `existsSync` puis `writeFileSync` — deux
 * processus lancés au même instant (Claude Code et Codex qui démarrent leurs
 * serveurs MCP pendant que le daemon est tombé) passaient tous les deux, et
 * ouvraient tous les deux les DB, rejouaient tous les deux le WAL (faits en
 * double, appels LLM doublés), le dernier écrivant daemon.json. Sur 60 essais
 * synchronisés : 55 doubles acquisitions.
 *
 * La course exige deux PROCESSUS (un même pid se refuse le lock à lui-même) :
 * on lance deux enfants sur `dist/state.js` (construit par `npm run typecheck`),
 * synchronisés sur un même horodatage.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLock } from '../src/state.js'

const STATE_DIST = fileURLToPath(new URL('../dist/state.js', import.meta.url))

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-lock-race-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Un enfant qui attend `startAt` puis tente le lock ; imprime OK ou REFUSE. */
function racer(startAt: number, holdMs: number): Promise<string> {
  const script =
    `import { acquireLock } from ${JSON.stringify(STATE_DIST)};` +
    `const wait = ${startAt} - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));` +
    `const release = acquireLock(${JSON.stringify(root)});` +
    `await new Promise(r => setTimeout(r, ${holdMs}));` +
    `process.stdout.write(release ? 'OK' : 'REFUSE');`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))
    child.on('exit', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`racer code ${code} : ${err}`))))
  })
}

describe('acquireLock — course entre deux processus', () => {
  it('deux processus simultanés : exactement UN obtient le verrou, à chaque essai', async () => {
    expect(existsSync(STATE_DIST), 'dist/state.js absent — lance « npm run typecheck »').toBe(true)
    const ROUNDS = 12
    for (let round = 0; round < ROUNDS; round++) {
      rmSync(join(root, 'daemon.lock'), { force: true })
      const startAt = Date.now() + 150
      const [a, b] = await Promise.all([racer(startAt, 60), racer(startAt, 60)])
      const winners = [a, b].filter(r => r === 'OK').length
      expect(winners, `essai ${round + 1} : ${a} / ${b}`).toBe(1)
    }
  }, 60_000)

  it('un verrou PÉRIMÉ (pid mort) est repris — et par un seul processus', async () => {
    expect(existsSync(STATE_DIST)).toBe(true)
    for (let round = 0; round < 6; round++) {
      writeFileSync(join(root, 'daemon.lock'), '999999', 'utf8') // pid inexistant
      const startAt = Date.now() + 150
      const [a, b] = await Promise.all([racer(startAt, 60), racer(startAt, 60)])
      expect([a, b].filter(r => r === 'OK').length, `essai ${round + 1} : ${a} / ${b}`).toBe(1)
    }
  }, 30_000)
})

describe('acquireLock — cas unitaires (même processus)', () => {
  it('verrou périmé (pid inexistant) → acquis, fichier réécrit avec notre pid', () => {
    writeFileSync(join(root, 'daemon.lock'), '999999', 'utf8')
    const release = acquireLock(root)
    expect(release).not.toBeNull()
    expect(readFileSync(join(root, 'daemon.lock'), 'utf8').trim()).toBe(String(process.pid))
    release!()
    expect(existsSync(join(root, 'daemon.lock'))).toBe(false)
  })

  it('verrou tenu par un pid VIVANT (le nôtre) → refusé, fichier intact', () => {
    writeFileSync(join(root, 'daemon.lock'), String(process.pid), 'utf8')
    expect(acquireLock(root)).toBeNull()
    expect(readFileSync(join(root, 'daemon.lock'), 'utf8').trim()).toBe(String(process.pid))
  })

  it('release ne supprime pas un verrou qui n’est plus le sien', () => {
    const release = acquireLock(root)
    expect(release).not.toBeNull()
    // un autre daemon (vivant) a repris le fichier entre-temps
    writeFileSync(join(root, 'daemon.lock'), String(process.ppid), 'utf8')
    release!()
    expect(existsSync(join(root, 'daemon.lock'))).toBe(true)
    rmSync(join(root, 'daemon.lock'))
  })
})
