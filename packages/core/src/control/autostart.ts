/**
 * Lancement automatique au login (macOS LaunchAgent).
 *
 * On NE lance PAS `memoria start` (qui rendrait la main aussitôt) : launchd
 * supervise directement le process daemon de premier plan (`memoria-daemon`),
 * avec KeepAlive → redémarrage auto en cas de crash. C'est le superviseur du
 * système qui garantit la persistance, pas nous.
 *
 * Linux (systemd --user) et Windows seront ajoutés au besoin ; ici on cible
 * la machine de dev/prod Primo (macOS). On échoue PROPREMENT ailleurs plutôt
 * que d'écrire un plist inutile.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

export const AUTOSTART_LABEL = 'fr.primo-studio.memoria'

/** PATH minimal que launchd donne à un agent sans EnvironmentVariables. */
const LAUNCHD_DEFAULT_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * PATH à inscrire dans le plist.
 *
 * Sans cette clé, le daemon hérite de `/usr/bin:/bin:/usr/sbin:/sbin` — où `git`
 * existe mais où `npm` n'est JAMAIS présent (nvm, Homebrew et le pkg officiel
 * l'installent tous ailleurs). C'est ce qui faisait échouer la mise à jour depuis
 * l'UI en `spawn npm ENOENT`.
 *
 * Ce n'est qu'une ceinture : le résolveur de `daemon/update.ts` trouve npm par
 * chemin absolu sans rien devoir au PATH. Mais tout futur outil externe lancé
 * par le daemon profite de ces dossiers, alors autant les poser une fois.
 * On préfixe le dossier du node COURANT : c'est celui qui a démarré le service,
 * donc son npm est cohérent avec lui.
 */
export function servicePath(execPath: string = process.execPath): string {
  const dirs = [dirname(execPath), '/opt/homebrew/bin', '/usr/local/bin', ...LAUNCHD_DEFAULT_PATH]
  return [...new Set(dirs)].join(':')
}

export interface AutostartSpec {
  /** Identifiant launchd (défaut fr.primo-studio.memoria). */
  label?: string
  /** Programme + arguments à lancer (ex. [node, daemonBin, '--storage-root', root]). */
  programArguments: string[]
  /** Répertoire de travail (défaut storage_root si fourni). */
  workingDirectory?: string
  /** Fichiers de log stdout/stderr (défaut ~/Library/Logs/memoria.*.log). */
  logDir?: string
  /** PATH du service (défaut : dossier du node courant + emplacements usuels). */
  path?: string
}

export interface AutostartStatus {
  supported: boolean
  installed: boolean
  loaded: boolean
  plistPath: string
}

function plistPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Exporté pour les tests : vérifier le plist sans écrire dans ~/Library. */
export function buildPlist(spec: Required<Pick<AutostartSpec, 'label'>> & AutostartSpec): string {
  const args = spec.programArguments.map(a => `      <string>${xmlEscape(a)}</string>`).join('\n')
  const logDir = spec.logDir ?? join(homedir(), 'Library', 'Logs')
  const out = join(logDir, 'memoria.out.log')
  const err = join(logDir, 'memoria.err.log')
  const wd = spec.workingDirectory ? `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(spec.workingDirectory)}</string>\n` : ''
  const path = spec.path ?? servicePath()
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>
${wd}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(err)}</string>
</dict>
</plist>
`
}

/** launchctl print gui/<uid>/<label> → 0 si chargé. Best-effort. */
function isLoaded(label: string): boolean {
  try {
    execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${label}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function autostartStatus(label: string = AUTOSTART_LABEL): AutostartStatus {
  const path = plistPath(label)
  const supported = platform() === 'darwin'
  return {
    supported,
    installed: existsSync(path),
    loaded: supported ? isLoaded(label) : false,
    plistPath: path,
  }
}

/**
 * Installe et charge le LaunchAgent (idempotent : recharge si déjà présent).
 * Le daemon démarre immédiatement (RunAtLoad) puis à chaque login.
 */
export function enableAutostart(spec: AutostartSpec): AutostartStatus {
  if (platform() !== 'darwin') {
    throw new Error('lancement auto : pris en charge sur macOS uniquement pour l’instant (launchd)')
  }
  const label = spec.label ?? AUTOSTART_LABEL
  const path = plistPath(label)
  mkdirSync(dirname(path), { recursive: true })
  const logDir = spec.logDir ?? join(homedir(), 'Library', 'Logs')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(path, buildPlist({ ...spec, label }), 'utf8')

  const uid = process.getuid?.() ?? 501
  // bootout d'abord (ignore l'échec si pas chargé) puis bootstrap → recharge propre.
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' })
  } catch {
    /* pas encore chargé : normal */
  }
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, path], { stdio: 'ignore' })
  } catch (err) {
    // fallback legacy (anciennes versions macOS)
    try {
      execFileSync('launchctl', ['load', '-w', path], { stdio: 'ignore' })
    } catch {
      throw new Error(`lancement auto : launchctl a refusé le chargement (${(err as Error).message})`)
    }
  }
  return autostartStatus(label)
}

/** Décharge et supprime le LaunchAgent (idempotent). */
export function disableAutostart(label: string = AUTOSTART_LABEL): AutostartStatus {
  const path = plistPath(label)
  if (platform() === 'darwin') {
    const uid = process.getuid?.() ?? 501
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' })
    } catch {
      try {
        execFileSync('launchctl', ['unload', '-w', path], { stdio: 'ignore' })
      } catch {
        /* déjà déchargé : on continue vers la suppression du fichier */
      }
    }
  }
  if (existsSync(path)) rmSync(path)
  return autostartStatus(label)
}
