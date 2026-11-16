/**
 * Espace d'équipe (`org`) : l'alias `org`, les garde-fous d'écriture d'un
 * agent, le partage et la promotion du tri vers l'équipe, le filtre
 * « candidats équipe », le rôle de la machine (`[sharing] machine`) et le
 * rendu `org` au rappel. Données fictives uniquement (dépôt public).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compactRecall,
  formatRecallBlocks,
  Memoria,
  TEAM_REFUSED_RUBRIQUES,
  TEAM_SHARE_GENRES,
  type Genre,
  type PairAssistantResult,
} from '../src/index.js'
import { seedPending, setupTriage, type TriageEnv } from './triage-fixtures.js'

const roots: string[] = []
const opened: Memoria[] = []
let env: TriageEnv | undefined

afterEach(() => {
  env?.close()
  env = undefined
  for (const m of opened.splice(0)) {
    try {
      m.close()
    } catch {
      /* déjà fermé */
    }
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** Memoria isolé ; `machine` écrit `[sharing] machine` dans sa config. */
function open(opts: { machine?: 'owner' | 'team'; root?: string } = {}): { m: Memoria; root: string } {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'memoria-org-'))
  if (!opts.root) roots.push(root)
  const configPath = join(root, 'config.toml')
  if (opts.machine) writeFileSync(configPath, `[sharing]\nmachine = "${opts.machine}"\n`)
  const m = Memoria.init({ storageRoot: join(root, 'data'), configPath, llm: { extraction: null }, secretsVault: 'aes-vault' })
  opened.push(m)
  return { m, root }
}

function orgScope(m: Memoria) {
  const scope = m.teamScope()
  if (!scope) throw new Error('espace d’équipe absent')
  return scope
}

/** Donne le droit d'écriture sur l'espace d'équipe (comme l'écran Partage). */
function grantOrg(m: Memoria, agent: PairAssistantResult): void {
  m.setScopeAccess(agent.assistant_id, orgScope(m).id, { can_read: true, can_write: true })
}

describe("alias `org` : l'espace de l'entreprise, quel que soit son identifiant", () => {
  it('store_fact vers `org` arrive dans le scope org:<uuid> de own_company', () => {
    const { m } = open()
    const agent = m.pairAssistant({ type: 'claude-code' })
    grantOrg(m, agent)
    const fact = m.declareFact({ instance: agent.assistant_instance_id, content: 'Les rendus du studio fictif sortent en ProRes 422', scope: 'org' }).fact!
    const scope = orgScope(m)
    expect(scope.name).toMatch(/^org:/)
    expect(fact.scope_id).toBe(scope.id)
    expect(fact.org_id).toBe(m.registry.ownCompany()!.id)
  })

  it("retrouvé même si l'organisation et le scope ont été renommés", () => {
    const { m } = open()
    const agent = m.pairAssistant({ type: 'codex' })
    grantOrg(m, agent)
    const before = orgScope(m).id
    m.registry.db.prepare("UPDATE organizations SET name = 'Atelier Nimbus' WHERE org_type = 'own_company'").run()
    m.registry.db.prepare("UPDATE memory_scopes SET name = 'org:renomme' WHERE type = 'org'").run()
    expect(orgScope(m).id).toBe(before)
    const fact = m.declareFact({ instance: agent.assistant_instance_id, content: 'Le gabarit de sous-titres est dans le dossier Modèles', scope: 'org' }).fact!
    expect(fact.scope_id).toBe(before)
  })

  it("repris d'un hub : l'org adopté reste la cible, même après le doublon recréé au redémarrage", () => {
    const first = open()
    first.m.registry.adoptScope({ id: 'org-du-hub-fictif', type: 'org', name: 'org:hub-fictif' })
    expect(orgScope(first.m).id).toBe('org-du-hub-fictif')
    first.m.close()

    // Au redémarrage, bootstrap recrée un org local à côté (même org_id).
    const again = open({ root: first.root })
    const orgs = again.m.registry.listScopes().filter(s => s.type === 'org')
    expect(orgs.length).toBe(2)
    expect(orgScope(again.m).id).toBe('org-du-hub-fictif')

    // Pair hub déclaré : c'est son scope autorisé qui l'emporte.
    again.m.registry.addPeer({
      machine_id: 'hub-fictif',
      display_name: 'hub',
      role: 'hub',
      peer_token: 'jeton-fictif',
      cpk_location: 'aes-vault:fictif',
      allowed_scopes: ['org-du-hub-fictif'],
    })
    expect(orgScope(again.m).id).toBe('org-du-hub-fictif')
  })

  it("repris d'un hub par une ligne à part (sans org_id) : le pair hub désigne le bon", () => {
    const { m } = open()
    m.registry.adoptScope({ id: 'org-a-part', type: 'org', name: 'org:a-part' }) // repointe le scope local
    m.registry.db
      .prepare("INSERT INTO memory_scopes (id, type, name, created_at) VALUES ('org-hub-insere', 'org', 'org:hub-insere', ?)")
      .run(new Date().toISOString())
    m.registry.addPeer({ machine_id: 'hub-2', display_name: 'hub', role: 'hub', peer_token: 't', cpk_location: 'x', allowed_scopes: ['org-hub-insere'] })
    expect(orgScope(m).id).toBe('org-hub-insere')
  })

  it('sans aucun scope org : refus clair', () => {
    const { m } = open()
    const agent = m.pairAssistant({ type: 'claude-code' })
    m.registry.db.prepare("DELETE FROM memory_scopes WHERE type = 'org'").run()
    expect(() => m.declareFact({ instance: agent.assistant_instance_id, content: 'x', scope: 'org' })).toThrow(/scope inconnu : org/)
  })
})

