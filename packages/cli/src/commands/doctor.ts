/**
 * `memoria doctor` — santé du stockage. Via HTTP admin si le daemon vit,
 * sinon lecture locale directe avec la note « daemon arrêté ».
 *
 * Trois états, pas deux : un daemon dont le process existe mais qui ne répond
 * pas est BLOQUÉ, pas arrêté. Le doctor l'attend, puis le dit, et n'ouvre
 * jamais les bases à côté de lui.
 */
import { relative } from 'node:path'
import type { Writable } from 'node:stream'
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import type { DoctorReport } from '@memoria/core'
import { DaemonClient, daemonLooksAlive, lockHolderPid, readDaemonState } from '@memoria/daemon'
import { fail, findAliveDaemon, formatBytes, resolveCommon, withLocalMemoria } from '../index.js'

/** Attente d'un daemon qui ne répond pas : le délai après lequel un agent abandonne. */
const DEFAULT_WAIT_S = 30

export class DoctorCommand extends Command {
  static override paths = [['doctor']]
  static override usage = Command.Usage({
    description: 'Bilan de santé complet : stockage, moteur d’IA, activité, consommation des modèles, avertissements.',
  })

  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage (défaut : résolution standard)' })
  config = Option.String('--config', { description: 'Fichier de découverte (défaut : ~/.memoria/config.toml)' })
  wait = Option.String('--wait', {
    description: `Secondes d’attente d’un daemon qui ne répond pas (défaut : ${DEFAULT_WAIT_S})`,
  })

  override async execute(): Promise<number> {
    const opts = { storageRoot: this.storageRoot, configPath: this.config }
    const out = this.context.stdout
    const startedAt = Date.now()
    try {
      const { storageRoot } = resolveCommon(opts)
      let daemon = await findAliveDaemon(opts)
      let note: string | null = null
      if (!daemon) {
        // Pas de réponse en 2 s. Si le process du daemon existe, il est occupé
        // (import, traitement de fond), pas arrêté : ouvrir les bases ici ferait
        // un second process sur la même mémoire, et « arrêté » serait faux au
        // moment précis où l'on vient chercher pourquoi il ne répond pas.
        // Le verrou compte autant que daemon.json : un daemon qui démarre (relancé
        // après un crash) tient déjà le verrou et ouvre les bases AVANT d'écrire
        // daemon.json, et l'ancien daemon.json porte encore un pid mort.
        const stuck = daemonLooksAlive(storageRoot)
        const pid = stuck?.pid ?? lockHolderPid(storageRoot, { liveOnly: true })
        if (pid !== null) {
          const waitS = parseWait(this.wait)
          out.write(`… le daemon (pid ${pid}) ne répond pas, nouvel essai pendant ${waitS} s\n`)
          const answer = await waitForDaemon(storageRoot, waitS * 1000)
          if (answer === null) {
            const where = stuck ? `pid ${stuck.pid}, port ${stuck.port}` : `pid ${pid}, en cours de démarrage`
            return blocked(out, storageRoot, `le process existe (${where}) mais n’a pas répondu après ${waitS} s d’attente`)
          }
          if (answer !== 'stopped') {
            daemon = answer
            const waited = ((Date.now() - startedAt) / 1000).toFixed(1).replace('.', ',')
            note = `le daemon a mis ${waited} s à répondre : il était bloqué`
          }
        }
      }
      let report: DoctorReport
      if (daemon) {
        try {
          report = (await daemon.client.doctor(REPORT_TIMEOUT_MS)) as DoctorReport
        } catch (err) {
          // Seul le délai dépassé veut dire « bloqué » ; une vraie erreur du
          // daemon (401, 500) garde son message.
          if ((err as Error).name !== 'TimeoutError') throw err
          const s = REPORT_TIMEOUT_MS / 1000
          return blocked(out, storageRoot, `il a répondu présent (pid ${daemon.state.pid}) puis n’a pas rendu son rapport en ${s} s`)
        }
      } else {
        note = 'daemon arrêté — lecture locale directe'
        report = withLocalMemoria(opts, memoria => memoria.doctor())
      }
      renderDoctor(out, report, note)
      // Le rapport EST le livrable : avertissements ≠ échec de la commande.
      return 0
    } catch (err) {
      return fail(this.context.stderr, `doctor : ${(err as Error).message}`)
    }
  }
}

type AliveDaemon = NonNullable<Awaited<ReturnType<typeof findAliveDaemon>>>

/** Délai du rapport lui-même : le daemon peut se figer entre le health et le rapport. */
const REPORT_TIMEOUT_MS = 30_000

