/**
 * @memoria/mcp — serveur MCP par agent, client du daemon (spec §5).
 * memoria_recall / memoria_store_fact / memoria_capture_turn / memoria_set_context /
 * memoria_get_context. Ne touche JAMAIS les fichiers SQLite en direct.
 */
export const MCP_VERSION = '0.1.0'

export { connect, registrationSnippets } from './connect.js'
export type { ConnectOptions, ConnectResult, PairingCompleter, RegistrationSnippets } from './connect.js'
export { ActiveContextTracker } from './context.js'
export type { DetectedRepo, SetContextInput } from './context.js'
export {
  credentialsPath,
  defaultCredentialsDir,
  loadCredentials,
  saveCredentials,
} from './credentials.js'
export type { InstanceCredentials } from './credentials.js'
export { buildServer, serve, HttpDaemonGateway, MCP_SERVER_VERSION } from './serve.js'
export type {
  BuildServerOptions,
  BuiltServer,
  CaptureMessage,
  DaemonGateway,
  ServeOptions,
  ToolHandlers,
} from './serve.js'
