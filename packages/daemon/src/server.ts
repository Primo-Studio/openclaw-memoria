/**
 * Daemon local unique (spec §2.2) — UN processus détient les DB ;
 * MCP/CLI/UI sont des clients HTTP sur 127.0.0.1.
 *
 * Auth à trois niveaux :
 *  - aucun : /v1/health, /v1/pairing/complete (le code one-shot TTL EST le secret) ;
 *  - Bearer <admin_token> (daemon.json chmod 600) : /v1/admin/* — réservé à
 *    l'utilisateur local (CLI, UI web) ;
 *  - Bearer <instance_token> (issu du pairing) : /v1/memory/* — les agents.
 *
 * Écritures sérialisées de fait : better-sqlite3 est synchrone sur l'unique
 * thread Node → zéro contention inter-process par construction.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  AUTOSTART_LABEL,
  Memoria,
  RegexRedactor,
  autoRegister,
  autostartStatus,
  collectTranscriptFiles,
  copyOpenClawKey,
  defaultStorageRoot,
  writeProviderKey,
  detectAgents,
  disableAutostart,
  enableAutostart,
  newToken,
  nowISO,
  resolveStorageRoot,
  saveCredentials,
  serveInvocation,
  type AssistantType,
  type AutostartSpec,
  type AutostartStatus,
  type CaptureMode,
  type CaptureTurnInput,
  type ForgetFilter,
  type MemoriaInitOptions,
  type RecallInput,
  type RegisterOptions,
  type RegisterResult,
  type ReusableProvider,
  type StoreFactInput,
} from '@memoria/core'
import { OllamaPullJob } from './ollama-pull.js'
import { ImportJobRunner } from './import-job.js'
import { currentVersion, lastBuiltSha, pullAndBuild, repoRoot, scheduleAutostartHandover, scheduleRestart } from './update.js'
import { findUiDist, serveUi } from './static.js'
import { acquireLock, clearDaemonState, lockHolderPid, writeDaemonState, type DaemonState } from './state.js'

export const DAEMON_VERSION = '0.1.0'

export interface DaemonOptions {
  storageRoot?: string
  configPath?: string
  /** Port d'écoute ; 0 = éphémère (persisté dans daemon.json). */
  port?: number
  /** Dossier dist de l'UI web (défaut : auto-détection @memoria/web/dist). */
  uiDist?: string
  /** URL du serveur Ollama (santé LLM + téléchargements) — injectable pour les tests. */
  ollamaBaseUrl?: string
  /** HOME inspecté par la détection d'agents et la collecte de transcripts (tests : tmpdir). */
  agentsHome?: string
  /** Sonde de présence d'un CLI (tests : jamais les vrais binaires). */
  checkCli?: (bin: string) => boolean
  /** Enregistrement MCP auprès de l'hôte (tests : stub — jamais le vrai ~/.claude.json). */
  registrar?: (host: string, instanceId: string, opts: RegisterOptions) => RegisterResult
  /** Dossier des credentials d'instance (tests : tmpdir, jamais ~/.memoria). */
  credentialsDir?: string
  /** Override LLM transmis au moteur (tests : extraction mockée, zéro réseau). */
  llm?: MemoriaInitOptions['llm']
  /** Coffre à secrets injecté (tests : simuler un Trousseau qui refuse — jamais le vrai). */
  secretProvider?: MemoriaInitOptions['secretProvider']
  /** Lancement auto / superviseur (tests : launchd simulé — jamais de launchctl réel). */
  control?: Partial<DaemonControlHooks>
  /** Mise à jour (tests : ni git pull, ni npm, ni redémarrage réels). */
  updater?: Partial<DaemonUpdaterHooks>
}

/** Mise à jour de l'installation — injectable pour tester les routes sans toucher au dépôt. */
export interface DaemonUpdaterHooks {
  currentVersion: typeof currentVersion
  pullAndBuild: typeof pullAndBuild
  scheduleRestart: typeof scheduleRestart
}

/**
 * Ce que le daemon sait faire du lancement auto. Tout est injectable : la
 * route admin ne doit jamais toucher le vrai launchctl dans un test.
 */
export interface DaemonControlHooks {
  /** Ce process est-il celui du service launchd ? (XPC_SERVICE_NAME posé par launchd) */
  isSupervised(): boolean
  autostartStatus(): AutostartStatus
  enableAutostart(spec: AutostartSpec): AutostartStatus
  disableAutostart(): AutostartStatus
  /** Passe la main à `memoria autostart on|off` (détaché) après la réponse ; lève si impossible. */
  handoverAutostart(mode: 'on' | 'off', storageRoot: string, configPath: string): void
}

export interface RunningDaemon {
  state: DaemonState
  memoria: Memoria
  close: () => Promise<void>
}

