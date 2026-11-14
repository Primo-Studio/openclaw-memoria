/**
 * `memoria cognition catchup` : rattrapage de cognition. Relie au graphe
 * (entités, relations), aux thèmes et aux amas les souvenirs qui ne l'ont
 * jamais été : ceux d'avant la migration (marqués « backfill ») et ceux posés
 * par store_fact ou un partage sans capture derrière.
 *
 * Par défaut le rattrapage est HEURISTIQUE : aucun appel LLM, ni pendant ni
 * après. `--llm` demande l'extraction par le LLM (un appel par souvenir),
 * plafonnée par lancement.
 *
 * Daemon vivant : le travail tourne chez lui (route admin, retour immédiat)
 * et la commande suit l'avancement. Daemon arrêté : passage local direct,
 * annoncé. Daemon vivant mais muet (process ou verrou tenu) : refus, jamais de
 * second écrivain. `--cancel` arrête le rattrapage en cours chez le daemon.
 */
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import { Memoria } from '@memoria/core'
import { daemonLooksAlive, lockHolderPid, type CognitionCatchupState } from '@memoria/daemon'
import { fail, findAliveDaemon, resolveCommon } from '../index.js'

/** Refus du daemon (réponse HTTP en erreur) : à afficher tel quel, jamais à réessayer. */
class DaemonRefusal extends Error {}

/** Plafond local du mode LLM, le même que celui du daemon par défaut. */
const LOCAL_LLM_DEFAULT_MAX = 500

function summary(
  s: Pick<CognitionCatchupState, 'processed' | 'llm_facts' | 'errors' | 'clusters_rebuilt' | 'clusters_skipped' | 'capped'>,
): string {
  const lines = [
    `  Souvenirs reliés : ${s.processed}`,
    `  Passés par le LLM : ${s.llm_facts}`,
    `  Bases dont les amas ont été recalculés : ${s.clusters_rebuilt}`,
  ]
  if (s.clusters_skipped > 0) lines.push(`  Bases trop grosses pour recalculer les amas : ${s.clusters_skipped}`)
  if (s.errors > 0) lines.push(`  En échec (mis de côté) : ${s.errors}`)
  if (s.capped) lines.push('  Plafond atteint : relance la commande pour traiter la suite.')
  return lines.join('\n') + '\n'
}

export class CognitionCatchupCommand extends Command {
  static override paths = [['cognition', 'catchup']]
  static override usage = Command.Usage({
    description:
      'Relie au graphe, aux thèmes et aux amas les souvenirs jamais traités. Sans LLM par défaut ; --llm = un appel par souvenir.',
  })

  instance = Option.String('--instance', { description: 'Limiter aux bases lisibles par cette instance (défaut : toutes)' })
  llm = Option.Boolean('--llm', false, { description: 'Extraction par le LLM (un appel par souvenir, plafonné)' })
  maxFacts = Option.String('--max-facts', { description: 'Nombre maximal de souvenirs traités par ce lancement' })
  status = Option.Boolean('--status', false, { description: 'Afficher l’état du rattrapage du daemon, sans rien lancer' })
  cancel = Option.Boolean('--cancel', false, { description: 'Arrêter le rattrapage en cours chez le daemon (ce qui est traité le reste)' })
  noWait = Option.Boolean('--no-wait', false, { description: 'Lancer et rendre la main sans attendre la fin' })
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  /** Intervalle de suivi (tests : court). */
  pollIntervalMs = 1000
  /** Délai d'un appel au daemon (tests : court). */
  requestTimeoutMs = 10_000
  /**
   * Lectures d'état ratées D'AFFILÉE tolérées pendant le suivi. Un daemon
   * occupé (gros rattrapage, recalcul des amas) peut tarder à répondre : la
   * commande sortait en erreur alors que le travail se terminait normalement.
   * Au-delà, le daemon est considéré comme perdu.
   */
  maxPollFailures = 30

