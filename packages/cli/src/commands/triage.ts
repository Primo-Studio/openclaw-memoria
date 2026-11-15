/**
 * `memoria triage run` / `memoria triage status` / `memoria triage cancel` :
 * tri des souvenirs (genre, auteur, date de la conversation, redites), sans
 * jamais rien valider ni effacer.
 *
 * Daemon vivant : le passage tourne chez lui (route admin
 * `/v1/admin/triage/run`, retour immédiat) et la commande suit l'avancement.
 * Daemon arrêté : passage local direct, annoncé. Daemon vivant mais muet :
 * refus, jamais de second écrivain. `--dry-run` estime le coût sans aucun
 * appel ; `--max-cost` fixe le plafond de dépense (arrêt net, défaut 5 $).
 */
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import { Memoria, TriageRefusedError, type TriageRunStatus } from '@memoria/core'
import { daemonLooksAlive, lockHolderPid } from '@memoria/daemon'
import { fail, findAliveDaemon, resolveCommon } from '../index.js'

/** Refus du daemon (réponse HTTP en erreur) : à afficher tel quel, jamais à réessayer. */
class DaemonRefusal extends Error {}

const STATE_LABEL: Record<TriageRunStatus['state'], string> = {
  idle: 'aucun tri lancé',
  running: 'en cours',
  done: 'terminé',
  cancelled: 'annulé',
  paused: 'arrêté par la pause de Memoria',
  budget: 'arrêté au plafond de dépense',
  error: 'arrêté sur erreur',
  interrupted: 'interrompu (arrêt du daemon)',
}

const usd = (x: number | null | undefined): string => (x === null || x === undefined ? 'inconnu' : `${x.toFixed(4)} $`)

export function triageSummary(s: TriageRunStatus): string {
  const lines = [`Tri des souvenirs : ${STATE_LABEL[s.state] ?? s.state}`]
  if (s.estimate) {
    const e = s.estimate
    lines.push(
      `  Souvenirs à trier : ${e.facts_pending} (dont ${e.facts_active} validés, ${e.facts_sensible} sensibles jamais envoyés)`,
      `  Envoyés au LLM au plus : ${e.llm_facts_max} en ${e.llm_calls_max} appels (${e.provider ?? 'aucun'}/${e.model ?? '-'})`,
      `  Vecteurs à calculer : ${e.facts_to_embed}`,
      `  Coût estimé : ${usd(e.cost_usd)} (LLM ${usd(e.llm_usd)}, vecteurs ${usd(e.embeddings_usd)}) ; plafond ${e.budget_usd} $${e.within_budget ? '' : ' : DÉPASSÉ, le passage s’arrêtera au plafond'}`,
    )
    return lines.join('\n') + '\n'
  }
  if (s.state === 'idle') return lines.join('\n') + '\n'
  lines.push(
    `  Bases : ${s.dbs_done}/${s.dbs_total}`,
    `  Souvenirs triés : ${s.facts_done} (classés par le LLM ${s.classified}, redites ${s.inherited}, sensibles ${s.sensible}, en échec ${s.failed})`,
    `  Dépense : ${usd(s.spent_usd)} sur ${s.budget_usd} $ (appels LLM ${s.llm_calls}, vecteurs ${s.embed_calls})`,
  )
  if (s.max_block_ms !== null) lines.push(`  Plus long blocage du daemon : ${s.max_block_ms} ms`)
  if (s.error) lines.push(`  Erreur : ${s.error}`)
  if (s.state === 'budget' || s.state === 'cancelled' || s.state === 'paused' || s.state === 'interrupted') {
    lines.push('  Relance « memoria triage run » pour continuer : le tri reprend où il s’est arrêté.')
  }
  return lines.join('\n') + '\n'
}

abstract class TriageBase extends Command {
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })
  /** Délai d'un appel au daemon (tests : court). */
  requestTimeoutMs = 10_000

  protected get common(): { storageRoot: string | undefined; configPath: string | undefined } {
    return { storageRoot: this.storageRoot, configPath: this.config }
  }

  /** Appel de la route admin (le client du daemon n'a pas de méthode dédiée ; packages/daemon n'est pas touché). */
  protected async request<T>(
    daemon: NonNullable<Awaited<ReturnType<typeof findAliveDaemon>>>,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${daemon.client.baseUrl}/v1/admin/triage/run`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.state.admin_token}` },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    const json = (await res.json()) as T & { error?: unknown }
    if (!res.ok) throw new DaemonRefusal(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
    return json
  }
}

export class TriageRunCommand extends TriageBase {
  static override paths = [['triage', 'run']]
  static override usage = Command.Usage({
    description: 'Trie les souvenirs (genre, auteur, date, redites) sans rien valider. --dry-run : coût estimé, aucun appel.',
  })

  dryRun = Option.Boolean('--dry-run', false, { description: 'Estimer le coût sans aucun appel ni écriture' })
  instance = Option.String('--instance', { description: 'Limiter aux bases lisibles par cette instance (défaut : toutes)' })
  maxCost = Option.String('--max-cost', { description: 'Plafond de dépense en dollars (défaut : config [triage] budget_usd, sinon 5)' })
  maxFacts = Option.String('--max-facts', { description: 'Nombre maximal de souvenirs triés par ce lancement' })
  noWait = Option.Boolean('--no-wait', false, { description: 'Lancer et rendre la main sans attendre la fin' })
  /** Intervalle de suivi (tests : court). */
  pollIntervalMs = 2000
  /** Lectures d'état ratées d'affilée tolérées pendant le suivi. */
  maxPollFailures = 30

