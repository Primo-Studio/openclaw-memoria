/**
 * `memoria-mcp serve --instance <id>` — serveur MCP stdio par agent (spec §5).
 * Relaye chaque outil vers le daemon (token d'instance) ; ne touche JAMAIS les
 * fichiers SQLite en direct. stdout = canal MCP → tout log humain part sur stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { RecallResult, Sensitivity } from '@memoria/core'
import { ensureDaemon, type DaemonState } from '@memoria/daemon'
import { loadCredentials } from './credentials.js'
import { ActiveContextTracker, type SetContextInput } from './context.js'

export const MCP_SERVER_VERSION = '0.1.0'

export interface CaptureMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Destination d'un fait déclaré. `private` = mémoire de CET agent seulement ;
 * `user` = scope partagé « user » (nom de scope côté registre), lu par tous les
 * assistants de l'utilisateur — c'est la seule voie par laquelle un agent peut
 * faire circuler ce qu'il apprend sur l'humain. Le daemon refuse l'écriture si
 * la policy de l'assistant n'a pas can_write sur ce scope (erreur explicite).
 */
export type StoreScope = 'private' | 'user'

/**
 * Réponse compacte de store_fact pour le LLM. Le daemon renvoie la ligne Fact
 * entière (~30 colonnes : origin_machine_id, content_hash, relevance_weight…),
 * soit ~770 caractères pour une phrase de 35 — du contexte brûlé pour rien.
 */
export function compactStoredFact(payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as { fact?: Record<string, unknown> | null; disabled?: boolean }
  if (!p.fact) return { stored: false, ...(p.disabled ? { disabled: true } : {}) }
  const f = p.fact
  return {
    stored: true,
    id: f['id'],
    content: f['fact'],
    category: f['category'],
    scope: f['visibility'] === 'shared' ? 'user' : 'private',
    visibility: f['visibility'],
    project_id: f['project_id'] ?? null,
    client_org_id: f['client_org_id'] ?? null,
  }
}

/** Sous-ensemble du daemon utilisé par les outils MCP (mockable en test). */
export interface DaemonGateway {
  recall(input: Record<string, unknown>): Promise<RecallResult>
  storeFact(input: Record<string, unknown>): Promise<unknown>
  captureTurn(input: Record<string, unknown>): Promise<unknown>
  identifyInterlocutor(input: Record<string, unknown>): Promise<unknown>
  identifyOrCreateInterlocutor(input: Record<string, unknown>): Promise<unknown>
  feedback(input: Record<string, unknown>): Promise<unknown>
  captureStatus(input: Record<string, unknown>): Promise<unknown>
  pin(input: Record<string, unknown>): Promise<unknown>
  expiry(input: Record<string, unknown>): Promise<unknown>
  correct(input: Record<string, unknown>): Promise<unknown>
}

/**
 * Erreur HTTP renvoyée PAR le daemon (4xx/5xx) : le daemon est joignable, il a
 * répondu. Distinguer ce cas d'une panne réseau est ce qui permet de ne pas
 * annoncer « daemon injoignable, lance memoria doctor » pour une date invalide.
 */
export class DaemonHttpError extends Error {
  readonly status: number
  readonly path: string
  readonly daemonMessage: string
  constructor(path: string, status: number, daemonMessage: string) {
    super(`daemon ${path} → ${status} : ${daemonMessage}`)
    this.name = 'DaemonHttpError'
    this.path = path
    this.status = status
    this.daemonMessage = daemonMessage
  }
}

/** Le daemon n'a pas répondu dans le délai : la requête a PEUT-ÊTRE été traitée. */
export class DaemonTimeoutError extends Error {
  readonly path: string
  readonly timeoutMs: number
  constructor(path: string, timeoutMs: number) {
    super(`daemon ${path} → pas de réponse en ${Math.round(timeoutMs / 1000)} s`)
    this.name = 'DaemonTimeoutError'
    this.path = path
    this.timeoutMs = timeoutMs
  }
}

/**
 * Délais de garde. Sans `signal`, un fetch pendait jusqu'au timeout de l'hôte
 * MCP (≈120 s) quand le provider d'extraction ne répondait plus.
 * capture_turn est plus long : le daemon extrait DANS l'appel (LLM local
 * possible) — mais l'appel doit rester sous le timeout de l'hôte.
 */
export const DAEMON_TIMEOUT_MS = 30_000
export const CAPTURE_TIMEOUT_MS = 60_000

