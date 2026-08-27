#!/usr/bin/env node
/**
 * `memoria-daemon [--storage-root <path>] [--config <path>] [--port <n>]`
 * Processus de premier plan ; lancé détaché par ensureDaemon()/npx/app bureau.
 */
import { parseArgs } from 'node:util'
import { AUTOSTART_LABEL } from '@memoria/core'
import { startWithStandby } from './standby.js'

const { values } = parseArgs({
  options: {
    'storage-root': { type: 'string' },
    // Sans `--config`, le daemon lisait toujours ~/.memoria/config.toml, quel
    // que soit le fichier demandé à la CLI (kill-switch, LLM, synchro faux).
    config: { type: 'string' },
    port: { type: 'string' },
  },
})

// Sous launchd (XPC_SERVICE_NAME posé par lui), un verrou tenu par un daemon
// direct fait ATTENDRE le service au lieu de le faire boucler en exit 1.
const running = await startWithStandby(
  {
    storageRoot: values['storage-root'],
    configPath: values.config,
    port: values.port ? Number.parseInt(values.port, 10) : 0,
  },
  { supervised: process.env['XPC_SERVICE_NAME'] === AUTOSTART_LABEL },
)

// eslint-disable-next-line no-console
console.log(`memoria-daemon prêt sur 127.0.0.1:${running.state.port} (storage: ${running.memoria.paths.root})`)

const shutdown = (): void => {
  void running.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
