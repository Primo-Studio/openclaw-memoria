#!/usr/bin/env node
/**
 * `memoria-mcp connect | disconnect | serve` — point d'entrée CLI.
 * `serve` parle MCP (JSON-RPC) sur stdout : tout message humain part sur stderr.
 * Les arguments sont analysés par cli-args.ts : une option inconnue donne un
 * message d'usage (exit 2), jamais une stack Node.
 */
import { parseCliArgs } from './cli-args.js'
import { connect } from './connect.js'
import { disconnect } from './disconnect.js'
import { serve } from './serve.js'

const HELP = `memoria-mcp — connecte un agent (Claude Code, Codex…) à la mémoire Memoria

Usage :
  memoria-mcp connect --code XXXX-XXXX [--no-register] [--storage-root <chemin>]
      Échange le code de pairing contre un token d'instance, le sauvegarde, PUIS
      enregistre AUTOMATIQUEMENT le serveur MCP auprès de ton agent (Claude Code,
      Codex, OpenClaw). Une seule commande, rien d'autre. --no-register affiche
      l'enregistrement manuel sans l'appliquer.

  memoria-mcp disconnect [--instance <id>] [--storage-root <chemin>]
      Déconnexion complète : retire le serveur MCP de la config de l'agent,
      révoque l'instance côté daemon, supprime les credentials locaux. Sans
      --instance : déconnecte l'unique agent connu.

  memoria-mcp serve --instance <id> [--storage-root <chemin>]
      Démarre le serveur MCP stdio de cet agent (lancé par Claude Code/Codex,
      pas à la main). Relaye memoria_recall / memoria_store_fact /
      memoria_capture_turn / memoria_set_context vers le daemon local.

Options :
  --code <XXXX-XXXX>        code de pairing one-shot (connect)
  --no-register             ne pas enregistrer auto le serveur MCP (connect)
  --instance <id>           identifiant d'instance (serve / disconnect)
  --storage-root <chemin>   racine de stockage Memoria (défaut : config.toml)
  -h, --help                cette aide
`

const parsed = parseCliArgs(process.argv.slice(2))

switch (parsed.kind) {
  case 'help':
    console.log(HELP)
    break

  case 'error':
    console.error(parsed.message)
    process.exit(parsed.exitCode)
    break

  case 'connect': {
    try {
      const result = await connect({ code: parsed.code, register: parsed.register, storageRoot: parsed.storageRoot })
      console.log(result.message)
    } catch (err) {
      console.error(`memoria-mcp connect : ${(err as Error).message}`)
      process.exit(1)
    }
    break
  }

  case 'disconnect': {
    try {
      const result = await disconnect({ instanceId: parsed.instanceId, storageRoot: parsed.storageRoot })
      console.log(result.message)
    } catch (err) {
      console.error(`memoria-mcp disconnect : ${(err as Error).message}`)
      process.exit(1)
    }
    break
  }

  case 'serve': {
    try {
      await serve({ instanceId: parsed.instanceId!, storageRoot: parsed.storageRoot })
    } catch (err) {
      console.error(`memoria-mcp serve : ${(err as Error).message}`)
      process.exit(1)
    }
    break
  }
}
