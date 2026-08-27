/**
 * `memoria import --instance <id> (--transcripts | --legacy <chemin>) [--max-windows N]`
 * — MINCE client des routes daemon /v1/admin/import_start + /v1/admin/import_status
 * (mission B5). Le job tourne DANS le daemon (un seul processus better-sqlite3
 * sur les DB) ; ici on ne fait qu'afficher la progression en ligne.
 *
 * Robustesse (audit 27/08, vu dans ~/.memoria/auto-import.log) : un « fetch
 * failed » transitoire pendant le polling faisait abandonner la commande alors
 * que le job continuait côté daemon ; l'instance suivante de auto-import.sh
 * recevait alors 409 « un import est déjà en cours ». Désormais :
 *  - les erreurs réseau du polling sont tolérées (jusqu'à MAX_TRANSIENT_POLL_FAILURES
 *    d'affilée, petit backoff, message clair) — on n'échoue qu'au-delà ;
 *  - un 409 au démarrage fait ATTENDRE la fin de l'import en cours, puis relance.
 */
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import type { DaemonClient, ImportJobStatus } from '@memoria/daemon'
import { fail, findAliveDaemon } from '../index.js'

/** Échecs réseau consécutifs tolérés pendant le polling (~40 s à 1 s de base avec le backoff). */
export const MAX_TRANSIENT_POLL_FAILURES = 10
/** Fois où l'on accepte d'attendre un import concurrent (409) avant de renoncer. */
export const MAX_BUSY_WAITS = 5
/** Tentatives de POST import_start sur erreur réseau transitoire. */
const MAX_TRANSIENT_START_FAILURES = 3

export class ImportCommand extends Command {
  static override paths = [['import']]
  static override usage = Command.Usage({
    description: 'Importe les souvenirs d’un agent : conversations (transcripts) ou mémoire legacy OpenClaw.',
    details:
      'Le job tourne dans le daemon (« memoria start » d’abord). Transcripts : les souvenirs arrivent DORMANTS et attendent ta validation dans l’écran Revue. Legacy : la mémoire est adoptée directement en privé pour l’instance. Si un autre import est en cours, la commande attend sa fin puis lance le sien.',
    examples: [
      ['Conversations Claude Code / Codex', 'memoria import --instance <id> --transcripts'],
      ['Mémoire legacy OpenClaw', 'memoria import --instance <id> --legacy ~/.openclaw/workspace/memory/memoria.db'],
    ],
  })

  instance = Option.String('--instance', { required: true, description: 'Instance cible (voir « memoria agents »)' })
  transcripts = Option.Boolean('--transcripts', false, { description: 'Importer les conversations de l’agent' })
  legacy = Option.String('--legacy', { description: 'Chemin de la base legacy OpenClaw (memoria.db)' })
  maxWindows = Option.String('--max-windows', { description: 'Fenêtres max analysées par fichier (transcripts)' })
  pollMs = Option.String('--poll-ms', { description: 'Intervalle de rafraîchissement en ms (défaut : 1000)' })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  override async execute(): Promise<number> {
    const out = this.context.stdout
    if (this.transcripts && this.legacy) {
      return fail(this.context.stderr, 'import : choisis UNE source — --transcripts OU --legacy <chemin>, pas les deux.')
    }
    if (!this.transcripts && !this.legacy) {
      return fail(this.context.stderr, 'import : indique la source — --transcripts (conversations) ou --legacy <chemin> (mémoire OpenClaw).')
    }
    const maxWindows = this.maxWindows !== undefined ? Number(this.maxWindows) : undefined
    if (maxWindows !== undefined && (!Number.isFinite(maxWindows) || maxWindows < 1)) {
      return fail(this.context.stderr, 'import : --max-windows doit être un entier ≥ 1.')
    }
    const pollMs = Math.max(10, this.pollMs !== undefined ? Number(this.pollMs) || 1000 : 1000)

    const daemon = await findAliveDaemon({ storageRoot: this.storageRoot, configPath: this.config })
    if (!daemon) {
      return fail(this.context.stderr, 'import : le daemon ne tourne pas — lance « memoria start » d’abord (le job d’import tourne dans le daemon).')
    }

    const kind = this.transcripts ? 'transcripts' : 'legacy'
    const write = (s: string): void => {
      out.write(s)
    }
    try {
      await startWhenFree(
        daemon.client,
        {
          instance_id: this.instance,
          kind,
          ...(this.legacy ? { legacy_path: this.legacy } : {}),
          ...(maxWindows !== undefined ? { max_windows_per_file: Math.floor(maxWindows) } : {}),
        },
        pollMs,
        write,
      )
      write(kind === 'transcripts' ? 'Import des conversations lancé…\n' : 'Import de la mémoire legacy lancé…\n')

      const status = await pollUntilSettled(daemon.client, pollMs, write, s => `  ${progressLine(s)}`)
      write('\n')

      if (status.state === 'error' || status.state === 'interrupted') {
        return fail(this.context.stderr, `import : ${status.error ?? 'erreur inconnue (voir le journal du daemon)'}`)
      }
      if (status.state !== 'done') {
        // `idle` en plein run : le daemon a perdu la trace du job (redémarrage sans statut persisté ?).
        return fail(this.context.stderr, 'import : le daemon a perdu la trace de l’import (redémarrage ?) — relance « memoria import » pour continuer.')
      }
      write(`✓ ${status.progress.facts_imported} souvenir(s) importé(s) (${status.progress.files_done}/${status.progress.files_total} fichier(s)).\n`)
      if (kind === 'transcripts') {
        write('  Ils sont DORMANTS : valide-les dans l’écran Revue (« memoria » → Revue) pour les activer.\n')
      } else {
        write('  Mémoire legacy adoptée directement en privé pour cette instance (active immédiatement).\n')
      }
      if (status.errors.length > 0) {
        write(`⚠ ${status.errors.length} erreur(s) non bloquante(s) pendant l’import :\n`)
        for (const e of status.errors.slice(0, 10)) write(`  - ${e}\n`)
        if (status.errors.length > 10) write(`  … et ${status.errors.length - 10} autre(s).\n`)
      }
      return 0
    } catch (err) {
      return fail(this.context.stderr, `import : ${(err as Error).message}`)
    }
  }
}

