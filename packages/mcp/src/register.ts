/**
 * Enregistrement/désenregistrement AUTOMATIQUE du serveur MCP Memoria auprès de
 * l'agent hôte (Claude Code / Codex / OpenClaw). Objectif : une seule commande
 * pour connecter, une seule pour déconnecter — zéro édition manuelle.
 *
 * La commande `serve` pointe sur CETTE installation (chemin absolu du bin) tant
 * que le paquet n'est pas publié sur npm ; après publication → `npx -y @memoria/mcp`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HostKind = 'claude-code' | 'codex' | 'openclaw' | 'generic'

export interface RegisterResult {
  host: HostKind
  registered: boolean
  /** Décrit ce qui a été fait, ou l'instruction manuelle si l'auto a échoué. */
  detail: string
}

/** Invocation `serve` de CETTE installation (chemin absolu du bin courant). */
export function serveInvocation(instanceId: string): { command: string; args: string[] } {
  const binPath = fileURLToPath(new URL('./bin.js', import.meta.url))
  return { command: process.execPath, args: [binPath, 'serve', '--instance', instanceId] }
}

function hasClaudeCli(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function hasOpenClawCli(): boolean {
  try {
    execFileSync('openclaw', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------- Claude Code

export function registerClaudeCode(instanceId: string): RegisterResult {
  const { command, args } = serveInvocation(instanceId)
  if (hasClaudeCli()) {
    try {
      // -- sépare les flags claude de la commande du serveur
      execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'memoria'], { stdio: 'ignore' })
    } catch {
      /* pas encore enregistré — normal */
    }
    execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'memoria', '--', command, ...args], { stdio: 'ignore' })
    return { host: 'claude-code', registered: true, detail: 'serveur MCP « memoria » ajouté à Claude Code (scope user).' }
  }
  // Repli : éditer ~/.claude.json (mcpServers global)
  const cfgPath = join(homedir(), '.claude.json')
  try {
    const cfg = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>) : {}
    const servers = (cfg['mcpServers'] as Record<string, unknown> | undefined) ?? {}
    servers['memoria'] = { command, args }
    cfg['mcpServers'] = servers
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
    return { host: 'claude-code', registered: true, detail: `serveur MCP « memoria » écrit dans ${cfgPath}.` }
  } catch (err) {
    return { host: 'claude-code', registered: false, detail: `échec auto (${(err as Error).message}). Manuel : claude mcp add memoria -- ${command} ${args.join(' ')}` }
  }
}

export function unregisterClaudeCode(): RegisterResult {
  if (hasClaudeCli()) {
    try {
      execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'memoria'], { stdio: 'ignore' })
      return { host: 'claude-code', registered: false, detail: 'serveur MCP « memoria » retiré de Claude Code.' }
    } catch (err) {
      return { host: 'claude-code', registered: false, detail: `retrait CLI échoué (${(err as Error).message}).` }
    }
  }
  const cfgPath = join(homedir(), '.claude.json')
  try {
    if (!existsSync(cfgPath)) return { host: 'claude-code', registered: false, detail: 'aucune config Claude Code à nettoyer.' }
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    const servers = cfg['mcpServers'] as Record<string, unknown> | undefined
    if (servers && 'memoria' in servers) {
      delete servers['memoria']
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
    }
    return { host: 'claude-code', registered: false, detail: `serveur MCP « memoria » retiré de ${cfgPath}.` }
  } catch (err) {
    return { host: 'claude-code', registered: false, detail: `nettoyage échoué (${(err as Error).message}).` }
  }
}

// --------------------------------------------------------------------- Codex

const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')

/** Retire un bloc `[mcp_servers.memoria]` existant (jusqu'au prochain `[` ou EOF). */
function stripCodexBlock(toml: string): string {
  const lines = toml.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.memoria(\.|])/.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function registerCodex(instanceId: string): RegisterResult {
  const { command, args } = serveInvocation(instanceId)
  try {
    const existing = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : ''
    const cleaned = stripCodexBlock(existing).replace(/\s*$/, '')
    const block = [
      '',
      '[mcp_servers.memoria]',
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map(a => JSON.stringify(a)).join(', ')}]`,
      'startup_timeout_sec = 30',
      '',
    ].join('\n')
    writeFileSync(CODEX_CONFIG, `${cleaned}\n${block}`, 'utf8')
    return { host: 'codex', registered: true, detail: `serveur MCP « memoria » écrit dans ${CODEX_CONFIG}.` }
  } catch (err) {
    return { host: 'codex', registered: false, detail: `échec auto (${(err as Error).message}). Ajoute [mcp_servers.memoria] manuellement dans ${CODEX_CONFIG}.` }
  }
}

export function unregisterCodex(): RegisterResult {
  try {
    if (!existsSync(CODEX_CONFIG)) return { host: 'codex', registered: false, detail: 'aucune config Codex à nettoyer.' }
    const cleaned = stripCodexBlock(readFileSync(CODEX_CONFIG, 'utf8'))
    writeFileSync(CODEX_CONFIG, cleaned, 'utf8')
    return { host: 'codex', registered: false, detail: `serveur MCP « memoria » retiré de ${CODEX_CONFIG}.` }
  } catch (err) {
    return { host: 'codex', registered: false, detail: `nettoyage échoué (${(err as Error).message}).` }
  }
}

// ------------------------------------------------------------------ OpenClaw

export function registerOpenClaw(instanceId: string): RegisterResult {
  const { command, args } = serveInvocation(instanceId)
  if (hasOpenClawCli()) {
    try {
      const spec = JSON.stringify({ command, args })
      execFileSync('openclaw', ['mcp', 'set', 'memoria', spec], { stdio: 'ignore' })
      return { host: 'openclaw', registered: true, detail: 'serveur MCP « memoria » enregistré dans OpenClaw.' }
    } catch (err) {
      return { host: 'openclaw', registered: false, detail: `openclaw mcp set échoué (${(err as Error).message}).` }
    }
  }
  return { host: 'openclaw', registered: false, detail: `CLI openclaw absente. Manuel : openclaw mcp set memoria '${JSON.stringify({ command, args })}'` }
}

export function unregisterOpenClaw(): RegisterResult {
  if (hasOpenClawCli()) {
    try {
      execFileSync('openclaw', ['mcp', 'unset', 'memoria'], { stdio: 'ignore' })
      return { host: 'openclaw', registered: false, detail: 'serveur MCP « memoria » retiré d’OpenClaw.' }
    } catch (err) {
      return { host: 'openclaw', registered: false, detail: `openclaw mcp unset échoué (${(err as Error).message}).` }
    }
  }
  return { host: 'openclaw', registered: false, detail: 'CLI openclaw absente — retire memoria manuellement.' }
}

// ---------------------------------------------------------------- dispatch

export function autoRegister(host: string, instanceId: string): RegisterResult {
  switch (host) {
    case 'claude-code':
      return registerClaudeCode(instanceId)
    case 'codex':
      return registerCodex(instanceId)
    case 'openclaw':
      return registerOpenClaw(instanceId)
    default:
      return { host: 'generic', registered: false, detail: `Type « ${host} » : enregistre le serveur MCP manuellement (memoria-mcp serve --instance ${instanceId}).` }
  }
}

export function autoUnregister(host: string): RegisterResult {
  switch (host) {
    case 'claude-code':
      return unregisterClaudeCode()
    case 'codex':
      return unregisterCodex()
    case 'openclaw':
      return unregisterOpenClaw()
    default:
      return { host: 'generic', registered: false, detail: 'Rien à nettoyer automatiquement pour ce type.' }
  }
}
