/**
 * `memoria-mcp connect --code XXXX-XXXX` — échange le code de pairing (affiché
 * par l'UI/CLI admin) contre un token d'instance, sauvegarde les credentials
 * et affiche les snippets d'enregistrement Claude Code / Codex.
 */
import { nowISO, resolveStorageRoot } from '@memoria/core'
import { DaemonClient, ensureDaemon, type DaemonState } from '@memoria/daemon'
import { defaultCredentialsDir, saveCredentials } from './credentials.js'

export interface PairingCompleter {
  completePairing(code: string): Promise<{ assistant_instance_id: string; instance_token: string }>
}

export interface ConnectOptions {
  code: string
  storageRoot?: string
  credentialsDir?: string
  /** Injectables pour les tests (pas de vrai daemon, pas de réseau). */
  ensure?: (opts: { storageRoot?: string }) => Promise<Pick<DaemonState, 'port'>>
  clientFor?: (state: Pick<DaemonState, 'port'>) => PairingCompleter
}

export interface RegistrationSnippets {
  claudeCode: string
  codexToml: string
}

export interface ConnectResult {
  instanceId: string
  credentialsPath: string
  storageRoot: string
  snippets: RegistrationSnippets
  /** Message complet en français, prêt à imprimer (bin.ts). */
  message: string
}

export function registrationSnippets(instanceId: string): RegistrationSnippets {
  return {
    claudeCode: `claude mcp add memoria -- npx -y @memoria/mcp serve --instance ${instanceId}`,
    codexToml: [
      '[mcp_servers.memoria]',
      'command = "npx"',
      `args = ["-y", "@memoria/mcp", "serve", "--instance", "${instanceId}"]`,
    ].join('\n'),
  }
}

export async function connect(opts: ConnectOptions): Promise<ConnectResult> {
  const code = opts.code.trim()
  if (!code) throw new Error('code de pairing manquant (--code XXXX-XXXX)')

  const { storageRoot } = resolveStorageRoot(
    opts.storageRoot !== undefined ? { storageRoot: opts.storageRoot } : {},
  )

  const ensure = opts.ensure ?? ensureDaemon
  const state = await ensure(opts.storageRoot !== undefined ? { storageRoot: opts.storageRoot } : {})

  const client = opts.clientFor ? opts.clientFor(state) : new DaemonClient(state)
  const done = await client.completePairing(code)

  const credentialsPath = saveCredentials(
    done.assistant_instance_id,
    {
      instance_token: done.instance_token,
      storage_root: storageRoot,
      created_at: nowISO(),
    },
    opts.credentialsDir ?? defaultCredentialsDir(),
  )

  const snippets = registrationSnippets(done.assistant_instance_id)
  const message = [
    `✓ Agent connecté à Memoria — instance ${done.assistant_instance_id}`,
    `  Token enregistré : ${credentialsPath} (chmod 600)`,
    `  Stockage : ${storageRoot}`,
    '',
    'Enregistre maintenant le serveur MCP auprès de ton agent :',
    '',
    '— Claude Code (une commande) :',
    `    ${snippets.claudeCode}`,
    '',
    '— Codex (bloc à ajouter dans ~/.codex/config.toml) :',
    ...snippets.codexToml.split('\n').map(line => `    ${line}`),
  ].join('\n')

  return {
    instanceId: done.assistant_instance_id,
    credentialsPath,
    storageRoot,
    snippets,
    message,
  }
}
