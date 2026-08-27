/**
 * Mise à jour de l'installation Memoria depuis l'UI (« bouton Mise à jour »).
 * Tire la dernière version (git), réinstalle + reconstruit, puis redémarre le
 * daemon. Pensé pour un non-dev (Badette sur l'iMac) : un clic, pas de terminal.
 *
 * Best-effort et HONNÊTE : renvoie le log réel ; si ce n'est pas un dépôt git
 * (paquet npm publié plus tard), le dit clairement au lieu d'échouer en silence.
 *
 * ⚠️ Ce module tourne SOUS LAUNCHD, pas dans un terminal. Le daemon est démarré
 * par le LaunchAgent, qui ne transmet aucun environnement de shell : son PATH
 * vaut `/usr/bin:/bin:/usr/sbin:/sbin`. `git` s'y trouve (/usr/bin/git), `npm`
 * JAMAIS — nvm, Homebrew et le pkg officiel l'installent tous ailleurs. Un
 * `execFile('npm', …)` échouait donc en `spawn npm ENOENT`, mais seulement quand
 * il y avait vraiment une mise à jour à installer (le bloc npm est conditionné
 * par `changed`), d'où un bug invisible sur une machine déjà à jour.
 */
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { stripLaunchdEnv } from './spawn-env.js'

const run = promisify(execFile)

/** Racine du monorepo (server.js vit dans packages/daemon/dist/). */
export function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url))
}

export interface UpdateResult {
  ok: boolean
  is_git: boolean
  before: string | null
  after: string | null
  /** Le `git pull` a rapporté une nouvelle révision. */
  changed: boolean
  /**
   * Un build a réellement eu lieu — ce qui arrive AUSSI sans nouveauté git,
   * quand le précédent avait échoué. C'est ce drapeau, et non `changed`, qui
   * doit décider d'un redémarrage : sans lui le service garde en mémoire le
   * code qu'on vient de remplacer sur le disque.
   */
  rebuilt: boolean
  log: string
  message: string
}

// ------------------------------------------------------------ résolution de npm

/** Comment lancer npm : un binaire et les arguments qui précèdent les siens. */
export interface NpmLauncher {
  cmd: string
  prefixArgs: string[]
}

/**
 * Emplacements possibles de npm, du plus fiable au plus opportuniste.
 *
 * On part de `process.execPath` — un chemin ABSOLU que le daemon connaît déjà,
 * puisque le plist lance node par son chemin complet. Deux dispositions coexistent :
 *
 *  - nvm / pkg officiel : npm est sous le préfixe du node courant
 *    (`…/v24.18.0/lib/node_modules/npm/bin/npm-cli.js`).
 *  - Homebrew : le npm du Cellar est un lien vers `/opt/homebrew/lib/node_modules/…`,
 *    HORS du préfixe du node. D'où le passage par le shim voisin + `realpath`.
 */
export function npmCandidates(execPath: string = process.execPath): string[] {
  const binDir = dirname(execPath)
  return [
    join(dirname(binDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(binDir, 'npm'),
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    '/usr/bin/npm',
  ]
}

/**
 * Trouve un npm exécutable SANS dépendre du PATH.
 *
 * Un candidat qui se résout (après symlinks) sur un `.js` est lancé par le node
 * courant : on évite le shim shell ET on garantit la même version de Node que
 * le service. Sinon on lance le binaire directement. `null` = rien trouvé.
 */
export function resolveNpm(execPath: string = process.execPath): NpmLauncher | null {
  for (const candidate of npmCandidates(execPath)) {
    if (!existsSync(candidate)) continue
    let real = candidate
    try {
      real = realpathSync(candidate)
    } catch {
      /* lien cassé : on tente le chemin brut */
    }
    if (real.endsWith('.js')) return { cmd: execPath, prefixArgs: [real] }
    return { cmd: real, prefixArgs: [] }
  }
  return null
}

/** Message actionnable : `spawn npm ENOENT` n'aide personne, surtout pas un non-dev. */
export const NPM_MISSING_MESSAGE =
  'npm est introuvable depuis le service Memoria. Installe Node.js (nodejs.org), ' +
  'ou mets à jour depuis le Terminal : `git pull && npm install && npm run build`.'

async function npmRun(args: string[], opts: { timeout: number }): Promise<{ stdout: string }> {
  const npm = resolveNpm()
  if (!npm) throw new Error(NPM_MISSING_MESSAGE)
  return run(npm.cmd, [...npm.prefixArgs, ...args], opts)
}

// ------------------------------------------------------------ git

async function gitSha(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])
    return stdout.trim()
  } catch {
    return null
  }
}