  override async execute(): Promise<number> {
    const out = this.context.stdout
    let budgetUsd: number | undefined
    let maxFacts: number | undefined
    if (this.maxCost !== undefined) {
      budgetUsd = Number(this.maxCost)
      if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return fail(this.context.stderr, 'triage run : --max-cost attend un montant en dollars ≥ 0')
    }
    if (this.maxFacts !== undefined) {
      maxFacts = Number(this.maxFacts)
      if (!Number.isInteger(maxFacts) || maxFacts < 1) return fail(this.context.stderr, 'triage run : --max-facts attend un entier ≥ 1')
    }
    try {
      const daemon = await findAliveDaemon(this.common)
      if (!daemon) {
        const { storageRoot } = resolveCommon(this.common)
        const pid = daemonLooksAlive(storageRoot)?.pid ?? lockHolderPid(storageRoot, { liveOnly: true })
        if (pid !== null) {
          return fail(
            this.context.stderr,
            `triage run : le daemon tourne (pid ${pid}) mais ne répond pas. Tri local refusé : deux processus écriraient les mêmes bases. Réessaie dans un moment.`,
          )
        }
        out.write('⚠ note : daemon arrêté — tri local direct\n')
        const memoria = Memoria.init({ storageRoot: this.storageRoot, configPath: this.config })
        try {
          const s = await memoria.triage.run({
            dryRun: this.dryRun,
            ...(this.instance ? { instance: this.instance } : {}),
            ...(budgetUsd !== undefined ? { budgetUsd } : {}),
            ...(maxFacts !== undefined ? { maxFacts } : {}),
          })
          out.write(triageSummary(s))
          return s.state === 'error' ? 1 : 0
        } finally {
          memoria.close()
        }
      }

      let state = await this.request<TriageRunStatus>(daemon, 'POST', {
        dry_run: this.dryRun,
        ...(this.instance ? { instance: this.instance } : {}),
        ...(budgetUsd !== undefined ? { budget_usd: budgetUsd } : {}),
        ...(maxFacts !== undefined ? { max_facts: maxFacts } : {}),
      })
      if (this.dryRun) {
        out.write(triageSummary(state))
        return 0
      }
      out.write(`Tri lancé (plafond ${state.budget_usd} $).\n`)
      if (this.noWait) {
        out.write('Suivi : memoria triage status\n')
        return 0
      }
      let failures = 0
      while (state.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs))
        try {
          state = await this.request<TriageRunStatus>(daemon, 'GET')
          failures = 0
        } catch (err) {
          if (err instanceof DaemonRefusal || ++failures >= this.maxPollFailures) throw err
          if (failures === 1) out.write('  (le daemon tarde à répondre, le suivi continue)\n')
        }
      }
      out.write(triageSummary(state))
      return state.state === 'error' ? 1 : 0
    } catch (err) {
      if (err instanceof TriageRefusedError || err instanceof DaemonRefusal) return fail(this.context.stderr, `triage run : ${err.message}`)
      return fail(this.context.stderr, `triage run : ${(err as Error).message}`)
    }
  }
}

export class TriageStatusCommand extends TriageBase {
  static override paths = [['triage', 'status']]
  static override usage = Command.Usage({ description: 'État du tri des souvenirs (progression, dépense).' })

  override async execute(): Promise<number> {
    try {
      const daemon = await findAliveDaemon(this.common)
      if (!daemon) {
        // Lecture de l'état persisté (aucun tri ne tourne sans daemon, hors CLI locale).
        const { storageRoot } = resolveCommon(this.common)
        const pid = daemonLooksAlive(storageRoot)?.pid ?? lockHolderPid(storageRoot, { liveOnly: true })
        if (pid !== null) return fail(this.context.stderr, `triage status : le daemon tourne (pid ${pid}) mais ne répond pas`)
        this.context.stdout.write('⚠ note : daemon arrêté — dernier état enregistré\n')
        const memoria = Memoria.init({ storageRoot: this.storageRoot, configPath: this.config })
        try {
          this.context.stdout.write(triageSummary(memoria.triage.status()))
        } finally {
          memoria.close()
        }
        return 0
      }
      this.context.stdout.write(triageSummary(await this.request<TriageRunStatus>(daemon, 'GET')))
      return 0
    } catch (err) {
      return fail(this.context.stderr, `triage status : ${(err as Error).message}`)
    }
  }
}

export class TriageCancelCommand extends TriageBase {
  static override paths = [['triage', 'cancel']]
  static override usage = Command.Usage({ description: 'Arrête le tri en cours chez le daemon (ce qui est trié le reste).' })

  override async execute(): Promise<number> {
    try {
      const daemon = await findAliveDaemon(this.common)
      if (!daemon) return fail(this.context.stderr, 'triage cancel : daemon arrêté, aucun tri en cours')
      const r = await this.request<{ cancelled: boolean }>(daemon, 'DELETE')
      this.context.stdout.write(r.cancelled ? 'Annulation demandée : le tri s’arrête après le lot en cours.\n' : 'Aucun tri en cours.\n')
      return 0
    } catch (err) {
      return fail(this.context.stderr, `triage cancel : ${(err as Error).message}`)
    }
  }
}
