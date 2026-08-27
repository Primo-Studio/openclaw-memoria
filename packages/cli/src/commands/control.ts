/**
 * Commandes de contrôle (spec §2.1, panneau Réglages) :
 *  - `memoria enable` / `memoria disable` : kill-switch global (pause Memoria).
 *  - `memoria autostart [on|off]`         : lancement auto au login (launchd).
 *  - `memoria move --to <chemin>`         : déplace TOUTE la mémoire (clé USB).
 *
 * Toutes passent par le daemon vivant quand il existe ; `move` exige au
 * contraire un daemon ARRÊTÉ (les DB ne peuvent être déplacées ouvertes) et
 * l'arrête lui-même proprement avant de bouger les fichiers.
 */
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import { autostartStatus, disableAutostart, enableAutostart, moveStorage, setEnabled } from '@memoria/core'
import {
  currentVersion,
  daemonProgramArguments,
  ensureDaemon,
  pullAndBuild,
  readDaemonState,
  scheduleRestart,
  waitForDaemon,
  waitForExit,
} from '@memoria/daemon'
import { fail, findAliveDaemon, resolveCommon } from '../index.js'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class EnableCommand extends Command {
  static override paths = [['enable']]
  static override usage = Command.Usage({ description: 'Réactive Memoria (lève la pause : capture et recall reprennent).' })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  override async execute(): Promise<number> {
    const opts = { storageRoot: this.storageRoot, configPath: this.config }
    try {
      const daemon = await findAliveDaemon(opts)
      if (daemon) await daemon.client.setEnabled(true)
      else setEnabled(true, resolveCommon(opts).configPath)
      this.context.stdout.write('✓ Memoria activé.\n')
      return 0
    } catch (err) {
      return fail(this.context.stderr, `enable : ${(err as Error).message}`)
    }
  }
}

export class DisableCommand extends Command {
  static override paths = [['disable']]
  static override usage = Command.Usage({
    description: 'Met Memoria en pause : le daemon reste joignable mais ne lit ni n’écrit plus de mémoire.',
  })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  override async execute(): Promise<number> {
    const opts = { storageRoot: this.storageRoot, configPath: this.config }
    try {
      const daemon = await findAliveDaemon(opts)
      if (daemon) await daemon.client.setEnabled(false)
      else setEnabled(false, resolveCommon(opts).configPath)
      this.context.stdout.write('✓ Memoria en pause (capture et recall suspendus). « memoria enable » pour reprendre.\n')
      return 0
    } catch (err) {
      return fail(this.context.stderr, `disable : ${(err as Error).message}`)
    }
  }
}

/** Arrêt propre d'un daemon par pid : SIGTERM puis attente de la mort (≤ 5 s). */
async function stopDaemonPid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return true // déjà mort
  }
  return waitForExit(pid, 5_000)
}

/**
 * `memoria autostart on|off` orchestre la PASSATION entre un daemon direct
 * (`memoria start`) et le service launchd. Le bug d'origine (27/08) :
 * « autostart on » faisait bootstrap pendant qu'un daemon direct tenait
 * daemon.lock → l'instance launchd mourait sur le verrou et KeepAlive la
 * relançait toutes les ~10 s, indéfiniment (memoria.err.log rempli, mémoire
 * indisponible), pendant que la CLI affichait ✓. Et « autostart off » tuait
 * le daemon launchd (bootout) en annonçant seulement « retiré » : plus aucun
 * daemon, sans le dire.
 */
export class AutostartCommand extends Command {
  static override paths = [['autostart']]
  static override usage = Command.Usage({
    description: 'Lancement automatique au login (launchd). « on » installe, « off » retire, sans argument affiche l’état.',
  })
  mode = Option.String({ required: false })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  /** Injectables pour les tests : launchd, daemon et attentes simulés — jamais le vrai launchctl. */
  autostartStatusFn: typeof autostartStatus = () => autostartStatus()
  enableAutostartFn: typeof enableAutostart = enableAutostart
  disableAutostartFn: () => ReturnType<typeof disableAutostart> = () => disableAutostart()
  findAliveDaemonFn: typeof findAliveDaemon = findAliveDaemon
  ensureDaemonFn: typeof ensureDaemon = ensureDaemon
  stopDaemonFn: (pid: number) => Promise<boolean> = stopDaemonPid
  waitForDaemonFn: typeof waitForDaemon = waitForDaemon
  waitForExitFn: typeof waitForExit = waitForExit
  /** Délai d'attente du daemon launchd après bootstrap. */
  startTimeoutMs = 15_000

