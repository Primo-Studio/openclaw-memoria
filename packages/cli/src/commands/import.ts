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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import type { ChatGptImportSummary, DaemonClient, ImportJobStatus } from '@memoria/daemon'
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
      ['Export ChatGPT (voir « memoria import chatgpt -h »)', 'memoria import chatgpt ~/chatgpt-export.zip --dry-run'],
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

/**
 * `memoria import chatgpt <zip | dossier | conversations.json> [--dry-run]` —
 * import de l'export ChatGPT dans l'instance ChatGPT de la machine (créée au
 * premier import). Même client mince : le job tourne dans le daemon.
 */
export class ImportChatGptCommand extends Command {
  static override paths = [['import', 'chatgpt']]
  static override usage = Command.Usage({
    description: 'Importe l’export ChatGPT (le .zip reçu par mail, son dossier décompressé, ou conversations.json).',
    details:
      'Le job tourne dans le daemon (« memoria start » d’abord). Les souvenirs arrivent DORMANTS et attendent ta validation dans l’écran Revue. Avec --dry-run : aucun appel au modèle, rien d’écrit ; la commande compte les conversations, les messages gardés, les fenêtres à extraire, et estime les jetons et le coût. Ré-importer le même export ne refait rien. Sous macOS, le daemon ne peut pas lire Téléchargements : place l’export dans ton dossier personnel.',
    examples: [
      ['Estimer le coût avant tout', 'memoria import chatgpt ~/chatgpt-export.zip --dry-run'],
      ['Importer', 'memoria import chatgpt ~/chatgpt-export.zip'],
    ],
  })

  exportPath = Option.String({ required: true, name: 'export' })
  dryRun = Option.Boolean('--dry-run', false, { description: 'Compter et estimer sans appel au modèle ni écriture' })
  instance = Option.String('--instance', { description: 'Instance ChatGPT cible (défaut : celle de cette machine, créée au premier import)' })
  maxWindows = Option.String('--max-windows', { description: 'Fenêtres max analysées par conversation et par passage (défaut : aucune limite ; le surplus est repris au passage suivant)' })
  pollMs = Option.String('--poll-ms', { description: 'Intervalle de rafraîchissement en ms (défaut : 1000)' })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  override async execute(): Promise<number> {
    const out = this.context.stdout
    // Le daemon n'a pas le même dossier courant : chemin ABSOLU, « ~ » déplié.
    const given = this.exportPath
    const raw = given.startsWith('~/') || given === '~' ? `${homedir()}${given.slice(1)}` : given
    const path = resolve(raw)
    if (!existsSync(path)) return fail(this.context.stderr, `import chatgpt : export introuvable : « ${path} »`)
    const maxWindows = this.maxWindows !== undefined ? Number(this.maxWindows) : undefined
    if (maxWindows !== undefined && (!Number.isFinite(maxWindows) || maxWindows < 1)) {
      return fail(this.context.stderr, 'import chatgpt : --max-windows doit être un entier ≥ 1.')
    }
    const pollMs = Math.max(10, this.pollMs !== undefined ? Number(this.pollMs) || 1000 : 1000)
    const daemon = await findAliveDaemon({ storageRoot: this.storageRoot, configPath: this.config })
    if (!daemon) {
      return fail(this.context.stderr, 'import chatgpt : le daemon ne tourne pas — lance « memoria start » d’abord (le job d’import tourne dans le daemon).')
    }
    const write = (s: string): void => {
      out.write(s)
    }
    try {
      await startWhenFree(
        daemon.client,
        {
          kind: 'chatgpt',
          path,
          dry_run: this.dryRun,
          ...(this.instance ? { instance_id: this.instance } : {}),
          ...(maxWindows !== undefined ? { max_windows_per_file: Math.floor(maxWindows) } : {}),
        },
        pollMs,
        write,
      )
      write(this.dryRun ? 'Estimation de l’import ChatGPT (aucun appel au modèle, rien d’écrit)…\n' : 'Import de l’export ChatGPT lancé…\n')
      const status = await pollUntilSettled(daemon.client, pollMs, write, s => `  ${chatGptProgressLine(s, this.dryRun)}`)
      write('\n')
      if (status.state === 'error' || status.state === 'interrupted') {
        return fail(this.context.stderr, `import chatgpt : ${status.error ?? 'erreur inconnue (voir le journal du daemon)'}`)
      }
      if (status.state !== 'done' || !status.summary) {
        return fail(this.context.stderr, 'import chatgpt : le daemon a perdu la trace de l’import (redémarrage ?) — relance la commande.')
      }
      write(renderChatGptSummary(status.summary, path))
      if (status.errors.length > 0) {
        write(`⚠ ${status.errors.length} erreur(s) non bloquante(s) :\n`)
        for (const e of status.errors.slice(0, 10)) write(`  - ${e}\n`)
        if (status.errors.length > 10) write(`  … et ${status.errors.length - 10} autre(s).\n`)
      }
      return 0
    } catch (err) {
      return fail(this.context.stderr, `import chatgpt : ${(err as Error).message}`)
    }
  }
}

