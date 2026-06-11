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
import { existsSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  Memoria,
  autostartStatus,
  disableAutostart,
  enableAutostart,
  newToken,
  nowISO,
  type CaptureMode,
  type CaptureTurnInput,
  type ForgetFilter,
  type RecallInput,
  type StoreFactInput,
} from '@memoria/core'
import { daemonBinPath } from './client.js'
import { findUiDist, serveUi } from './static.js'
import { acquireLock, clearDaemonState, writeDaemonState, type DaemonState } from './state.js'

export const DAEMON_VERSION = '0.1.0'

export interface DaemonOptions {
  storageRoot?: string
  configPath?: string
  /** Port d'écoute ; 0 = éphémère (persisté dans daemon.json). */
  port?: number
  /** Dossier dist de l'UI web (défaut : auto-détection @memoria/web/dist). */
  uiDist?: string
}

export interface RunningDaemon {
  state: DaemonState
  memoria: Memoria
  close: () => Promise<void>
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
  const memoria = Memoria.init({ storageRoot: opts.storageRoot, configPath: opts.configPath })
  const storageRoot = memoria.paths.root

  const release = acquireLock(storageRoot)
  if (!release) {
    memoria.close()
    throw new Error(`un daemon Memoria tourne déjà pour ${storageRoot} (daemon.lock)`)
  }

