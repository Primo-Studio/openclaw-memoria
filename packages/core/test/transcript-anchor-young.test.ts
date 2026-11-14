/**
 * Ancre d'un fichier importé tout jeune (contre-vérification du 14/11) : une
 * fenêtre déjà extraite AILLEURS (rappel commun de fin de sous-agent) ne doit
 * pas faire sauter le début d'un fichier qu'aucun passage n'a plafonné.
 * Données fictives.
 */
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Memoria } from '../src/engine/memoria.js'
import { importTranscripts } from '../src/migration/import-transcripts.js'
class Rec { name = 'fake'; model = 'fake'; prompts: string[] = []; isAvailable() { return Promise.resolve(true) } complete(o: { prompt: string }) { this.prompts.push(o.prompt); return Promise.resolve('{"facts":[]}') } }
let c = 0
const ts = () => new Date(Date.UTC(2026, 0, 1, 10, 0, c++)).toISOString()
const base = { sessionId: 's', cwd: '/fictif', version: '2.0.0', isSidechain: false }
const U = (t: string) => JSON.stringify({ ...base, type: 'user', timestamp: ts(), origin: { kind: 'human' }, message: { role: 'user', content: t } })
const A = (t: string) => JSON.stringify({ ...base, type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
const pairs = (tag: string, n: number) => Array.from({ length: n }, (_, i) => [U(`${tag} q${i}`), A(`${tag} r${i}`)]).flat()
const shared = [U('Rappel commun 0'), A('Accusé 0'), U('Rappel commun 1'), A('Accusé 1'), U('Rappel commun 2'), A('Accusé 2')]
it('fichier importé tout jeune, puis une fenêtre connue ailleurs : son début est envoyé', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zz-'))
  const fake = new Rec()
  const m = Memoria.init({ storageRoot: join(root, 's'), configPath: join(root, 'c.toml'), llm: { extraction: fake as never }, secretsVault: 'aes-vault' })
  try {
    const inst = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    const opts = { memoria: m, instanceId: inst, extraction: fake as never, tailQuietMs: 0 }
    const a = join(root, 'a.jsonl'); writeFileSync(a, [...pairs('A', 3), ...shared].join('\n') + '\n')
    await importTranscripts({ ...opts, files: [a] })
    const b = join(root, 'b.jsonl'); writeFileSync(b, pairs('B-debut', 1).join('\n') + '\n')
    await importTranscripts({ ...opts, files: [b] })
    appendFileSync(b, [...pairs('B-idee', 5), ...shared].join('\n') + '\n')
    utimesSync(b, new Date(Date.now() - 3.6e6), new Date(Date.now() - 3.6e6))
    fake.prompts = []
    await importTranscripts({ ...opts, files: [b] })
    expect(fake.prompts.some(p => p.includes('B-idee'))).toBe(true)
  } finally { m.close(); rmSync(root, { recursive: true, force: true }) }
})