/** Un autre daemon VIVANT tient daemon.lock pour ce stockage. Typée : le service launchd la reconnaît pour attendre au lieu de boucler. */
export class DaemonLockHeldError extends Error {
  constructor(
    readonly storageRoot: string,
    readonly holderPid: number | null,
  ) {
    super(`un daemon Memoria tourne déjà pour ${storageRoot} (daemon.lock${holderPid ? `, pid ${holderPid}` : ''})`)
    this.name = 'DaemonLockHeldError'
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  // Le verrou AVANT l'ouverture des DB : un second daemon qui perd la course ne
  // doit jamais avoir touché SQLite (ni rejoué le WAL) — Memoria.init ouvre les
  // bases et le perdant les refermait après coup, fenêtre pendant laquelle deux
  // processus écrivaient la même mémoire.
  const { storageRoot, configPath } = resolveStorageRoot({ storageRoot: opts.storageRoot, configPath: opts.configPath })
  mkdirSync(storageRoot, { recursive: true })
  const release = acquireLock(storageRoot)
  if (!release) throw new DaemonLockHeldError(storageRoot, lockHolderPid(storageRoot))
  let memoria: Memoria
  try {
    memoria = Memoria.init({ storageRoot, configPath: opts.configPath, llm: opts.llm, secretProvider: opts.secretProvider })
  } catch (err) {
    release()
    throw err
  }
  const importJobs = new ImportJobRunner(memoria, join(storageRoot, 'import-status.json'))

  const adminToken = newToken()
  const daemonId = newToken().slice(0, 16)
  const startedAt = nowISO()
  const control: DaemonControlHooks = {
    // launchd pose XPC_SERVICE_NAME sur ses agents (visible dans
    // `launchctl print … environment`) : c'est ce qui dit « je SUIS le service ».
    isSupervised: () => process.env['XPC_SERVICE_NAME'] === AUTOSTART_LABEL,
    autostartStatus: () => autostartStatus(),
    enableAutostart,
    disableAutostart: () => disableAutostart(),
    handoverAutostart: scheduleAutostartHandover,
    ...opts.control,
  }
  const supervisor: 'launchd' | null = control.isSupervised() ? 'launchd' : null
  const updater: DaemonUpdaterHooks = { currentVersion, pullAndBuild, scheduleRestart, ...opts.updater }
  // Build réellement chargé : après une mise à jour, c'est le seul moyen de
  // vérifier que le daemon n'exécute pas encore l'ancien dist.
  const builtSha = lastBuiltSha(repoRoot())
  // Un seul téléchargement de modèle Ollama à la fois (progression en mémoire).
  const ollamaPull = new OllamaPullJob(opts.ollamaBaseUrl)

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => reportAndSend(req, res, err))
  })

  const uiDist = findUiDist(opts.uiDist)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`

    // Anti-DNS-rebinding : un site web malveillant peut résoudre un domaine vers
    // 127.0.0.1 et taper notre daemon. On n'accepte que les hôtes loopback.
    if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      res.writeHead(403).end()
      return
    }

    if (route === 'GET /v1/health') {
      // pid / superviseur / build : ce qu'il faut pour distinguer « un daemon
      // répond » de « LE daemon attendu répond » (launchd, dist à jour).
      sendJson(res, 200, {
        ok: true,
        version: DAEMON_VERSION,
        daemon_id: daemonId,
        ui: Boolean(uiDist),
        pid: process.pid,
        started_at: startedAt,
        supervisor,
        built_sha: builtSha,
        storage_root: storageRoot,
        config_path: configPath,
      })
      return
    }

    if (req.method === 'GET' && uiDist && serveUi(url.pathname, uiDist, res)) return

    if (route === 'POST /v1/pairing/complete') {
      const body = await readJson(req)
      const code = String(body['code'] ?? '')
      const done = memoria.completePairing(code)
      if (!done) throw new HttpError(401, 'code de pairing invalide ou expiré')
      sendJson(res, 200, done)
      return
    }

    const token = bearerToken(req)

    if (url.pathname.startsWith('/v1/admin/')) {
      if (!token || !timingSafeEqualStr(token, adminToken)) throw new HttpError(401, 'token admin requis')
      await handleAdmin(route, url, req, res)
      return
    }

    if (url.pathname.startsWith('/v1/memory/')) {
      if (!token) throw new HttpError(401, 'token d’instance requis')
      const instance = memoria.authenticate(token)
      if (!instance) throw new HttpError(401, 'token d’instance invalide ou révoqué')
      await handleMemory(route, req, res, instance.id)
      return
    }

    throw new HttpError(404, `route inconnue : ${route}`)
  }

  async function handleAdmin(route: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    switch (route) {
      case 'GET /v1/admin/facts': {
        const facts = memoria.browseFacts({
          instance: url.searchParams.get('instance') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
          limit: intParam(url, 'limit', { def: undefined, min: 1, max: 200 }),
        })
        sendJson(res, 200, { facts })
        return
      }
      case 'GET /v1/admin/search': {
        const q = url.searchParams.get('q') ?? ''
        const limit = intParam(url, 'limit', { def: 80, min: 1, max: 500 })
        sendJson(res, 200, { facts: memoria.globalSearch(q, limit) })
        return
      }
      case 'GET /v1/admin/review': {
        sendJson(res, 200, { items: memoria.listReview() })
        return
      }
      case 'POST /v1/admin/adopt_legacy': {
        const body = await readJson(req)
        const instanceId = String(body['instance'] ?? '')
        if (!instanceId) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, mapEngineErrors(() => memoria.adoptLegacyInto(instanceId, { reindex: body['reindex'] !== false })))
        return
      }
      case 'GET /v1/admin/scopes': {
        sendJson(res, 200, { scopes: memoria.listScopesWithAccess(), assistants: memoria.registry.listAssistants() })
        return
      }
      case 'POST /v1/admin/share': {
        const body = await readJson(req)
        const factIds = stringArray(body['fact_ids'], 'fact_ids')
        const targetScope = String(body['target_scope'] ?? '')
        if (!targetScope) throw new HttpError(400, 'target_scope requis')
        // « scope cible inconnu » → 404, « partage interdit vers un scope privé » → 400.
        sendJson(res, 200, mapEngineErrors(() => memoria.shareFacts(factIds, targetScope)))
        return
      }
      case 'POST /v1/admin/policy': {
        const body = await readJson(req)
        const assistantId = String(body['assistant_id'] ?? '')
        const scopeId = String(body['scope_id'] ?? '')
        if (!assistantId || !scopeId) throw new HttpError(400, 'assistant_id et scope_id requis')
        // Existence vérifiée ICI : sinon la clé étrangère SQLite répondait
        // « FOREIGN KEY constraint failed » en 500, sans dire lequel manque.
        if (!memoria.registry.getAssistant(assistantId)) throw new HttpError(404, `assistant inconnu : ${assistantId}`)
        if (!memoria.registry.getScope(scopeId)) throw new HttpError(404, `scope inconnu : ${scopeId}`)
        memoria.setScopeAccess(assistantId, scopeId, body as Record<string, never>)
        sendJson(res, 200, { ok: true })
        return
      }
      case 'GET /v1/admin/identity_candidates': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { candidates: memoria.suggestIdentityFacts(instance) })
        return
      }
      case 'GET /v1/admin/topics': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        const minFacts = intParam(url, 'min_facts', { def: 1, min: 1, max: 100_000 })
        sendJson(res, 200, { topics: memoria.listTopics(instance, minFacts) })
        return
      }
      case 'GET /v1/admin/topic_facts': {
        const instance = url.searchParams.get('instance')
        const topic = url.searchParams.get('topic')
        if (!instance || !topic) throw new HttpError(400, 'instance et topic requis')
        sendJson(res, 200, { facts: memoria.topicFacts(instance, topic) })
        return
      }
      case 'GET /v1/admin/topic_relations': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        const minFacts = intParam(url, 'min_facts', { def: 2, min: 1, max: 100_000 })
        sendJson(res, 200, memoria.topicRelations(instance, minFacts))
        return
      }
      case 'GET /v1/admin/patterns': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        // détection à la demande (puis liste des propositions)
        memoria.detectPatterns(instance)
        sendJson(res, 200, { patterns: memoria.listPatterns(instance) })
        return
      }
      case 'POST /v1/admin/pattern_decision': {
        const body = await readJson(req)
        const instance = String(body['instance'] ?? '')
        const id = String(body['id'] ?? '')
        const decision = body['decision'] === 'accept' ? 'accept' : 'dismiss'
        if (!instance || !id) throw new HttpError(400, 'instance et id requis')
        sendJson(res, 200, memoria.decidePattern(instance, id, decision))
        return
      }
      case 'GET /v1/admin/procedures': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { procedures: memoria.listProcedures(instance) })
        return
      }
      case 'GET /v1/admin/expertise': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { domains: memoria.topExpertise(instance) })
        return
      }
      case 'GET /v1/admin/clusters': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { clusters: memoria.listClusters(instance) })
        return
      }
      case 'GET /v1/admin/self_observations': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { observations: memoria.selfObservations(instance) })
        return
      }
      case 'POST /v1/admin/derive_self': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.deriveSelfObservations(String(body['instance'] ?? '')))
        return
      }
      case 'POST /v1/admin/dialectic': {
        const body = await readJson(req)
        const instance = String(body['instance'] ?? '')
        const question = String(body['question'] ?? '')
        if (!instance || !question) throw new HttpError(400, 'instance et question requis')
        sendJson(res, 200, await memoria.dialectic(instance, question))
        return
      }
      case 'GET /v1/admin/revisions': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { proposals: memoria.listRevisions(instance) })
        return
      }
      case 'POST /v1/admin/correct_fact': {
        // Équivalents ADMIN des opérations de maintenance : l'interface web
        // parle au daemon avec le token admin, pas avec un token d'instance.
        // L'instance est donc passée dans le corps, comme pour les autres
        // routes admin (propose_revisions, topics…).
        const body = await readJson(req)
        const instance = String(body['instance'] ?? '')
        const factId = String(body['fact_id'] ?? '')
        const content = String(body['content'] ?? '')
        if (!instance || !factId || !content.trim()) throw new HttpError(400, 'instance, fact_id et content requis')
        sendJson(res, 200, memoria.correctFact(instance, factId, content))
        return
      }
      case 'POST /v1/admin/merge_facts': {
        const body = await readJson(req)
        const instance = String(body['instance'] ?? '')
        const keep = String(body['keep_fact_id'] ?? '')
        const ids = body['merge_fact_ids']
        if (!instance || !keep || !Array.isArray(ids)) {
          throw new HttpError(400, 'instance, keep_fact_id et merge_fact_ids requis')
        }
        sendJson(res, 200, memoria.mergeFacts(instance, keep, ids.filter((v): v is string => typeof v === 'string')))
        return
      }
      case 'GET /v1/admin/never_used': {
        const instance = url.searchParams.get('instance') ?? ''
        if (!instance) throw new HttpError(400, 'paramètre instance requis')
        const limit = intParam(url, 'limit', { def: 100, min: 1, max: 1000 })
        sendJson(res, 200, { facts: memoria.neverUsedFacts(instance, limit) })
        return
      }
      case 'POST /v1/admin/propose_revisions': {
        const body = await readJson(req)
        sendJson(res, 200, await memoria.proposeRevisions(String(body['instance'] ?? '')))
        return
      }
      case 'POST /v1/admin/revision_decision': {
        const body = await readJson(req)
        const instance = String(body['instance'] ?? '')
        const id = String(body['id'] ?? '')
        const decision = body['decision'] === 'accept' ? 'accept' : 'dismiss'
        if (!instance || !id) throw new HttpError(400, 'instance et id requis')
        sendJson(res, 200, memoria.decideRevision(instance, id, decision))
        return
      }
      case 'GET /v1/admin/skill_proposals': {
        const instance = url.searchParams.get('instance')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, { skills: memoria.proposeSkills(instance) })
        return
      }
      case 'POST /v1/admin/review/approve': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.reviewDecision(stringArray(body['ids'], 'ids'), 'accepted'))
        return
      }
      case 'POST /v1/admin/review/reject': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.reviewDecision(stringArray(body['ids'], 'ids'), 'rejected'))
        return
      }
      case 'GET /v1/admin/providers': {
        sendJson(res, 200, await memoria.detectProviders())
        return
      }
      case 'GET /v1/admin/llm_profile': {
        sendJson(res, 200, memoria.getLlmProfile())
        return
      }
      case 'POST /v1/admin/llm_profile': {
        const body = await readJson(req)
        const profile = String(body['profile'] ?? '')
        if (!['100-local', 'local-plus-cloud', 'cloud'].includes(profile)) {
          throw new HttpError(400, `profil inconnu : ${profile}`)
        }
        memoria.setLlmProfile(profile)
        sendJson(res, 200, { profile })
        return
      }
      case 'POST /v1/admin/llm_extraction': {
        const body = await readJson(req)
        const provider = String(body['provider'] ?? '')
        if (!['ollama', 'lmstudio', 'anthropic', 'openai', 'openrouter'].includes(provider)) {
          throw new HttpError(400, `provider inconnu : ${provider}`)
        }
        memoria.setExtractionProvider(provider, body['model'] as string | undefined, body['base_url'] as string | undefined)
        sendJson(res, 200, { provider, model: body['model'] ?? null })
        return
      }
      case 'POST /v1/admin/llm_embeddings': {
        // Choix explicite du moteur de recherche sémantique. Deux fournisseurs
        // réels seulement : openai (clé API, le plus simple) ou ollama (local).
        const body = await readJson(req)
        const provider = String(body['provider'] ?? '')
        if (!['ollama', 'openai'].includes(provider)) {
          throw new HttpError(400, `provider d'embeddings inconnu : ${provider} (attendu : ollama|openai)`)
        }
        // `dimensions` : entier plausible ou rien. Les dimensions sont gravées
        // avec chaque vecteur — une chaîne « abc » était persistée telle quelle
        // dans config.toml puis envoyée à l'API (« une valeur fausse corrompt
        // la base », config.ts).
        let dimensions: number | undefined
        const rawDims = body['dimensions']
        if (rawDims !== undefined && rawDims !== null) {
          if (typeof rawDims !== 'number' || !Number.isInteger(rawDims) || rawDims < 64 || rawDims > 8192) {
            throw new HttpError(400, `dimensions doit être un entier entre 64 et 8192 (reçu : ${JSON.stringify(rawDims)}) — omets-le pour un modèle connu`)
          }
          dimensions = rawDims
        }
        memoria.setEmbeddingsProvider(
          provider,
          optionalString(body, 'model'),
          dimensions,
          optionalString(body, 'base_url'),
        )
        // Réindexation incrémentale en tâche de fond (ne bloque pas la réponse) :
        // seuls les faits sans vecteur pour le nouveau modèle sont ré-embqués.
        void memoria
          .indexEmbeddings()
          .catch((err: unknown) => console.warn(`[daemon] réindexation embeddings : ${(err as Error).message}`))
        sendJson(res, 200, { provider, model: body['model'] ?? null, pending: await memoria.embeddingsPending() })
        return
      }
      case 'GET /v1/admin/llm_usage': {
        // Consommation des modèles (appels, tokens, coût estimé) — tous
        // fournisseurs, locaux compris. ?period=24h|7d|30d|all (défaut 24h).
        const period = url.searchParams.get('period') ?? '24h'
        if (period !== '24h' && period !== '7d' && period !== '30d' && period !== 'all') {
          throw new HttpError(400, 'period invalide (attendu : 24h | 7d | 30d | all)')
        }
        sendJson(res, 200, memoria.llmUsage(period))
        return
      }
      case 'GET /v1/admin/machine_caps': {
        // Scan matériel : l'UI s'en sert pour proposer/déconseiller le local.
        sendJson(res, 200, memoria.machineCaps())
        return
      }
      case 'GET /v1/admin/llm_health': {
        // LA source de vérité anti-mort-silencieuse : moteurs effectifs +
        // raisons d'indisponibilité + WAL en attente + options détectées.
        sendJson(res, 200, await memoria.llmHealth({ ollamaBaseUrl: opts.ollamaBaseUrl }))
        return
      }
      case 'POST /v1/admin/ollama_pull': {
        const body = await readJson(req)
        const model = String(body['model'] ?? '').trim()
        if (!model) throw new HttpError(400, 'model requis')
        if (ollamaPull.status().running) {
          throw new HttpError(409, `un téléchargement est déjà en cours (${ollamaPull.status().model ?? '?'})`)
        }
        ollamaPull.start(model)
        sendJson(res, 200, { ok: true, model })
        return
      }
      case 'GET /v1/admin/ollama_pull_status': {
        sendJson(res, 200, ollamaPull.status())
        return
      }
      case 'POST /v1/admin/openclaw_copy_key': {
        // « Réutiliser ma config OpenClaw » : copie une clé API en clair vers
        // ~/.<provider>/api_key (chmod 600). La valeur n'apparaît JAMAIS ici.
        const body = await readJson(req)
        const provider = String(body['provider'] ?? '')
        if (!['openai', 'anthropic', 'openrouter'].includes(provider)) {
          throw new HttpError(400, `provider invalide : ${provider}`)
        }
        // Pas de clé en clair (OpenClaw en OAuth, ou pas d'OpenClaw) = cas
        // NOMINAL → 404 lisible par l'Onboarding, pas un 500. Le HOME inspecté
        // suit `agentsHome` (tests : jamais la vraie config OpenClaw).
        const copied = mapEngineErrors(() =>
          copyOpenClawKey(provider as ReusableProvider, opts.agentsHome ? { openclawDir: join(opts.agentsHome, '.openclaw') } : {}),
        )
        memoria.registry.audit({
          actor_type: 'user',
          actor_id: 'local',
          action: `openclaw_copy_key:${provider}`,
          target_id_hash: null,
          scope_id: null,
          reason: `depuis ${copied.from}`,
        })
        sendJson(res, 200, { ok: true, provider, key_file: copied.keyFile })
        return
      }
      case 'POST /v1/admin/provider_key': {
        // L'utilisateur colle sa clé API → écrite dans ~/.<provider>/api_key
        // (chmod 600). La valeur n'est JAMAIS loggée ni renvoyée.
        const body = await readJson(req)
        const provider = String(body['provider'] ?? '')
        const key = String(body['key'] ?? '')
        if (!['openai', 'anthropic', 'openrouter'].includes(provider)) {
          throw new HttpError(400, `provider invalide : ${provider}`)
        }
        if (key.trim() === '') throw new HttpError(400, 'clé vide')
        const written = writeProviderKey(provider as ReusableProvider, key)
        memoria.registry.audit({
          actor_type: 'user',
          actor_id: 'local',
          action: `provider_key:${provider}`,
          target_id_hash: null,
          scope_id: null,
          reason: 'clé saisie par l’utilisateur',
        })
        sendJson(res, 200, { ok: true, provider, key_file: written.keyFile })
        return
      }
      case 'GET /v1/admin/options': {
        sendJson(res, 200, { options: memoria.getOptions() })
        return
      }
      case 'POST /v1/admin/options': {
        const body = await readJson(req)
        const key = String(body['key'] ?? '')
        const enabled = body['enabled'] === true
        if (!key) throw new HttpError(400, 'key requise')
        await memoria.setOption(key, enabled)
        sendJson(res, 200, { options: memoria.getOptions() })
        return
      }
      case 'GET /v1/admin/capture_mode': {
        sendJson(res, 200, { mode: memoria.getCaptureMode() })
        return
      }
      case 'POST /v1/admin/capture_mode': {
        const body = await readJson(req)
        const mode = String(body['mode'] ?? '') as CaptureMode
        if (!['auto-private', 'review-first', 'incognito'].includes(mode)) {
          throw new HttpError(400, `mode de capture inconnu : ${mode}`)
        }
        memoria.setCaptureMode(mode)
        sendJson(res, 200, { mode })
        return
      }
      case 'POST /v1/admin/pair': {
        const body = await readJson(req)
        const result = memoria.pairAssistant({
          type: (body['type'] as never) ?? 'generic',
          display_name: body['display_name'] as string | undefined,
          machine: body['machine'] as string | undefined,
          profile: (body['profile'] as string | undefined) ?? null,
        })
        // Tant que @memoria/mcp n'est pas publié sur npm, la commande npx ne
        // marche pas : on la remplace par le binaire LOCAL s'il existe. Et la
        // commande vise CE stockage (--storage-root) quand il n'est pas celui
        // par défaut : sans lui, memoria-mcp résolvait ~/.memoria/config.toml →
        // autre daemon (ou un daemon neuf dans ~/.memoria/data) → « code de
        // pairing invalide ou expiré » alors que le code était bon ici.
        sendJson(res, 200, { ...result, command: connectCommand(result.pairing_code, storageRoot, result.command), storage_root: storageRoot })
        return
      }
      case 'POST /v1/admin/revoke': {
        // Avant : `ok:true` même pour un id vide ou inconnu (UPDATE sur 0 ligne)
        // — un client croyait avoir coupé un agent qui gardait son token.
        // `instance_id` accepté en alias : c'est le nom des autres routes admin.
        const body = await readJson(req)
        const instanceId = String(body['assistant_instance_id'] ?? body['instance_id'] ?? '')
        if (!instanceId) throw new HttpError(400, 'assistant_instance_id requis')
        if (!memoria.registry.getInstance(instanceId)) throw new HttpError(404, `instance inconnue : ${instanceId}`)
        memoria.revokeInstance(instanceId)
        sendJson(res, 200, { ok: true, revoked: true })
        return
      }
      case 'GET /v1/admin/agents': {
        sendJson(res, 200, { agents: memoria.listAgents() })
        return
      }
      case 'GET /v1/admin/persons': {
        sendJson(res, 200, { persons: memoria.listPersons() })
        return
      }
      case 'POST /v1/admin/person': {
        const body = await readJson(req)
        const displayName = String(body['display_name'] ?? '').trim()
        if (!displayName) throw new HttpError(400, 'display_name requis')
        sendJson(res, 200, {
          person: memoria.createPerson({
            display_name: displayName,
            relation: (body['relation'] as string | null) ?? null,
            notes: (body['notes'] as string | null) ?? null,
            org_id: (body['org_id'] as string | null) ?? null,
          }),
        })
        return
      }
      case 'POST /v1/admin/person_update': {
        const body = await readJson(req)
        const id = String(body['id'] ?? '')
        if (!id) throw new HttpError(400, 'id requis')
        const person = memoria.updatePerson(id, body as Record<string, never>)
        if (!person) throw new HttpError(404, 'personne inconnue')
        sendJson(res, 200, { person })
        return
      }
      case 'POST /v1/admin/person_delete': {
        const body = await readJson(req)
        sendJson(res, 200, { deleted: memoria.deletePerson(String(body['id'] ?? '')) })
        return
      }
      case 'POST /v1/admin/person_identifier': {
        const body = await readJson(req)
        const personId = String(body['person_id'] ?? '')
        const kind = String(body['kind'] ?? '') as 'phone' | 'email' | 'telegram' | 'whatsapp' | 'handle' | 'other'
        const value = String(body['value'] ?? '')
        if (!personId || !kind || !value) throw new HttpError(400, 'person_id, kind et value requis')
        if (!['phone', 'email', 'telegram', 'whatsapp', 'handle', 'other'].includes(kind)) throw new HttpError(400, `kind inconnu : ${kind}`)
        if (!memoria.getPerson(personId)) throw new HttpError(404, `personne inconnue : ${personId}`)
        sendJson(res, 200, {
          identifier: mapEngineErrors(() => memoria.addPersonIdentifier(personId, kind, value, (body['label'] as string | null) ?? null)),
        })
        return
      }
      case 'POST /v1/admin/person_identifier_delete': {
        const body = await readJson(req)
        sendJson(res, 200, { deleted: memoria.removePersonIdentifier(String(body['id'] ?? '')) })
        return
      }
      case 'POST /v1/admin/identify_interlocutor': {
        const body = await readJson(req)
        sendJson(res, 200, { match: memoria.identifyInterlocutor(body as Record<string, never>) })
        return
      }
      case 'GET /v1/admin/stats': {
        sendJson(res, 200, memoria.stats())
        return
      }
      case 'GET /v1/admin/overview': {
        sendJson(res, 200, { agents: memoria.agentOverview() })
        return
      }
      case 'GET /v1/admin/cognitive_stats': {
        sendJson(res, 200, { stats: memoria.cognitiveStats() })
        return
      }
      case 'GET /v1/admin/secrets': {
        sendJson(res, 200, { secrets: memoria.listSecrets() })
        return
      }
      case 'GET /v1/admin/shared_scopes': {
        sendJson(res, 200, { scopes: memoria.listSharedScopes() })
        return
      }
      case 'GET /v1/admin/scope_facts': {
        const scope = url.searchParams.get('scope')
        if (!scope) throw new HttpError(400, 'scope requis')
        sendJson(res, 200, { facts: memoria.scopeFacts(scope) })
        return
      }
      case 'POST /v1/admin/refine_topics': {
        const body = await readJson(req)
        const instance = String(body['instance'] ?? '')
        if (!instance) throw new HttpError(400, 'instance requise')
        sendJson(res, 200, await memoria.refineTopicLabels(instance))
        return
      }
      case 'GET /v1/admin/doctor': {
        sendJson(res, 200, memoria.doctor())
        return
      }
      case 'POST /v1/admin/forget': {
        // Corps validé (ids tableau de chaînes, booléens) puis gardes du moteur
        // (« filtre vide », « confirm_bulk requis ») en 400 lisibles par l'UI
        // Maintenance — plus de « erreur interne » ni de `ids.map is not a function`.
        const body = await readJson(req)
        const filter = forgetFilterFromBody(body)
        sendJson(res, 200, mapEngineErrors(() => memoria.forget(filter)))
        return
      }
      case 'GET /v1/admin/audit': {
        sendJson(res, 200, { entries: memoria.registry.auditTail(200) })
        return
      }
      case 'GET /v1/admin/control': {
        sendJson(res, 200, {
          enabled: memoria.isEnabled(),
          autostart: control.autostartStatus(),
          supervisor,
          storage: memoria.storageInfo(),
        })
        return
      }
      case 'POST /v1/admin/enabled': {
        // Booléen OBLIGATOIRE : `body.enabled === true` sinon false transformait un
        // `{}` ou un `{enabled:'true'}` en mise en pause persistée dans config.toml.
        const body = await readJson(req)
        const enabled = memoria.setEnabled(requireBoolean(body, 'enabled'))
        sendJson(res, 200, { enabled })
        return
      }
      case 'POST /v1/admin/autostart': {
        // JAMAIS de launchctl bootout/bootstrap depuis le process supervisé :
        // bootout = ordre à launchd de tuer CE daemon (bloqué dans execFileSync,
        // SIGKILL après 5 s, daemon.json/lock périmés, réponse jamais envoyée) ;
        // et depuis un daemon direct, bootstrap lance un second daemon qui
        // bute sur notre verrou. Dans ces deux cas on répond `handover: true`
        // puis la CLI détachée fait le travail proprement (arrêt, attente,
        // relance) — voir scheduleAutostartHandover.
        const body = await readJson(req)
        const enabled = requireBoolean(body, 'enabled')
        const supervised = control.isSupervised()
        if (enabled && supervised) {
          // Déjà sous launchd : idempotent, et recharger tuerait le daemon pour rien.
          sendJson(res, 200, { autostart: control.autostartStatus(), handover: false })
          return
        }
        if (!enabled && !supervised) {
          sendJson(res, 200, { autostart: control.disableAutostart(), handover: false })
          return
        }
        const mode = enabled ? 'on' : 'off'
        // Vérifié AVANT la réponse : une passation impossible doit se voir (500), pas se perdre.
        control.handoverAutostart(mode, storageRoot, configPath)
        sendJson(res, 200, { autostart: control.autostartStatus(), handover: true, mode })
        return
      }
      case 'POST /v1/admin/delete_agent': {
        const body = await readJson(req)
        const instanceId = String(body['assistant_instance_id'] ?? '')
        if (!instanceId) throw new HttpError(400, 'assistant_instance_id requis')
        sendJson(res, 200, memoria.deleteInstance(instanceId))
        return
      }
      // ------------------------------------- agents sur cette machine (B1/B2/B3)
      case 'GET /v1/admin/agents_detect': {
        sendJson(res, 200, {
          agents: detectAgents({
            home: opts.agentsHome,
            checkCli: opts.checkCli,
            agents: memoria.listAgents(),
          }),
        })
        return
      }
      case 'POST /v1/admin/agents_connect': {
        // Connexion 1 CLIC : pairing complet EN PROCESSUS (pairAssistant +
        // completePairing), credentials chmod 600, puis enregistrement MCP
        // automatique selon le type — l'équivalent serveur de mcp/connect.ts.
        const body = await readJson(req)
        const kind = String(body['kind'] ?? '')
        const allowedKinds = ['claude-code', 'codex', 'openclaw', 'cursor', 'generic']
        if (!allowedKinds.includes(kind)) {
          throw new HttpError(400, `type d'agent inconnu : « ${kind} » (attendu : ${allowedKinds.join(', ')})`)
        }
        const displayName = typeof body['name'] === 'string' && body['name'].trim().length > 0 ? body['name'].trim() : undefined
        const paired = memoria.pairAssistant({ type: kind as AssistantType, display_name: displayName })
        const done = memoria.completePairing(paired.pairing_code)
        if (!done) throw new HttpError(500, 'échange de pairing impossible — code interne rejeté (voir le journal du daemon)')

        const credentialsPath = saveCredentials(
          done.assistant_instance_id,
          {
            instance_token: done.instance_token,
            storage_root: storageRoot,
            created_at: nowISO(),
            assistant_type: kind,
          },
          opts.credentialsDir,
        )

        const registrar = opts.registrar ?? autoRegister
        let registration: RegisterResult
        try {
          registration = registrar(kind, done.assistant_instance_id, { token: done.instance_token, storageRoot })
        } catch (err) {
          // VISIBLE, jamais avalé : échec précis + repli manuel (commande serve).
          const inv = serveInvocation(done.assistant_instance_id)
          registration = {
            host: 'generic',
            registered: false,
            detail: `enregistrement automatique en échec : ${(err as Error).message}. Manuel : ${inv.command} ${inv.args.join(' ')}`,
          }
        }
        if (!registration.registered) {
          console.warn(`[memoria-daemon] agents_connect ${kind} : ${registration.detail}`)
        }
        sendJson(res, 200, {
          instance_id: done.assistant_instance_id,
          credentials_path: credentialsPath,
          registered: registration,
          restart_hint: registration.registered ? 'Redémarre ton agent pour activer Memoria.' : null,
        })
        return
      }
      case 'POST /v1/admin/import_start': {
        const body = await readJson(req)
        const instanceId = String(body['instance_id'] ?? '')
        const kind = String(body['kind'] ?? '')
        if (!instanceId) throw new HttpError(400, 'instance_id requis')
        if (kind !== 'transcripts' && kind !== 'legacy') {
          throw new HttpError(400, `kind inconnu : « ${kind} » (attendu : transcripts | legacy)`)
        }
        if (importJobs.running) {
          throw new HttpError(409, 'un import est déjà en cours — attends sa fin (GET /v1/admin/import_status)')
        }
        const agent = memoria.listAgents().find(a => a.instance.id === instanceId)
        if (!agent) throw new HttpError(404, `instance inconnue : ${instanceId}`)
        if (agent.instance.revoked_at !== null) {
          throw new HttpError(400, 'instance révoquée — reconnecte l’agent avant d’importer')
        }

        if (kind === 'legacy') {
          // Pas de LLM requis : l'import legacy copie des faits déjà extraits.
          const legacyPath = String(body['legacy_path'] ?? '')
          if (!legacyPath) {
            throw new HttpError(400, 'legacy_path requis pour un import legacy (chemin de la base memoria.db OpenClaw)')
          }
          if (!existsSync(legacyPath)) throw new HttpError(404, `base legacy introuvable : ${legacyPath}`)
          // GARDE-FOU : scope legacy_to_review UNIQUE — jamais 2 bases en même temps.
          const pending = memoria.legacyQuarantineCount()
          if (pending > 0) {
            throw new HttpError(
              409,
              `la quarantaine legacy contient déjà ${pending} souvenir(s) non adoptés — termine cette adoption d'abord (une seule base legacy à la fois)`,
            )
          }
          sendJson(res, 200, importJobs.startLegacy({ instanceId, legacyPath }))
          return
        }

        // kind === 'transcripts'
        if (agent.assistant_type === 'openclaw') {
          throw new HttpError(400, 'OpenClaw n’a pas de transcripts importables — utilise l’import de mémoire legacy (kind=legacy + legacy_path)')
        }
        if (agent.assistant_type !== 'claude-code' && agent.assistant_type !== 'codex') {
          throw new HttpError(400, `pas de transcripts connus pour le type « ${agent.assistant_type} » (supportés : claude-code, codex)`)
        }
        // L'extraction a besoin d'un LLM : pas de job qui tourne pour rien.
        if (!(await memoria.hasExtraction())) {
          throw new HttpError(422, 'Configure d’abord un moteur d’intelligence (Réglages) — l’import de conversations a besoin d’un LLM d’extraction.')
        }
        const files = collectTranscriptFiles(agent.assistant_type, opts.agentsHome)
        if (files.length === 0) {
          throw new HttpError(404, `aucune conversation trouvée pour ${agent.assistant_type} sur cette machine`)
        }
        const rawMax = body['max_windows_per_file']
        let maxWindowsPerFile: number | undefined
        if (rawMax !== undefined && rawMax !== null) {
          const n = Number(rawMax)
          if (!Number.isFinite(n) || n < 1) throw new HttpError(400, 'max_windows_per_file doit être un entier ≥ 1')
          maxWindowsPerFile = Math.floor(n)
        }
        sendJson(res, 200, importJobs.startTranscripts({ instanceId, files, maxWindowsPerFile }))
        return
      }
      case 'GET /v1/admin/import_status': {
        sendJson(res, 200, importJobs.current)
        return
      }
      // ----------------------------------------------------------- synchro inter-machines (admin)
      case 'GET /v1/admin/sync/status': {
        const cfg = memoria.resolved.config.sync ?? {}
        sendJson(res, 200, {
          enabled: cfg.enabled === true,
          role: memoria.sync.role,
          machine_id: memoria.sync.machineId,
          hub: cfg.hub ?? null,
          listen_lan: cfg.listen_lan ?? null,
          scopes: memoria.sync.syncScopes().map(s => ({ id: s.id, type: s.type, name: s.name })),
          peers: memoria.sync.peers(),
        })
        return
      }
      case 'POST /v1/admin/sync/init_hub': {
        const body = await readJson(req)
        const listenLan = String(body['listen_lan'] ?? '0.0.0.0:47600')
        memoria.configureSyncHub(listenLan, (body['scopes'] as string[] | undefined) ?? undefined)
        sendJson(res, 200, { role: 'hub', listen_lan: listenLan, machine_id: memoria.sync.machineId, restart_required: true })
        return
      }
      case 'POST /v1/admin/sync/invite': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.sync.invite((body['display_name'] as string | undefined) ?? undefined))
        return
      }
      case 'POST /v1/admin/sync/join': {
        const body = await readJson(req)
        const hub = String(body['hub'] ?? '').trim()
        const code = String(body['code'] ?? '').trim()
        if (!hub || !code) throw new HttpError(400, 'hub et code requis')
        if (!isHostPort(hub)) throw new HttpError(400, `hub invalide : « ${hub} » (hôte:port attendu, ex. 192.168.1.20:47600)`)
        // Le cas le plus courant (mauvaise IP/port, hub pas démarré, pare-feu)
        // remontait « fetch failed » en 500 avec une stack : ici 502 avec
        // l'adresse essayée et la piste ; code refusé → 400 (pas une panne).
        try {
          sendJson(res, 200, await memoria.sync.join({ hub, code }))
        } catch (err) {
          const message = (err as Error)?.message ?? String(err)
          if (isNetworkFailure(err)) {
            const cause = describeNetworkFailure(err)
            throw new HttpError(
              502,
              `hub injoignable à ${hub}${cause ? ` (${cause})` : ''} — vérifie l'adresse hôte:port du hub, qu'il est démarré en mode hub (« memoria sync init-hub ») et joignable sur le LAN (pare-feu)`,
            )
          }
          if (message.startsWith('pairing refusé par le hub')) {
            throw new HttpError(400, `${message} : code expiré, déjà utilisé ou erroné — génère-en un nouveau sur le hub (« memoria sync invite »)`)
          }
          if (message.startsWith('échec du descellement')) throw new HttpError(400, message)
          throw err
        }
        return
      }
      case 'POST /v1/admin/sync/now': {
        const r = await memoria.sync.syncAll()
        sendJson(res, 200, r)
        return
      }
      case 'GET /v1/admin/sync/peers': {
        sendJson(res, 200, { peers: memoria.sync.peers() })
        return
      }
      case 'POST /v1/admin/sync/revoke': {
        const body = await readJson(req)
        sendJson(res, 200, { revoked: memoria.registry.revokePeer(String(body['machine_id'] ?? '')) })
        return
      }
      case 'POST /v1/admin/sync/leave': {
        memoria.sync.leave()
        sendJson(res, 200, { ok: true })
        return
      }
      // ----------------------------------------------------------- mise à jour
      case 'GET /v1/admin/version': {
        sendJson(res, 200, { ...(await updater.currentVersion()), daemon: DAEMON_VERSION })
        return
      }
      case 'POST /v1/admin/update': {
        // Une mise à jour redémarre le daemon : un import en cours serait coupé net.
        if (importJobs.running) {
          throw new HttpError(409, 'un import est en cours — attends sa fin (GET /v1/admin/import_status) avant de mettre à jour')
        }
        const result = await updater.pullAndBuild()
        sendJson(res, 200, result)
        // Redémarrage planifié APRÈS l'envoi de la réponse, dès qu'un build a eu
        // lieu — `rebuilt` et non `changed` : un rattrapage de build sans
        // nouveauté git remplace bien le code sur le disque, il faut recharger.
        if (result.ok && result.rebuilt) {
          try {
            updater.scheduleRestart(storageRoot)
          } catch (err) {
            // La réponse est partie : une exception ici remonterait dans
            // reportAndSend, qui ne peut plus répondre. On la journalise avec
            // la consigne — le nouveau build est sur le disque mais pas chargé.
            console.error(`[memoria-daemon] mise à jour installée mais redémarrage NON planifié : ${(err as Error)?.message ?? err} — relance « memoria stop » puis « memoria start »`)
          }
        }
        return
      }
      default:
        throw new HttpError(404, `route admin inconnue : ${route}`)
    }
  }

  async function handleMemory(route: string, req: IncomingMessage, res: ServerResponse, instanceId: string): Promise<void> {
    // KILL-SWITCH (config.enabled = false) : Memoria est « en pause ». On reste
    // joignable (l'agent ne casse pas) mais on ne lit ni n'écrit AUCUNE mémoire.
    // Réponse no-op ANNONCÉE (disabled: true) — jamais un échec silencieux.
    if (!memoria.isEnabled()) {
      // TOUTES les routes mémoire, pas seulement les cinq « courantes » : pin,
      // correct, merge, expiry, identify_* tombaient en 404 « route mémoire
      // inconnue » — un agent (memoria_pin…) croyait la route cassée alors que
      // Memoria était simplement en pause.
      const paused = PAUSED_MEMORY_RESPONSES[route]
      if (!paused) throw new HttpError(404, `route mémoire inconnue : ${route}`)
      sendJson(res, 200, { ...paused, disabled: true })
      return
    }
    switch (route) {
      case 'POST /v1/memory/store_fact': {
        const body = await readJson(req)
        // Corps VALIDÉ champ par champ (400 explicite) — avant, `{}` faisait un
        // TypeError, une sensibilité hors enum cassait sur la contrainte CHECK
        // SQLite, `confidence: 42` était persisté tel quel : 500 « erreur
        // interne » pour des refus attendus. Les refus du moteur (policy, scope
        // inconnu) deviennent des codes HTTP parlants.
        // declareFact (pas storeFact) : le mode de capture s'applique — en
        // « Pause » rien n'est écrit et la réponse le DIT (skipped/paused).
        const input = storeFactInputFromBody(body)
        const result = mapEngineErrors(() => memoria.declareFact({ ...input, instance: instanceId }))
        if (result.skipped) {
          sendJson(res, 200, { fact: null, skipped: true, reason: result.reason, mode: result.mode })
          return
        }
        sendJson(res, 200, { fact: result.fact, mode: result.mode })
        return
      }
      case 'POST /v1/memory/recall': {
        const body = await readJson(req)
        // Hybride FTS+vectoriel quand un provider d'embeddings est disponible —
        // sinon strictement équivalent au recall FTS.
        const result = await memoria.recallSemantic({ ...recallInputFromBody(body), instance: instanceId })
        sendJson(res, 200, result)
        return
      }
      case 'POST /v1/memory/capture_turn': {
        const body = await readJson(req)
        const result = await memoria.captureTurn({
          instance: instanceId,
          messages: captureMessagesFromBody(body['messages']),
          active_context: body['active_context'] as CaptureTurnInput['active_context'],
        })
        sendJson(res, 200, result)
        return
      }
      case 'POST /v1/memory/correct': {
        const body = await readJson(req)
        const factId = String(body['fact_id'] ?? '')
        const content = String(body['content'] ?? '')
        if (!factId || !content.trim()) throw new HttpError(400, 'fact_id et content requis')
        // Refus de policy sur un fait PARTAGÉ → 403 (pas un 500 avec stack).
        sendJson(res, 200, mapEngineErrors(() => memoria.correctFact(instanceId, factId, content)))
        return
      }
      case 'POST /v1/memory/merge': {
        const body = await readJson(req)
        const keep = String(body['keep_fact_id'] ?? '')
        const ids = body['merge_fact_ids']
        if (!keep || !Array.isArray(ids)) throw new HttpError(400, 'keep_fact_id et merge_fact_ids requis')
        // « fusion impossible : le fait conservé … est absent » → 404 (mapEngineErrors).
        sendJson(res, 200, mapEngineErrors(() => memoria.mergeFacts(instanceId, keep, ids.filter((v): v is string => typeof v === 'string'))))
        return
      }
      case 'POST /v1/memory/pin': {
        const body = await readJson(req)
        const factId = String(body['fact_id'] ?? '')
        if (!factId) throw new HttpError(400, 'fact_id requis')
        if (typeof body['pinned'] !== 'boolean') throw new HttpError(400, 'pinned requis (booléen)')
        const pinned = body['pinned']
        const updated = mapEngineErrors(() => memoria.setPinned(instanceId, factId, pinned))
        // false = fait introuvable dans les scopes de cet agent : 404, pas un
        // « updated:false » que l'agent prenait pour un succès sans effet.
        if (!updated) throw new HttpError(404, `fait inconnu dans les scopes de cet agent : ${factId}`)
        sendJson(res, 200, { updated })
        return
      }
      case 'POST /v1/memory/expiry': {
        const body = await readJson(req)
        const factId = String(body['fact_id'] ?? '')
        if (!factId) throw new HttpError(400, 'fact_id requis')
        const raw = body['expires_at']
        const expires = raw === null || raw === undefined || raw === '' ? null : String(raw)
        // Validé ICI (400) : le moteur lève une Error plate qui finissait en
        // 500, et l'outil MCP envoyait le LLM vers « memoria doctor » pour une
        // simple faute d'argument.
        if (expires !== null && Number.isNaN(Date.parse(expires))) {
          throw new HttpError(400, `expires_at invalide : « ${expires} » (date ISO 8601 attendue, ex. 2026-12-31T00:00:00Z, ou null pour lever l'expiration)`)
        }
        const updated = mapEngineErrors(() => memoria.setExpiry(instanceId, factId, expires))
        if (!updated) throw new HttpError(404, `fait inconnu dans les scopes de cet agent : ${factId}`)
        sendJson(res, 200, { updated })
        return
      }
      case 'POST /v1/memory/capture_status': {
        // Suivi post-timeout : `capture_turn` rend des `wal_ids`, cette route dit
        // ce qu'ils sont devenus. Sans elle, un appelant dont la requête expire
        // ne sait pas si son tour a fini par être mémorisé.
        const body = await readJson(req)
        const ids = body['wal_ids']
        if (!Array.isArray(ids)) throw new HttpError(400, 'wal_ids requis (tableau d’entiers)')
        sendJson(res, 200, memoria.captureStatus(instanceId, ids.filter((v): v is number => typeof v === 'number')))
        return
      }
      case 'POST /v1/memory/feedback': {
        // BOUCLE DE FEEDBACK : l'agent dit si les souvenirs remontés au recall
        // ont RÉELLEMENT servi. `used:true` fait monter relevance_weight (cap
        // 2.0) et crédite l'expertise du domaine ; `used:false` atténue
        // doucement (plancher 0.3). Ne touche JAMAIS le contenu d'un fait :
        // pas de supersession, pas de suppression (règle d'or de la couche 7).
        const body = await readJson(req)
        const ids = body['fact_ids']
        if (!Array.isArray(ids) || ids.length === 0) {
          throw new HttpError(400, 'fact_ids requis (tableau d’identifiants de faits)')
        }
        if (typeof body['used'] !== 'boolean') {
          throw new HttpError(400, 'used requis (booléen) : true = a servi à répondre, false = remonté mais inutile')
        }
        const result = memoria.reinforceFacts(
          instanceId,
          ids.filter((v): v is string => typeof v === 'string'),
          body['used'],
        )
        sendJson(res, 200, result)
        return
      }
      case 'POST /v1/memory/identify_interlocutor': {
        // L'agent demande « à qui je parle ? » via un identifiant (Telegram/mail/tel…).
        const body = await readJson(req)
        // instanceId = la vue « known » est bornée aux scopes LISIBLES de l'agent
        // appelant (P0 27/08 : sans lui, un agent voyait les faits privés et
        // critiques de TOUS les autres). Les routes /v1/admin/* gardent la vue globale.
        sendJson(res, 200, { match: memoria.identifyInterlocutor(body as Record<string, never>, instanceId) })
        return
      }
      case 'POST /v1/memory/identify_or_create_interlocutor': {
        // Comme identify_interlocutor mais CRÉE la personne au 1er contact d'un
        // identifiant inconnu (auto-enregistrement WhatsApp/Telegram/…).
        const body = await readJson(req)
        sendJson(res, 200, { match: memoria.identifyOrCreateInterlocutor(body as Record<string, never>, instanceId) })
        return
      }
      default:
        throw new HttpError(404, `route mémoire inconnue : ${route}`)
    }
  }

  /**
   * Routes de SYNCHRO sur le LAN (SYNC §3.10). Seules ces routes sortent du
   * loopback, derrière peer_token + HMAC (sauf /pairing/complete : code TTL).
   * /v1/admin/* et /v1/memory/* ne sont JAMAIS servis ici.
   */
  async function handleSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://lan')
    if (!url.pathname.startsWith('/v1/sync/')) {
      res.writeHead(403).end()
      return
    }
    const method = req.method ?? 'GET'
    const pathWithQuery = url.pathname + url.search
    const body = await readRawBody(req)

    // Pairing : pas de Bearer (le code one-shot TTL EST le secret).
    if (method === 'POST' && url.pathname === '/v1/sync/pairing/complete') {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      const host = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      sendJson(res, 200, memoria.sync.completePairing({
        code: String(parsed['code'] ?? ''),
        machine_id: String(parsed['machine_id'] ?? ''),
        display_name: parsed['display_name'] as string | undefined,
        host: host || undefined,
      }))
      return
    }

    // Toutes les autres routes : authenticité HMAC + token de pair.
    try {
      memoria.sync.authenticate(
        bearerToken(req) ?? undefined,
        headerStr(req, 'x-memoria-sig'),
        { method, path: pathWithQuery, body, ts: headerStr(req, 'x-memoria-ts') ?? '', nonce: headerStr(req, 'x-memoria-nonce') ?? '' },
      )
    } catch (err) {
      sendJson(res, 401, { error: (err as Error).message })
      return
    }

    if (method === 'GET' && url.pathname === '/v1/sync/snapshot') {
      sendJson(res, 200, memoria.sync.snapshot(url.searchParams.get('scope') ?? '', url.searchParams.get('since') ?? undefined))
      return
    }
    if (method === 'GET' && url.pathname === '/v1/sync/pull') {
      sendJson(res, 200, memoria.sync.collectDelta(url.searchParams.get('scope') ?? '', url.searchParams.get('since') ?? '1970-01-01T00:00:00.000Z'))
      return
    }
    if (method === 'POST' && url.pathname === '/v1/sync/push') {
      const b = JSON.parse(body) as { scope_id: string; facts: never[]; tombstones: never[] }
      sendJson(res, 200, memoria.sync.applyIncoming(b.scope_id, b.facts ?? [], b.tombstones ?? []))
      return
    }
    if (method === 'GET' && url.pathname === '/v1/sync/secrets') {
      const secrets = memoria.sync.serveSecrets(url.searchParams.get('scope') ?? '').map(s => ({ name: s.name, env: s.env }))
      sendJson(res, 200, { secrets })
      return
    }
    throw new HttpError(404, `route sync inconnue : ${method} ${url.pathname}`)
  }

  let port: number
  try {
    port = await new Promise<number>((resolvePort, reject) => {
      server.once('error', reject)
      server.listen(opts.port ?? 0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolvePort(addr.port)
        else reject(new Error('adresse d’écoute illisible'))
      })
    })
  } catch (err) {
    release()
    memoria.close()
    throw err
  }

  const state: DaemonState = {
    daemon_id: daemonId,
    port,
    admin_token: adminToken,
    pid: process.pid,
    started_at: startedAt,
  }
  writeDaemonState(storageRoot, state)

  // ---- SYNCHRO INTER-MACHINES (SYNC §3.10) -------------------------------
  // (a) HUB : second listener sur le LAN, routes /v1/sync/* uniquement.
  const syncCfg = memoria.resolved.config.sync
  let lanServer: Server | null = null
  let syncTimer: ReturnType<typeof setInterval> | null = null
  if (syncCfg?.enabled && syncCfg.role === 'hub' && syncCfg.listen_lan) {
    const [lanHost, lanPortStr] = parseHostPort(syncCfg.listen_lan)
    lanServer = createServer((req, res) => {
      void handleSync(req, res).catch((err: unknown) => reportAndSend(req, res, err))
    })
    lanServer.on('error', e => console.warn('[memoria-daemon] listener LAN sync en échec :', (e as Error).message))
    lanServer.listen(lanPortStr, lanHost, () => console.log(`[memoria-daemon] synchro HUB à l'écoute sur ${lanHost}:${lanPortStr} (/v1/sync/*)`))
  }
  // (b) SPOKE : passe de synchro best-effort, au boot puis périodiquement.
  if (syncCfg?.enabled && syncCfg.role === 'spoke') {
    const intervalMs = Math.max(30, syncCfg.interval_sec ?? 120) * 1000
    const runTick = (): void => {
      void memoria.sync.tick().then(r => {
        if (r && (r.pulled > 0 || r.pushed > 0)) console.log(`[memoria-daemon] synchro : ${r.pulled} reçus, ${r.pushed} poussés`)
      }).catch(() => {})
    }
    syncTimer = setInterval(runTick, intervalMs)
    setTimeout(runTick, 2000) // 1re passe peu après le boot (laisse replayWal démarrer)
  }

  // Rejeu du WAL au boot (spec §6.2) : best-effort, jamais bloquant pour le
  // démarrage — sans LLM dispo les entrées restent pending (visibles au doctor).
  void memoria
    .replayWal()
    .then(replayed => {
      const totals = replayed.reduce(
        (acc, r) => ({ processed: acc.processed + r.summary.processed, facts: acc.facts + r.summary.facts_created }),
        { processed: 0, facts: 0 },
      )
      if (totals.processed > 0) {
        console.log(`[memoria-daemon] WAL rejoué : ${totals.processed} entrées → ${totals.facts} faits`)
      }
      // rattrapage d'indexation vectorielle (faits jamais embedés)
      return memoria.indexEmbeddings()
    })
    .then(r => {
      if (r.indexed > 0) console.log(`[memoria-daemon] embeddings indexés : ${r.indexed}`)
      // options activées (couches opt-in qui tournent en auto)
      return memoria.runEnabledOptions()
    })
    .then(o => {
      if (o.ran.length > 0) console.log(`[memoria-daemon] options auto exécutées : ${o.ran.join(', ')}`)
    })
    .catch((err: unknown) => console.warn('[memoria-daemon] rejeu/indexation au boot en échec :', (err as Error).message))

  const close = async (): Promise<void> => {
    if (syncTimer) clearInterval(syncTimer)
    if (lanServer) await new Promise<void>(r => lanServer!.close(() => r()))
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    // Un import en cours est ANNONCÉ interrompu (persisté) avant de fermer les
    // DB — sinon il mourait en « Memoria est fermé » dans un état perdu avec le
    // process. On lui laisse 2 s (launchd SIGKILL à 5 s) pour finir un fichier.
    if (importJobs.interrupt('arrêt du daemon')) await importJobs.settle(2_000)
    clearDaemonState(storageRoot)
    release()
    memoria.close()
  }

  return { state, memoria, close }
}