/**
 * Gateway HTTP réel : un seul chemin (`postMemory`) pour TOUTES les routes
 * mémoire, avec délai de garde et erreurs typées — DaemonClient (daemon)
 * lève des `Error` plates sans status, inutilisables pour différencier
 * une panne d'un 400.
 */
export class HttpDaemonGateway implements DaemonGateway {
  private readonly baseUrl: string
  private readonly token: string

  constructor(state: Pick<DaemonState, 'port'>, instanceToken: string) {
    this.baseUrl = `http://127.0.0.1:${state.port}`
    this.token = instanceToken
  }

  recall(input: Record<string, unknown>): Promise<RecallResult> {
    return this.postMemory('/v1/memory/recall', input) as Promise<RecallResult>
  }

  storeFact(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/store_fact', input)
  }

  captureTurn(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/capture_turn', input, CAPTURE_TIMEOUT_MS)
  }

  identifyInterlocutor(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/identify_interlocutor', input)
  }

  feedback(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/feedback', input)
  }

  captureStatus(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/capture_status', input)
  }

  pin(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/pin', input)
  }

  correct(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/correct', input)
  }

  expiry(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/expiry', input)
  }

  identifyOrCreateInterlocutor(input: Record<string, unknown>): Promise<unknown> {
    return this.postMemory('/v1/memory/identify_or_create_interlocutor', input)
  }

  private async postMemory(path: string, input: Record<string, unknown>, timeoutMs = DAEMON_TIMEOUT_MS): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if ((err as { name?: string }).name === 'TimeoutError') throw new DaemonTimeoutError(path, timeoutMs)
      throw err // erreur réseau (ECONNREFUSED, fetch failed) : le daemon est absent
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new DaemonHttpError(path, res.status, String(payload['error'] ?? 'erreur'))
    return payload
  }
}

export interface BuildServerOptions {
  instanceId: string
  tracker: ActiveContextTracker
  /** Connexion (ou re-connexion) au daemon ; en prod = ensureDaemon + gateway HTTP. */
  connect: () => Promise<DaemonGateway>
  version?: string
}

export interface ToolHandlers {
  recall(args: { query: string; limit?: number }): Promise<CallToolResult>
  storeFact(args: {
    content: string
    category?: string
    tags?: string[]
    sensitivity?: Sensitivity
    scope?: StoreScope
  }): Promise<CallToolResult>
  captureTurn(args: { messages: CaptureMessage[] }): Promise<CallToolResult>
  setContext(args: SetContextInput): Promise<CallToolResult>
  getContext(): Promise<CallToolResult>
  identifyInterlocutor(args: { phone?: string; email?: string; telegram?: string; whatsapp?: string; handle?: string; name?: string }): Promise<CallToolResult>
  identifyOrCreateInterlocutor(args: { phone?: string; email?: string; telegram?: string; whatsapp?: string; handle?: string; name?: string; relation?: string }): Promise<CallToolResult>
  feedback(args: { fact_ids: string[]; verdict: 'useful' | 'noise' }): Promise<CallToolResult>
  captureStatus(args: { wal_ids: number[] }): Promise<CallToolResult>
  correct(args: { fact_id: string; content: string }): Promise<CallToolResult>
  pin(args: { fact_id: string; pinned: boolean }): Promise<CallToolResult>
  expiry(args: { fact_id: string; expires_at?: string }): Promise<CallToolResult>
}

export interface BuiltServer {
  server: McpServer
  handlers: ToolHandlers
}

const SERVER_INSTRUCTIONS = [
  'Memoria is the user\'s local long-term memory, shared across their AI agents.',
  '- Call memoria_recall at the START of a task to load relevant context (preferences, decisions, project facts).',
  '- Call memoria_store_fact whenever you learn a durable fact worth remembering (a decision, a preference, a stable project detail). Do not store transient chatter.',
  '- Call memoria_set_context when you switch project, client or repository, so recall and storage are scoped correctly.',
  '- Call memoria_identify_interlocutor when the person speaking might not be the owner (e.g. a phone number or name appears) to learn who they are and how they relate to the user.',
  '- memoria_capture_turn lets you hand over full conversation turns for background extraction.',
].join('\n')

/**
 * Fabrique testable : construit le McpServer ET expose les handlers purs.
 * Les handlers ne lancent JAMAIS d'exception non gérée : un throw remonterait
 * dans la boucle stdio. Échec daemon → UNE re-connexion (ensureDaemon côté
 * prod) puis résultat MCP `isError` lisible par l'agent.
 */
