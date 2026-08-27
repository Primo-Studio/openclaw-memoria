/**
 * La quarantaine (faits DORMANTS, jamais validés) est promise « invisible au
 * recall jusqu'à approbation ». La route recall relayait `...body` tel quel :
 * un agent pouvait poser `include_dormant: true` dans le corps HTTP et lire la
 * quarantaine entière. Le corps est désormais filtré sur une liste blanche.
 */
import DatabaseCtor from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-dormant-guard-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

describe('POST /v1/memory/recall', () => {
  it('include_dormant dans le corps est ignoré : la quarantaine reste invisible', async () => {
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('codex')
    const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
    const agent = new DaemonClient(daemon.state, done.instance_token)
    const stored = (await agent.storeFact({ content: 'Néto travaille chez Primo Studio à Saint-Laurent' })) as { fact: { id: string } }

    // On met le fait en quarantaine directement en base (comme un import).
    const db = new DatabaseCtor(daemon.memoria.paths.assistantDb(paired.assistant_instance_id))
    db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(stored.fact.id)
    db.close()

    const normal = await agent.recall({ query: 'Primo Studio' })
    expect(normal.items).toEqual([])
    const sneaky = await agent.recall({ query: 'Primo Studio', include_dormant: true })
    expect(sneaky.items).toEqual([])
    // les champs légitimes passent toujours
    const limited = await agent.recall({ query: 'Primo Studio', limit: 1, expand_graph: false })
    expect(limited.items).toEqual([])
  })
})