export async function currentVersion(): Promise<{ version: string; sha: string | null; is_git: boolean }> {
  const dir = repoRoot()
  const sha = await gitSha(dir)
  let version = '0.1.0'
  try {
    // Lecture directe : passer par `cat` spawnait un process pour rien et
    // ajoutait une dépendance au PATH là où le disque suffit.
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }
    if (pkg.version) version = pkg.version
  } catch {
    /* garde le défaut */
  }
  return { version, sha, is_git: sha !== null }
}

// ------------------------------------------------------------ marqueur de build

/**
 * Dernière révision RÉELLEMENT reconstruite.
 *
 * `changed` compare deux SHA git : il dit si le `git pull` a rapporté quelque
 * chose, PAS si le `dist/` correspond aux sources. Quand un build échoue (npm
 * introuvable, erreur de compilation…), le pull reste acquis — et l'appel
 * suivant voit `changed === false`, ne reconstruit rien, et annonce « Déjà à
 * jour » alors que le service tourne sur un dist périmé. L'installation restait
 * cassée en se déclarant saine, sans aucun moyen de s'en sortir par l'UI.
 *
 * Le marqueur tranche : on reconstruit tant qu'il ne coïncide pas avec HEAD.
 */
const BUILD_MARKER = '.memoria-built-sha'

export function buildMarkerPath(dir: string): string {
  return join(dir, BUILD_MARKER)
}

export function lastBuiltSha(dir: string): string | null {
  try {
    const raw = readFileSync(buildMarkerPath(dir), 'utf8').trim()
    return raw === '' ? null : raw
  } catch {
    return null
  }
}

/**
 * Faut-il (re)construire ? `changed` ne suffit pas — voir BUILD_MARKER.
 *
 * Marqueur absent (installation antérieure à ce mécanisme) → on reconstruit une
 * fois. C'est le seul choix sûr : on ne peut pas distinguer un dist à jour d'un
 * dist périmé, et se tromper dans ce sens ne coûte qu'un build, tandis que se
 * tromper dans l'autre laisse tourner du code périmé indéfiniment.
 */
export function needsRebuild(changed: boolean, headSha: string | null, builtSha: string | null): boolean {
  if (changed) return true
  if (headSha === null) return false // dépôt illisible : on ne devine pas
  return builtSha !== headSha
}

/** Traduit une panne d'outil manquant en consigne exploitable. */
export function explainFailure(err: Error): string {
  const m = err.message
  if (m.includes('ENOENT') && m.includes('npm')) return NPM_MISSING_MESSAGE
  if (m.includes('ENOENT') && m.includes('git')) {
    return 'git est introuvable depuis le service Memoria. Installe les outils en ligne de commande Xcode (`xcode-select --install`).'
  }
  return m
}

/**
 * Tire + reconstruit. Ne redémarre PAS lui-même (l'appelant décide) : on renvoie
 * le résultat d'abord pour que l'UI l'affiche, puis le daemon planifie son redémarrage.
 */
