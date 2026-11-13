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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLock, bootSessionId, daemonLooksAlive, lockHolderPid, placeLockExclusive, removeStaleLock, writeDaemonState } from '../src/state.js'

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

  // Trois agents et le service relancent le daemon au même instant : la reprise
  // d'un verrou périmé ne doit laisser passer qu'un seul d'entre eux (un verrou
  // lu vide ou une restitution par renommage en laissaient passer deux).
  it('quatre processus sur un verrou périmé : un seul gagnant, aucun fichier de travail oublié', async () => {
    expect(existsSync(STATE_DIST)).toBe(true)
    for (let round = 0; round < 8; round++) {
      writeFileSync(join(root, 'daemon.lock'), '999999', 'utf8')
      const startAt = Date.now() + 200
      const results = await Promise.all([0, 1, 2, 3].map(() => racer(startAt, 80)))
      expect(results.filter(r => r === 'OK').length, `essai ${round + 1} : ${results.join(' / ')}`).toBe(1)
      expect(readdirSync(root).filter(f => f !== 'daemon.lock')).toEqual([])
    }
  }, 60_000)
})

/** PID lu comme le fait une version antérieure : `parseInt` du fichier entier. */
const legacyPid = (path: string): number => Number.parseInt(readFileSync(path, 'utf8').trim(), 10)