  override async execute(): Promise<number> {
    const out = this.context.stdout
    const opts = { storageRoot: this.storageRoot, configPath: this.config }
    try {
      if (this.mode === undefined) return this.showStatus()
      if (this.mode === 'on') return await this.turnOn(opts)
      if (this.mode === 'off') return await this.turnOff(opts)
      return fail(this.context.stderr, `autostart : argument « ${this.mode} » inconnu (attendu : on | off | rien).`)
    } catch (err) {
      return fail(this.context.stderr, `autostart : ${(err as Error).message}`)
    }
  }

  private showStatus(): number {
    const out = this.context.stdout
    const s = this.autostartStatusFn()
    if (!s.supported) {
      out.write('Lancement auto : non pris en charge sur cette plateforme (macOS uniquement).\n')
      return 0
    }
    // « chargé » ≠ « en marche » : on dit ce que launchd sait vraiment (pid,
    // relances) — un service chargé dont le process est mort ou qui boucle
    // n'est PAS une bonne nouvelle.
    let state = s.installed ? 'installé' : 'absent'
    if (s.loaded) state += s.running ? ` (en marche, pid ${s.pid ?? '?'})` : ' (chargé mais ARRÊTÉ — « memoria start » le relance)'
    out.write(`Lancement auto : ${state}\n  plist : ${s.plistPath}\n`)
    if (s.loaded && (s.runs ?? 0) > 3 && s.last_exit_code !== null && s.last_exit_code !== 0) {
      out.write(`⚠ ${s.runs} relances par launchd, dernier code de sortie ${s.last_exit_code} — le service boucle. Voir ~/Library/Logs/memoria.err.log\n`)
    }
    return 0
  }

  private async turnOn(opts: { storageRoot?: string; configPath?: string }): Promise<number> {
    const out = this.context.stdout
    const { storageRoot, configPath } = resolveCommon(opts)
    const alive = await this.findAliveDaemonFn(opts)
    if (alive) {
      const health = await alive.client.health()
      if (health?.supervisor === 'launchd') {
        // Déjà sous launchd : recharger le service tuerait le daemon pour rien.
        out.write(`✓ Lancement auto déjà actif — daemon sous launchd (pid ${alive.state.pid}, 127.0.0.1:${alive.state.port}).\n`)
        return 0
      }
      // Un daemon DIRECT tient le verrou : launchd ne pourrait pas démarrer le
      // sien. On l'arrête d'abord, proprement, et on attend sa mort.
      out.write(`Arrêt du daemon direct (pid ${alive.state.pid}) — launchd va le reprendre…\n`)
      if (!(await this.stopDaemonFn(alive.state.pid))) {
        return fail(this.context.stderr, `autostart : le daemon (pid ${alive.state.pid}) ne s’est pas arrêté — réessaie après « memoria stop ».`)
      }
    }
    const s = this.enableAutostartFn({
      programArguments: daemonProgramArguments(storageRoot, configPath),
      workingDirectory: storageRoot,
    })
    // `enableAutostart` lève si le chargement n'a pas pris, mais on ne
    // réaffirme un succès que sur l'état RÉEL : un ✓ affiché pendant que le
    // daemon est à terre est pire qu'une erreur.
    if (!s.loaded) {
      return fail(
        this.context.stderr,
        `autostart : plist écrit (${s.plistPath}) mais le service n’est pas chargé — le daemon ne tourne pas. ` +
          'Réessaie, ou : launchctl bootstrap gui/$(id -u) ' + s.plistPath,
      )
    }
    // Chargé ≠ en marche : le ✓ attend que le daemon launchd RÉPONDE.
    const state = await this.waitForDaemonFn(storageRoot, this.startTimeoutMs)
    if (!state) {
      return fail(
        this.context.stderr,
        `autostart : service chargé mais le daemon ne répond pas après ${Math.round(this.startTimeoutMs / 1000)} s — voir ~/Library/Logs/memoria.err.log (et « memoria doctor »).`,
      )
    }
    out.write(`✓ Lancement auto installé et chargé — daemon sous launchd (pid ${state.pid}, 127.0.0.1:${state.port}), relancé à chaque login.\n  plist : ${s.plistPath}\n`)
    return 0
  }