describe("écriture d'un agent dans l'espace d'équipe", () => {
  it('sans le droit : refus « écriture refusée » qui nomme l’espace d’équipe', () => {
    const { m } = open()
    const agent = m.pairAssistant({ type: 'claude-code' })
    expect(() => m.declareFact({ instance: agent.assistant_instance_id, content: 'Le montage se fait en 25 images par seconde', scope: 'org' })).toThrow(
      /^écriture refusée dans l'espace d'équipe \(org\) : cet agent n'a pas can_write/,
    )
  })

  it('OpenClaw : refusé même avec le droit posé à la main, et ne peut ni épingler ni corriger un fait d’équipe', () => {
    const { m } = open()
    const bot = m.pairAssistant({ type: 'openclaw', display_name: 'Bot fictif' })
    const writer = m.pairAssistant({ type: 'claude-code' })
    grantOrg(m, bot)
    grantOrg(m, writer)
    expect(() => m.declareFact({ instance: bot.assistant_instance_id, content: 'Le serveur de rendu redémarre à minuit', scope: 'org' })).toThrow(
      /espace d'équipe \(org\) : un agent OpenClaw/,
    )
    const fact = m.declareFact({ instance: writer.assistant_instance_id, content: 'Le serveur de rendu redémarre à minuit', scope: 'org' }).fact!
    expect(() => m.setPinned(bot.assistant_instance_id, fact.id, true)).toThrow(/espace d'équipe \(org\)/)
    expect(() => m.correctFact(bot.assistant_instance_id, fact.id, 'Le serveur de rendu redémarre à une heure')).toThrow(/espace d'équipe \(org\)/)
  })

  it('lecture seule sur `org` (Mac du propriétaire) : épingler ou corriger est refusé en nommant l’espace d’équipe', () => {
    const { m } = open()
    const writer = m.pairAssistant({ type: 'codex' })
    const reader = m.pairAssistant({ type: 'claude-code' })
    grantOrg(m, writer)
    m.setScopeAccess(reader.assistant_id, orgScope(m).id, { can_read: true, can_write: false })
    const fact = m.declareFact({ instance: writer.assistant_instance_id, content: 'Les sous-titres se calent à la frame près', scope: 'org' }).fact!
    expect(() => m.setPinned(reader.assistant_instance_id, fact.id, true)).toThrow(/^écriture refusée dans l'espace d'équipe \(org\) : .*sans can_write/)
    expect(() => m.correctFact(reader.assistant_instance_id, fact.id, 'Les sous-titres se calent à deux frames près')).toThrow(
      /^écriture refusée dans l'espace d'équipe \(org\)/,
    )
  })

  it('avec le droit : écrit, et l’organisation du contexte de l’agent est remplacée par celle du scope', () => {
    const { m } = open()
    const agent = m.pairAssistant({ type: 'codex' })
    grantOrg(m, agent)
    const r = m.declareFact({ instance: agent.assistant_instance_id, content: 'Les miniatures se font en 1280 x 720', scope: 'org', org_id: 'etiquette-libre' })
    expect(r.fact?.org_id).toBe(orgScope(m).org_id)
    expect(m.scopeFacts(orgScope(m).id).map(f => f.id)).toEqual([r.fact!.id])
  })

  it('refuse un fait sensitive ou critical, un sujet sensible, un secret (rien au coffre) et un client déclaré', () => {
    const { m } = open()
    const agent = m.pairAssistant({ type: 'claude-code' })
    grantOrg(m, agent)
    const instance = agent.assistant_instance_id
    // Aucun refus ne passe par le coffre : le secret refusé n'est mis nulle part.
    const vaulted = vi.spyOn(m.secrets, 'set')
    const store = (content: string, extra: Record<string, unknown> = {}) => () => m.declareFact({ instance, content, scope: 'org', ...extra })
    expect(store('Le planning du tournage est partagé', { sensitivity: 'sensitive' })).toThrow(/un fait sensitive/)
    expect(store('Le planning du tournage est partagé', { sensitivity: 'critical' })).toThrow(/un fait critical/)
    expect(store('Le salaire de Zorba passe à 2 100 euros')).toThrow(/sujet sensible/)
    expect(store('La clé du service de rendu est api_key=Zx9fictif00112233445566')).toThrow(/contient un secret/)
    expect(store('Le service de rendu utilise [secret:generic-token-1]')).toThrow(/contient un secret/)
    expect(store('Le logo se livre en SVG', { client_org_id: 'client-fictif' })).toThrow(/un client est déclaré/)
    // Projet d'un client du registre : même refus.
    const client = m.registry.createOrganization('Client Fictif', 'client')
    const project = m.registry.createProject('Projet Fictif', m.registry.ownCompany()!.id, client.id)
    expect(store('Le logo se livre en SVG', { project_id: project.id })).toThrow(/un client est déclaré/)
    // Rien n'a été écrit, et le secret refusé n'est pas parti au coffre.
    expect(m.scopeFacts(orgScope(m).id)).toEqual([])
    expect(vaulted).not.toHaveBeenCalled()
    // Témoin : le même secret écrit en PRIVÉ passe bien par le coffre (l'espion voit les mises au coffre).
    m.declareFact({ instance, content: 'La clé du service de rendu est api_key=Zx9fictif00112233445566' })
    expect(vaulted).toHaveBeenCalledTimes(1)
    vaulted.mockClear()
    // Le même fait, privé, reste possible.
    expect(m.declareFact({ instance, content: 'Le logo se livre en SVG', client_org_id: 'client-fictif' }).fact).not.toBeNull()
  })
})

describe('rôle de la machine ([sharing] machine)', () => {
  it('Mac d’équipe : Claude Code et Codex lisent et écrivent `org` dès l’appairage, OpenClaw jamais', () => {
    const { m } = open({ machine: 'team' })
    expect(m.machineRole()).toBe('team')
    const claude = m.pairAssistant({ type: 'claude-code' })
    const codex = m.pairAssistant({ type: 'codex' })
    const bot = m.pairAssistant({ type: 'openclaw' })
    const org = orgScope(m)
    expect(m.registry.getPolicy(claude.assistant_id, org.id)).toMatchObject({ can_read: true, can_write: true })
    expect(m.registry.getPolicy(codex.assistant_id, org.id)).toMatchObject({ can_read: true, can_write: true })
    expect(m.registry.getPolicy(bot.assistant_id, org.id)).toBeNull()
    expect(m.declareFact({ instance: codex.assistant_instance_id, content: 'Le build iOS passe par la file du soir', scope: 'org' }).fact).not.toBeNull()
    expect(() => m.declareFact({ instance: bot.assistant_instance_id, content: 'Le build iOS passe par la file du soir', scope: 'org' })).toThrow(
      /OpenClaw/,
    )
  })

  it('Mac du propriétaire (défaut) : rien ne change, aucun droit sur `org` à l’appairage', () => {
    const { m } = open()
    expect(m.machineRole()).toBe('owner')
    const claude = m.pairAssistant({ type: 'claude-code' })
    expect(m.registry.getPolicy(claude.assistant_id, orgScope(m).id)).toBeNull()
  })

  it('passage en `team` : les agents déjà appairés reçoivent le droit au démarrage, un réglage existant reste tel quel', () => {
    const first = open()
    const claude = first.m.pairAssistant({ type: 'claude-code' })
    const codex = first.m.pairAssistant({ type: 'codex' })
    // Le propriétaire a réglé Codex en lecture seule : son choix est gardé.
    first.m.setScopeAccess(codex.assistant_id, orgScope(first.m).id, { can_read: true, can_write: false })
    first.m.close()
    writeFileSync(join(first.root, 'config.toml'), '[sharing]\nmachine = "team"\n')
    const again = open({ root: first.root })
    const org = orgScope(again.m)
    expect(again.m.registry.getPolicy(claude.assistant_id, org.id)).toMatchObject({ can_read: true, can_write: true })
    expect(again.m.registry.getPolicy(codex.assistant_id, org.id)).toMatchObject({ can_read: true, can_write: false })
  })
})

describe('rappel : un fait de l’espace d’équipe est rendu `org`', () => {
  it('scope_type org dans le rappel, `scope: "org"` en compact, « team space » en blocs ; un fait user reste sans marque', () => {
    const { m } = open({ machine: 'team' })
    const agent = m.pairAssistant({ type: 'claude-code' })
    m.declareFact({ instance: agent.assistant_instance_id, content: 'Le chromakey se règle avec le gabarit Lumen', scope: 'org' })
    m.declareFact({ instance: agent.assistant_instance_id, content: 'Le gabarit Lumen préféré est le bleu', scope: 'user' })
    const result = m.recall({ instance: agent.assistant_instance_id, query: 'gabarit Lumen' })
    const team = result.items.find(i => i.content.includes('chromakey'))!
    const user = result.items.find(i => i.content.includes('bleu'))!
    expect(team.scope_type).toBe('org')
    expect(user.scope_type).toBeUndefined()
    const compact = compactRecall(result).items as Array<Record<string, unknown>>
    expect(compact.find(i => i['id'] === team.id)!['scope']).toBe('org')
    expect('scope' in compact.find(i => i['id'] === user.id)!).toBe(false)
    expect(formatRecallBlocks(result)).toContain('team space (org)')
  })
})

describe("partage vers l'espace d'équipe : garde-fous côté serveur", () => {
  /** Fait trié (genre, rubriques corrigés à la main), dans la mémoire privée de l'agent du tri. */
  async function triaged(rows: Array<{ text: string; genre?: Genre; rubriques?: string[] }>): Promise<string[]> {
    env = setupTriage()
    const ids = rows.map(r => env!.m.storeFact({ instance: env!.instance, content: r.text }).id)
    await env.m.triage.run()
    rows.forEach((r, i) => {
      if (r.genre || r.rubriques) {
        env!.m.triage.correct({ fact_id: ids[i]!, ...(r.genre ? { genre: r.genre } : {}), ...(r.rubriques ? { rubriques: r.rubriques as never } : {}) })
      }
    })
    return ids
  }

  it('genres autorisés : process, savoir, lecon, decision', async () => {
    const ids = await triaged(TEAM_SHARE_GENRES.map((genre, i) => ({ text: `Règle d'atelier numéro ${i + 1} pour le banc de montage`, genre, rubriques: ['outils'] })))
    const r = env!.m.shareFacts(ids, 'org')
    expect(r.shared).toBe(4)
    expect(Object.values(r.refused!).every(n => n === 0)).toBe(true)
    expect(env!.m.scopeFacts(orgScope(env!.m).id)).toHaveLength(4)
  })

  it('refuse chaque genre interdit et chaque rubrique interdite, et rend les comptes', async () => {
    const refusedGenres: Genre[] = ['preference', 'style', 'idee', 'chronologie', 'fait', 'ephemere']
    const ids = await triaged([
      ...refusedGenres.map((genre, i) => ({ text: `Note fictive ${i + 1} sur le banc de montage`, genre, rubriques: ['outils'] })),
      ...TEAM_REFUSED_RUBRIQUES.map((rubrique, i) => ({ text: `Process fictif ${i + 1} du bureau`, genre: 'process' as Genre, rubriques: ['app', rubrique] })),
    ])
    const r = env!.m.shareFacts(ids, 'org')
    expect(r.shared).toBe(0)
    expect(r.refused).toMatchObject({ genre: refusedGenres.length, rubrique: TEAM_REFUSED_RUBRIQUES.length })
    // Rien n'a bougé : chaque fait est encore dans la mémoire privée.
    for (const id of ids) expect(env!.db().prepare('SELECT 1 FROM facts WHERE id = ?').get(id)).toBeDefined()
  })

  it('refuse sensible, critical, secret, client, redite, sans tri et faux, chacun à sa raison', async () => {
    const ids = await triaged([
      { text: 'Le salaire de Zorba passe à 2 100 euros' },
      { text: 'Le process de sauvegarde du serveur Nimbus', genre: 'process', rubriques: ['infra'] },
      { text: 'Le process de clé du service Nimbus', genre: 'process', rubriques: ['infra'] },
      { text: 'Le process de livraison au client Nimbus', genre: 'process', rubriques: ['contenu'] },
      { text: 'Le process d’export du banc Nimbus', genre: 'process', rubriques: ['outils'] },
      { text: 'Le process de nettoyage du banc Nimbus', genre: 'process', rubriques: ['outils'] },
    ])
    const [salary, critical, secret, client, redite, faux] = ids as [string, string, string, string, string, string]
    const db = env!.db()
    db.prepare("UPDATE facts SET sensitivity = 'critical' WHERE id = ?").run(critical)
    db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('Le process de clé du service Nimbus utilise [secret:generic-token-9]', secret)
    db.prepare("UPDATE facts SET client_org_id = 'client-fictif' WHERE id = ?").run(client)
    db.prepare('UPDATE facts SET superseded = 1, superseded_by = ? WHERE id = ?').run(faux, redite)
    env!.m.triage.setVerdict([faux], 'faux')
    const untriaged = env!.m.storeFact({ instance: env!.instance, content: 'Le process de rangement des rushes' }).id
    const r = env!.m.shareFacts([salary, critical, secret, client, redite, faux, untriaged], 'org')
    expect(r).toMatchObject({
      shared: 0,
      refused: { sensible: 1, critical: 1, secret: 1, client: 1, redite: 1, faux: 1, sans_tri: 1, rubrique: 0, genre: 0 },
    })
  })

  it('le partage vers `user` ne change pas (aucun garde-fou d’équipe, pas de `refused`)', async () => {
    const ids = await triaged([{ text: 'Note fictive sur le banc de montage', genre: 'preference' }])
    const r = env!.m.shareFacts(ids, 'user')
    expect(r).toEqual({ shared: 1, scope: 'user' })
  })
})

describe("tri : promotion vers l'équipe et filtre « candidats équipe »", () => {
  async function seeded(): Promise<{ good: string; idea: string; finance: string; noRubric: string }> {
    env = setupTriage()
    const good = seedPending(env, 'Le banc de montage exporte les masters en ProRes')
    const idea = seedPending(env, 'Le banc de montage pourrait trier les rushes seul')
    const finance = seedPending(env, 'Le banc de montage suit les achats de disques')
    const noRubric = seedPending(env, 'Le banc de montage se nettoie le vendredi')
    await env.m.triage.run()
    env.m.triage.correct({ fact_id: good, genre: 'process', rubriques: ['outils'] })
    env.m.triage.correct({ fact_id: finance, genre: 'process', rubriques: ['outils', 'finance'] })
    env.m.triage.correct({ fact_id: noRubric, genre: 'savoir', rubriques: [] })
    return { good, idea, finance, noRubric }
  }

  it('filtre « candidats équipe » : seulement le process outillé, hors refus et hors faits déjà dans l’équipe', async () => {
    const { good } = await seeded()
    expect(env!.m.triage.list({ team: true }).items.map(i => i.fact_id)).toEqual([good])
    // Importance sous 2 : écarté.
    env!.m.triage.correct({ fact_id: good, importance: 1 })
    expect(env!.m.triage.list({ team: true }).items).toEqual([])
    env!.m.triage.correct({ fact_id: good, importance: 3 })
    // Déjà dans l'espace d'équipe : plus proposé.
    expect(env!.m.shareFacts([good], 'org').shared).toBe(1)
    expect(env!.m.triage.list({ team: true }).items).toEqual([])
  })

  it("share: 'org' valide tout, mais n'envoie à l'équipe que ce qui passe les garde-fous", async () => {
    const { good, idea, finance } = await seeded()
    const r = env!.m.triage.promote({ fact_ids: [good, idea, finance], share: 'org' })
    expect(r).toMatchObject({ promoted: 3, shared: 1 })
    expect(r.share_refused).toMatchObject({ genre: 1, rubrique: 1 })
    expect(env!.m.scopeFacts(orgScope(env!.m).id).map(f => f.id)).toEqual([good])
    // Les refusés sont validés, mais restés privés.
    const state = env!.db().prepare('SELECT lifecycle_state FROM facts WHERE id = ?')
    expect(state.get(idea)).toEqual({ lifecycle_state: 'active' })
    expect(state.get(finance)).toEqual({ lifecycle_state: 'active' })
  })

  it("share: 'org' prend aussi un fait déjà validé désigné par son id (amorçage)", async () => {
    const { good } = await seeded()
    env!.m.triage.promote({ fact_ids: [good] })
    const r = env!.m.triage.promote({ fact_ids: [good], share: 'org' })
    expect(r).toMatchObject({ promoted: 0, already_active: 1, shared: 1 })
  })

  it('share: true reste vers `user`, sans garde-fou d’équipe', async () => {
    const { good, idea } = await seeded()
    const r = env!.m.triage.promote({ fact_ids: [good, idea], share: true })
    expect(r.shared).toBe(2)
    expect(r.share_refused).toBeUndefined()
    const userScope = env!.m.registry.getScopeByName('user')!
    expect(env!.m.scopeFacts(userScope.id).map(f => f.id).sort()).toEqual([good, idea].sort())
    expect(env!.m.scopeFacts(orgScope(env!.m).id)).toEqual([])
  })

  it('promotion par filtre `team` : les candidats seulement', async () => {
    const { good } = await seeded()
    const r = env!.m.triage.promote({ filter: { team: true }, share: 'org' })
    expect(r).toMatchObject({ promoted: 1, shared: 1 })
    expect(env!.m.scopeFacts(orgScope(env!.m).id).map(f => f.id)).toEqual([good])
  })
})
