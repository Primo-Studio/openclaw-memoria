/**
 * Jonction des deux voies du partage d'équipe : le rôle `team` d'un Mac
 * (droit d'écriture des agents sur `org`, alias `org`) ET la synchro (reprise
 * de l'identité de l'org du hub au join). Chaque voie a ses tests ; ici, ce
 * qui n'existe qu'une fois les deux branchées :
 *  - un Mac `team` dont les agents ont déjà un droit sur l'org local se relie
 *    sans erreur, et le droit suit l'org repris ;
 *  - l'alias `org` vise l'org repris, avant comme après un redémarrage ;
 *  - un fait écrit par un agent du collègue est rappelé `org` sur le hub ;
 *  - un hub qui porte deux scopes org ne fait voyager que celui de l'alias.
 *
 * Données FICTIVES uniquement (dépôt public).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compactRecall, Memoria, type FetchLike } from '../src/index.js'

const HUB_ADDR = '10.20.30.40:47600'

let dir: string
const opened: Memoria[] = []

/** Memoria isolé ; `machine` écrit `[sharing] machine` dans sa config. */
function mk(name: string, machine?: 'owner' | 'team'): Memoria {
  const configPath = join(dir, `${name}.toml`)
  if (machine) writeFileSync(configPath, `[sharing]\nmachine = "${machine}"\n`)
  const m = Memoria.init({ storageRoot: join(dir, name), configPath, llm: { extraction: null }, secretsVault: 'aes-vault' })
  opened.push(m)
  return m
}

/** Redémarrage : même stockage, même fichier de config (réécrit par le join). */
function reopen(m: Memoria, name: string): Memoria {
  m.close()
  opened.splice(opened.indexOf(m), 1)
  return mk(name)
}

/** Le hub derrière le même répartiteur que le daemon. */
function hubFetch(hub: Memoria): FetchLike {
  return async (url, init) => {
    const u = new URL(url)
    const h = init.headers ?? {}
    const r = hub.sync.handleHttp({
      method: init.method,
      pathWithQuery: u.pathname + u.search,
      body: init.body ?? '',
      bearer: (h['authorization'] ?? '').replace(/^Bearer\s+/, ''),
      sig: h['x-memoria-sig'],
      ts: h['x-memoria-ts'],
      nonce: h['x-memoria-nonce'],
      remoteHost: '10.20.30.41',
    })
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  }
}

async function joinTo(spoke: Memoria, hub: Memoria): Promise<void> {
  const inv = hub.sync.invite('Mac de l’équipe')
  await spoke.sync.join({ hub: HUB_ADDR, code: inv.code, fetchImpl: hubFetch(hub) })
}

function orgs(m: Memoria) {
  return m.registry.listScopes().filter(s => s.type === 'org')
}

function policyCount(m: Memoria): number {
  return (m.registry.db.prepare('SELECT COUNT(*) AS c FROM assistant_scope_policy').get() as { c: number }).c
}

function hasFact(m: Memoria, scopeId: string, content: string): boolean {
  const store = m.sharedContentStore(scopeId)
  if (!store) return false
  return !!store.db.prepare('SELECT 1 FROM facts WHERE scope_id = ? AND fact = ? AND deleted_at IS NULL').get(scopeId, content)
}

/** Hub = Mac du propriétaire (rôle par défaut), avec un fait d'équipe fictif dans son org. */
function makeHub(name = 'hub'): Memoria {
  const hub = mk(name)
  hub.configureSyncHub('127.0.0.1:47600')
  const writer = hub.pairAssistant({ type: 'claude-code', display_name: 'Agent du hub' })
  const org = hub.teamScope()!
  hub.setScopeAccess(writer.assistant_id, org.id, { can_read: true, can_write: true })
  hub.storeFact({ instance: writer.assistant_instance_id, scope: org.id, content: 'Essai fictif : les exports passent par le dossier Livraisons' })
  return hub
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-team-sync-'))
})