export function buildServer(opts: BuildServerOptions): BuiltServer {
  let gateway: DaemonGateway | null = null

  /**
   * Seule une erreur RÉSEAU (daemon absent : ECONNREFUSED, fetch failed) mérite
   * une reconnexion + un rejeu. Une réponse 4xx/5xx prouve que le daemon est
   * là : rejouer coûtait une requête pour rien. Un timeout est pire : la
   * requête a pu aboutir (capture_turn déjà journalisé) → rejouer = doublons.
   */
  const isNetworkError = (err: unknown): boolean =>
    !(err instanceof DaemonHttpError) && !(err instanceof DaemonTimeoutError)

  async function withDaemon<T>(op: (g: DaemonGateway) => Promise<T>): Promise<T> {
    if (!gateway) gateway = await opts.connect()
    try {
      return await op(gateway)
    } catch (err) {
      if (!isNetworkError(err)) throw err
      // visible sur stderr + une seule relance — jamais de boucle
      console.warn(`[memoria-mcp] échec daemon, tentative de relance : ${(err as Error).message}`)
      gateway = null
      gateway = await opts.connect()
      return op(gateway)
    }
  }

  const ok = (payload: unknown): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  })

  /**
   * Message d'erreur POUR LE LLM, différencié par cause. Avant, tout finissait
   * en « daemon unreachable… run memoria doctor » — y compris une date
   * invalide, un token révoqué ou Memoria mise en pause par l'utilisateur —
   * et `memoria doctor` répondait ensuite que tout allait bien.
   */
  const explain = (err: unknown): string => {
    if (err instanceof DaemonHttpError) {
      const m = err.daemonMessage
      if (err.status === 400 || err.status === 422) {
        return `Memoria rejected this request: ${m}. The memory layer itself is fine — fix the arguments and retry.`
      }
      if (err.status === 401 || err.status === 403) {
        return `Memoria refused this agent's token (${m}): it was revoked or never paired. Continue without memory and tell the user to reconnect this agent from the Memoria app (or run \`memoria-mcp connect\`).`
      }
      if (err.status === 404) {
        return `Memoria could not serve this operation (${m}). Either the user has paused Memoria, or the daemon is older than this MCP server. Continue without it and do not retry; mention it to the user only if they expected memory to work.`
      }
      return `Memoria daemon failed on ${err.path} (HTTP ${err.status}: ${m}). Continue without memory for now; if it keeps happening, suggest the user runs \`memoria doctor\`.`
    }
    if (err instanceof DaemonTimeoutError) {
      const hint = err.path.endsWith('/capture_turn')
        ? ' The turn may still have been journaled and processed: check with memoria_capture_status (if you have wal_ids) instead of re-capturing, which would create duplicates.'
        : ''
      return `Memoria daemon did not answer within ${Math.round(err.timeoutMs / 1000)} s on ${err.path}.${hint} Continue without memory; if it keeps happening, suggest the user runs \`memoria doctor\`.`
    }
    return `Memoria daemon is unreachable (${(err as Error).message}). The memory layer is temporarily unavailable — continue without it and suggest the user runs \`memoria doctor\`.`
  }

  const fail = (err: unknown): CallToolResult => ({
    isError: true,
    content: [{ type: 'text', text: explain(err) }],
  })

  const handlers: ToolHandlers = {
    async recall(args) {
      try {
        const input: Record<string, unknown> = {
          query: args.query,
          active_context: opts.tracker.current(),
        }
        if (args.limit !== undefined) input['limit'] = args.limit
        return ok(await withDaemon(g => g.recall(input)))
      } catch (err) {
        return fail(err)
      }
    },

    async storeFact(args) {
      try {
        const input: Record<string, unknown> = { content: args.content }
        if (args.category !== undefined) input['category'] = args.category
        if (args.tags !== undefined) input['tags'] = args.tags
        if (args.sensitivity !== undefined) input['sensitivity'] = args.sensitivity
        // Le fait déclaré hérite du contexte actif, comme capture_turn : sans
        // project_id/client_org_id, `passesClientIsolation` le laissait remonter
        // chez un autre client et le boost projet ne s'appliquait jamais.
        // repo_path/topic ne sont pas des identifiants de scoping → non envoyés.
        const ctx = opts.tracker.current()
        if (ctx.project_id) input['project_id'] = ctx.project_id
        if (ctx.client_org_id) input['client_org_id'] = ctx.client_org_id
        if (ctx.org_id) input['org_id'] = ctx.org_id
        // `private` (défaut) = on n'envoie rien : le daemon retombe sur le scope
        // privé de l'instance. `user` = nom du scope partagé côté registre.
        if (args.scope === 'user') input['scope'] = 'user'
        return ok(compactStoredFact(await withDaemon(g => g.storeFact(input))))
      } catch (err) {
        return fail(err)
      }
    },

    async captureTurn(args) {
      try {
        const input: Record<string, unknown> = {
          messages: args.messages,
          active_context: opts.tracker.current(),
        }
        return ok(await withDaemon(g => g.captureTurn(input)))
      } catch (err) {
        return fail(err)
      }
    },

    async correct(args) {
      try {
        return ok(await withDaemon(g => g.correct({ fact_id: args.fact_id, content: args.content })))
      } catch (err) {
        return fail(err)
      }
    },

    async pin(args) {
      try {
        return ok(await withDaemon(g => g.pin({ fact_id: args.fact_id, pinned: args.pinned })))
      } catch (err) {
        return fail(err)
      }
    },

    async expiry(args) {
      try {
        return ok(await withDaemon(g => g.expiry({ fact_id: args.fact_id, expires_at: args.expires_at ?? null })))
      } catch (err) {
        return fail(err)
      }
    },

    async captureStatus(args) {
      try {
        return ok(await withDaemon(g => g.captureStatus({ wal_ids: args.wal_ids })))
      } catch (err) {
        return fail(err)
      }
    },

    async feedback(args) {
      try {
        // `verdict` plutôt qu'un booléen nu : « useful/noise » se lit sans
        // ambiguïté côté agent, et laisse la place à d'autres verdicts plus
        // tard sans casser le schéma d'outil.
        const input: Record<string, unknown> = {
          fact_ids: args.fact_ids,
          used: args.verdict === 'useful',
        }
        return ok(await withDaemon(g => g.feedback(input)))
      } catch (err) {
        return fail(err)
      }
    },

    // Les deux outils de contexte sont locaux au process : pas de daemon.
    async setContext(args) {
      const effective = opts.tracker.set(args)
      return ok({ active_context: effective })
    },

    async getContext() {
      const detected = opts.tracker.autoDetect()
      return ok({ active_context: opts.tracker.current(), auto_detected_repo: detected })
    },

    async identifyInterlocutor(args) {
      try {
        return ok(await withDaemon(g => g.identifyInterlocutor(args as Record<string, unknown>)))
      } catch (err) {
        return fail(err)
      }
    },

    async identifyOrCreateInterlocutor(args) {
      try {
        return ok(await withDaemon(g => g.identifyOrCreateInterlocutor(args as Record<string, unknown>)))
      } catch (err) {
        return fail(err)
      }
    },
  }

  const server = new McpServer(
    { name: 'memoria', version: opts.version ?? MCP_SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  )

  server.registerTool(
    'memoria_recall',
    {
      description:
        'Search the user\'s long-term memory (facts, preferences, decisions, procedures) and return the most relevant items for a query. Call this at the start of a task to load context. The current active context (project/client/repo) is applied automatically. '
        + 'An item carrying a `revision` field is CONTESTED: a more recent memory contradicts or duplicates it, pending the user\'s decision. Treat it as doubtful, prefer the memory named by `replacement_fact_id`, and say so rather than acting on it silently. '
        + 'The `origin` field says how much to trust an item: "declared" was stated explicitly, "extracted" comes from a conversation, "confirmed" proved useful in past answers, and "inferred" was deduced by an agent and never actually stated by anyone — treat inferred items as hypotheses, not rules.',
      inputSchema: {
        query: z.string().min(1).describe('Natural-language search query, e.g. "deployment rules for project X".'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of items to return (default chosen by the daemon).'),
      },
    },
    async args => handlers.recall(args),
  )

  server.registerTool(
    'memoria_store_fact',
    {
      description:
        'Store one durable fact in the user\'s long-term memory (a decision, preference, or stable project detail). Keep it short, self-contained and written in third person. Do not store secrets or transient information.',
      inputSchema: {
        content: z.string().min(1).describe('The fact to remember, as one self-contained sentence or short paragraph.'),
        category: z.string().optional().describe('Free-form category, e.g. "preference", "decision", "infra".'),
        tags: z.array(z.string()).optional().describe('Optional tags for later filtering.'),
        sensitivity: z
          .enum(['normal', 'sensitive', 'critical'])
          .optional()
          .describe('Sensitivity level; higher levels are shared more restrictively.'),
        scope: z
          .enum(['private', 'user'])
          .optional()
          .describe(
            '"private" (default): remembered by this agent only. "user": shared with ALL of the user\'s AI assistants — use it for facts about the user themself (identity, preferences, how they like to work, stable personal/business details), NOT for project-specific or agent-specific details. If the daemon refuses the write, the user has not granted this agent write access to the shared scope: store it privately and tell the user.',
          ),
      },
    },
    async args => handlers.storeFact(args),
  )

  server.registerTool(
    'memoria_capture_turn',
    {
      description:
        'Hand over one or more raw conversation messages so Memoria can extract durable facts from them (deduplicated against existing memories). Use it after a meaningful exchange — a decision, a preference, a new procedure, a correction from the user — not for every message. The daemon journals the messages first, then extracts: the call returns when done (it may take a few seconds) and includes `wal_ids`. If it times out, do NOT re-send the same messages (duplicates): check `wal_ids` with memoria_capture_status.',
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']).describe('Author of the message.'),
              content: z.string().min(1).describe('Verbatim message text.'),
            }),
          )
          .min(1)
          .describe('Conversation turn(s) to capture, in chronological order.'),
      },
    },
    async args => handlers.captureTurn(args),
  )

  server.registerTool(
    'memoria_correct',
    {
      description:
        'Correct a memory that is wrong or outdated. Stores the corrected version and marks the old one as replaced by it — the old text is kept and stays traceable, never overwritten. Prefer this over storing a second contradictory memory, which would leave both active.',
      inputSchema: {
        fact_id: z.string().min(1).describe('Id of the memory to correct, from memoria_recall.'),
        content: z.string().min(1).describe('The corrected statement, self-contained, in the user\'s language.'),
      },
    },
    async args => handlers.correct(args),
  )

  server.registerTool(
    'memoria_pin',
    {
      description:
        'Pin or unpin a memory. A pinned memory ranks strongly at recall and is never faded by disuse — use it when the user says something must always be kept in mind. It never edits or deletes the memory itself.',
      inputSchema: {
        fact_id: z.string().min(1).describe('Id of the memory, from the `id` field returned by memoria_recall.'),
        pinned: z.boolean().describe('true to pin, false to unpin.'),
      },
    },
    async args => handlers.pin(args),
  )

  server.registerTool(
    'memoria_set_expiry',
    {
      description:
        'Give a memory an expiry date, or lift it. Past that date the memory stops being recalled — it is NOT deleted, the history stays. Use it for things true only for a while (a temporary setup, a holiday closure, a stopgap decision). Omit `expires_at` to lift an existing expiry.',
      inputSchema: {
        fact_id: z.string().min(1).describe('Id of the memory, from the `id` field returned by memoria_recall.'),
        expires_at: z
          .string()
          .optional()
          .describe('ISO 8601 date after which the memory is no longer recalled. Omit to lift the expiry.'),
      },
    },
    async args => handlers.expiry(args),
  )

  server.registerTool(
    'memoria_capture_status',
    {
      description:
        'Check what became of messages you handed to memoria_capture_turn. Pass the `wal_ids` it returned. Extraction runs in the background, so a capture that timed out may well have succeeded afterwards — use this instead of re-capturing, which would create duplicates. Statuses: "pending" (queued), "retrying" (extraction failed, will retry), "done" (processed), "failed" (given up after repeated failures).',
      inputSchema: {
        wal_ids: z
          .array(z.number().int())
          .min(1)
          .describe('Ids returned in `wal_ids` by memoria_capture_turn.'),
      },
    },
    async args => handlers.captureStatus(args),
  )

  server.registerTool(
    'memoria_feedback',
    {
      description:
        'Tell Memoria whether the memories it surfaced actually helped. Call it after answering with recalled memories: pass the ids of the ones you genuinely used with verdict "useful", and the ids that were surfaced but irrelevant with verdict "noise". This is what makes recall improve over time — useful memories rank higher, noisy ones fade. It never edits or deletes a memory; to correct or remove one, store a corrected fact instead.',
      inputSchema: {
        fact_ids: z
          .array(z.string().min(1))
          .min(1)
          .describe('Ids of recalled memories, taken from the `id` field returned by memoria_recall.'),
        verdict: z
          .enum(['useful', 'noise'])
          .describe('"useful" = these memories contributed to the answer. "noise" = they were surfaced but irrelevant.'),
      },
    },
    async args => handlers.feedback(args),
  )

  server.registerTool(
    'memoria_set_context',
    {
      description:
        'Declare the active working context (project, client, organization, repository path). Memoria uses it to scope recall and storage — call this whenever you switch project or client. Names are normalized to a stable slug (lowercase, no accents, words joined by "-") so that every agent lands on the same identifier: use the SAME short name for the same project/client each time (e.g. "maroway", not "Maroway ferry project"). Pass an empty string to clear a field. Returns the effective (normalized) context.',
      inputSchema: {
        project: z.string().optional().describe('Short stable project name, e.g. "site-primo". Normalized to a slug.'),
        client: z.string().optional().describe('Short stable client organization name, e.g. "maroway" (enforces client isolation: facts stored under a client are hidden outside it). Normalized to a slug.'),
        org: z.string().optional().describe('Short stable organization name. Normalized to a slug.'),
        repo_path: z.string().optional().describe('Absolute path of the current repository.'),
      },
    },
    async args => handlers.setContext(args),
  )

  server.registerTool(
    'memoria_get_context',
    {
      description:
        'Return the current active context (project, client, organization, repository) plus what was auto-detected from the working directory (.git lookup). Useful to verify scoping before storing facts.',
      inputSchema: {},
    },
    async () => handlers.getContext(),
  )

  server.registerTool(
    'memoria_identify_interlocutor',
    {
      description:
        'Identify WHO you are talking to (the human on the other end) from an identifier — a phone number, email, Telegram/WhatsApp handle, or a name. Returns the matched person, their relation to the user (e.g. colleague, intern, client) and known facts about them. Call this at the start of a conversation when the speaker may not be the owner (Néto), so you address the right person and apply the right context. Returns no match when unknown (assume it is the owner).',
      inputSchema: {
        phone: z.string().optional().describe('Phone number (any format).'),
        email: z.string().optional().describe('Email address.'),
        telegram: z.string().optional().describe('Telegram handle or numeric id.'),
        whatsapp: z.string().optional().describe('WhatsApp number.'),
        handle: z.string().optional().describe('Generic handle/username.'),
        name: z.string().optional().describe('Display name to match as a fallback.'),
      },
    },
    async args => handlers.identifyInterlocutor(args),
  )

  server.registerTool(
    'memoria_identify_or_create_interlocutor',
    {
      description:
        'Like memoria_identify_interlocutor, but AUTO-REGISTERS the person on first contact: if no known person matches the given identifier (phone/email/Telegram/WhatsApp/handle), a new person is created with that identifier (and name/relation if provided). Use when a new contact reaches you on a channel and should be remembered for next time. Returns the person and created=true when a new one was made. With no identifier at all, creates nothing (assume the owner).',
      inputSchema: {
        phone: z.string().optional().describe('Phone number (any format).'),
        email: z.string().optional().describe('Email address.'),
        telegram: z.string().optional().describe('Telegram handle or numeric id.'),
        whatsapp: z.string().optional().describe('WhatsApp number.'),
        handle: z.string().optional().describe('Generic handle/username.'),
        name: z.string().optional().describe('Display name for the new person (falls back to the identifier).'),
        relation: z.string().optional().describe('Relation to the owner (e.g. client, colleague), stored on creation.'),
      },
    },
    async args => handlers.identifyOrCreateInterlocutor(args),
  )

  return { server, handlers }
}