export async function pullAndBuild(): Promise<UpdateResult> {
  const dir = repoRoot()
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, is_git: false, before: null, after: null, changed: false, rebuilt: false, log: '', message: 'Installation non-git (paquet figé) — mets à jour via ton gestionnaire de paquets.' }
  }
  const before = await gitSha(dir)
  const log: string[] = []
  try {
    const pull = await run('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 120_000 })
    log.push(pull.stdout.trim())
    const after = await gitSha(dir)
    const changed = before !== after
    const rebuilt = needsRebuild(changed, after, lastBuiltSha(dir))
    if (rebuilt) {
      const install = await npmRun(['install', '--prefix', dir, '--no-audit', '--no-fund'], { timeout: 600_000 })
      log.push(install.stdout.trim().split('\n').slice(-3).join('\n'))
      const build = await npmRun(['run', 'build', '--prefix', dir], { timeout: 600_000 })
      log.push(build.stdout.trim().split('\n').slice(-3).join('\n'))
      // Marqueur posé APRÈS le build seulement : un échec doit laisser la
      // reconstruction en attente, pas la déclarer faite.
      if (after) writeFileSync(buildMarkerPath(dir), after, 'utf8')
    }
    return {
      ok: true,
      is_git: true,
      before,
      after,
      changed,
      rebuilt,
      log: log.join('\n'),
      message: changed
        ? `Mis à jour ${before} → ${after}. Redémarrage du service…`
        : rebuilt
          ? `Aucune nouveauté, mais le build était en retard sur les sources — reconstruit. Redémarrage du service…`
          : 'Déjà à jour.',
    }
  } catch (err) {
    // `after` reflète le dépôt RÉEL, pas `before` : si le pull est passé et que
    // c'est le build qui a cassé, le source est déjà en avance sur le dist — le
    // dire évite de croire l'installation intacte.
    const after = await gitSha(dir)
    return {
      ok: false,
      is_git: true,
      before,
      after,
      changed: before !== after,
      rebuilt: false,
      log: log.join('\n'),
      message: `Échec de la mise à jour : ${explainFailure(err as Error)}`,
    }
  }
}

/**
 * Planifie un redémarrage du daemon APRÈS la réponse HTTP : un process détaché
 * attend ~1,5 s (le temps que la réponse parte + ce daemon s'arrête) puis relance
 * `memoria start`. Survit à la mort du parent (detached + unref).
 */
export function scheduleRestart(storageRoot: string): void {
  const cliBin = cliBinPath()
  if (!existsSync(cliBin)) return
  const node = process.execPath
  // STOP (libère le lock + vide daemon.json) puis START : le nouveau process
  // charge le BUILD fraîchement reconstruit. Détaché → survit à notre arrêt.
  const script =
    `sleep 1; "${node}" "${cliBin}" stop --storage-root "${storageRoot}" >/dev/null 2>&1; ` +
    `sleep 1; "${node}" "${cliBin}" start --storage-root "${storageRoot}" >/dev/null 2>&1`
  spawnDetachedShell(script, dirname(cliBin))
}

/** `memoria` (cli/dist/bin.js), voisin du daemon dans le monorepo. */
function cliBinPath(): string {
  return fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
}

function spawnDetachedShell(script: string, cwd: string): void {
  // env épuré : `sh` → CLI → daemon direct ne doivent pas hériter du marqueur
  // launchd de CE process, sinon le daemon relancé se croit supervisé (spawn-env.ts).
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', cwd, env: stripLaunchdEnv() })
  child.unref()
}

/**
 * Passe la main à `memoria autostart on|off` dans un process DÉTACHÉ, après
 * que la réponse HTTP est partie.
 *
 * Pourquoi pas dans le daemon : quand ce process EST le service launchd, un
 * `launchctl bootout` depuis lui est l'ordre de NOUS tuer — bloqués dans
 * execFileSync/sleepSync, le handler SIGTERM ne tourne pas, launchd applique
 * « exit timeout = 5 » → SIGKILL, close() jamais appelé (daemon.json et
 * daemon.lock périmés, réponse jamais envoyée, mémoire perdue jusqu'à
 * relance manuelle). Et depuis un daemon direct, un `bootstrap` lance un
 * second daemon qui se heurte à notre verrou. La CLI, elle, arrête le bon
 * daemon, attend sa mort, puis laisse launchd (ou `memoria start`) reprendre.
 * Sa sortie va dans daemon.log pour rester diagnosticable.
 */
export function scheduleAutostartHandover(mode: 'on' | 'off', storageRoot: string, configPath: string): void {
  const cliBin = cliBinPath()
  if (!existsSync(cliBin)) {
    throw new Error(`passation impossible : CLI introuvable (${cliBin}) — lance « memoria autostart ${mode} » depuis le Terminal`)
  }
  const node = process.execPath
  const log = join(storageRoot, 'daemon.log')
  const script =
    `sleep 1; "${node}" "${cliBin}" autostart ${mode} --storage-root "${storageRoot}" --config "${configPath}" >>"${log}" 2>&1`
  spawnDetachedShell(script, dirname(cliBin))
}