afterEach(() => {
  for (const m of opened.splice(0)) m.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Mac `team` relié au hub', () => {
  it('le join réussit avec des agents déjà dotés du droit org ; le droit suit, OpenClaw reste sans rien', async () => {
    const hub = makeHub()
    const spoke = mk('spoke', 'team')
    const cc = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent de montage' })
    const bot = spoke.pairAssistant({ type: 'openclaw', display_name: 'Bot de canal' })
    const localOrg = spoke.teamScope()!
    // le rôle `team` a posé lecture + écriture sur l'org LOCAL à l'appairage
    expect(spoke.registry.getPolicy(cc.assistant_id, localOrg.id)).toMatchObject({ can_read: true, can_write: true })
    expect(spoke.registry.getPolicy(bot.assistant_id, localOrg.id)).toBeNull()
    spoke.declareFact({ instance: cc.assistant_instance_id, content: 'Essai fictif : le gabarit de titres est dans Modèles', scope: 'org' })
    const policiesBefore = policyCount(spoke)

    await joinTo(spoke, hub)

    const hubOrg = hub.teamScope()!
    const adopted = spoke.teamScope()!
    expect(adopted.id).toBe(hubOrg.id)
    expect(adopted.org_id).toBe(spoke.registry.ownCompany()!.id)
    expect(orgs(spoke)).toHaveLength(1)
    expect(spoke.registry.getScope(localOrg.id)).toBeNull()
    // le droit d'écriture a suivi l'id du hub, sans ligne en plus ni en moins
    expect(policyCount(spoke)).toBe(policiesBefore)
    expect(spoke.registry.getPolicy(cc.assistant_id, hubOrg.id)).toMatchObject({ can_read: true, can_write: true })
    expect(spoke.registry.getPolicy(bot.assistant_id, hubOrg.id)).toBeNull()
    // le fait écrit avant le join est sous l'id du hub, à côté de celui reçu
    expect(hasFact(spoke, hubOrg.id, 'Essai fictif : le gabarit de titres est dans Modèles')).toBe(true)
    expect(hasFact(spoke, hubOrg.id, 'Essai fictif : les exports passent par le dossier Livraisons')).toBe(true)

    // l'alias `org` vise l'org repris ; OpenClaw y est toujours refusé
    const after = spoke.declareFact({ instance: cc.assistant_instance_id, content: 'Essai fictif : les sous-titres se calent à la frame', scope: 'org' }).fact!
    expect(after.scope_id).toBe(hubOrg.id)
    expect(() => spoke.declareFact({ instance: bot.assistant_instance_id, content: 'Essai fictif : note du bot', scope: 'org' })).toThrow(/espace d'équipe/)
  })

  it('un fait écrit par l’agent du collègue arrive au hub et y est rappelé `org`', async () => {
    const hub = makeHub()
    const spoke = mk('spoke', 'team')
    const cc = spoke.pairAssistant({ type: 'codex', display_name: 'Agent de publication' })
    await joinTo(spoke, hub)
    spoke.declareFact({ instance: cc.assistant_instance_id, content: 'Essai fictif : la fiche du store se relit avant envoi', scope: 'org' })
    await spoke.sync.syncAll(hubFetch(hub))

    const hubOrg = hub.teamScope()!
    expect(hasFact(hub, hubOrg.id, 'Essai fictif : la fiche du store se relit avant envoi')).toBe(true)
    const reader = hub.pairAssistant({ type: 'claude-code', display_name: 'Lecteur du hub' })
    hub.setScopeAccess(reader.assistant_id, hubOrg.id, { can_read: true })
    const rec = hub.recall({ instance: reader.assistant_instance_id, query: 'Essai fictif fiche store relit' })
    const item = rec.items.find(i => i.content === 'Essai fictif : la fiche du store se relit avant envoi')
    expect(item).toBeDefined()
    expect(item!.scope_type).toBe('org')
    const compact = compactRecall(rec).items as Array<Record<string, unknown>>
    expect(compact.find(i => i['id'] === item!.id)!['scope']).toBe('org')
  })

  it('après redémarrage : toujours `team`, un seul org, et un agent appairé ensuite reçoit le droit sur l’org repris', async () => {
    const hub = makeHub()
    let spoke = mk('spoke', 'team')
    const cc = spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent de montage' })
    await joinTo(spoke, hub)
    const hubOrgId = hub.teamScope()!.id
    const policiesBefore = policyCount(spoke)

    spoke = reopen(spoke, 'spoke')
    expect(spoke.machineRole()).toBe('team') // le join réécrit la config sans perdre [sharing]
    expect(orgs(spoke).map(s => s.id)).toEqual([hubOrgId])
    expect(spoke.teamScope()!.id).toBe(hubOrgId)
    expect(policyCount(spoke)).toBe(policiesBefore) // le droit du démarrage ne double rien
    expect(spoke.registry.getPolicy(cc.assistant_id, hubOrgId)?.can_write).toBe(true)

    const codex = spoke.pairAssistant({ type: 'codex', display_name: 'Agent de publication' })
    expect(spoke.registry.getPolicy(codex.assistant_id, hubOrgId)).toMatchObject({ can_read: true, can_write: true })
  })
})

describe('hub qui porte deux scopes org', () => {
  it('seul l’org de l’alias voyage, et le Mac relié le reprend une seule fois', async () => {
    const hub = makeHub()
    const team = hub.teamScope()!
    // doublon laissé par un ancien code : ligne org sans organisation, plus récente
    hub.registry.db
      .prepare("INSERT INTO memory_scopes (id, type, name, created_at) VALUES ('org-doublon-fictif', 'org', 'org:doublon-fictif', '2999-01-01T00:00:00.000Z')")
      .run()
    expect(orgs(hub)).toHaveLength(2)
    expect(hub.teamScope()!.id).toBe(team.id)
    expect(hub.sync.syncScopes().map(s => s.id)).toEqual([team.id])

    const spoke = mk('spoke', 'team')
    spoke.pairAssistant({ type: 'claude-code', display_name: 'Agent de montage' })
    await joinTo(spoke, hub)
    expect(hub.sync.peers().find(p => p.role === 'spoke')!.allowed_scopes).toEqual([team.id])
    expect(orgs(spoke).map(s => s.id)).toEqual([team.id])
    expect(spoke.teamScope()!.id).toBe(team.id)
    expect(hasFact(spoke, team.id, 'Essai fictif : les exports passent par le dossier Livraisons')).toBe(true)
  })
})