// ----------------------------------------------------------------- helpers

/** Valeur d'en-tête HTTP en string (jamais un tableau). */
function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** « hôte:port » plausible : hôte sans espace, port 1..65535 (IPv6 entre crochets accepté). */
function isHostPort(addr: string): boolean {
  const i = addr.lastIndexOf(':')
  if (i <= 0) return false
  const host = addr.slice(0, i)
  const port = Number(addr.slice(i + 1))
  return /^[^\s/]+$/.test(host) && Number.isInteger(port) && port >= 1 && port <= 65535
}

/** Erreur RÉSEAU de fetch (connexion refusée, hôte introuvable, délai) — pas une réponse HTTP. */
function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true
  const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code
  return typeof code === 'string' && /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN)$/.test(code)
}

/** Cause lisible d'une panne réseau (code système ou message de la cause). */
function describeNetworkFailure(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause
  return cause?.code ?? cause?.message ?? (err as Error)?.name ?? ''
}

/** « host:port » → [host, port]. host vide → 0.0.0.0. */
function parseHostPort(addr: string): [string, number] {
  const i = addr.lastIndexOf(':')
  if (i < 0) return ['0.0.0.0', Number.parseInt(addr, 10) || 47600]
  const host = addr.slice(0, i) || '0.0.0.0'
  const port = Number.parseInt(addr.slice(i + 1), 10) || 47600
  return [host, port]
}