const NUM = new Intl.NumberFormat('fr-FR')
const DEC = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const USD = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function tokens(n: number): string {
  if (n >= 1_000_000) return `${DEC.format(n / 1_000_000)} M`
  if (n >= 10_000) return `${NUM.format(Math.round(n / 1000))} k`
  return NUM.format(n)
}

const DROP_LABELS: Record<string, string> = {
  system: 'système',
  tool: 'outils',
  tool_call: 'appels d’outils',
  hidden: 'cachés',
  user_system: 'consignes système',
  weight0: 'poids nul',
  commentary: 'commentaires d’outil',
  analysis: 'analyse',
  empty: 'sans texte',
  no_role: 'sans rôle',
}

function chatGptProgressLine(status: ImportJobStatus, dryRun: boolean): string {
  const p = status.progress
  if (p.files_total === 0) return 'lecture de l’export…'
  return dryRun
    ? `${NUM.format(p.files_done)}/${NUM.format(p.files_total)} conversation(s) comptée(s)`
    : `${NUM.format(p.files_done)}/${NUM.format(p.files_total)} conversation(s) — ${NUM.format(p.facts_imported)} souvenir(s)`
}

/** Bilan lisible d'un import ChatGPT (dry-run ou réel). */
export function renderChatGptSummary(sum: ChatGptImportSummary, path: string): string {
  const st = sum.stats
  const lines: string[] = []
  const aside = [
    st.conversations_empty > 0 ? `${NUM.format(st.conversations_empty)} vide(s)` : '',
    st.conversations_malformed > 0 ? `${NUM.format(st.conversations_malformed)} illisible(s)` : '',
    st.conversations_duplicate > 0 ? `${NUM.format(st.conversations_duplicate)} en double` : '',
  ].filter(Boolean)
  lines.push(
    `✓ Export lu : ${NUM.format(st.conversations_kept)} conversation(s) gardée(s) sur ${NUM.format(st.conversations_seen)}` +
      `${aside.length > 0 ? ` (${aside.join(', ')})` : ''}, ${NUM.format(st.files)} fichier(s).`,
  )
  const dropped = Object.entries(st.dropped)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${DROP_LABELS[k] ?? k.replace(/^type:/, '')} ${NUM.format(n)}`)
  lines.push(
    `  Messages gardés : ${NUM.format(st.messages_kept)} sur ${NUM.format(st.messages_on_branch)} de la branche affichée` +
      `${dropped.length > 0 ? ` (écartés : ${dropped.join(', ')})` : ''} ; ${NUM.format(st.nodes_off_branch)} nœud(s) d’autres branches ignoré(s).`,
  )
  if (sum.dry_run) {
    lines.push(
      `  Fenêtres à extraire : ${NUM.format(sum.windows)} (déjà extraites : ${NUM.format(sum.windows_known)} ; conversations déjà importées : ${NUM.format(sum.conversations_unchanged)}).`,
    )
    const est = sum.estimate
    if (est) {
      lines.push(
        `  Jetons estimés : ${tokens(est.input_tokens)} en entrée, ${tokens(est.output_tokens)} en sortie (pire cas ${tokens(est.output_tokens_max)}).`,
      )
    }
    const cost = sum.cost
    if (!cost) {
      lines.push('  Coût : aucun moteur d’extraction configuré, impossible à estimer (Réglages).')
    } else if (cost.usd === null) {
      lines.push(`  Coût : tarif inconnu pour ${cost.provider}/${cost.model}, impossible à estimer.`)
    } else {
      lines.push(
        `  Coût estimé avec ${cost.provider}/${cost.model} : ${USD.format(cost.usd)} $ (pire cas ${USD.format(cost.usd_max ?? cost.usd)} $), tarifs indicatifs de ${cost.pricing_as_of}.`,
      )
    }
    lines.push('  Hypothèses : 3,7 caractères par jeton, sortie moyenne observée par taille d’extrait ; appels témoins et nouveaux essais non comptés.')
    lines.push(`  Pour lancer l’import : memoria import chatgpt ${JSON.stringify(path)}`)
  } else {
    lines.push(
      `  ${NUM.format(sum.facts_quarantined)} souvenir(s) mis en attente de revue (${NUM.format(sum.windows)} fenêtre(s) envoyée(s), ` +
        `${NUM.format(sum.windows_known)} déjà extraite(s), ${NUM.format(sum.facts_skipped_duplicates)} doublon(s) écarté(s), ` +
        `${NUM.format(sum.conversations_unchanged)} conversation(s) déjà importée(s)).`,
    )
    lines.push('  Ils sont DORMANTS : valide-les dans l’écran Revue (« memoria » → Revue) pour les activer.')
  }
  for (const note of sum.notes.slice(0, 5)) lines.push(`  · ${note}`)
  return `${lines.join('\n')}\n`
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
