/**
 * Job d'import ASYNCHRONE dans le daemon (mission B3) : le daemon est le seul
 * processus better-sqlite3 sur les DB → plus de conflit avec un script externe.
 *
 * Règles :
 *  - UN seul job à la fois (la route renvoie 409 sinon) ;
 *  - progression lisible à tout moment (GET /v1/admin/import_status, polling) ;
 *  - legacy : import TOUJOURS depuis un snapshot (better-sqlite3 backup → tmpdir),
 *    jamais la base vivante, puis adoptLegacyInto(instance, { reindex: true }) ;
 *  - aucune mort silencieuse : échec fatal → state 'error' + message précis ;
 *    erreurs non bloquantes (fenêtre/fichier) → status.errors, job 'done'.
 */
import DatabaseCtor from 'better-sqlite3'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatGptUnitsAsync,
  estimateExtractionCost,
  importLegacyDb,
  nowISO,
  readChatGptExport,
  type ChatGptStats,
  type ExtractionCost,
  type ExtractionEstimate,
  type Memoria,
} from '@memoria/core'

/** `interrupted` : le daemon s'est arrêté (stop, mise à jour, crash) pendant le job. */
export type ImportJobState = 'idle' | 'running' | 'done' | 'error' | 'interrupted'
export type ImportJobKind = 'transcripts' | 'legacy' | 'chatgpt'

/**
 * Bilan d'un import ChatGPT (dry-run ou réel) : ce que l'export contenait et
 * ce que l'extraction a coûté ou coûterait.
 */
export interface ChatGptImportSummary {
  dry_run: boolean
  /** Instance ChatGPT visée (null : dry-run avant tout import, rien n'est créé). */
  instance_id: string | null
  stats: ChatGptStats
  /** Fenêtres à extraire (dry-run) ou envoyées au LLM (import). */
  windows: number
  /** Fenêtres déjà extraites lors d'un import précédent. */
  windows_known: number
  /** Conversations déjà importées et inchangées. */
  conversations_unchanged: number
  /** Dry-run : jetons estimés (aucun appel LLM). */
  estimate: ExtractionEstimate | null
  /** Dry-run : coût estimé avec le modèle d'extraction configuré (null : aucun modèle configuré). */
  cost: ExtractionCost | null
  facts_extracted: number
  facts_quarantined: number
  facts_skipped_duplicates: number
  notes: string[]
}

export interface ImportJobProgress {
  files_done: number
  files_total: number
  facts_imported: number
}

export interface ImportJobStatus {
  state: ImportJobState
  kind: ImportJobKind | null
  instance_id: string | null
  progress: ImportJobProgress
  /** Erreur FATALE (state === 'error'). */
  error: string | null
  /** Erreurs non bloquantes consignées pendant le run (fichier/fenêtre en échec). */
  errors: string[]
  started_at: string | null
  finished_at: string | null
  /** Import ChatGPT : bilan (rempli à la fin du job). */
  summary?: ChatGptImportSummary | null
}

function idleStatus(): ImportJobStatus {
  return {
    state: 'idle',
    kind: null,
    instance_id: null,
    progress: { files_done: 0, files_total: 0, facts_imported: 0 },
    error: null,
    errors: [],
    started_at: null,
    finished_at: null,
  }
}

export class ImportJobRunner {
  private status: ImportJobStatus = idleStatus()
  /** Promesse du job en cours (résolue quoi qu'il arrive) — close() l'attend un peu. */
  private inFlight: Promise<void> | null = null

  /**
   * `statusPath` : le dernier statut est ÉCRIT SUR DISQUE à chaque étape.
   * Avant, l'état ne vivait qu'en mémoire : un stop / une mise à jour pendant
   * un import de 1 355 fichiers le coupait net, et au redémarrage
   * import_status répondait « idle » — l'utilisateur ne savait ni qu'il avait
   * été interrompu, ni où. Au boot, un statut `running` retrouvé sur disque
   * devient `interrupted`, avec la progression atteinte.
   */
  constructor(
    private readonly memoria: Memoria,
    private readonly statusPath?: string,
  ) {
    this.status = this.restore()
  }

  /** Copie défensive — le statut interne ne fuit jamais par référence. */
  get current(): ImportJobStatus {
    return {
      ...this.status,
      progress: { ...this.status.progress },
      errors: [...this.status.errors],
      ...(this.status.summary ? { summary: structuredClone(this.status.summary) } : {}),
    }
  }

  get running(): boolean {
    return this.status.state === 'running'
  }