  private async turnOff(opts: { storageRoot?: string; configPath?: string }): Promise<number> {
    const out = this.context.stdout
    const { storageRoot, configPath } = resolveCommon(opts)
    const alive = await this.findAliveDaemonFn(opts)
    const health = alive ? await alive.client.health() : null
    const wasLaunchd = alive !== null && health?.supervisor === 'launchd'
    // bootout arrête le daemon du service (SIGTERM → sortie propre) : l'utilisateur
    // garde sa mémoire parce qu'on le relance en direct juste après.
    this.disableAutostartFn()
    if (!wasLaunchd) {
      out.write('✓ Lancement auto retiré.\n')
      return 0
    }
    await this.waitForExitFn(alive.state.pid, 5_000)
    const state = await this.ensureDaemonFn({ storageRoot, configPath })
    out.write(`✓ Lancement auto retiré — daemon relancé en direct (pid ${state.pid}, 127.0.0.1:${state.port}) ; il ne survivra pas à la fermeture de session.\n`)
    return 0
  }
}

export class UpdateCommand extends Command {
  static override paths = [['update']]
  static override usage = Command.Usage({
    description: 'Met Memoria à jour (git pull + build) et redémarre le daemon.',
  })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  override async execute(): Promise<number> {
    const out = this.context.stdout
    try {
      const v = await currentVersion()
      out.write(`Version actuelle : ${v.version}${v.sha ? ` (${v.sha})` : ''}\n`)
      if (!v.is_git) return fail(this.context.stderr, 'update : installation non-git — mets à jour via ton gestionnaire de paquets.')
      out.write('Téléchargement + reconstruction…\n')
      const r = await pullAndBuild()
      out.write(`${r.message}\n`)
      if (r.ok && r.rebuilt) {
        const { storageRoot } = resolveCommon({ storageRoot: this.storageRoot, configPath: this.config })
        scheduleRestart(storageRoot)
        out.write('Le daemon redémarre dans quelques secondes (memoria stop && start).\n')
      }
      return r.ok ? 0 : 1
    } catch (err) {
      return fail(this.context.stderr, `update : ${(err as Error).message}`)
    }
  }
}

export class MoveCommand extends Command {
  static override paths = [['move']]
  static override usage = Command.Usage({
    description: 'Déplace TOUTE la mémoire vers un nouvel emplacement (ex. clé USB) et met à jour config.toml.',
    details: 'Le daemon est arrêté automatiquement (les DB ne peuvent bouger ouvertes), puis « memoria start » le relancera au nouvel emplacement.',
  })
  to = Option.String('--to', { required: true, description: 'Dossier de destination (vide ou inexistant)' })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage source' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  override async execute(): Promise<number> {
    const out = this.context.stdout
    const opts = { storageRoot: this.storageRoot, configPath: this.config }
    try {
      const { storageRoot, configPath } = resolveCommon(opts)
      // 1) arrêter le daemon s'il vit (sinon DB ouvertes = déplacement risqué)
      const state = readDaemonState(storageRoot)
      if (state && pidAlive(state.pid)) {
        out.write(`Arrêt du daemon (pid ${state.pid}) avant déplacement…\n`)
        process.kill(state.pid, 'SIGTERM')
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline && pidAlive(state.pid)) await new Promise(r => setTimeout(r, 100))
        if (pidAlive(state.pid)) return fail(this.context.stderr, `move : le daemon (pid ${state.pid}) ne s’est pas arrêté — réessaie après « memoria stop ».`)
      }
      // 2) déplacer + réécrire config.toml
      const { from, to } = moveStorage({ from: storageRoot, to: this.to, configPath })
      out.write(`✓ Mémoire déplacée :\n  de : ${from}\n  à  : ${to}\nconfig.toml mis à jour. Lance « memoria start » pour redémarrer au nouvel emplacement.\n`)
      return 0
    } catch (err) {
      return fail(this.context.stderr, `move : ${(err as Error).message}`)
    }
  }
}
