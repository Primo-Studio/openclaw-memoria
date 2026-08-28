/**
 * La VALEUR d'un secret n'apparaît JAMAIS dans une réponse HTTP ni dans le
 * journal du daemon — même quand le coffre refuse l'écriture. Avant : le
 * Trousseau refusé faisait remonter `security add-generic-password … -w
 * <valeur>` en 500 (corps de réponse + err.stack dans daemon.log).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretProvider } from '@memoria/core'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

const VALUE = 'sk-proj-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn'

let root: string
let daemon: RunningDaemon
let instanceToken: string
let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

/** Coffre AES qui refuse tout : aucun repli possible → échec bruyant attendu. */
const refusing: SecretProvider = {
  kind: 'aes-vault',
  isAvailable: () => true,
  set: (name, value) => {
    throw new Error(`Command failed: /usr/bin/security add-generic-password -U -s memoria -a ${name} -w ${value}`)
  },
  get: () => null,
  delete: () => {},
  locationFor: name => `vault:secrets.enc#${name}`,
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-secrets-http-'))
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  daemon = await startDaemon({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: null },
    secretProvider: refusing,
  })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  instanceToken = (await new DaemonClient(daemon.state).completePairing(paired.pairing_code)).instance_token
})

afterEach(async () => {
  await daemon.close()
  errorSpy.mockRestore()
  warnSpy.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

async function memory(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instanceToken}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

function everythingLogged(): string {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls].map(c => c.map(String).join(' ')).join('\n')
}

describe('coffre refusé — jamais la valeur', () => {
  it('capture_turn → erreur annoncée, corps ET journal sans la valeur', async () => {
    const r = await memory('/v1/memory/capture_turn', { messages: [{ role: 'user', content: `ma clé est ${VALUE}` }] })
    expect(r.status).toBe(500)
    expect(r.text).not.toContain(VALUE)
    expect(r.text).toContain('mise au coffre')
    expect(everythingLogged()).not.toContain(VALUE)
  })

  it('store_fact → idem', async () => {
    const r = await memory('/v1/memory/store_fact', { content: `la clé OpenAI du studio est ${VALUE}` })
    expect(r.status).toBe(500)
    expect(r.text).not.toContain(VALUE)
    expect(everythingLogged()).not.toContain(VALUE)
  })
})
