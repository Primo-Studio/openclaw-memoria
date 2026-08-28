/**
 * Coffre natif macOS via `/usr/bin/security` (spec §9, D2).
 * ⚠ TOUJOURS execFileSync avec arguments séparés — jamais d'interpolation
 * shell : un nom ou une valeur de secret ne doit pas pouvoir injecter une
 * commande.
 *
 * ⚠ ERREURS ASSAINIES : quand `security` échoue, l'erreur d'execFileSync porte
 * la ligne de commande COMPLÈTE (`… -w <valeur>`) dans `message` et l'argv
 * dans `spawnargs`. Relancée telle quelle, elle finissait dans daemon.log et
 * dans une réponse HTTP 500 — le secret en clair, exactement ce que le coffre
 * doit empêcher. Ici, on ne relance JAMAIS l'erreur d'origine : une Error
 * neuve avec le statut et le stderr de `security` (lui-même expurgé de la
 * valeur, par défense), rien d'autre.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SecretProvider } from './types.js'

const DEFAULT_SECURITY_BIN = '/usr/bin/security'

/** Erreur levée par execFileSync (status + stderr du process fils). */
interface ExecError {
  status?: number | null
  stderr?: string | Buffer
  code?: string
}

/** Stderr du process fils — jamais `message` (il contient l'argv). */
function stderrOf(err: unknown): string {
  const e = err as ExecError
  if (typeof e.stderr === 'string') return e.stderr
  if (Buffer.isBuffer(e.stderr)) return e.stderr.toString('utf8')
  return ''
}

/** `security` signale l'absence d'un item par ce libellé (errSecItemNotFound). */
function isNotFound(err: unknown): boolean {
  return stderrOf(err).includes('could not be found')
}

/**
 * Description d'un échec SANS la valeur : « <sous-commande> a échoué (status N) :
 * <stderr> ». Toute occurrence de `hide` dans le stderr est masquée — `security`
 * n'y recopie pas la valeur aujourd'hui, mais on ne parie pas dessus.
 */
function describeFailure(subcommand: string, err: unknown, hide?: string): string {
  const e = err as ExecError
  const status = e.status === undefined || e.status === null ? (e.code ?? 'inconnu') : String(e.status)
  let detail = stderrOf(err).trim()
  if (hide && hide.length > 0) detail = detail.split(hide).join('[secret]')
  return `keychain : ${subcommand} a échoué (status ${status})${detail ? ` : ${detail}` : ''}`
}

export interface KeychainMacOptions {
  /** Service keychain (défaut `memoria`) — surchargé uniquement par les tests. */
  service?: string
  /** Binaire `security` (défaut /usr/bin/security) — surchargé uniquement par les tests (faux binaire). */
  bin?: string
}

export class KeychainMacProvider implements SecretProvider {
  readonly kind = 'keychain-macos'
  private readonly service: string
  private readonly bin: string

  constructor(opts: KeychainMacOptions = {}) {
    this.service = opts.service ?? 'memoria'
    this.bin = opts.bin ?? DEFAULT_SECURITY_BIN
  }

  isAvailable(): boolean {
    return process.platform === 'darwin' && existsSync(this.bin)
  }

  set(name: string, value: string): void {
    try {
      // -U = update si l'item existe déjà (sinon `security` refuse le doublon).
      execFileSync(
        this.bin,
        ['add-generic-password', '-U', '-s', this.service, '-a', name, '-w', value],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      // Error NEUVE : ni le message d'origine (argv avec la valeur), ni spawnargs.
      throw new Error(describeFailure('add-generic-password', err, value))
    }
  }

  get(name: string): string | null {
    try {
      const out = execFileSync(
        this.bin,
        ['find-generic-password', '-s', this.service, '-a', name, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      // `security -w` ajoute un \n final — on ne retire QUE celui-là.
      return out.replace(/\n$/, '')
    } catch (err) {
      if (isNotFound(err)) return null // contrat : null si absent
      console.warn(`[memoria] keychain get('${name}') : ${describeFailure('find-generic-password', err)}`)
      return null
    }
  }

  delete(name: string): void {
    try {
      execFileSync(
        this.bin,
        ['delete-generic-password', '-s', this.service, '-a', name],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      if (isNotFound(err)) return // delete idempotent : absent = déjà supprimé
      console.warn(`[memoria] keychain delete('${name}') : ${describeFailure('delete-generic-password', err)}`)
    }
  }

  locationFor(name: string): string {
    return `keychain:${this.service}/${name}`
  }
}
