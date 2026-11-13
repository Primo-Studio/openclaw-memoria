/**
 * État local du daemon : `daemon.json` (découverte clients) + lock-file singleton.
 *
 * - `daemon.json` (chmod 600) : { daemon_id, port, admin_token, pid, started_at }.
 *   C'est par CE fichier que CLI/UI/MCP découvrent le daemon et son token admin.
 * - `daemon.lock` : PID en première ligne, puis `boot=<identifiant de la session
 *   de démarrage>`. Un seul daemon par storage_root. Lock périmé (process mort,
 *   OU verrou d'une session de démarrage précédente) → reprise automatique.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, constants, copyFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
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
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    // Les droits sont fixés AVANT le renommage (le mode de création ne vaut que
    // pour un fichier neuf). Après lui, un échec laissait un daemon.json valide,
    // au pid vivant, pour un daemon qui venait de renoncer : « bloqué » à tort.
    chmodSync(tmp, 0o600)
    renameSync(tmp, p)
  } catch (err) {
    // Ne pas laisser traîner un fichier qui porte l'admin_token.
    rmSync(tmp, { force: true })
    throw err
  }
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

/** Contenu d'un fichier de verrou. `bootId` null = ancien format (pid seul). */
interface LockContent {
  pid: number
  bootId: string | null
}

/**
 * Lit un fichier de verrou, null si illisible.
 *
 * Format : le pid en PREMIÈRE ligne (une version antérieure, qui fait un
 * `parseInt` du fichier entier, continue donc à le lire), puis `boot=<id>`.
 */
function readLock(lockPath: string): LockContent | null {
  let text: string
  try {
    text = readFileSync(lockPath, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n').map(l => l.trim())
  const pid = Number.parseInt(lines[0] ?? '', 10)
  if (!Number.isFinite(pid) || pid <= 0) return null
  const bootLine = lines.find(l => l.startsWith('boot='))
  const bootId = bootLine ? bootLine.slice('boot='.length) : ''
  return { pid, bootId: BOOT_ID_SHAPE.test(bootId) ? bootId : null }
}

/** PID inscrit dans un fichier de verrou, null si illisible. */
function readLockPid(lockPath: string): number | null {
  return readLock(lockPath)?.pid ?? null
}

function lockFileContent(bootId: string | null): string {
  return bootId ? `${process.pid}\nboot=${bootId}\n` : `${process.pid}\n`
}

const BOOT_ID_SHAPE = /^[0-9A-Za-z-]{8,64}$/

let cachedBootId: string | null | undefined

/**
 * Identifiant de la session de démarrage de la machine, null si la plateforme
 * n'en fournit pas. Il change à chaque démarrage et JAMAIS quand l'heure est
 * corrigée : c'est ce qui le rend plus sûr qu'une comparaison de dates.
 */
export function bootSessionId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId
  let id: string | null = null
  try {
    if (process.platform === 'darwin') {
      id = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } else if (process.platform === 'linux') {
      id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    }
  } catch {
    id = null
  }
  cachedBootId = id !== null && BOOT_ID_SHAPE.test(id) ? id : null
  return cachedBootId
}

/** Marge sur l'heure de démarrage de la machine (arrondis d'horloge). */
const BOOT_MARGIN_MS = 10_000

/** Heure de démarrage de la machine. `os.uptime()` compte la veille (vérifié sur macOS contre kern.boottime). */
function machineBootTimeMs(): number {
  return Date.now() - uptime() * 1000
}

/** Ce qu'on sait du démarrage en cours, pour juger un verrou dont le pid vit. */
interface BootContext {
  bootId: string | null
  bootTimeMs: number
}

/**
 * Le verrou date-t-il d'AVANT le démarrage de la machine ?
 *
 * Après un redémarrage brutal, `daemon.lock` garde le pid de l'ancien daemon.
 * Ce pid peut avoir été repris par n'importe quel process (un process système,
 * panne du ticket #27) : `isPidAlive` répond alors « vivant » et le daemon
 * attendait sans fin un verrou que personne ne tient. Aucun daemon de la
 * session en cours ne peut avoir écrit un verrou d'une session précédente : un
 * tel verrou est périmé, quel que soit l'état de son pid.
 *
 * Deux preuves, par ordre de confiance :
 * 1. l'identifiant de session inscrit dans le verrou diffère de celui en cours ;
 * 2. en repli seulement (verrou à l'ancien format, plateforme sans identifiant) :
 *    la date du fichier précède l'heure de démarrage.
 * La date seule ne suffit pas quand on a mieux : l'heure de démarrage est
 * calculée depuis l'horloge murale, et une correction d'heure (synchro réseau
 * après un démarrage hors ligne, réglage manuel) la déplace APRÈS la date d'un
 * verrou pourtant tenu par un daemon vivant. On démarrait alors un second
 * daemon sur les mêmes bases.
 */
function lockPredatesBoot(lockPath: string, lock: LockContent, boot: BootContext): boolean {
  if (lock.bootId !== null && boot.bootId !== null) return lock.bootId !== boot.bootId
  try {
    return statSync(lockPath).mtimeMs < boot.bootTimeMs - BOOT_MARGIN_MS
  } catch {
    return false
  }
}

/**
 * Lit le verrou en laissant à son auteur le temps de l'écrire.
 *
 * Ce daemon pose son verrou déjà rempli (voir `placeLockExclusive`), mais une
 * version antérieure, ou le repli sans lien dur, crée le fichier PUIS y écrit :
 * entre les deux il existe, vide. Un concurrent qui le lisait à cet instant le
 * prenait pour un verrou illisible, donc périmé, et le réclamait : deux daemons
 * (vu sous forte charge machine, test de course « OK / OK »). Un verrou vide
 * est donc relu pendant 200 ms au plus avant d'être déclaré illisible.
 */
function readLockSettled(lockPath: string): LockContent | null {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; i < 20; i++) {
    const lock = readLock(lockPath)
    if (lock !== null || !existsSync(lockPath)) return lock
    Atomics.wait(pause, 0, 0, 10)
  }
  return readLock(lockPath)
}

