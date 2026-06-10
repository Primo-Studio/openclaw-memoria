#!/usr/bin/env node
/**
 * `memoria-mcp connect | serve` — point d'entrée CLI.
 * `serve` parle MCP (JSON-RPC) sur stdout : tout message humain part sur stderr.
 */
import { parseArgs } from 'node:util'
import { connect } from './connect.js'
import { serve } from './serve.js'

const HELP = `memoria-mcp — connecte un agent (Claude Code, Codex…) à la mémoire Memoria

Usage :
  memoria-mcp connect --code XXXX-XXXX [--storage-root <chemin>]
      Échange le code de pairing (affiché par l'UI/CLI Memoria) contre un token
      d'instance, le sauvegarde dans ~/.memoria/credentials/, puis affiche les
      commandes d'enregistrement pour Claude Code et Codex.

  memoria-mcp serve --instance <id> [--storage-root <chemin>]
      Démarre le serveur MCP stdio de cet agent (lancé par Claude Code/Codex,
      pas à la main). Relaye memoria_recall / memoria_store_fact /
      memoria_capture_turn / memoria_set_context vers le daemon local.

Options :
  --code <XXXX-XXXX>        code de pairing one-shot (connect)
  --instance <id>           identifiant d'instance issu du pairing (serve)
  --storage-root <chemin>   racine de stockage Memoria (défaut : config.toml)
  -h, --help                cette aide
`

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case 'connect': {
    const { values } = parseArgs({
      args: rest,
      options: {
        code: { type: 'string' },
        'storage-root': { type: 'string' },
      },
    })
    if (!values.code) {
      console.error('memoria-mcp connect : --code XXXX-XXXX requis (affiché par l’UI Memoria)')
      process.exit(2)
    }
    try {
      const result = await connect({ code: values.code, storageRoot: values['storage-root'] })
      console.log(result.message)
    } catch (err) {
      console.error(`memoria-mcp connect : ${(err as Error).message}`)
      process.exit(1)
    }
    break
  }

  case 'serve': {
    const { values } = parseArgs({
      args: rest,
      options: {
        instance: { type: 'string' },
        'storage-root': { type: 'string' },
      },
    })
    if (!values.instance) {
      console.error('memoria-mcp serve : --instance <id> requis (voir memoria-mcp connect)')
      process.exit(2)
    }
    try {
      await serve({ instanceId: values.instance, storageRoot: values['storage-root'] })
    } catch (err) {
      console.error(`memoria-mcp serve : ${(err as Error).message}`)
      process.exit(1)
    }
    break
  }

  case undefined:
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP)
    break

  default:
    console.error(`memoria-mcp : commande inconnue « ${command} »\n`)
    console.error(HELP)
    process.exit(2)
}
