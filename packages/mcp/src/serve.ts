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
import { DaemonClient, ensureDaemon, type DaemonState } from '@memoria/daemon'
import { loadCredentials } from './credentials.js'
import { ActiveContextTracker, type SetContextInput } from './context.js'

export const MCP_SERVER_VERSION = '0.1.0'

export interface CaptureMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Sous-ensemble du daemon utilisé par les outils MCP (mockable en test). */
export interface DaemonGateway {
  recall(input: Record<string, unknown>): Promise<RecallResult>
  storeFact(input: Record<string, unknown>): Promise<unknown>
  captureTurn(input: Record<string, unknown>): Promise<unknown>
}

/**
 * Gateway HTTP réel : DaemonClient pour recall/store_fact + appel direct pour
 * `POST /v1/memory/capture_turn` (route côté daemon en cours d'ajout — le
 * client est prêt, l'intégrateur câble la route serveur).
 */
export class HttpDaemonGateway implements DaemonGateway {
  private readonly client: DaemonClient
  private readonly token: string

  constructor(state: Pick<DaemonState, 'port'>, instanceToken: string) {
    this.client = new DaemonClient(state, instanceToken)
    this.token = instanceToken
  }

  recall(input: Record<string, unknown>): Promise<RecallResult> {
    return this.client.recall(input)
  }

  storeFact(input: Record<string, unknown>): Promise<unknown> {
    return this.client.storeFact(input)
  }

  async captureTurn(input: Record<string, unknown>): Promise<unknown> {
    const path = '/v1/memory/capture_turn'
    const res = await fetch(`${this.client.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(input),
    })
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      throw new Error(`daemon ${path} → ${res.status} : ${String(payload['error'] ?? 'erreur')}`)
    }
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
  }): Promise<CallToolResult>
  captureTurn(args: { messages: CaptureMessage[] }): Promise<CallToolResult>
  setContext(args: SetContextInput): Promise<CallToolResult>
  getContext(): Promise<CallToolResult>
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

  async function withDaemon<T>(op: (g: DaemonGateway) => Promise<T>): Promise<T> {
    if (!gateway) gateway = await opts.connect()
    try {
      return await op(gateway)
    } catch (err) {
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

  const fail = (err: unknown): CallToolResult => ({
    isError: true,
    content: [
      {
        type: 'text',
        text: `Memoria daemon is unreachable or the request failed: ${(err as Error).message}. The memory layer is temporarily unavailable — continue without it and suggest the user runs \`memoria doctor\`.`,
      },
    ],
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
        return ok(await withDaemon(g => g.storeFact(input)))
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

    // Les deux outils de contexte sont locaux au process : pas de daemon.
    async setContext(args) {
      const effective = opts.tracker.set(args)
      return ok({ active_context: effective })
    },

    async getContext() {
      const detected = opts.tracker.autoDetect()
      return ok({ active_context: opts.tracker.current(), auto_detected_repo: detected })
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
        'Search the user\'s long-term memory (facts, preferences, decisions, procedures) and return the most relevant items for a query. Call this at the start of a task to load context. The current active context (project/client/repo) is applied automatically.',
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
      },
    },
    async args => handlers.storeFact(args),
  )

  server.registerTool(
    'memoria_capture_turn',
    {
      description:
        'Hand over one or more raw conversation messages so Memoria can extract durable facts in the background. Use it after a meaningful exchange; extraction, deduplication and storage happen asynchronously on the daemon.',
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
    'memoria_set_context',
    {
      description:
        'Declare the active working context (project, client, organization, repository path). Memoria uses it to scope recall and storage — call this whenever you switch project or client. Pass an empty string to clear a field. Returns the effective context.',
      inputSchema: {
        project: z.string().optional().describe('Project identifier or name currently being worked on.'),
        client: z.string().optional().describe('Client organization identifier (enforces client isolation).'),
        org: z.string().optional().describe('Organization identifier.'),
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
