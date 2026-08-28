/**
 * GET /v1/admin/revisions renvoie les DEUX souvenirs en cause, pas des ids.
 *
 * POURQUOI : l'écran Révisions demande d'arbitrer (« garder le récent » /
 * « écarter la proposition ») ; sans le texte des souvenirs, la question n'a
 * pas de sens. Ce test verrouille le contrat HTTP côté daemon : texte,
 * catégorie, date, agent d'origine et état pour l'ancien ET le remplaçant.
 *
 * Daemon réel sur 127.0.0.1, stockage en tmpdir, aucun LLM.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon
let instanceId: string
let instanceToken: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-revisions-route-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair('claude-code')
  const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
  instanceId = done.assistant_instance_id
  instanceToken = done.instance_token
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

async function call(
  path: string,
  body: unknown,
  token: string,
  method = 'POST',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const adminGet = (path: string) => call(path, undefined, daemon.state.admin_token, 'GET')
const adminPost = (path: string, body: unknown) => call(path, body, daemon.state.admin_token)
const agentPost = (path: string, body: unknown) => call(path, body, instanceToken)

/** Un souvenir tel que la route le rend (miroir de RevisionFactDetail). */
interface RouteFact {
  id: string
  fact: string
  category: string
  created_at: string
  assistant_instance_id: string | null
  lifecycle_state: string
  superseded: number
}

interface RouteProposal {
  id: string
  fact_id: string
  kind: string
  reason: string
  replacement_fact_id: string | null
  fact: RouteFact | null
  replacement: RouteFact | null
}

describe('GET /v1/admin/revisions', () => {
  it('une contradiction est rendue avec le TEXTE des deux souvenirs', async () => {
    const older = await agentPost('/v1/memory/store_fact', {
      content: 'Le port du serveur de production est 8080',
      category: 'technique',
    })
    expect(older.status).toBe(200)
    // Deux dates distinctes : c'est le PLUS RÉCENT qui remplace l'ancien.
    await new Promise(resolve => setTimeout(resolve, 5))
    const newer = await agentPost('/v1/memory/store_fact', {
      content: 'Le port du serveur de production est 9090',
      category: 'technique',
    })
    expect(newer.status).toBe(200)

    expect((await adminPost('/v1/admin/propose_revisions', { instance: instanceId })).status).toBe(200)
    const res = await adminGet(`/v1/admin/revisions?instance=${encodeURIComponent(instanceId)}`)
    expect(res.status).toBe(200)

    const proposals = res.json['proposals'] as RouteProposal[]
    expect(proposals.length).toBeGreaterThanOrEqual(1)
    const p = proposals.find(x => x.kind === 'contradicted')!
    expect(p).toBeTruthy()

    // Le souvenir qui serait RANGÉ : lisible, daté, attribué, avec son état.
    expect(p.fact).not.toBeNull()
    expect(p.fact!.fact).toBe('Le port du serveur de production est 8080')
    expect(p.fact!.id).toBe(p.fact_id)
    expect(p.fact!.category).toBe('technique')
    expect(p.fact!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(p.fact!.assistant_instance_id).toBe(instanceId)
    expect(p.fact!.lifecycle_state).toBe('active')
    expect(p.fact!.superseded).toBe(0)

    // Le souvenir CONSERVÉ : celui qu'on garde en acceptant.
    expect(p.replacement).not.toBeNull()
    expect(p.replacement!.fact).toBe('Le port du serveur de production est 9090')
    expect(p.replacement!.id).toBe(p.replacement_fact_id)
  })

  it('instance inconnue → liste vide, pas une erreur', async () => {
    const res = await adminGet('/v1/admin/revisions?instance=inconnue@nulle-part')
    expect(res.status).toBe(200)
    expect(res.json['proposals']).toEqual([])
  })

  it('instance absente → 400 explicite', async () => {
    const res = await adminGet('/v1/admin/revisions')
    expect(res.status).toBe(400)
  })
})