type ImportStartInput = Parameters<DaemonClient['importStart']>[0]

/**
 * POST import_start, en attendant la fin d'un import concurrent (409) au lieu
 * d'échouer : auto-import.sh enchaîne les instances, la seconde tombait sur le
 * job de la première. Retente aussi sur erreur réseau transitoire.
 */
async function startWhenFree(client: DaemonClient, input: ImportStartInput, pollMs: number, write: (s: string) => void): Promise<void> {
  let busyWaits = 0
  let transient = 0
  for (;;) {
    try {
      await client.importStart(input)
      return
    } catch (err) {
      if (isBusyError(err)) {
        busyWaits++
        if (busyWaits > MAX_BUSY_WAITS) throw new Error(`un autre import occupe toujours le daemon après ${MAX_BUSY_WAITS} attentes — réessaie plus tard.`)
        write('Un autre import est déjà en cours dans le daemon — on attend sa fin avant de lancer celui-ci…\n')
        const other = await pollUntilSettled(client, pollMs, write, s => `  (import en cours : ${progressLine(s)})`)
        write(`\n  Import précédent terminé (${other.state}) — on lance le nôtre.\n`)
        continue
      }
      if (isTransientNetworkError(err)) {
        transient++
        if (transient > MAX_TRANSIENT_START_FAILURES) throw describeUnreachable(err, transient, 'le démarrage de l’import n’a pas pu être demandé')
        write(`  ⚠ daemon momentanément injoignable (${(err as Error).message}), on réessaie… (${transient}/${MAX_TRANSIENT_START_FAILURES})\n`)
        await sleep(pollMs * Math.min(transient, 5))
        continue
      }
      throw err
    }
  }
}

/**
 * Sonde import_status jusqu'à un état final (tout sauf `running`).
 * Erreurs réseau transitoires : tolérées jusqu'à MAX_TRANSIENT_POLL_FAILURES
 * d'affilée avec un petit backoff (pollMs × 1, 2, 3, 4, 5, 5…) ; une réponse
 * réussie remet le compteur à zéro. Les erreurs HTTP du daemon (401, 500…)
 * restent fatales : ce n'est plus « momentané ».
 * La ligne de progression n'est réécrite que quand elle change (sinon un
 * journal redirigé se remplissait d'une ligne identique par seconde).
 */
export async function pollUntilSettled(
  client: DaemonClient,
  pollMs: number,
  write: (s: string) => void,
  render: (status: ImportJobStatus) => string,
): Promise<ImportJobStatus> {
  let failures = 0
  let lastLine = ''
  for (;;) {
    await sleep(pollMs * Math.min(failures + 1, 5))
    let status: ImportJobStatus
    try {
      status = await client.importStatus()
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err
      failures++
      if (failures > MAX_TRANSIENT_POLL_FAILURES) throw describeUnreachable(err, failures, 'l’import continue peut-être côté daemon')
      write(`\n  ⚠ daemon momentanément injoignable (${(err as Error).message}), on réessaie… (${failures}/${MAX_TRANSIENT_POLL_FAILURES})\n`)
      continue
    }
    failures = 0
    const line = render(status)
    if (line !== lastLine) {
      write(`\r${line}          `)
      lastLine = line
    }
    if (status.state !== 'running') return status
  }
}

/** 409 du daemon = « un import est déjà en cours » (handleResponse : `daemon <route> → 409 : …`). */
export function isBusyError(err: unknown): boolean {
  return err instanceof Error && /→ 409\b/.test(err.message)
}

/**
 * Erreur réseau transitoire (daemon qui ne répond pas un instant : socket
 * réinitialisée pendant un gros fichier, connexion refusée le temps d'un
 * redémarrage…) — par opposition à une réponse HTTP d'erreur, qui est un vrai
 * refus. undici enveloppe ces cas dans un TypeError « fetch failed ».
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  if (!(err instanceof Error)) return false
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|network/i.test(err.message)
}

function describeUnreachable(err: unknown, attempts: number, hint: string): Error {
  return new Error(
    `daemon injoignable ${attempts} fois d’affilée (${(err as Error).message}) — ${hint} : vérifie avec « memoria doctor » puis relance « memoria import ».`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Ligne de progression : « 3/12 fichiers — 27 souvenirs ». */
function progressLine(status: ImportJobStatus): string {
  const p = status.progress
  return `${p.files_done}/${p.files_total} fichier(s) — ${p.facts_imported} souvenir(s)`
}