  const adminToken = newToken()
  const daemonId = newToken().slice(0, 16)

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      sendJson(res, status, { error: (err as Error).message ?? 'erreur interne' })
    })
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
      sendJson(res, 200, { ok: true, version: DAEMON_VERSION, daemon_id: daemonId, ui: Boolean(uiDist) })
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
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        })
        sendJson(res, 200, { facts })
        return
      }
      case 'GET /v1/admin/search': {
        const q = url.searchParams.get('q') ?? ''
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 80
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
        sendJson(res, 200, memoria.adoptLegacyInto(instanceId, { reindex: body['reindex'] !== false }))
        return
      }
      case 'GET /v1/admin/scopes': {
        sendJson(res, 200, { scopes: memoria.listScopesWithAccess(), assistants: memoria.registry.listAssistants() })
        return
      }
      case 'POST /v1/admin/share': {
        const body = await readJson(req)
        const factIds = (body['fact_ids'] as string[]) ?? []
        const targetScope = String(body['target_scope'] ?? '')
        if (!targetScope) throw new HttpError(400, 'target_scope requis')
        sendJson(res, 200, memoria.shareFacts(factIds, targetScope))
        return
      }
      case 'POST /v1/admin/policy': {
        const body = await readJson(req)
        const assistantId = String(body['assistant_id'] ?? '')
        const scopeId = String(body['scope_id'] ?? '')
        if (!assistantId || !scopeId) throw new HttpError(400, 'assistant_id et scope_id requis')
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
        const minFacts = url.searchParams.has('min_facts') ? Number(url.searchParams.get('min_facts')) : 1
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
        const minFacts = url.searchParams.has('min_facts') ? Number(url.searchParams.get('min_facts')) : 2
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
        sendJson(res, 200, memoria.reviewDecision((body['ids'] as string[]) ?? [], 'accepted'))
        return
      }
      case 'POST /v1/admin/review/reject': {
        const body = await readJson(req)
        sendJson(res, 200, memoria.reviewDecision((body['ids'] as string[]) ?? [], 'rejected'))
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
        if (!['ollama', 'anthropic', 'openai', 'openrouter'].includes(provider)) {
          throw new HttpError(400, `provider inconnu : ${provider}`)
        }
        memoria.setExtractionProvider(provider, body['model'] as string | undefined)
        sendJson(res, 200, { provider, model: body['model'] ?? null })
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
        // marche pas : on la remplace par le binaire LOCAL s'il existe.
        sendJson(res, 200, { ...result, command: localConnectCommand(result.pairing_code) ?? result.command })
        return
      }
      case 'POST /v1/admin/revoke': {
        const body = await readJson(req)
        memoria.revokeInstance(String(body['assistant_instance_id'] ?? ''))
        sendJson(res, 200, { ok: true })
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
        sendJson(res, 200, { identifier: memoria.addPersonIdentifier(personId, kind, value, (body['label'] as string | null) ?? null) })
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
        const body = await readJson(req)
        sendJson(res, 200, memoria.forget(body as ForgetFilter))
        return
      }
      case 'GET /v1/admin/audit': {
        sendJson(res, 200, { entries: memoria.registry.auditTail(200) })
        return
      }
      case 'GET /v1/admin/control': {
        sendJson(res, 200, {
          enabled: memoria.isEnabled(),
          autostart: autostartStatus(),
          storage: memoria.storageInfo(),
        })
        return
      }
      case 'POST /v1/admin/enabled': {
        const body = await readJson(req)
        const enabled = memoria.setEnabled(body['enabled'] === true)
        sendJson(res, 200, { enabled })
        return
      }
      case 'POST /v1/admin/autostart': {
        const body = await readJson(req)
        if (body['enabled'] === true) {
          const args = [process.execPath, daemonBinPath(), '--storage-root', storageRoot]
          sendJson(res, 200, { autostart: enableAutostart({ programArguments: args, workingDirectory: storageRoot }) })
        } else {
          sendJson(res, 200, { autostart: disableAutostart() })
        }
        return
      }
      case 'POST /v1/admin/delete_agent': {
        const body = await readJson(req)
        const instanceId = String(body['assistant_instance_id'] ?? '')
        if (!instanceId) throw new HttpError(400, 'assistant_instance_id requis')
        sendJson(res, 200, memoria.deleteInstance(instanceId))
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
      if (route === 'POST /v1/memory/recall') sendJson(res, 200, { items: [], disabled: true })
      else if (route === 'POST /v1/memory/store_fact') sendJson(res, 200, { fact: null, disabled: true })
      else if (route === 'POST /v1/memory/capture_turn') sendJson(res, 200, { captured: 0, facts: [], disabled: true })
      else throw new HttpError(404, `route mémoire inconnue : ${route}`)
      return
    }
    switch (route) {
      case 'POST /v1/memory/store_fact': {
        const body = await readJson(req)
        const fact = memoria.storeFact({ ...(body as Omit<StoreFactInput, 'instance'>), instance: instanceId })
        sendJson(res, 200, { fact })
        return
      }
      case 'POST /v1/memory/recall': {
        const body = await readJson(req)
        // Hybride FTS+vectoriel quand un provider d'embeddings est disponible —
        // sinon strictement équivalent au recall FTS.
        const result = await memoria.recallSemantic({ ...(body as Omit<RecallInput, 'instance'>), instance: instanceId })
        sendJson(res, 200, result)
        return
      }
      case 'POST /v1/memory/capture_turn': {
        const body = await readJson(req)
        const messages = body['messages']
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new HttpError(400, 'messages requis (tableau {role, content})')
        }
        const result = await memoria.captureTurn({
          instance: instanceId,
          messages: messages as CaptureTurnInput['messages'],
          active_context: body['active_context'] as CaptureTurnInput['active_context'],
        })
        sendJson(res, 200, result)
        return
      }
      case 'POST /v1/memory/identify_interlocutor': {
        // L'agent demande « à qui je parle ? » via un identifiant (Telegram/mail/tel…).
        const body = await readJson(req)
        sendJson(res, 200, { match: memoria.identifyInterlocutor(body as Record<string, never>) })
        return
      }
      default:
        throw new HttpError(404, `route mémoire inconnue : ${route}`)
    }
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
    started_at: nowISO(),
  }
  writeDaemonState(storageRoot, state)

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
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    clearDaemonState(storageRoot)
    release()
    memoria.close()
  }

  return { state, memoria, close }
}

// ----------------------------------------------------------------- helpers

/**
 * Commande de connexion LOCALE : `node <repo>/packages/mcp/dist/bin.js connect
 * --code XXXX`. Le bin MCP est voisin du daemon dans le monorepo. Retourne null
 * si introuvable (paquet publié npm → on garde la forme npx).
 */
function localConnectCommand(code: string): string | null {
  try {
    const binPath = fileURLToPath(new URL('../../mcp/dist/bin.js', import.meta.url))
    if (existsSync(binPath)) return `${process.execPath} ${binPath} connect --code ${code}`
  } catch {
    /* ignore */
  }
  return null
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
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 2_000_000) throw new HttpError(413, 'corps de requête trop grand')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'JSON invalide')
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export type { Server }
