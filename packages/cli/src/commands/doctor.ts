/**
 * `memoria doctor` — santé du stockage. Via HTTP admin si le daemon vit,
 * sinon lecture locale directe avec la note « daemon arrêté ».
 */
import { relative } from 'node:path'
import type { Writable } from 'node:stream'
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import type { DoctorReport } from '@memoria/core'
import { fail, findAliveDaemon, formatBytes, withLocalMemoria } from '../index.js'

export class DoctorCommand extends Command {
  static override paths = [['doctor']]
  static override usage = Command.Usage({
    description: 'Vérifie la santé du stockage Memoria (DB, garde réseau, WAL).',
  })

  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage (défaut : résolution standard)' })
  config = Option.String('--config', { description: 'Fichier de découverte (défaut : ~/.memoria/config.toml)' })

  override async execute(): Promise<number> {
    const opts = { storageRoot: this.storageRoot, configPath: this.config }
    try {
      const daemon = await findAliveDaemon(opts)
      let report: DoctorReport
      let note: string | null = null
      if (daemon) {
        report = (await daemon.client.doctor()) as DoctorReport
      } else {
        note = 'daemon arrêté — lecture locale directe'
        report = withLocalMemoria(opts, memoria => memoria.doctor())
      }
      renderDoctor(this.context.stdout, report, note)
      // Le rapport EST le livrable : avertissements ≠ échec de la commande.
      return 0
    } catch (err) {
      return fail(this.context.stderr, `doctor : ${(err as Error).message}`)
    }
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
