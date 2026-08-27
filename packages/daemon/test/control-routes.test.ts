/**
 * Routes admin de contrôle (GET /control, POST /autostart) avec launchd
 * SIMULÉ par les hooks `control` — jamais de launchctl réel.
 *
 * Bug d'origine : POST /v1/admin/autostart appelait enableAutostart /
 * disableAutostart DANS le process daemon. Quand ce daemon est l'instance
 * launchd, `launchctl bootout` est l'ordre de tuer ce même process — bloqué
 * dans execFileSync + sleepSync, SIGKILL après 5 s, close() jamais appelé,
 * réponse jamais envoyée, mémoire perdue jusqu'à relance manuelle. Depuis
 * un daemon direct, `bootstrap` lançait un second daemon qui butait sur le
 * verrou (boucle KeepAlive). Désormais le daemon répond puis PASSE LA MAIN
 * à la CLI détachée (`handover: true`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutostartStatus } from '@memoria/core'
import { startDaemon, type DaemonControlHooks, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon | null = null

const STATUS: AutostartStatus = {
  supported: true,
  installed: true,
  loaded: true,
  running: true,
  pid: 4242,
  runs: 1,
  last_exit_code: 0,
  plistPath: '/fake/fr.primo-studio.memoria.plist',
}

function fakeControl(supervised: boolean): DaemonControlHooks & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    isSupervised: () => supervised,
    autostartStatus: () => STATUS,
    enableAutostart: () => {
      calls.push('enable')
      return STATUS
    },
    disableAutostart: () => {
      calls.push('disable')
      return { ...STATUS, installed: false, loaded: false, running: false, pid: null }
    },
    handoverAutostart: (mode, storageRoot, configPath) => {
      calls.push(`handover:${mode}:${storageRoot}:${configPath}`)
    },
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-control-routes-'))
})

afterEach(async () => {
  await daemon?.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

async function boot(control: Partial<DaemonControlHooks>): Promise<RunningDaemon> {
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, control })
  return daemon
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon!.state.admin_token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.state.port}${path}`, { headers: { authorization: `Bearer ${daemon!.state.admin_token}` } })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('GET /v1/admin/control', () => {
  it('renvoie enabled, le statut launchd (sonde injectée) et le superviseur', async () => {
    await boot(fakeControl(true))
    const { status, json } = await get('/v1/admin/control')
    expect(status).toBe(200)
    expect(json['enabled']).toBe(true)
    expect(json['autostart']).toMatchObject({ loaded: true, running: true, pid: 4242 })
    expect(json['supervisor']).toBe('launchd')
    expect(json['storage']).toBeTruthy()
  })
})

describe('POST /v1/admin/autostart', () => {
  it('`{}` → 400, aucune action launchd (un corps sans booléen retirait le lancement auto)', async () => {
    const control = fakeControl(true)
    await boot(control)
    const r = await post('/v1/admin/autostart', {})
    expect(r.status).toBe(400)
    expect(String(r.json['error'])).toContain('enabled')
    expect(control.calls).toEqual([])
  })

  it('daemon supervisé + off → réponse handover:true, PUIS passation à la CLI ; jamais bootout ici', async () => {
    const control = fakeControl(true)
    await boot(control)
    const r = await post('/v1/admin/autostart', { enabled: false })
    expect(r.status).toBe(200)
    expect(r.json['handover']).toBe(true)
    expect(r.json['mode']).toBe('off')
    expect(control.calls).toEqual([`handover:off:${root}:${join(root, 'config.toml')}`])
  })

  it('daemon supervisé + on → idempotent : statut renvoyé, ni enable ni passation', async () => {
    const control = fakeControl(true)
    await boot(control)
    const r = await post('/v1/admin/autostart', { enabled: true })
    expect(r.status).toBe(200)
    expect(r.json['handover']).toBe(false)
    expect(control.calls).toEqual([])
  })

  it('daemon direct + on → passation (le verrou empêcherait launchd de démarrer le sien), jamais enable ici', async () => {
    const control = fakeControl(false)
    await boot(control)
    const r = await post('/v1/admin/autostart', { enabled: true })
    expect(r.status).toBe(200)
    expect(r.json['handover']).toBe(true)
    expect(control.calls).toEqual([`handover:on:${root}:${join(root, 'config.toml')}`])
  })

  it('daemon direct + off → disable en direct (aucun process à tuer), handover:false', async () => {
    const control = fakeControl(false)
    await boot(control)
    const r = await post('/v1/admin/autostart', { enabled: false })
    expect(r.status).toBe(200)
    expect(r.json['handover']).toBe(false)
    expect((r.json['autostart'] as AutostartStatus).installed).toBe(false)
    expect(control.calls).toEqual(['disable'])
  })

  it('passation impossible (CLI introuvable) → 500 explicite, jamais un ✓', async () => {
    const control = fakeControl(true)
    control.handoverAutostart = () => {
      throw new Error('passation impossible : CLI introuvable (/x/bin.js)')
    }
    await boot(control)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await post('/v1/admin/autostart', { enabled: false })
    expect(r.status).toBe(500)
    expect(String(r.json['error'])).toContain('CLI introuvable')
    err.mockRestore()
  })
})

/** Routes de mise à jour : git/npm/redémarrage SIMULÉS (hooks `updater`). */
describe('GET /v1/admin/version + POST /v1/admin/update', () => {
  const baseResult = { ok: true, is_git: true, before: 'aaa', after: 'aaa', changed: false, rebuilt: false, log: '', message: 'Déjà à jour.' }

  it('version : sha du dépôt (simulé) + version du daemon', async () => {
    await boot({})
    daemon = null
    daemon = await startDaemon({
      storageRoot: join(root, 'v'),
      configPath: join(root, 'config.toml'),
      llm: { extraction: null },
      updater: { currentVersion: async () => ({ version: '9.9.9', sha: 'abc1234', is_git: true }) },
    })
    const { status, json } = await get('/v1/admin/version')
    expect(status).toBe(200)
    expect(json).toMatchObject({ version: '9.9.9', sha: 'abc1234', is_git: true })
    expect(typeof json['daemon']).toBe('string')
  })

  it('« Déjà à jour » (rebuilt:false) → réponse telle quelle, AUCUN redémarrage', async () => {
    const restarts: string[] = []
    daemon = await startDaemon({
      storageRoot: root,
      configPath: join(root, 'config.toml'),
      llm: { extraction: null },
      updater: { pullAndBuild: async () => baseResult, scheduleRestart: r => restarts.push(r) },
    })
    const r = await post('/v1/admin/update', {})
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, rebuilt: false })
    await new Promise(res => setTimeout(res, 50))
    expect(restarts).toEqual([])
  })

  it('build effectué (rebuilt:true) → redémarrage planifié UNE fois, APRÈS la réponse (un hook qui lève ne change ni la réponse ni la vie du daemon)', async () => {
    const restarts: string[] = []
    daemon = await startDaemon({
      storageRoot: root,
      configPath: join(root, 'config.toml'),
      llm: { extraction: null },
      updater: {
        pullAndBuild: async () => ({ ...baseResult, after: 'bbb', changed: true, rebuilt: true, message: 'Mis à jour aaa → bbb.' }),
        // Le hook LÈVE : s'il était appelé avant sendJson, la route échouerait
        // en 500 — c'est ce qui prouve l'ordre. Appelé après, la réponse 200
        // est déjà partie et l'échec doit être journalisé, pas tuer le daemon
        // (un rejet non géré dans le .catch du handler = crash du process).
        scheduleRestart: r => {
          restarts.push(r)
          throw new Error('spawn sh EAGAIN (simulé)')
        },
      },
    })
    const r = await post('/v1/admin/update', {})
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, rebuilt: true })
    expect(restarts).toEqual([root])
    // le daemon a survécu à l'échec de planification et répond toujours
    const health = await get('/v1/health')
    expect(health.status).toBe(200)
  })

  it('échec (npm introuvable) → ok:false renvoyé au client, aucun redémarrage', async () => {
    const restarts: string[] = []
    daemon = await startDaemon({
      storageRoot: root,
      configPath: join(root, 'config.toml'),
      llm: { extraction: null },
      updater: {
        pullAndBuild: async () => ({ ...baseResult, ok: false, rebuilt: false, message: 'Échec de la mise à jour : npm est introuvable depuis le service Memoria.' }),
        scheduleRestart: r => restarts.push(r),
      },
    })
    const r = await post('/v1/admin/update', {})
    expect(r.status).toBe(200)
    expect(r.json['ok']).toBe(false)
    expect(String(r.json['message'])).toContain('npm est introuvable')
    expect(restarts).toEqual([])
  })
})