  override async execute(): Promise<number> {
    const out = this.context.stdout
    const opts = { storageRoot: this.storageRoot, configPath: this.config }
    try {
      let maxFacts: number | undefined
      if (this.maxFacts !== undefined) {
        maxFacts = Number(this.maxFacts)
        if (!Number.isInteger(maxFacts) || maxFacts < 1) {
          return fail(this.context.stderr, 'cognition catchup : --max-facts attend un entier ≥ 1')
        }
      }
      const daemon = await findAliveDaemon(opts)

      if (this.status) {
        if (!daemon) return fail(this.context.stderr, 'cognition catchup : daemon arrêté, aucun rattrapage en cours')
        const state = await this.request(daemon, 'GET')
        out.write(`Rattrapage de cognition : ${state.status} (${state.mode})\n`)
        if (state.status !== 'idle') out.write(`  Bases : ${state.dbs_done}/${state.dbs_total}\n` + summary(state))
        if (state.error) out.write(`  Erreur : ${state.error}\n`)
        return 0
      }

      if (this.cancel) {
        if (!daemon) return fail(this.context.stderr, 'cognition catchup : daemon arrêté, aucun rattrapage en cours')
        await this.request(daemon, 'DELETE')
        out.write('Annulation demandée : le rattrapage s’arrête après le souvenir en cours.\nSuivi : memoria cognition catchup --status\n')
        return 0
      }

      if (!daemon) {
        // /v1/health sans réponse en 2 s ne veut pas dire « arrêté » : un daemon
        // occupé (rappel lent, recalcul) se tait aussi. Un rattrapage local
        // ferait alors deux écrivains sur les mêmes bases, et paierait deux fois
        // le LLM pour les mêmes faits.
        const { storageRoot } = resolveCommon(opts)
        const pid = daemonLooksAlive(storageRoot)?.pid ?? lockHolderPid(storageRoot, { liveOnly: true })
        if (pid !== null) {
          return fail(
            this.context.stderr,
            `cognition catchup : le daemon tourne (pid ${pid}) mais ne répond pas. Rattrapage local refusé : deux processus écriraient les mêmes bases. Réessaie dans un moment, ou vérifie avec memoria doctor.`,
          )
        }
        out.write('⚠ note : daemon arrêté — rattrapage local direct\n')
        const memoria = Memoria.init({ storageRoot: opts.storageRoot, configPath: opts.configPath })
        try {
          const r = await memoria.processCognition(this.instance, {
            includeBackfill: true,
            llm: this.llm,
            // Mode LLM : jamais sans plafond, même si l'option est oubliée.
            ...(maxFacts !== undefined ? { maxFacts } : this.llm ? { maxFacts: LOCAL_LLM_DEFAULT_MAX } : {}),
          })
          out.write('✓ Rattrapage terminé.\n' + summary({ ...r, clusters_skipped: r.clusters_skipped ?? 0, capped: r.capped === true }))
          return r.errors > 0 ? 1 : 0
        } finally {
          memoria.close()
        }
      }

      let state = await this.request(daemon, 'POST', {
        ...(this.instance ? { instance: this.instance } : {}),
        llm: this.llm,
        ...(maxFacts !== undefined ? { max_facts: maxFacts } : {}),
      })
      out.write(`Rattrapage lancé (${state.mode === 'llm' ? `LLM, ${state.max_facts ?? '∞'} souvenirs au plus` : 'heuristique, sans LLM'}).\n`)
      if (this.noWait) {
        out.write('Suivi : memoria cognition catchup --status\n')
        return 0
      }
      let failures = 0
      while (state.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs))
        try {
          state = await this.request(daemon, 'GET')
          failures = 0
        } catch (err) {
          // Délai dépassé ou connexion ratée : le travail continue chez le
          // daemon, on réessaie au tour suivant au lieu d'abandonner le suivi.
          if (err instanceof DaemonRefusal || ++failures >= this.maxPollFailures) throw err
          if (failures === 1) out.write('  (le daemon tarde à répondre, le suivi continue)\n')
        }
      }
      if (state.status === 'error') return fail(this.context.stderr, `cognition catchup : ${state.error ?? 'échec'}`)
      if (state.status === 'cancelled') {
        out.write('Rattrapage annulé avant la fin.\n' + summary(state) + '  Relance la commande pour traiter la suite.\n')
        return 0
      }
      out.write('✓ Rattrapage terminé.\n' + summary(state))
      return state.errors > 0 ? 1 : 0
    } catch (err) {
      return fail(this.context.stderr, `cognition catchup : ${(err as Error).message}`)
    }
  }

  /** Appel de la route admin (le client du daemon n'a pas encore de méthode dédiée). */
  private async request(
    daemon: NonNullable<Awaited<ReturnType<typeof findAliveDaemon>>>,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<CognitionCatchupState> {
    const res = await fetch(`${daemon.client.baseUrl}/v1/admin/cognition_catchup`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.state.admin_token}` },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    const json = (await res.json()) as CognitionCatchupState
    // En erreur, le daemon répond { error: "message" }.
    if (!res.ok) throw new DaemonRefusal(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
    return json
  }
}