export interface ServeOptions {
  instanceId: string
  storageRoot?: string
  /** Répertoire des credentials — injectable pour les tests. */
  credentialsDir?: string
}

export async function serve(opts: ServeOptions): Promise<void> {
  const creds = loadCredentials(opts.instanceId, opts.credentialsDir)
  if (!creds) {
    throw new Error(
      `credentials introuvables pour l'instance ${opts.instanceId} — lance d'abord : memoria-mcp connect --code XXXX-XXXX`,
    )
  }
  const storageRoot = opts.storageRoot ?? creds.storage_root

  const connect = async (): Promise<DaemonGateway> => {
    // ensureDaemon = la « UNE tentative » : réutilise un daemon vivant, sinon
    // en démarre un détaché et attend son health (15 s max).
    const state = await ensureDaemon({ storageRoot })
    return new HttpDaemonGateway(state, creds.instance_token)
  }

  const tracker = new ActiveContextTracker()
  tracker.autoDetect() // contexte repo connu dès le démarrage

  const { server } = buildServer({ instanceId: opts.instanceId, tracker, connect })
  await server.connect(new StdioServerTransport())
  // stderr uniquement : stdout est le canal JSON-RPC
  console.error(`[memoria-mcp] serveur stdio prêt (instance ${opts.instanceId}, storage ${storageRoot})`)
}