/**
 * Commande de connexion à coller dans le chat de l'agent : binaire LOCAL
 * (`node <repo>/packages/mcp/dist/bin.js connect --code XXXX`, voisin du
 * daemon dans le monorepo) sinon la forme npx ; plus ` --storage-root <racine>`
 * dès que le stockage n'est pas ~/.memoria/data, pour que memoria-mcp parle
 * au BON daemon.
 */
function connectCommand(code: string, storageRoot: string, npxCommand: string): string {
  let base = npxCommand
  try {
    const binPath = fileURLToPath(new URL('../../mcp/dist/bin.js', import.meta.url))
    if (existsSync(binPath)) base = `${process.execPath} ${binPath} connect --code ${code}`
  } catch {
    /* paquet publié npm : forme npx conservée */
  }
  if (resolve(storageRoot) === resolve(defaultStorageRoot())) return base
  return `${base} --storage-root ${shellQuote(storageRoot)}`
}

/** Chemin cité pour un shell si nécessaire (espaces, caractères spéciaux). */
function shellQuote(p: string): string {
  return /^[A-Za-z0-9_./~:@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/** Hôte loopback uniquement (anti-DNS-rebinding). Absent = client non-HTTP/1.0 toléré. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/** Origin (si présent) doit être loopback — un site web tiers ne doit pas nous appeler. */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true // appels non-navigateur (CLI/MCP/agents) n'envoient pas d'Origin
  try {
    const h = new URL(origin).hostname.toLowerCase()
    return h === '127.0.0.1' || h === 'localhost' || h === '::1'
  } catch {
    return false
  }
}

/** Comparaison de tokens à temps constant (anti-timing-attack). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim()
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req)
  if (raw.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'JSON invalide')
  }
  // `JSON.parse('null')` est valide : sans cette garde, `body['code']` levait un
  // TypeError → 500 « Cannot read properties of null » au lieu d'un 400 net.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'objet JSON attendu dans le corps de la requête')
  }
  return parsed as Record<string, unknown>
}

/**
 * Réponses no-op de CHAQUE route mémoire quand Memoria est en pause : même
 * forme que la réponse normale (l'agent n'a rien à parser de spécial), plus
 * `disabled: true` ajouté par l'appelant. Une route absente d'ici = 404.
 */
const PAUSED_MEMORY_RESPONSES: Record<string, Record<string, unknown>> = {
  'POST /v1/memory/recall': { items: [] },
  'POST /v1/memory/store_fact': { fact: null },
  'POST /v1/memory/capture_turn': { captured: 0, facts: [] },
  'POST /v1/memory/feedback': { updated: [], domains: [] },
  'POST /v1/memory/capture_status': { entries: [], pending: 0, retrying: 0, done: 0, failed: 0 },
  'POST /v1/memory/correct': { replacement: null },
  'POST /v1/memory/merge': { merged: [] },
  'POST /v1/memory/pin': { updated: false },
  'POST /v1/memory/expiry': { updated: false },
  'POST /v1/memory/identify_interlocutor': { match: null },
  'POST /v1/memory/identify_or_create_interlocutor': { match: null },
}

/**
 * Corps de recall → RecallInput, sur LISTE BLANCHE. `...body` relayait tout,
 * dont `include_dormant` : un porteur de token d'instance lisait la quarantaine
 * (faits importés jamais validés) promise « invisible au recall jusqu'à
 * approbation ». Ces drapeaux internes restent réservés au moteur/admin.
 */
function recallInputFromBody(body: Record<string, unknown>): Omit<RecallInput, 'instance'> {
  const input: Omit<RecallInput, 'instance'> = { query: String(body['query'] ?? '') }
  if (typeof body['limit'] === 'number') input.limit = body['limit']
  if (typeof body['token_budget'] === 'number') input.token_budget = body['token_budget']
  if (typeof body['expand_graph'] === 'boolean') input.expand_graph = body['expand_graph']
  if (body['active_context'] && typeof body['active_context'] === 'object') {
    input.active_context = body['active_context'] as RecallInput['active_context']
  }
  return input
}

/**
 * Refus du MOTEUR → HTTP parlant. Le core lève des Error plates (pas de classe
 * dédiée) : on reconnaît ses préfixes. 403 quand la policy interdit, 404 quand
 * l'identifiant n'existe pas (scope, instance, personne, fait conservé d'une
 * fusion, clé OpenClaw absente), 400 quand l'argument est mauvais (date,
 * contenu vide, gardes de forget, partage vers un scope privé). Sans ce
 * mapping, un refus attendu devenait un 500 indiscernable d'une panne, avec sa
 * stack dans le journal — et l'outil MCP envoyait le LLM vers « memoria
 * doctor », qui répondait que tout allait bien.
 */
const ENGINE_ERROR_STATUS: ReadonlyArray<readonly [prefix: string, status: number]> = [
  ['écriture refusée', 403],
  ['scope inconnu', 404],
  ['scope cible inconnu', 404],
  ['instance inconnue', 404],
  ['instance révoquée', 400],
  ['personne inconnue', 404],
  ['fusion impossible', 404],
  ["date d'expiration invalide", 400],
  ['storeFact : contenu vide', 400],
  ['contenu de correction vide', 400],
  ['forget : ', 400],
  ['partage interdit', 400],
  ['identifiant vide', 400],
  ['aucune clé API', 404],
  ["OpenClaw n'a qu'un compte OAuth", 404],
]

function mapEngineErrors<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof HttpError) throw err
    const message = (err as Error)?.message ?? ''
    for (const [prefix, status] of ENGINE_ERROR_STATUS) {
      if (message.startsWith(prefix)) throw new HttpError(status, message)
    }
    throw err
  }
}