/** Le message « daemon bloqué », code 1. Les bases ne sont jamais ouvertes dans ce cas. */
function blocked(out: Writable, storageRoot: string, what: string): number {
  out.write(`Memoria doctor — ${storageRoot}\n\n`)
  out.write(`✗ daemon bloqué : ${what}\n`)
  out.write('  cause habituelle : un import ou un traitement de fond qui occupe le daemon\n')
  out.write('  les bases ne sont pas lues à côté d’un daemon vivant : relance « memoria doctor » dans un instant\n')
  out.write('  si aucun daemon ne tourne (machine tout juste redémarrée) : « memoria start »\n')
  out.write('\nÉtat : ✗ daemon bloqué\n')
  return 1
}

function parseWait(raw: string | undefined): number {
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_S
}

/**
 * Réessaie jusqu'à `waitMs` de joindre le daemon. Rend null si rien n'a répondu.
 * daemon.json est relu à chaque essai : un daemon qui démarre ne l'écrit qu'une
 * fois ses bases ouvertes. En boucle plutôt qu'en un seul appel long : une
 * connexion refusée échoue tout de suite, et le daemon peut reprendre la main
 * entre deux essais.
 */
async function waitForDaemon(storageRoot: string, waitMs: number): Promise<AliveDaemon | 'stopped' | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    const state = readDaemonState(storageRoot)
    if (state) {
      const client = new DaemonClient(state, state.admin_token)
      if (await client.health(remaining)) return { state, client }
    }
    // Plus de process ni de verrou tenu : il s'est arrêté pendant l'attente
    // (démarrage raté), inutile d'attendre la fin du délai pour dire « bloqué ».
    if (!daemonLooksAlive(storageRoot) && lockHolderPid(storageRoot, { liveOnly: true }) === null) return 'stopped'
    const pause = Math.min(500, deadline - Date.now())
    if (pause > 0) await new Promise(r => setTimeout(r, pause))
  }
}