  /** Import de transcripts (claude-code / codex). Le job part en arrière-plan. */
  startTranscripts(input: { instanceId: string; files: string[]; maxWindowsPerFile?: number }): ImportJobStatus {
    this.begin('transcripts', input.instanceId, input.files.length)
    this.inFlight = this.memoria
      .importTranscripts(input.instanceId, input.files, {
        maxWindowsPerFile: input.maxWindowsPerFile,
        onProgress: p => {
          if (!this.running) return // interrompu : on ne réécrit pas l'état final
          this.status.progress = { files_done: p.filesDone, files_total: p.filesTotal, facts_imported: p.factsImported }
          this.persist()
        },
      })
      .then(report => {
        if (!this.running) return
        this.status.errors = [...report.errors]
        this.finish({
          files_done: input.files.length,
          files_total: input.files.length,
          facts_imported: report.facts_quarantined,
        })
      })
      .catch((err: unknown) => this.fail(`import transcripts : ${(err as Error).message}`))
    return this.current
  }

  /**
   * Import de l'export ChatGPT (zip, dossier ou conversations.json). Lecture
   * en flux puis même chaîne que les transcripts, en arrière-plan. Dry-run :
   * aucun appel LLM, aucune écriture, aucune instance créée.
   */
  startChatGpt(input: { path: string; instanceId?: string; dryRun?: boolean; maxWindowsPerFile?: number }): ImportJobStatus {
    this.begin('chatgpt', input.instanceId ?? null, 0)
    this.inFlight = this.runChatGpt(input).catch((err: unknown) => this.fail(`import ChatGPT : ${(err as Error).message}`))
    return this.current
  }

  private async runChatGpt(input: { path: string; instanceId?: string; dryRun?: boolean; maxWindowsPerFile?: number }): Promise<void> {
    const dryRun = input.dryRun === true
    const read = await readChatGptExport(input.path)
    if (!this.running) return
    const units = await chatGptUnitsAsync(read.conversations)
    this.status.progress = { files_done: 0, files_total: units.length, facts_imported: 0 }
    this.persist()

    // Toujours la même instance ; créée au premier VRAI import seulement.
    let instanceId = input.instanceId ?? this.memoria.findChatGptInstance()
    if (!instanceId && !dryRun) instanceId = this.memoria.ensureChatGptInstance()
    this.status.instance_id = instanceId ?? null

    const report = await this.memoria.importChatGpt(instanceId ?? null, units, {
      dryRun,
      maxWindowsPerFile: input.maxWindowsPerFile,
      onProgress: p => {
        if (!this.running) return
        this.status.progress = { files_done: p.filesDone, files_total: p.filesTotal, facts_imported: p.factsImported }
        this.persist()
      },
    })
    if (!this.running) return
    const model = dryRun ? await this.memoria.extractionModel() : null
    const estimate = report.estimate ?? null
    this.status.summary = {
      dry_run: dryRun,
      instance_id: instanceId ?? null,
      stats: read.stats,
      windows: report.windows,
      windows_known: report.windows_skipped_known,
      conversations_unchanged: report.files_skipped_already_imported,
      estimate,
      cost: estimate && model ? estimateExtractionCost(estimate, model.provider, model.model) : null,
      facts_extracted: report.facts_extracted,
      facts_quarantined: report.facts_quarantined,
      facts_skipped_duplicates: report.facts_skipped_duplicates,
      // Les notes par conversation (« dry-run … ») noieraient le reste : on garde le général.
      notes: report.notes.filter(n => !n.startsWith('dry-run ') && !n.startsWith('déjà importé')).slice(0, 50),
    }
    this.status.errors = [...read.errors, ...report.errors]
    this.finish({ files_done: units.length, files_total: units.length, facts_imported: report.facts_quarantined })
  }

  /** Import d'une base legacy OpenClaw (snapshot → quarantaine → adoption). */
  startLegacy(input: { instanceId: string; legacyPath: string }): ImportJobStatus {
    this.begin('legacy', input.instanceId, 1)
    this.inFlight = this.runLegacy(input).catch((err: unknown) => this.fail(`import legacy : ${(err as Error).message}`))
    return this.current
  }

  /**
   * Arrêt du daemon pendant un job : on marque `interrupted` (persisté) au
   * lieu de laisser le job mourir en « Memoria est fermé » dans une mémoire
   * qui disparaît. Le travail déjà fait reste en base (chaque fichier est
   * committé) ; relancer l'import reprend là où il faut (idempotent).
   * Retourne true si un job tournait.
   */
  interrupt(reason: string): boolean {
    if (!this.running) return false
    const p = this.status.progress
    this.status.state = 'interrupted'
    this.status.error = `import interrompu (${reason}) après ${p.files_done}/${p.files_total} fichier(s), ${p.facts_imported} souvenir(s) — relance l'import pour continuer`
    this.status.finished_at = nowISO()
    this.persist()
    console.warn(`[memoria-daemon] ${this.status.error}`)
    return true
  }