describe('acquireLock — cas unitaires (même processus)', () => {
  it('verrou périmé (pid inexistant) → acquis, fichier réécrit avec notre pid', () => {
    writeFileSync(join(root, 'daemon.lock'), '999999', 'utf8')
    const release = acquireLock(root)
    expect(release).not.toBeNull()
    expect(legacyPid(join(root, 'daemon.lock'))).toBe(process.pid)
    release!()
    expect(existsSync(join(root, 'daemon.lock'))).toBe(false)
  })

  it('format : pid en première ligne (lisible par une version antérieure), puis la session de démarrage', () => {
    const release = acquireLock(root, { bootId: 'session-aaaa' })
    expect(release).not.toBeNull()
    expect(readFileSync(join(root, 'daemon.lock'), 'utf8')).toBe(`${process.pid}\nboot=session-aaaa\n`)
    expect(legacyPid(join(root, 'daemon.lock'))).toBe(process.pid)
    // aucun brouillon ni fichier réclamé ne reste à côté du verrou
    expect(readdirSync(root)).toEqual(['daemon.lock'])
    release!()
    expect(existsSync(join(root, 'daemon.lock'))).toBe(false)
  })

  it('plateforme sans identifiant de session : pid seul, comme avant', () => {
    const release = acquireLock(root, { bootId: null })
    expect(readFileSync(join(root, 'daemon.lock'), 'utf8').trim()).toBe(String(process.pid))
    release!()
  })

  // La pose ne doit jamais remplacer le verrou qu'un autre process a posé
  // entre-temps (un renommage le remplaçait en silence).
  it('placeLockExclusive ne remplace pas un verrou existant', () => {
    const lock = join(root, 'daemon.lock')
    const claimed = join(root, 'daemon.lock.claim-1')
    writeFileSync(lock, '111\n', 'utf8')
    writeFileSync(claimed, '222\n', 'utf8')
    expect(placeLockExclusive(claimed, lock)).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe('111\n')
    rmSync(lock)
    expect(placeLockExclusive(claimed, lock)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe('222\n')
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

// Trois démarrages simultanés sur un verrou périmé : B, qui avait lu le verrou
// périmé, attrapait par renommage le verrou tout neuf de A ; C posait le sien
// dans la place vide ; A et C tournaient tous les deux. Désormais un verrou
// n'est retiré que sous réclamation exclusive, après relecture.
describe('acquireLock : réclamation sérialisée d’un verrou périmé', () => {
  const lock = (): string => join(root, 'daemon.lock')
  const claim = (): string => join(root, 'daemon.lock.claim')
  const draft = (): string => {
    const p = join(root, 'brouillon')
    writeFileSync(p, `${process.pid}\n`, 'utf8')
    return p
  }

  it('B croit le verrou périmé alors que A vient de poser le sien : le verrou de A ne bouge pas', () => {
    // État vu par B au moment d'agir : le verrou en place est celui d'un daemon vivant.
    writeFileSync(lock(), `${process.ppid}\n`, 'utf8')
    expect(removeStaleLock(draft(), lock())).toBe('live')
    expect(readFileSync(lock(), 'utf8')).toBe(`${process.ppid}\n`)
    expect(existsSync(claim())).toBe(false)
  })

  it('verrou réellement périmé : retiré, réclamation rendue', () => {
    writeFileSync(lock(), '999999\n', 'utf8')
    expect(removeStaleLock(draft(), lock())).toBe('removed')
    expect(existsSync(lock())).toBe(false)
    expect(existsSync(claim())).toBe(false)
  })

  it('un autre process vivant réclame déjà : on ne touche ni au verrou périmé ni à sa réclamation', () => {
    writeFileSync(lock(), '999999\n', 'utf8')
    writeFileSync(claim(), `${process.ppid}\n`, 'utf8')
    expect(acquireLock(root)).toBeNull()
    expect(readFileSync(lock(), 'utf8')).toBe('999999\n')
    expect(readFileSync(claim(), 'utf8')).toBe(`${process.ppid}\n`)
    expect(readdirSync(root).sort()).toEqual(['daemon.lock', 'daemon.lock.claim'])
  })

  it('réclamation abandonnée (pid mort) : écartée, le verrou périmé est repris', () => {
    writeFileSync(lock(), '999999\n', 'utf8')
    writeFileSync(claim(), '999998\n', 'utf8')
    const release = acquireLock(root)
    expect(release).not.toBeNull()
    expect(legacyPid(lock())).toBe(process.pid)
    expect(readdirSync(root)).toEqual(['daemon.lock'])
    release!()
  })

  it('réclamation de plus de 30 s (pid repris par un autre process) : écartée aussi', () => {
    writeFileSync(lock(), '999999\n', 'utf8')
    writeFileSync(claim(), `${process.ppid}\n`, 'utf8')
    const old = new Date(Date.now() - 60_000)
    utimesSync(claim(), old, old)
    const release = acquireLock(root)
    expect(release).not.toBeNull()
    expect(readdirSync(root)).toEqual(['daemon.lock'])
    release!()
  })

  it('lockHolderPid liveOnly : le pid d’un détenteur vivant, null pour un verrou périmé', () => {
    expect(lockHolderPid(root, { liveOnly: true })).toBeNull()
    writeFileSync(lock(), `${process.ppid}\n`, 'utf8')
    expect(lockHolderPid(root, { liveOnly: true })).toBe(process.ppid)
    writeFileSync(lock(), '999999\n', 'utf8')
    expect(lockHolderPid(root)).toBe(999999)
    expect(lockHolderPid(root, { liveOnly: true })).toBeNull()
    const id = bootSessionId()
    if (id) {
      writeFileSync(lock(), `${process.ppid}\nboot=session-precedente\n`, 'utf8')
      expect(lockHolderPid(root, { liveOnly: true })).toBeNull()
    }
  })
})

// Panne du ticket #27 : après un redémarrage brutal, le
// pid inscrit dans daemon.lock avait été repris par un process système — le
// verrou paraissait tenu et le daemon attendait sans fin.
describe('acquireLock — verrou antérieur au démarrage de la machine', () => {
  const lock = (): string => join(root, 'daemon.lock')

  it('pid VIVANT mais verrou écrit avant le démarrage → repris sans intervention', () => {
    // process.ppid = un pid vivant qui n'est pas un daemon Memoria (le pid « repris »)
    writeFileSync(lock(), String(process.ppid), 'utf8')
    const boot = Date.now() - 3_600_000
    const before = new Date(boot - 86_400_000)
    utimesSync(lock(), before, before)
    const started = Date.now()
    const release = acquireLock(root, { bootTimeMs: boot })
    expect(release).not.toBeNull()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(legacyPid(lock())).toBe(process.pid)
    release!()
  })

  it('pid vivant et verrou écrit APRÈS le démarrage → refusé (un seul daemon)', () => {
    writeFileSync(lock(), String(process.ppid), 'utf8')
    expect(acquireLock(root, { bootTimeMs: Date.now() - 3_600_000 })).toBeNull()
    expect(readFileSync(lock(), 'utf8').trim()).toBe(String(process.ppid))
  })

  it('verrou à quelques secondes du démarrage → refusé (marge d’horloge)', () => {
    writeFileSync(lock(), String(process.ppid), 'utf8')
    const boot = Date.now() - 3_600_000
    const justBefore = new Date(boot - 2000)
    utimesSync(lock(), justBefore, justBefore)
    expect(acquireLock(root, { bootTimeMs: boot })).toBeNull()
  })

  it('heure de démarrage réelle de la machine : un verrou de la session en cours est respecté', () => {
    writeFileSync(lock(), String(process.ppid), 'utf8')
    expect(acquireLock(root)).toBeNull()
  })
})

// Un saut d'horloge (synchro réseau après un démarrage hors ligne, réglage
// manuel) déplace l'heure de démarrage CALCULÉE après la date d'un verrou tenu
// par un daemon vivant : la date seule le déclarait périmé, second daemon.
describe('acquireLock : identifiant de session de démarrage', () => {
  const lock = (): string => join(root, 'daemon.lock')
  const longBefore = (boot: number): Date => new Date(boot - 86_400_000)

  it('même session, pid vivant, date antérieure au démarrage calculé → refusé (saut d’horloge)', () => {
    writeFileSync(lock(), `${process.ppid}\nboot=session-aaaa\n`, 'utf8')
    const boot = Date.now() - 3_600_000
    utimesSync(lock(), longBefore(boot), longBefore(boot))
    expect(acquireLock(root, { bootTimeMs: boot, bootId: 'session-aaaa' })).toBeNull()
    expect(legacyPid(lock())).toBe(process.ppid)
    expect(readdirSync(root)).toEqual(['daemon.lock'])
  })

  it('autre session, pid vivant, date récente → périmé, repris', () => {
    writeFileSync(lock(), `${process.ppid}\nboot=session-aaaa\n`, 'utf8')
    const release = acquireLock(root, { bootTimeMs: Date.now() - 3_600_000, bootId: 'session-bbbb' })
    expect(release).not.toBeNull()
    expect(readFileSync(lock(), 'utf8')).toBe(`${process.pid}\nboot=session-bbbb\n`)
    release!()
  })

  it('verrou à l’ancien format (pid seul) : le test de date reste le repli', () => {
    writeFileSync(lock(), String(process.ppid), 'utf8')
    const boot = Date.now() - 3_600_000
    expect(acquireLock(root, { bootTimeMs: boot, bootId: 'session-aaaa' })).toBeNull()
    utimesSync(lock(), longBefore(boot), longBefore(boot))
    const release = acquireLock(root, { bootTimeMs: boot, bootId: 'session-aaaa' })
    expect(release).not.toBeNull()
    release!()
  })

  it('identifiant réel de la machine : stable d’un appel à l’autre, inscrit dans le verrou', () => {
    const id = bootSessionId()
    expect(bootSessionId()).toBe(id)
    const release = acquireLock(root)
    const text = readFileSync(lock(), 'utf8')
    if (id) expect(text).toContain(`boot=${id}`)
    else expect(text.trim()).toBe(String(process.pid))
    release!()
  })

  it('daemonLooksAlive : daemon.json d’une session précédente dont le pid a été repris → pas vivant', () => {
    const id = bootSessionId()
    if (!id) return // plateforme sans identifiant : rien à distinguer
    const state = { daemon_id: 'd', port: 1, admin_token: 't', pid: process.ppid, started_at: new Date().toISOString() }
    writeDaemonState(root, state)
    writeFileSync(lock(), `${process.ppid}\nboot=${id}\n`, 'utf8')
    expect(daemonLooksAlive(root)?.pid).toBe(process.ppid)
    writeFileSync(lock(), `${process.ppid}\nboot=session-precedente\n`, 'utf8')
    expect(daemonLooksAlive(root)).toBeNull()
  })
})