function renderDoctor(out: Writable, report: DoctorReport, note: string | null): void {
  out.write(`Memoria doctor — ${report.storage_root}\n`)
  if (note) out.write(`⚠ note : ${note}\n`)
  out.write('\n')
  // En tête : un daemon plus ancien n'envoie pas `enabled` (undefined = actif).
  const paused = report.enabled === false
  if (paused) out.write('⏸ état : Memoria en PAUSE — capture et recall refusés (« memoria enable » pour reprendre)\n')
  out.write(`✓ config : ${report.config_path}\n`)

  for (const db of report.databases) {
    const label = db.kind === 'registry' ? 'registre' : `db ${db.kind}`
    const path = relativeOrAbsolute(report.storage_root, db.path)
    if (!db.exists) {
      out.write(`⚠ ${label} : ${path} — enregistrée mais absente du disque\n`)
      continue
    }
    const wal = db.wal_pending !== undefined ? `, wal_pending=${db.wal_pending}` : ''
    out.write(`✓ ${label} : ${path} (${formatBytes(db.size_bytes)}${wal})\n`)
  }

  const guard = report.network_guard
  if (guard.on_network_volume) {
    out.write(`⚠ garde réseau : volume réseau/synchronisé détecté (journal_mode=${guard.journal_mode})\n`)
  } else {
    out.write(`✓ garde réseau : volume local (journal_mode=${guard.journal_mode})\n`)
  }

  // Réactivité : seulement quand le daemon répond (absent en lecture locale).
  const r = report.responsiveness
  if (r) {
    const secs = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`)
    const mark = r.max_block_ms_15m >= 5000 ? '⚠' : '✓'
    out.write(`${mark} réactivité : plus long blocage ${secs(r.max_block_ms_1m)} (1 min), ${secs(r.max_block_ms_15m)} (15 min)\n`)
  }

  const m = report.memory
  if (m) {
    out.write('\nMémoire\n')
    out.write(`  faits          : ${m.facts_total} actifs·archivés — ${m.facts_superseded} supersédés\n`)
    out.write(`  jamais utilisés: ${m.facts_never_used}\n`)
    const revisions = m.contradictions_pending + m.duplicates_pending
    out.write(
      `  révisions      : ${revisions} en attente (${m.contradictions_pending} contradiction(s), ${m.duplicates_pending} doublon(s))\n`,
    )
    out.write(`  extraction     : ${m.wal_pending} message(s) en attente, ${m.wal_stuck} bloqué(s)\n`)
  }

  const a = report.activity
  if (a) {
    out.write('\nActivité (24 h)\n')
    out.write(`  recalls        : ${a.recalls_24h}${a.last_recall_at ? ` — dernier ${shortTs(a.last_recall_at)}` : ''}\n`)
    out.write(`  captures       : ${a.captures_24h}${a.last_capture_at ? ` — dernière ${shortTs(a.last_capture_at)}` : ''}\n`)
    // Absent ≠ zéro : les entrées d'audit antérieures à l'instrumentation ne
    // portent pas de mesure. On le dit plutôt que d'afficher un « 0 ms » faux.
    out.write(
      a.recall_ms_avg !== undefined
        ? `  latence recall : ${a.recall_ms_avg} ms en moyenne, p95 ${a.recall_ms_p95} ms\n`
        : '  latence recall : pas encore mesurée\n',
    )
    if (a.recall_tokens_avg !== undefined) out.write(`  contexte injecté: ${a.recall_tokens_avg} tokens en moyenne\n`)
    if (a.capture_ms_avg !== undefined) out.write(`  latence capture: ${a.capture_ms_avg} ms en moyenne\n`)
  }

  // MOTEUR D'IA — juste avant les chiffres d'activité : sans moteur, tous les
  // compteurs qui suivent resteront à zéro, et il faut le dire AVANT, pas après.
  const engine = report.engine
  if (engine) {
    out.write('\nMoteur d’IA\n')
    if (!engine.configured) {
      out.write('  ✗ aucun moteur configuré — les conversations sont enregistrées, aucun souvenir n’en est extrait\n')
      out.write('    → ouvre « memoria ui » puis Réglages → Moteur d’intelligence\n')
    } else {
      out.write(`  extraction     : ${engine.extraction_provider}${engine.extraction_model ? ` · ${engine.extraction_model}` : ''}\n`)
      out.write(
        engine.embeddings_provider
          ? `  recherche sens : ${engine.embeddings_provider}${engine.embeddings_model ? ` · ${engine.embeddings_model}` : ''}\n`
          : '  recherche sens : aucune — recherche par mots-clés seule\n',
      )
    }
  }

  const cloud = report.cloud
  if (cloud) {
    out.write('\nDonnées envoyées au cloud (24 h)\n')
    if (cloud.sends_24h.length === 0) {
      // L'absence d'envoi EST l'information : sur une installation tout-local,
      // c'est la garantie que rien n'a quitté la machine.
      out.write('  aucun envoi — rien n’a quitté la machine\n')
    } else {
      for (const s of cloud.sends_24h) {
        const ko = s.failures > 0 ? `, ${s.failures} échec(s)` : ''
        out.write(`  ${s.provider}/${s.model} · ${s.purpose} : ${s.calls} appel(s), ${s.items} élément(s), ${formatBytes(s.chars)} de texte${ko}\n`)
      }
      out.write(`  total          : ${formatBytes(cloud.chars_24h)}${cloud.last_send_at ? ` — dernier ${shortTs(cloud.last_send_at)}` : ''}\n`)
    }
  }

  const usage = report.usage
  if (usage) {
    out.write('\nConsommation des modèles (24 h)\n')
    if (usage.rows.length === 0) {
      out.write('  aucun appel à un modèle\n')
    } else {
      for (const r of usage.rows) {
        const tokens =
          r.input_tokens === null && r.output_tokens === null
            ? 'tokens non mesurés'
            : `${fmtInt(r.input_tokens ?? 0)} tokens entrés · ${fmtInt(r.output_tokens ?? 0)} sortis`
        const cost = r.local
          ? 'local, 0 $'
          : r.estimated_cost_usd === null
            ? 'tarif inconnu'
            : `≈ ${fmtUsd(r.estimated_cost_usd)}`
        const ko = r.failures > 0 ? `, ${r.failures} échec(s)` : ''
        out.write(`  ${r.provider}/${r.model} · ${r.purpose} : ${r.calls} appel(s)${ko}, ${tokens} — ${cost}\n`)
      }
      const t = usage.totals
      const total = t.estimated_cost_usd === null ? 'coût non estimable' : `≈ ${fmtUsd(t.estimated_cost_usd)}`
      const unmetered = t.unmetered_calls > 0 ? ` — ${t.unmetered_calls} appel(s) sans mesure de tokens` : ''
      out.write(`  total          : ${total} (estimation, tarifs ${usage.pricing_as_of})${unmetered}\n`)
    }
  }

  if (report.warnings.length > 0) {
    out.write('\nAvertissements :\n')
    for (const warning of report.warnings) out.write(`  ⚠ ${warning}\n`)
  }
  out.write('\n')
  if (paused) {
    // Jamais « ✓ OK » en pause : les agents ne lisent ni n'écrivent rien.
    out.write(`État : ⏸ en pause (${report.warnings.length} avertissement(s)) — « memoria enable » pour reprendre\n`)
  } else {
    out.write(report.ok ? 'État : ✓ OK\n' : `État : ⚠ ${report.warnings.length} avertissement(s)\n`)
  }
}

/** `2026-07-28T14:31:02.123Z` → `28/07 14:31` (lisible en une ligne de terminal). */
function shortTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function relativeOrAbsolute(root: string, path: string): string {
  const rel = relative(root, path)
  return rel === '' || rel.startsWith('..') ? path : rel
}

/** Entier lisible (séparateurs de milliers). */
function fmtInt(n: number): string {
  return n.toLocaleString('fr-FR')
}

/** Coût estimé en dollars : « < 0,0001 $ » plutôt qu'un faux « 0,0000 $ ». */
function fmtUsd(v: number): string {
  if (v === 0) return '0 $'
  if (v < 0.0001) return '< 0,0001 $'
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 0.01 ? 4 : 2 })} $`
}