/** Tableau de chaînes obligatoire (400 sinon) — `ids: 'x'` faisait un `ids.map is not a function` en 500. */
function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
    throw new HttpError(400, `${name} doit être un tableau de chaînes`)
  }
  return value
}

/** Chaîne optionnelle (400 si présente mais d'un autre type). */
function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new HttpError(400, `${name} doit être une chaîne`)
  return v
}

/** Booléen optionnel (400 si présent mais d'un autre type). */
function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const v = body[name]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new HttpError(400, `${name} doit être un booléen`)
  return v
}

const SENSITIVITIES = ['normal', 'sensitive', 'critical'] as const

/**
 * Corps de store_fact → StoreFactInput, sur LISTE BLANCHE et typé : `content`
 * chaîne non vide, `sensitivity` dans l'enum (la contrainte CHECK SQLite
 * répondait 500), `confidence` nombre dans [0,1] (42 était persisté tel quel),
 * `tags` tableau de chaînes.
 */
function storeFactInputFromBody(body: Record<string, unknown>): Omit<StoreFactInput, 'instance'> {
  const content = body['content']
  if (typeof content !== 'string' || content.trim() === '') {
    throw new HttpError(400, 'content requis (chaîne non vide) : le fait à mémoriser, en une phrase')
  }
  const input: Omit<StoreFactInput, 'instance'> = { content }
  const scope = optionalString(body, 'scope')
  if (scope !== undefined) input.scope = scope
  const category = optionalString(body, 'category')
  if (category !== undefined) input.category = category
  const factType = optionalString(body, 'fact_type')
  if (factType !== undefined) input.fact_type = factType
  const source = optionalString(body, 'source')
  if (source !== undefined) input.source = source
  if (body['confidence'] !== undefined && body['confidence'] !== null) {
    const c = body['confidence']
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
      throw new HttpError(400, `confidence doit être un nombre entre 0 et 1 (reçu : ${JSON.stringify(c)})`)
    }
    input.confidence = c
  }
  if (body['sensitivity'] !== undefined && body['sensitivity'] !== null) {
    const s = body['sensitivity']
    if (typeof s !== 'string' || !(SENSITIVITIES as readonly string[]).includes(s)) {
      throw new HttpError(400, `sensitivity invalide : ${JSON.stringify(s)} (attendu : ${SENSITIVITIES.join(' | ')})`)
    }
    input.sensitivity = s as (typeof SENSITIVITIES)[number]
  }
  if (body['tags'] !== undefined && body['tags'] !== null) input.tags = stringArray(body['tags'], 'tags')
  for (const key of ['org_id', 'client_org_id', 'project_id'] as const) {
    const v = body[key]
    if (v === undefined) continue
    if (v !== null && typeof v !== 'string') throw new HttpError(400, `${key} doit être une chaîne ou null`)
    input[key] = v
  }
  return input
}

