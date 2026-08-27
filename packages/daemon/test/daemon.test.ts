/**
 * Tests daemon : santé, auth 3 niveaux, pairing bout-en-bout par HTTP,
 * singleton lock-file. DoD P1 : « daemon démarre en singleton ».
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'memoria-daemon-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
})

afterEach(async () => {
  await daemon.close()
  rmSync(root, { recursive: true, force: true })
})

describe('daemon', () => {
  it('répond au health check', async () => {
    const client = new DaemonClient(daemon.state)
    const health = await client.health()
    expect(health?.ok).toBe(true)
    expect(health?.daemon_id).toBe(daemon.state.daemon_id)
  })

  it('singleton : un second daemon sur le même storage_root est refusé', async () => {
    await expect(startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })).rejects.toThrow(/déjà/)
  })

  it('admin sans token → 401 ; avec token → OK', async () => {
    const anonymous = new DaemonClient(daemon.state)
    await expect(anonymous.stats()).rejects.toThrow(/401/)

    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const stats = (await admin.stats()) as { instances: number }
    expect(stats.instances).toBe(0)
  })

  it('flux complet par HTTP : pair → complete → store → recall', async () => {
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('claude-code', 'Claude Code')
    expect(paired.pairing_code).toBeTruthy()

    // l'agent échange son code (sans aucun token)
    const anonymous = new DaemonClient(daemon.state)
    const done = await anonymous.completePairing(paired.pairing_code)
    expect(done.instance_token).toBeTruthy()

    // puis utilise son token d'instance
    const agent = new DaemonClient(daemon.state, done.instance_token)
    await agent.storeFact({ content: 'le mot de passe wifi du studio est dans le coffre', category: 'infra' })
    const recall = await agent.recall({ query: 'wifi studio' })
    expect(recall.items.length).toBe(1)

    // un token bidon est rejeté
    const intruder = new DaemonClient(daemon.state, 'token-bidon')
    await expect(intruder.recall({ query: 'wifi' })).rejects.toThrow(/401/)
  })

  it('boucle de feedback : le signal d’usage atteint la base et modifie le poids', async () => {
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('claude-code', 'Claude Code')
    const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
    const agent = new DaemonClient(daemon.state, done.instance_token)

    await agent.storeFact({ content: 'Néto préfère le local-first pour Primo', category: 'preference' })
    const recall = await agent.recall({ query: 'local-first' })
    const factId = recall.items[0]?.id
    expect(factId).toBeTruthy()

    const post = async (body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${daemon.state.port}/v1/memory/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${done.instance_token}` },
        body: JSON.stringify(body),
      })

    const res = await post({ fact_ids: [factId], used: true })
    expect(res.status).toBe(200)
    const result = (await res.json()) as { updated: string[]; domains: string[] }
    // Le fait a bien été touché, et son domaine crédité en expertise.
    expect(result.updated).toEqual([factId])
    expect(result.domains).toEqual(['preference'])

    // Contrat d'entrée : fact_ids et used sont obligatoires.
    expect((await post({ used: true })).status).toBe(400)
    expect((await post({ fact_ids: [factId] })).status).toBe(400)

    // Un id inconnu ne fait rien — et ne casse rien.
    const unknown = await post({ fact_ids: ['fact-inexistant'], used: false })
    expect(unknown.status).toBe(200)
    expect(((await unknown.json()) as { updated: string[] }).updated).toEqual([])
  })

  it('routes admin de maintenance : corriger, fusionner, jamais utilisés', async () => {
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('claude-code', 'Claude Code')
    const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
    const agent = new DaemonClient(daemon.state, done.instance_token)
    const instance = paired.assistant_instance_id

    await agent.storeFact({ content: 'Le déploiement du studio passe par Hello-Primo', category: 'process' })
    const recall = await agent.recall({ query: 'déploiement studio' })
    const factId = recall.items[0]!.id

    const call = async (path: string, body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${daemon.state.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.state.admin_token}` },
        body: JSON.stringify(body),
      })

    // CORRIGER : l'ancien texte n'est pas écrasé, il est remplacé.
    const corrected = await call('/v1/admin/correct_fact', {
      instance,
      fact_id: factId,
      content: 'Le déploiement du studio passe par Vercel',
    })
    expect(corrected.status).toBe(200)
    const { replacement } = (await corrected.json()) as { replacement: { id: string; fact: string } | null }
    expect(replacement?.fact).toBe('Le déploiement du studio passe par Vercel')

    // FUSIONNER : refuse un fait conservé déjà supersédé (chaîne cassée).
    const broken = await call('/v1/admin/merge_facts', {
      instance,
      keep_fact_id: factId,
      merge_fact_ids: [replacement!.id],
    })
    expect(broken.status).toBeGreaterThanOrEqual(400)

    // JAMAIS UTILISÉS : la correction n'a encore servi à personne.
    const never = await fetch(
      `http://127.0.0.1:${daemon.state.port}/v1/admin/never_used?instance=${instance}`,
      { headers: { authorization: `Bearer ${daemon.state.admin_token}` } },
    )
    expect(never.status).toBe(200)
    expect(((await never.json()) as { facts: unknown[] }).facts.length).toBeGreaterThan(0)

    // Contrat d'entrée : chaque champ requis est vérifié.
    expect((await call('/v1/admin/correct_fact', { instance, fact_id: factId })).status).toBe(400)
    expect((await call('/v1/admin/merge_facts', { instance })).status).toBe(400)
  })

  it('révocation par l’admin coupe l’agent', async () => {
    const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
    const paired = await admin.pair('codex')
    const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
    const agent = new DaemonClient(daemon.state, done.instance_token)
    await agent.storeFact({ content: 'note temporaire' })

    await admin.revoke(paired.assistant_instance_id)
    await expect(agent.recall({ query: 'note' })).rejects.toThrow(/401/)
  })
})