  /** Attend (au plus `ms`) que le job en cours se termine — best-effort avant de fermer les DB. */
  async settle(ms: number): Promise<void> {
    if (!this.inFlight) return
    await Promise.race([this.inFlight, new Promise<void>(r => setTimeout(r, ms))])
  }

  private async runLegacy(input: { instanceId: string; legacyPath: string }): Promise<void> {
    // 1) SNAPSHOT dans un tmpdir : on n'importe JAMAIS la base vivante (un
    //    OpenClaw encore ouvert dessus ne casse rien), et la source reste intacte.
    const tmp = mkdtempSync(join(tmpdir(), 'memoria-import-legacy-'))
    const snapshot = join(tmp, 'legacy-snapshot.sqlite')
    try {
      const source = new DatabaseCtor(input.legacyPath, { readonly: true, fileMustExist: true })
      try {
        await source.backup(snapshot)
      } finally {
        source.close()
      }

      // 2) Import en quarantaine (pré-vol + backup + vérif/rollback inclus).
      const report = importLegacyDb({ legacyPath: snapshot, memoria: this.memoria })
      if (report.errors.length > 0) {
        this.fail(`import legacy interrompu : ${report.errors.join(' ; ')}`)
        return
      }

      // 3) Adoption immédiate dans la mémoire privée de l'instance (+ réindexation).
      const adopted = this.memoria.adoptLegacyInto(input.instanceId, { reindex: true })
      this.finish({ files_done: 1, files_total: 1, facts_imported: adopted.facts })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  private begin(kind: ImportJobKind, instanceId: string | null, filesTotal: number): void {
    if (this.status.state === 'running') {
      // défense en profondeur — la route vérifie déjà et renvoie 409
      throw new Error('un import est déjà en cours')
    }
    this.status = {
      state: 'running',
      kind,
      instance_id: instanceId,
      progress: { files_done: 0, files_total: filesTotal, facts_imported: 0 },
      error: null,
      errors: [],
      started_at: nowISO(),
      finished_at: null,
      summary: null,
    }
    this.persist()
  }

  private finish(progress: ImportJobProgress): void {
    this.status.progress = progress
    this.status.state = 'done'
    this.status.finished_at = nowISO()
    this.persist()
    console.log(
      `[memoria-daemon] import ${this.status.kind ?? '?'} terminé : ${progress.facts_imported} souvenir(s) ` +
        `(${progress.files_done}/${progress.files_total} fichier(s)${this.status.errors.length > 0 ? `, ${this.status.errors.length} erreur(s) non bloquante(s)` : ''})`,
    )
  }

  private fail(message: string): void {
    if (!this.running) return // déjà interrompu : l'erreur « Memoria est fermé » qui suit n'est pas la vraie cause
    this.status.state = 'error'
    this.status.error = message
    this.status.finished_at = nowISO()
    this.persist()
    console.warn(`[memoria-daemon] ${message}`)
  }

  /** Écriture atomique (tmp + rename) ; un disque en échec ne casse jamais le job. */
  private persist(): void {
    if (!this.statusPath) return
    try {
      const tmp = `${this.statusPath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.status, null, 2), 'utf8')
      renameSync(tmp, this.statusPath)
    } catch (err) {
      console.warn(`[memoria-daemon] statut d'import non persisté : ${(err as Error).message}`)
    }
  }

  /** Statut du daemon précédent ; `running` retrouvé = interrompu par un arrêt non annoncé (crash, SIGKILL). */
  private restore(): ImportJobStatus {
    if (!this.statusPath) return idleStatus()
    let saved: ImportJobStatus
    try {
      saved = JSON.parse(readFileSync(this.statusPath, 'utf8')) as ImportJobStatus
    } catch {
      return idleStatus()
    }
    if (saved.state === 'running') {
      const p = saved.progress
      saved.state = 'interrupted'
      saved.error = `import interrompu par l'arrêt du daemon après ${p.files_done}/${p.files_total} fichier(s), ${p.facts_imported} souvenir(s) — relance l'import pour continuer`
      saved.finished_at = saved.finished_at ?? nowISO()
      this.status = saved
      this.persist()
    }
    return saved
  }
}
