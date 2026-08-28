/**
 * POST /v1/admin/pair — la commande de connexion affichée doit viser LE BON
 * stockage. Avec un stockage non standard (init/pair --storage-root, config
 * ailleurs), `memoria-mcp connect --code X` sans `--storage-root` résolvait
 * ~/.memoria/config.toml → autre daemon (ou un daemon neuf spawné dans
 * ~/.memoria/data) → « code de pairing invalide ou expiré » alors que le code
 * était valide sur le bon daemon.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let dir: string
let daemon: RunningDaemon | null = null

afterEach(async () => {
  if (daemon) await daemon.close()
  daemon = null
  rmSync(dir, { recursive: true, force: true })
})

describe('commande de connexion et stockage', () => {
  it('stockage non standard → « --storage-root <racine> » dans la commande', async () => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-pair-'))
    const root = join(dir, 'data')
    daemon = await startDaemon({ storageRoot: root, configPath: join(dir, 'config.toml'), llm: { extraction: null } })
    const paired = await new DaemonClient(daemon.state, daemon.state.admin_token).pair('codex')
    expect(paired.command).toMatch(/connect --code [A-Z0-9]{4}-[A-Z0-9]{4}/)
    expect(paired.command).toContain(`--storage-root ${root}`)
  })

  it('stockage par défaut (~/.memoria/data) → commande sans --storage-root', async () => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-pair-home-'))
    const savedHome = process.env['HOME']
    process.env['HOME'] = dir // defaultStorageRoot() suit HOME au moment de l'appel
    try {
      const root = join(dir, '.memoria', 'data')
      mkdirSync(root, { recursive: true })
      daemon = await startDaemon({ storageRoot: root, configPath: join(dir, '.memoria', 'config.toml'), llm: { extraction: null } })
      const paired = await new DaemonClient(daemon.state, daemon.state.admin_token).pair('codex')
      expect(paired.command).not.toContain('--storage-root')
    } finally {
      process.env['HOME'] = savedHome
    }
  })
})
