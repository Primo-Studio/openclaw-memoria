/**
 * État local du daemon : `daemon.json` (découverte clients) + lock-file singleton.
 *
 * - `daemon.json` (chmod 600) : { daemon_id, port, admin_token, pid, started_at }.
 *   C'est par CE fichier que CLI/UI/MCP découvrent le daemon et son token admin.
 * - `daemon.lock` : PID — un seul daemon par storage_root. Lock périmé (process
 *   mort) → reprise automatique.
 */
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { storagePaths } from '@memoria/core'

export interface DaemonState {
  daemon_id: string
  port: number
  admin_token: string
  pid: number
  started_at: string
}

export function readDaemonState(storageRoot: string): DaemonState | null {
  const p = storagePaths(storageRoot).daemonState
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonState
  } catch {
    return null
  }
}

export function writeDaemonState(storageRoot: string, state: DaemonState): void {
  const p = storagePaths(storageRoot).daemonState
  // mode 600 dès la création (pas de fenêtre 644 entre write et chmod) : le
  // fichier porte l'admin_token. Écriture tmp+rename pour l'atomicité.
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, p)
  chmodSync(p, 0o600)
}

export function clearDaemonState(storageRoot: string): void {
  const p = storagePaths(storageRoot).daemonState
  rmSync(p, { force: true })
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** PID inscrit dans un fichier de verrou, null si illisible. */
function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Notre pid est-il celui inscrit dans le verrou ? (le fichier a pu être repris) */
function lockIsOurs(lockPath: string): boolean {
  return readLockPid(lockPath) === process.pid
}

/**
 * Prend le lock singleton. Retourne `null` si un autre daemon VIVANT le tient,
 * sinon une fonction de libération.
 *
 * ATOMIQUE : `existsSync` puis `writeFileSync` laissaient passer DEUX processus
 * lancés au même instant (Claude Code et Codex qui démarrent leurs serveurs MCP
 * pendant que le daemon est tombé) — 55 doubles acquisitions sur 60 essais.
 * Résultat : deux daemons sur les mêmes DB, WAL rejoué deux fois (faits en
 * double), daemon.json écrit par le dernier, l'autre invisible mais actif.
 * La création en `wx` (O_EXCL) est tranchée par le noyau : un seul gagne.
 *
 * Verrou PÉRIMÉ (pid mort après un crash) : on ne l'efface pas — un `rm` suivi
 * d'un `wx` laisse un concurrent effacer le verrou tout neuf du gagnant. On le
 * RÉCLAME par renommage (atomique, un seul des deux y arrive) puis on vérifie
 * ce qu'on a réellement attrapé avant de repartir en `wx`.
 */
export function acquireLock(storageRoot: string): (() => void) | null {
  const lockPath = storagePaths(storageRoot).daemonLock
  const release = (): void => {
    // Ne jamais supprimer le verrou d'un autre : après un crash + reprise, le
    // fichier peut appartenir au daemon survivant.
    if (lockIsOurs(lockPath)) rmSync(lockPath, { force: true })
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      return release
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    // Un lock tenu par un process VIVANT (y compris le nôtre) refuse : un seul
    // daemon par storage_root, même intra-process.
    const holder = readLockPid(lockPath)
    if (holder !== null && isPidAlive(holder)) return null

    // Périmé (ou illisible) : réclamation par renommage.
    const claimed = `${lockPath}.claim-${process.pid}`
    try {
      renameSync(lockPath, claimed)
    } catch {
      continue // un concurrent l'a réclamé avant nous → on retente le wx
    }
    const claimedPid = readLockPid(claimed)
    if (claimedPid !== null && claimedPid !== process.pid && isPidAlive(claimedPid)) {
      // On a attrapé le verrou TOUT NEUF d'un gagnant : on le lui rend.
      try {
        renameSync(claimed, lockPath)
      } catch {
        /* le gagnant a déjà recréé son verrou : le nôtre est de trop */
        rmSync(claimed, { force: true })
      }
      return null
    }
    rmSync(claimed, { force: true })
  }
  return null
}

/** Le daemon décrit par daemon.json est-il vivant (PID) ? */
export function daemonLooksAlive(storageRoot: string): DaemonState | null {
  const state = readDaemonState(storageRoot)
  if (!state) return null
  return isPidAlive(state.pid) ? state : null
}