const CAPTURE_ROLES = ['user', 'assistant', 'tool'] as const

/**
 * Messages de capture_turn validés UN PAR UN : un rôle hors user|assistant|tool
 * ou absent cassait sur la contrainte CHECK / NOT NULL du WAL (500). L'index
 * fautif est nommé pour que l'appelant sache quoi corriger.
 */
function captureMessagesFromBody(raw: unknown): CaptureTurnInput['messages'] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'messages requis (tableau {role, content})')
  return raw.map((m, i) => {
    const msg = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    const role = msg['role']
    if (typeof role !== 'string' || !(CAPTURE_ROLES as readonly string[]).includes(role)) {
      throw new HttpError(400, `messages[${i}].role invalide (attendu : ${CAPTURE_ROLES.join('|')}, reçu : ${JSON.stringify(role ?? null)})`)
    }
    const content = msg['content']
    if (typeof content !== 'string' || content.trim() === '') {
      throw new HttpError(400, `messages[${i}].content requis (chaîne non vide)`)
    }
    return { role: role as (typeof CAPTURE_ROLES)[number], content }
  })
}

/** Corps de forget → ForgetFilter typé (les gardes métier restent au moteur, mappées en 400). */
function forgetFilterFromBody(body: Record<string, unknown>): ForgetFilter {
  const filter: ForgetFilter = {}
  if (body['ids'] !== undefined && body['ids'] !== null) filter.ids = stringArray(body['ids'], 'ids')
  const scopeId = optionalString(body, 'scope_id')
  if (scopeId !== undefined) filter.scope_id = scopeId
  const query = optionalString(body, 'query')
  if (query !== undefined) filter.query = query
  const category = optionalString(body, 'category')
  if (category !== undefined) filter.category = category
  const confirmBulk = optionalBoolean(body, 'confirm_bulk')
  if (confirmBulk !== undefined) filter.confirm_bulk = confirmBulk
  const dryRun = optionalBoolean(body, 'dry_run')
  if (dryRun !== undefined) filter.dry_run = dryRun
  return filter
}

