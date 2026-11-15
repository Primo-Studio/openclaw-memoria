/**
 * Provenance du tri : date de la conversation (fichier, archive, état
 * d'import, métadonnées, import) et origine (session ou sous-agent).
 * Données fictives.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { firstTimestamp, originOf, PROVENANCE_HEAD_BYTES } from '../src/index.js'
import { ensureSource, seedPending, setupTriage, triageRow, writeTranscript, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

describe('premier horodatage', () => {
  it('lit le premier horodatage valide (Claude Code) et l’epoch de Codex', async () => {
    env = setupTriage()
    const cc = join(env.root, 'cc.jsonl')
    writeTranscript(cc, [{ role: 'user', text: 'Bonjour', ts: '2026-02-03T04:05:06.000Z' }])
    expect(await firstTimestamp(cc)).toBe('2026-02-03T04:05:06.000Z')
    const codex = join(env.root, 'history.jsonl')
    writeFileSync(codex, JSON.stringify({ session_id: 's', ts: 1767225600, text: 'salut' }) + '\n')
    expect(await firstTimestamp(codex)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('ne lit que le début du fichier (64 Ko)', async () => {
    env = setupTriage()
    const big = join(env.root, 'big.jsonl')
    const filler = JSON.stringify({ type: 'summary', summary: 'x'.repeat(1000) })
    const lines = Array.from({ length: Math.ceil(PROVENANCE_HEAD_BYTES / filler.length) + 5 }, () => filler)
    lines.push(JSON.stringify({ type: 'user', timestamp: '2026-02-03T04:05:06.000Z', message: { role: 'user', content: 'tard' } }))
    writeFileSync(big, lines.join('\n'))
    expect(await firstTimestamp(big)).toBeNull()
  })

  it('origine : un chemin sous /subagents/ est un sous-agent', () => {
    expect(originOf('/x/projets/p/s1/subagents/agent-1.jsonl')).toBe('sous-agent')
    expect(originOf('/x/projets/p/s1.jsonl')).toBe('session')
    expect(originOf(null)).toBeNull()
  })
})

describe('date de la conversation pendant un passage', () => {
  it('fichier, puis archive, puis état d’import, puis métadonnées, puis import ; capture directe : sa date de création', async () => {
    env = setupTriage()
    const live = join(env.claudeDir, 'p', 'vivante.jsonl')
    writeTranscript(live, [{ role: 'user', text: 'a', ts: '2026-03-01T10:00:00.000Z' }])
    const archivedPath = join(env.claudeDir, 'p', 'archivee.jsonl')
    mkdirSync(join(env.archiveDir, 'p'), { recursive: true })
    writeTranscript(join(env.archiveDir, 'p', 'archivee.jsonl'), [{ role: 'user', text: 'b', ts: '2026-03-02T10:00:00.000Z' }])
    const gone = join(env.claudeDir, 'p', 'disparue.jsonl')
    env.db()
      .prepare("INSERT INTO transcript_file_state (path, size, mtime_ms, source_hash, updated_at) VALUES (?, 1, ?, 'h', '2026-01-01')")
      .run(gone, Date.parse('2026-03-03T10:00:00.000Z'))
    const chatSource = ensureSource(env.db(), 'chatgpt:conv-fictive', { first_message_at: '2026-03-04T10:00:00.000Z' })

    const a = seedPending(env, 'Le dossier 1 est rangé chez Nimbus', { path: live })
    const b = seedPending(env, 'Le dossier 2 est rangé chez Nimbus', { path: archivedPath })
    const c = seedPending(env, 'Le dossier 3 est rangé chez Nimbus', { path: gone })
    const d = seedPending(env, 'Le dossier 4 est rangé chez Nimbus', { path: 'chatgpt:conv-fictive', sourceId: chatSource })
    const e = seedPending(env, 'Le dossier 5 est rangé chez Nimbus', { path: join(env.claudeDir, 'p', 'inconnue.jsonl') })
    const f = env.m.storeFact({ instance: env.instance, content: 'Le dossier 6 est rangé chez Nimbus' })

    await env.m.triage.run()
    const at = (id: string): unknown[] => {
      const r = triageRow(env.db(), id)!
      return [r.conversation_at, r.conversation_at_source]
    }
    expect(at(a)).toEqual(['2026-03-01T10:00:00.000Z', 'fichier'])
    expect(at(b)).toEqual(['2026-03-02T10:00:00.000Z', 'archive'])
    expect(at(c)).toEqual(['2026-03-03T10:00:00.000Z', 'etat'])
    expect(at(d)).toEqual(['2026-03-04T10:00:00.000Z', 'metadata'])
    expect(at(e)).toEqual(['2026-01-02T03:04:05.000Z', 'import'])
    expect(at(f.id)).toEqual([f.created_at, 'creation'])
  })
})