/** Notre pid est-il celui inscrit dans le verrou ? (le fichier a pu être repris) */
function lockIsOurs(lockPath: string): boolean {
  return readLockPid(lockPath) === process.pid
}

/**
 * Pose `src` (un fichier DÉJÀ rempli) à l'emplacement du verrou, sans jamais
 * remplacer un verrou existant. Rend false si la place est prise.
 *
 * Le lien dur est tranché par le noyau comme une création exclusive, avec deux
 * avantages sur `open('wx')` + écriture et sur `rename` :
 * - le verrou n'existe jamais vide (pas de fenêtre « créé mais pas écrit ») ;
 * - contrairement à `rename`, qui REMPLACE la cible sans erreur, il échoue si
 *   un autre process a posé son verrou entre-temps.
 * Repli pour un système de fichiers sans lien dur : copie exclusive.
 */
export function placeLockExclusive(src: string, lockPath: string): boolean {
  try {
    linkSync(src, lockPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
  }
  try {
    copyFileSync(src, lockPath, constants.COPYFILE_EXCL)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** Un verrou tenu par un process vivant de la session de démarrage en cours. */
function heldByLiveDaemon(path: string, lock: LockContent | null, boot: BootContext): boolean {
  return lock !== null && isPidAlive(lock.pid) && !lockPredatesBoot(path, lock, boot)
}

function currentBoot(opts: { bootTimeMs?: number; bootId?: string | null } = {}): BootContext {
  return {
    bootId: opts.bootId !== undefined ? opts.bootId : bootSessionId(),
    bootTimeMs: opts.bootTimeMs ?? machineBootTimeMs(),
  }
}

/** Une réclamation dure quelques microsecondes : au-delà, son auteur est mort en route. */
const CLAIM_MAX_AGE_MS = 30_000

/** Résultat de `removeStaleLock`. */
export type StaleLockOutcome = 'removed' | 'live' | 'busy'

/**
 * Retire le verrou périmé, sous un verrou de RÉCLAMATION exclusif
 * (`daemon.lock.claim`). `draft` est un fichier déjà rempli à notre pid.
 *
 * - 'removed' : la place est libre (verrou périmé retiré, ou déjà absent) ;
 * - 'live'    : relu sous réclamation, le verrou est tenu par un daemon vivant ;
 * - 'busy'    : un autre process réclame en ce moment, réessayer.
 *
 * Pourquoi sérialiser : avant, chacun réclamait par renommage puis regardait ce
 * qu'il avait attrapé. Avec trois démarrages simultanés, B renommait le verrou
 * tout neuf de A, C posait le sien pendant que la place était vide, et B ne
 * pouvait plus rendre celui de A : A et C tournaient tous les deux sur les
 * mêmes bases. Ici seul le détenteur de la réclamation retire un verrou, et il
 * le RELIT d'abord : un verrou vivant ne quitte jamais sa place.
 *
 * Réclamation abandonnée (process tué en la tenant) : retirée si son pid est
 * mort ou si elle a plus de 30 s. Limite connue et acceptée : deux process qui
 * retirent au même instant une réclamation abandonnée peuvent se gêner ; il
 * faut un process tué pendant ces quelques microsecondes, puis une course à
 * trois au démarrage suivant.
 */
export function removeStaleLock(
  draft: string,
  lockPath: string,
  opts: { bootTimeMs?: number; bootId?: string | null } = {},
): StaleLockOutcome {
  const boot = currentBoot(opts)
  const claimPath = `${lockPath}.claim`
  if (!placeLockExclusive(draft, claimPath)) {
    // Une réclamation absente à la relecture vient d'être rendue : on n'y
    // touche pas (un `rm` ici pourrait effacer celle du suivant).
    const holder = readLockSettled(claimPath)
    // Illisible (copie interrompue) ET ancienne : retirée aussi, sinon plus aucun
    // démarrage ne passerait sur un verrou périmé.
    const unreadableOld = holder === null && existsSync(claimPath) && fileAgeMs(claimPath) > CLAIM_MAX_AGE_MS
    if (unreadableOld || (holder !== null && (!heldByLiveDaemon(claimPath, holder, boot) || fileAgeMs(claimPath) > CLAIM_MAX_AGE_MS))) {
      rmSync(claimPath, { force: true })
    }
    return 'busy'
  }
  try {
    const lock = readLockSettled(lockPath)
    if (heldByLiveDaemon(lockPath, lock, boot)) return 'live'
    // Place DÉJÀ vide : ne rien supprimer. La pose d'un verrou se fait hors
    // réclamation ; un `rm` ici pouvait effacer le verrou tout neuf qu'un
    // concurrent vient de poser entre notre relecture et le retrait (deux
    // daemons sur les mêmes bases). Un verrou PRÉSENT et périmé, lui, ne peut
    // être remplacé que par le détenteur de la réclamation : son retrait est sûr.
    if (lock === null && !existsSync(lockPath)) return 'removed'
    rmSync(lockPath, { force: true })
    return 'removed'
  } finally {
    if (lockIsOurs(claimPath)) rmSync(claimPath, { force: true })
  }
}

/** Âge d'un fichier d'après sa date de modification, 0 s'il est illisible. */
function fileAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return 0
  }
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
 * La pose exclusive (`placeLockExclusive`) est tranchée par le noyau : un seul
 * gagne.
 *
 * Verrou PÉRIMÉ (pid mort après un crash) : retiré par `removeStaleLock`, un
 * seul process à la fois, puis on retente la pose comme sur une place vide.
 */
export function acquireLock(
  storageRoot: string,
  opts: { bootTimeMs?: number; bootId?: string | null } = {},
): (() => void) | null {
  const lockPath = storagePaths(storageRoot).daemonLock
  const boot = currentBoot(opts)
  const release = (): void => {
    // Ne jamais supprimer le verrou d'un autre : après un crash + reprise, le
    // fichier peut appartenir au daemon survivant.
    if (lockIsOurs(lockPath)) rmSync(lockPath, { force: true })
  }

  // Brouillon propre à ce process : rempli ici, posé d'un seul geste ensuite.
  const draft = `${lockPath}.new-${process.pid}`
  const pause = new Int32Array(new SharedArrayBuffer(4))
  try {
    writeFileSync(draft, lockFileContent(boot.bootId), 'utf8')
    // 20 essais : une réclamation concurrente se termine en quelques
    // microsecondes, on lui laisse jusqu'à 400 ms avant de renoncer.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (placeLockExclusive(draft, lockPath)) return release

      // Un lock tenu par un process VIVANT (y compris le nôtre) refuse : un seul
      // daemon par storage_root, même intra-process.
      // Exception : un verrou antérieur au démarrage de la machine est périmé même
      // si son pid « vit » (pid repris par un autre process après le redémarrage).
      if (heldByLiveDaemon(lockPath, readLockSettled(lockPath), boot)) return null

      // Périmé (ou illisible) : on le retire, puis on retente la pose.
      const outcome = removeStaleLock(draft, lockPath, boot)
      if (outcome === 'live') return null
      if (outcome === 'busy') Atomics.wait(pause, 0, 0, 20)
    }
    return null
  } finally {
    rmSync(draft, { force: true })
  }
}

/**
 * PID inscrit dans daemon.lock (null si absent/illisible), pour un message qui
 * nomme le détenteur.
 *
 * `liveOnly` : null aussi quand le verrou est périmé (pid mort, ou verrou d'une
 * session de démarrage précédente). Sert au doctor : un daemon qui démarre
 * tient déjà le verrou alors que daemon.json n'est pas encore écrit.
 */
export function lockHolderPid(storageRoot: string, opts: { liveOnly?: boolean } = {}): number | null {
  const lockPath = storagePaths(storageRoot).daemonLock
  const lock = readLock(lockPath)
  if (lock === null) return null
  if (opts.liveOnly && !heldByLiveDaemon(lockPath, lock, currentBoot())) return null
  return lock.pid
}

/**
 * Le daemon décrit par daemon.json est-il vivant (PID) ?
 *
 * Un pid qui « vit » ne prouve rien après un redémarrage brutal (pid repris par
 * un autre process) : si le verrou de ce même pid porte l'identifiant d'une
 * session de démarrage précédente, le daemon décrit n'existe plus.
 */
export function daemonLooksAlive(storageRoot: string): DaemonState | null {
  const state = readDaemonState(storageRoot)
  if (!state) return null
  if (!isPidAlive(state.pid)) return null
  const lock = readLock(storagePaths(storageRoot).daemonLock)
  const current = bootSessionId()
  if (lock !== null && lock.pid === state.pid && lock.bootId !== null && current !== null && lock.bootId !== current) return null
  return state
}