/** Champ booléen obligatoire du corps — `{}` ne vaut ni true ni false. */
function requireBoolean(body: Record<string, unknown>, name: string): boolean {
  const v = body[name]
  if (typeof v !== 'boolean') throw new HttpError(400, `${name} requis (booléen true|false)`)
  return v
}

/**
 * Paramètre d'URL entier borné. `Number('abc')` = NaN, que better-sqlite3
 * refuse en « datatype mismatch » (500) — l'utilisateur voyait « erreur »
 * sans raison. Ici : 400 avec le nom du paramètre et les bornes.
 */
function intParam<D extends number | undefined>(url: URL, name: string, opts: { def: D; min: number; max: number }): number | D {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return opts.def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new HttpError(400, `${name} doit être un entier entre ${opts.min} et ${opts.max} (reçu : ${raw})`)
  }
  return n
}

/**
 * Réponse d'erreur + JOURNAL des pannes internes. Un 500 sans trace était une
 * mort silencieuse : le client voyait « erreur », daemon.log restait vide et
 * `memoria doctor` n'avait rien à dire. Les HttpError (4xx attendus) ne sont
 * pas des pannes : pas de bruit dans les logs.
 */
function reportAndSend(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500
  // DÉFENSE EN PROFONDEUR : une erreur interne peut citer une commande, un
  // corps de requête, une réponse de provider… Tout ce qui ressemble à un
  // secret est masqué AVANT le journal et AVANT le client — la valeur d'un
  // secret ne sort jamais du daemon, quelle que soit la panne.
  const message = errorRedactor.redact((err as Error)?.message ?? 'erreur interne').text
  // Journalisé : toute exception NON attendue, et les HttpError 500 posées
  // sciemment (« voir le journal du daemon »). Un 502 expliqué (hub
  // injoignable) est une réponse, pas une panne : pas de stack pour ça.
  if (!(err instanceof HttpError) || status === 500) {
    const detail = errorRedactor.redact((err as Error)?.stack ?? message).text
    console.error(`[memoria-daemon] ${req.method ?? '?'} ${req.url ?? '?'} → ${status} : ${detail}`)
  }
  // Exception APRÈS l'envoi de la réponse (effet de bord post-réponse) :
  // writeHead lèverait ERR_HTTP_HEADERS_SENT depuis le .catch du handler →
  // rejet non géré → Node tue le daemon. On journalise et on coupe proprement.
  if (res.headersSent) {
    console.error(`[memoria-daemon] ${req.method ?? '?'} ${req.url ?? '?'} : erreur après la réponse (non transmise au client) : ${message}`)
    if (!res.writableEnded) res.end()
    return
  }
  sendJson(res, status, { error: message })
}

/** Redacteur des messages d'erreur (mêmes motifs que le gate secrets du moteur). */
const errorRedactor = new RegexRedactor()

/** Corps BRUT (string) — nécessaire au HMAC de synchro (sha256 du corps exact). */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 8_000_000) throw new HttpError(413, 'corps de requête trop grand')
    chunks.push(chunk as Buffer)
  }
  return chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export type { Server }
