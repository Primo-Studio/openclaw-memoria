/**
 * Tests @memoria/mcp : credentials (round-trip + chmod 600), auto-détection
 * repo, handlers MCP (relai daemon + active_context, erreur propre sans throw),
 * connect (pairing → credentials + snippets), gateway HTTP capture_turn.
 * Jamais de vrai daemon, de réseau, ni de vrai HOME : tmpdir + fakes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecallResult } from '@memoria/core'
import {
  ActiveContextTracker,
  buildServer,
  connect,
  credentialsPath,
  DaemonHttpError,
  DaemonTimeoutError,
  SERVER_INSTRUCTIONS,
  HttpDaemonGateway,
  loadCredentials,
  normalizeContextId,
  saveCredentials,
  type DaemonGateway,
  type InstanceCredentials,
} from '../src/index.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-mcp-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const RECALL_EMPTY: RecallResult = { items: [], totalFound: 0, tokens: 0, scopes_searched: [] }

/** Gateway factice qui enregistre les appels. */
function fakeGateway(): DaemonGateway & { calls: Array<{ method: string; input: Record<string, unknown> }> } {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = []
  return {
    calls,
    recall: async input => {
      calls.push({ method: 'recall', input })
      return RECALL_EMPTY
    },
    storeFact: async input => {
      calls.push({ method: 'storeFact', input })
      return { fact: { id: 'f1' } }
    },
    captureTurn: async input => {
      calls.push({ method: 'captureTurn', input })
      return { queued: true }
    },
    identifyInterlocutor: async input => {
      calls.push({ method: 'identifyInterlocutor', input })
      return { match: null }
    },
    identifyOrCreateInterlocutor: async input => {
      calls.push({ method: 'identifyOrCreateInterlocutor', input })
      return { match: null }
    },
    feedback: async input => {
      calls.push({ method: 'feedback', input })
      return { updated: ['f1'], domains: ['preference'] }
    },
    captureStatus: async input => {
      calls.push({ method: 'captureStatus', input })
      return { entries: [{ wal_id: 1, status: 'done', attempts: 0 }], pending: 0, retrying: 0, done: 1, failed: 0 }
    },
    pin: async input => { calls.push({ method: 'pin', input }); return { updated: true } },
    correct: async input => { calls.push({ method: 'correct', input }); return { replacement: { id: 'f2' } } },
    expiry: async input => { calls.push({ method: 'expiry', input }); return { updated: true } },
  }
}

describe('credentials', () => {
  it('round-trip + chmod 600', () => {
    const creds: InstanceCredentials = {
      instance_token: 'tok-secret',
      storage_root: '/tmp/memoria-data',
      created_at: '2026-06-10T00:00:00.000Z',
    }
    const p = saveCredentials('inst-1', creds, root)
    expect(p).toBe(credentialsPath('inst-1', root))
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(loadCredentials('inst-1', root)).toEqual(creds)
  })

  it('instance inconnue → null ; fichier corrompu → warn + null (pas de throw)', () => {
    expect(loadCredentials('absent', root)).toBeNull()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(credentialsPath('corrompu', root), '{pas du json', 'utf8')
    expect(loadCredentials('corrompu', root)).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('refuse un instance_id avec séparateur de chemin', () => {
    const creds: InstanceCredentials = { instance_token: 't', storage_root: '/x', created_at: '' }
    expect(() => saveCredentials('../evil', creds, root)).toThrow(/invalide/)
  })
})

describe('ActiveContextTracker', () => {
  it('autoDetect remonte jusqu’à la racine .git (repo_path + topic)', () => {
    const repo = join(root, 'mon-projet')
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    mkdirSync(join(repo, '.git'))

    const tracker = new ActiveContextTracker()
    const found = tracker.autoDetect(join(repo, 'src', 'deep'))
    expect(found).toEqual({ repo_path: repo, topic: 'mon-projet' })
    expect(tracker.current()).toMatchObject({ repo_path: repo, topic: 'mon-projet' })
  })

  it('hors repo → null ; set() explicite prime sur la détection', () => {
    const tracker = new ActiveContextTracker()
    expect(tracker.autoDetect(root)).toBeNull()

    const repo = join(root, 'repo-b')
    mkdirSync(join(repo, '.git'), { recursive: true })
    tracker.autoDetect(repo)
    const effective = tracker.set({ project: 'primask', client: 'acme', repo_path: '/ailleurs' })
    expect(effective).toMatchObject({
      project_id: 'primask',
      client_org_id: 'acme',
      repo_path: '/ailleurs', // explicite > détecté
      topic: 'repo-b',
    })
  })
})

describe('normalisation des identifiants de contexte', () => {
  it('« Maroway », « maroway » et « MAROWAY  » donnent le même client_org_id', () => {
    // Deux agents n'écrivent jamais le même identifiant à la main ; l'isolation
    // client (égalité stricte côté core) masquait alors les souvenirs de l'autre.
    const a = new ActiveContextTracker().set({ client: 'Maroway' })
    const b = new ActiveContextTracker().set({ client: 'maroway' })
    const c = new ActiveContextTracker().set({ client: ' MAROWAY  ' })
    expect(a.client_org_id).toBe('maroway')
    expect(b.client_org_id).toBe('maroway')
    expect(c.client_org_id).toBe('maroway')
  })

  it('accents, espaces et ponctuation → slug stable ; un UUID reste intact', () => {
    expect(normalizeContextId('Mairie Saint-Laurent du Maroni')).toBe('mairie-saint-laurent-du-maroni')
    expect(normalizeContextId('Terra Plena / refonte')).toBe('terra-plena-refonte')
    expect(normalizeContextId('Néto & Cie')).toBe('neto-cie')
    expect(normalizeContextId('7f3c2a10-4b2e-4c1d-9c6a-2c9d3e8f1a2b')).toBe('7f3c2a10-4b2e-4c1d-9c6a-2c9d3e8f1a2b')
    expect(normalizeContextId('')).toBeNull()
    expect(normalizeContextId('  ---  ')).toBeNull()
  })

  it('repo_path n’est PAS normalisé (c’est un chemin)', () => {
    const ctx = new ActiveContextTracker().set({ repo_path: '/Users/Néto/Mon Projet' })
    expect(ctx.repo_path).toBe('/Users/Néto/Mon Projet')
  })
})

describe('buildServer handlers', () => {
  it('memoria_recall transmet query + limit + active_context au daemon', async () => {
    const gateway = fakeGateway()
    const tracker = new ActiveContextTracker()
    tracker.set({ project: 'memoria-v3', client: 'interne' })

    const { handlers } = buildServer({
      instanceId: 'inst-1',
      tracker,
      connect: async () => gateway,
    })

    const result = await handlers.recall({ query: 'règles de déploiement', limit: 7 })
    expect(result.isError).toBeUndefined()
    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]?.input).toEqual({
      query: 'règles de déploiement',
      limit: 7,
      active_context: { project_id: 'memoria-v3', client_org_id: 'interne' },
    })
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text)).toEqual({ items: [], total_found: 0, tokens: 0 })
  })

  it('memoria_recall relaie token_budget au daemon (cap dur du bloc renvoyé)', async () => {
    const gateway = fakeGateway()
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    await handlers.recall({ query: 'x', token_budget: 800 })
    expect(gateway.calls[0]?.input).toMatchObject({ query: 'x', token_budget: 800 })
  })

  it('memoria_recall renvoie une projection compacte : ni scope_id ni source_db, date YYYY-MM-DD, score à 3 décimales', async () => {
    // Mesuré E2E : JSON = 2,44× le contenu utile (UUID de scope, chemin de DB,
    // score à 16 décimales, timestamp à la ms) — du contexte LLM brûlé pour rien.
    const gateway = fakeGateway()
    gateway.recall = async () => ({
      items: [
        {
          kind: 'fact',
          id: 'f-1',
          content: 'Néto préfère les réponses courtes.',
          category: 'preference',
          scope_id: '7f3c2a10-4b2e-4c1d-9c6a-2c9d3e8f1a2b',
          source_db: 'assistants/claude-code-72615d82/content.sqlite',
          score: 0.8123456789012345,
          created_at: '2026-08-27T09:12:33.123Z',
          origin: 'declared',
        },
        {
          kind: 'procedure',
          id: 'f-2',
          content: 'Déployer avec git push en Nieto42.',
          category: 'infra',
          scope_id: 'scope-2',
          source_db: 'shared/user.sqlite',
          score: 0.5,
          created_at: '2026-08-01T00:00:00.000Z',
          revision: { kind: 'contradicted', replacement_fact_id: 'f-9' },
        },
      ],
      totalFound: 2,
      tokens: 40,
      scopes_searched: ['private:i', 'user'],
    })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const res = await handlers.recall({ query: 'réponses' })
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text) as Record<string, unknown>
    expect(payload).toEqual({
      items: [
        { id: 'f-1', kind: 'fact', content: 'Néto préfère les réponses courtes.', category: 'preference', date: '2026-08-27', score: 0.812, origin: 'declared' },
        {
          id: 'f-2',
          kind: 'procedure',
          content: 'Déployer avec git push en Nieto42.',
          category: 'infra',
          date: '2026-08-01',
          score: 0.5,
          revision: { kind: 'contradicted', replacement_fact_id: 'f-9' },
        },
      ],
      total_found: 2,
      tokens: 40,
    })
  })

  it('memoria_recall quand Memoria est en pause → items vides + disabled:true conservé', async () => {
    const gateway = fakeGateway()
    gateway.recall = async () => ({ items: [], disabled: true } as unknown as RecallResult)
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const res = await handlers.recall({ query: 'x' })
    expect(JSON.parse((res.content[0] as { type: 'text'; text: string }).text)).toEqual({ items: [], total_found: 0, tokens: 0, disabled: true })
  })

  it('memoria_identify_interlocutor / _or_create renvoient une personne compacte (id, nom, relation, notes, known, created)', async () => {
    const full = {
      id: 'p-1',
      display_name: 'Marion Dol',
      relation: 'client',
      notes: 'GCSMS',
      org_id: 'org-1',
      user_id: null,
      created_at: '2026-08-24T10:00:00.000Z',
      updated_at: null,
      identifiers: [{ id: 'pi-1', person_id: 'p-1', kind: 'email', value: 'm@x.fr', created_at: '2026-08-24T10:00:00.000Z' }],
    }
    const gateway = fakeGateway()
    gateway.identifyInterlocutor = async () => ({ match: { person: full, known: ['Marion Dol pilote la plénière GCSMS.'] } })
    gateway.identifyOrCreateInterlocutor = async () => ({ match: { person: full, known: [], created: true } })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })

    const a = JSON.parse(((await handlers.identifyInterlocutor({ email: 'm@x.fr' })).content[0] as { type: 'text'; text: string }).text)
    expect(a).toEqual({
      found: true,
      person: { id: 'p-1', display_name: 'Marion Dol', relation: 'client', notes: 'GCSMS' },
      known: ['Marion Dol pilote la plénière GCSMS.'],
    })
    const b = JSON.parse(((await handlers.identifyOrCreateInterlocutor({ email: 'm@x.fr' })).content[0] as { type: 'text'; text: string }).text)
    expect(b).toMatchObject({ found: true, created: true })
    expect(b.person).not.toHaveProperty('identifiers')

    gateway.identifyInterlocutor = async () => ({ match: null })
    const c = JSON.parse(((await handlers.identifyInterlocutor({ name: 'inconnu' })).content[0] as { type: 'text'; text: string }).text)
    expect(c).toEqual({ found: false })
  })

  it('memoria_store_fact et memoria_capture_turn relaient au daemon', async () => {
    const gateway = fakeGateway()
    const tracker = new ActiveContextTracker()
    const { handlers } = buildServer({ instanceId: 'i', tracker, connect: async () => gateway })

    await handlers.storeFact({ content: 'Néto préfère le français', category: 'preference', tags: ['langue'] })
    await handlers.captureTurn({ messages: [{ role: 'user', content: 'salut' }] })

    expect(gateway.calls.map(c => c.method)).toEqual(['storeFact', 'captureTurn'])
    expect(gateway.calls[0]?.input).toEqual({
      content: 'Néto préfère le français',
      category: 'preference',
      tags: ['langue'],
    })
    expect(gateway.calls[1]?.input).toMatchObject({ messages: [{ role: 'user', content: 'salut' }] })
  })

  it('memoria_store_fact transmet project/client/org du contexte actif (isolation client)', async () => {
    // Sans ça, un fait déclaré en travaillant pour le client A était stocké avec
    // client_org_id=null : visible sous le client B, jamais boosté par le projet.
    const gateway = fakeGateway()
    const tracker = new ActiveContextTracker()
    tracker.set({ project: 'site-primo', client: 'primo', org: 'primo-studio' })
    const { handlers } = buildServer({ instanceId: 'i', tracker, connect: async () => gateway })

    await handlers.storeFact({ content: 'Le site est déployé sur Vercel' })
    expect(gateway.calls[0]?.input).toMatchObject({
      content: 'Le site est déployé sur Vercel',
      project_id: 'site-primo',
      client_org_id: 'primo',
      org_id: 'primo-studio',
    })
    // repo_path/topic auto-détectés ne sont PAS des identifiants de scoping :
    // ils ne doivent pas être envoyés comme tels.
    expect(gateway.calls[0]?.input).not.toHaveProperty('repo_path')
  })

  it('memoria_store_fact scope:"user" relaie le scope partagé ; défaut/private → aucun scope (privé)', async () => {
    const gateway = fakeGateway()
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })

    await handlers.storeFact({ content: 'Néto préfère les réponses courtes', category: 'preference', scope: 'user' })
    await handlers.storeFact({ content: 'Le build passe par tsc -b', scope: 'private' })
    await handlers.storeFact({ content: 'Sans scope' })

    expect(gateway.calls[0]?.input).toMatchObject({ scope: 'user' })
    expect(gateway.calls[1]?.input).not.toHaveProperty('scope')
    expect(gateway.calls[2]?.input).not.toHaveProperty('scope')
  })

  it('memoria_store_fact renvoie une réponse compacte (id, contenu, scope) — pas la ligne SQL entière', async () => {
    const gateway = fakeGateway()
    gateway.storeFact = async input => {
      gateway.calls.push({ method: 'storeFact', input })
      // Forme réelle du daemon : la Fact complète (30 colonnes, ~770 caractères).
      return {
        fact: {
          id: 'f-42',
          fact: 'Néto préfère les réponses courtes.',
          category: 'preference',
          fact_type: 'fact',
          confidence: 1,
          source: 'manual',
          assistant_instance_id: 'i',
          user_id: null,
          org_id: null,
          client_org_id: 'primo',
          project_id: 'site-primo',
          topic_id: null,
          scope_id: 'scope-uuid',
          sensitivity: 'normal',
          visibility: 'shared',
          tags: [],
          entity_ids: [],
          lifecycle_state: 'active',
          superseded: false,
          superseded_by: null,
          usefulness: 0,
          recall_count: 0,
          used_count: 0,
          relevance_weight: 1,
          created_at: '2026-08-27T09:00:00.000Z',
          updated_at: '2026-08-27T09:00:00.000Z',
          last_accessed_at: null,
          origin_machine_id: 'mac',
          origin_rev: 3,
          content_hash: 'abc',
          deleted_at: null,
        },
      }
    }
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })

    const res = await handlers.storeFact({ content: 'Néto préfère les réponses courtes.', scope: 'user' })
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text) as Record<string, unknown>
    expect(payload).toEqual({
      stored: true,
      id: 'f-42',
      content: 'Néto préfère les réponses courtes.',
      category: 'preference',
      scope: 'user',
      visibility: 'shared',
      project_id: 'site-primo',
      client_org_id: 'primo',
    })
    expect(payload).not.toHaveProperty('origin_machine_id')
    expect(payload).not.toHaveProperty('content_hash')
  })

  it('memoria_store_fact quand Memoria est en pause → stored:false, disabled:true (pas d’erreur)', async () => {
    const gateway = fakeGateway()
    gateway.storeFact = async () => ({ fact: null, disabled: true })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const res = await handlers.storeFact({ content: 'x' })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse((res.content[0] as { type: 'text'; text: string }).text)).toEqual({ stored: false, disabled: true })
  })

  it('memoria_store_fact en mode « Pause » (capture incognito) → stored:false, skipped:true, reason:paused', async () => {
    const gateway = fakeGateway()
    gateway.storeFact = async () => ({ fact: null, skipped: true, reason: 'paused', mode: 'incognito' })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const res = await handlers.storeFact({ content: 'x' })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse((res.content[0] as { type: 'text'; text: string }).text)).toEqual({ stored: false, skipped: true, reason: 'paused' })
  })

  it('memoria_store_fact en mode « Revue d’abord » → stored:true + pending_review:true', async () => {
    const gateway = fakeGateway()
    gateway.storeFact = async () => ({ fact: { id: 'f-7', fact: 'x', category: 'general', visibility: 'private', lifecycle_state: 'dormant' }, mode: 'review-first' })
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const res = await handlers.storeFact({ content: 'x' })
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text) as Record<string, unknown>
    expect(payload).toMatchObject({ stored: true, pending_review: true, id: 'f-7' })
  })

  it('daemon mort → UNE re-connexion puis erreur MCP propre (jamais de throw)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let attempts = 0
    const broken: DaemonGateway = {
      recall: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:9999')
      },
      storeFact: async () => ({}),
      captureTurn: async () => ({}),
      identifyInterlocutor: async () => ({ match: null }),
      feedback: async () => ({ updated: [], domains: [] }),
      captureStatus: async () => ({ entries: [], pending: 0, retrying: 0, done: 0, failed: 0 }),
      pin: async () => ({ updated: false }),
      correct: async () => ({ replacement: null }),
      expiry: async () => ({ updated: false }),
    }
    const { handlers } = buildServer({
      instanceId: 'i',
      tracker: new ActiveContextTracker(),
      connect: async () => {
        attempts += 1
        return broken
      },
    })

    const result = await handlers.recall({ query: 'x' })
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('ECONNREFUSED')
    expect(attempts).toBe(2) // connexion initiale + UNE relance
    expect(warn).toHaveBeenCalled()
  })

  it('erreur HTTP 400 du daemon → AUCUNE relance, message daemon verbatim, pas de « memoria doctor »', async () => {
    // Une date invalide dans set_expiry était annoncée comme une panne du daemon,
    // rejouée une fois pour rien, et le LLM envoyait l'utilisateur lancer
    // `memoria doctor` qui disait que tout allait bien.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let connections = 0
    let calls = 0
    const gateway = fakeGateway()
    gateway.expiry = async () => {
      calls += 1
      throw new DaemonHttpError('/v1/memory/expiry', 400, "date d'expiration invalide : demain")
    }
    const { handlers } = buildServer({
      instanceId: 'i',
      tracker: new ActiveContextTracker(),
      connect: async () => {
        connections += 1
        return gateway
      },
    })
    const res = await handlers.expiry({ fact_id: 'f1', expires_at: 'demain' })
    expect(res.isError).toBe(true)
    const text = (res.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain("date d'expiration invalide : demain")
    expect(text).not.toMatch(/unreachable|memoria doctor/)
    expect(calls).toBe(1)
    expect(connections).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('401 (token révoqué) → message de re-connexion, pas de relance', async () => {
    const gateway = fakeGateway()
    gateway.recall = async () => {
      throw new DaemonHttpError('/v1/memory/recall', 401, 'token d’instance invalide ou révoqué')
    }
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const text = (await handlers.recall({ query: 'x' })).content[0] as { type: 'text'; text: string }
    expect(text.text).toMatch(/reconnect|memoria-mcp connect/)
    expect(text.text).not.toMatch(/unreachable/)
  })

  it('404 « route inconnue » (daemon trop ancien) → dit « older », pas « unreachable » ni « doctor »', async () => {
    const gateway = fakeGateway()
    gateway.pin = async () => {
      throw new DaemonHttpError('/v1/memory/pin', 404, 'route mémoire inconnue : POST /v1/memory/pin')
    }
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const text = ((await handlers.pin({ fact_id: 'f1', pinned: true })).content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/older/)
    expect(text).not.toMatch(/unreachable|memoria doctor/)
  })

  it('404 « fait inconnu » (identifiant faux) → « fix the arguments », pas « memoria doctor »', async () => {
    const gateway = fakeGateway()
    gateway.expiry = async () => {
      throw new DaemonHttpError('/v1/memory/expiry', 404, 'fait inconnu dans les scopes de cet agent : f-zzz')
    }
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const res = await handlers.expiry({ fact_id: 'f-zzz', expires_at: null })
    const text = (res.content[0] as { type: 'text'; text: string }).text
    expect(res.isError).toBe(true)
    expect(text).toMatch(/identifier is unknown/)
    expect(text).toContain('f-zzz')
    expect(text).not.toMatch(/memoria doctor|paused/)
  })

  it('store_fact scope:"user" refusé par la policy → message « store it privately », pas de « memoria doctor »', async () => {
    // Chemin NOMINAL de la feature : par défaut un nouvel agent n'a pas
    // can_write sur le scope user, le core lève une Error plate et le daemon
    // la mappe en 500. La branche 5xx annonçait une panne (« daemon failed…
    // memoria doctor ») alors que la description promet « store it privately
    // and tell the user » : le LLM abandonnait le fait. Tant que le daemon
    // n'envoie pas 403, on reconnaît le refus au message ; 403 reste couvert.
    for (const status of [500, 403]) {
      const gateway = fakeGateway()
      gateway.storeFact = async () => {
        throw new DaemonHttpError('/v1/memory/store_fact', status, "écriture refusée : l'assistant n'a pas can_write sur le scope « user »")
      }
      const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
      const res = await handlers.storeFact({ content: 'Le propriétaire préfère les réponses courtes.', scope: 'user' })
      expect(res.isError, `HTTP ${status}`).toBe(true)
      const text = (res.content[0] as { type: 'text'; text: string }).text
      expect(text, `HTTP ${status}`).toMatch(/store the fact privately/i)
      expect(text, `HTTP ${status}`).toMatch(/omit scope/)
      expect(text, `HTTP ${status}`).toMatch(/Memoria app/)
      expect(text, `HTTP ${status}`).not.toMatch(/memoria doctor|daemon failed|unreachable|revoked/)
    }
  })

  it('403 dont le message ne parle pas de can_write → reste un refus de token (re-connexion)', async () => {
    const gateway = fakeGateway()
    gateway.recall = async () => {
      throw new DaemonHttpError('/v1/memory/recall', 403, 'token d’instance invalide ou révoqué')
    }
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const text = ((await handlers.recall({ query: 'x' })).content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/reconnect|memoria-mcp connect/)
    expect(text).not.toMatch(/store the fact privately/i)
  })

  it('timeout sur capture_turn → UN SEUL appel (jamais de rejeu d’un POST non idempotent) + renvoi vers capture_status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const gateway = fakeGateway()
    gateway.captureTurn = async () => {
      calls += 1
      throw new DaemonTimeoutError('/v1/memory/capture_turn', 60_000)
    }
    const { handlers } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => gateway })
    const res = await handlers.captureTurn({ messages: [{ role: 'user', content: 'salut' }] })
    expect(res.isError).toBe(true)
    expect(calls).toBe(1)
    expect((res.content[0] as { type: 'text'; text: string }).text).toContain('memoria_capture_status')
  })

  it('memoria_set_context / memoria_get_context retournent le contexte effectif', async () => {
    const tracker = new ActiveContextTracker()
    const { handlers } = buildServer({ instanceId: 'i', tracker, connect: async () => fakeGateway() })

    const set = await handlers.setContext({ project: 'jamboard' })
    const setPayload = JSON.parse((set.content[0] as { type: 'text'; text: string }).text) as {
      active_context: { project_id: string }
    }
    expect(setPayload.active_context.project_id).toBe('jamboard')

    const get = await handlers.getContext()
    const getPayload = JSON.parse((get.content[0] as { type: 'text'; text: string }).text) as {
      active_context: { project_id: string }
    }
    expect(getPayload.active_context.project_id).toBe('jamboard')
  })

  it('le serveur MCP expose bien les 12 outils', () => {
    const { server } = buildServer({
      instanceId: 'i',
      tracker: new ActiveContextTracker(),
      connect: async () => fakeGateway(),
    })
    // registre privé du SDK — vérification structurelle volontairement minimale
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    expect(Object.keys(tools).sort()).toEqual([
      'memoria_capture_status',
      'memoria_capture_turn',
      'memoria_correct',
      'memoria_feedback',
      'memoria_get_context',
      'memoria_identify_interlocutor',
      'memoria_identify_or_create_interlocutor',
      'memoria_pin',
      'memoria_recall',
      'memoria_set_context',
      'memoria_set_expiry',
      'memoria_store_fact',
    ])
  })
})

describe('connect (pairing)', () => {
  it('ensureDaemon → completePairing → credentials 600 + auto-register', async () => {
    const completePairing = vi.fn(async (code: string) => {
      expect(code).toBe('ABCD-2345')
      return { assistant_instance_id: 'claude-code-abc123', instance_token: 'tok-xyz', assistant_type: 'claude-code' }
    })
    const registrar = vi.fn(() => ({ host: 'claude-code' as const, registered: true, detail: 'enregistré' }))

    const result = await connect({
      code: ' ABCD-2345 ', // trim vérifié
      storageRoot: join(root, 'data'),
      credentialsDir: join(root, 'credentials'),
      ensure: async () => ({ port: 4242 }),
      clientFor: () => ({ completePairing }),
      registrar,
    })

    expect(completePairing).toHaveBeenCalledOnce()
    expect(result.instanceId).toBe('claude-code-abc123')
    expect(result.assistantType).toBe('claude-code')
    expect(statSync(result.credentialsPath).mode & 0o777).toBe(0o600)

    const saved = JSON.parse(readFileSync(result.credentialsPath, 'utf8')) as InstanceCredentials
    expect(saved.instance_token).toBe('tok-xyz')
    expect(saved.storage_root).toBe(join(root, 'data'))
    expect(saved.assistant_type).toBe('claude-code')

    expect(registrar).toHaveBeenCalledWith('claude-code', 'claude-code-abc123', { token: 'tok-xyz', storageRoot: join(root, 'data') })
    expect(result.registration?.registered).toBe(true)
    expect(result.message).toContain('Agent connecté à Memoria')
  })

  it('code vide → erreur explicite', async () => {
    await expect(connect({ code: '   ', credentialsDir: root })).rejects.toThrow(/pairing manquant/)
  })
})

describe('HttpDaemonGateway.captureTurn', () => {
  it('POST /v1/memory/capture_turn avec Bearer token (fetch mocké)', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      expect(String(url)).toBe('http://127.0.0.1:5151/v1/memory/capture_turn')
      expect(init?.headers?.['authorization']).toBe('Bearer tok-abc')
      expect(JSON.parse(init?.body ?? '{}')).toMatchObject({ messages: [{ role: 'user', content: 'hello' }] })
      return new Response(JSON.stringify({ queued: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const gateway = new HttpDaemonGateway({ port: 5151 }, 'tok-abc')
    const out = await gateway.captureTurn({ messages: [{ role: 'user', content: 'hello' }] })
    expect(out).toEqual({ queued: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('réponse non-OK → DaemonHttpError typée (status + message daemon)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'route inconnue' }), { status: 404 })),
    )
    const gateway = new HttpDaemonGateway({ port: 5151 }, 'tok-abc')
    const err = await gateway.captureTurn({ messages: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DaemonHttpError)
    expect((err as DaemonHttpError).status).toBe(404)
    expect((err as DaemonHttpError).message).toMatch(/404.*route inconnue/)
  })

  it('recall et store_fact passent aussi par la gateway typée (timeout + erreurs HTTP)', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal) // un fetch sans délai pendait jusqu'au timeout de l'hôte MCP
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new HttpDaemonGateway({ port: 5151 }, 'tok-abc')
    await expect(gateway.recall({ query: 'x' })).rejects.toBeInstanceOf(DaemonHttpError)
    await expect(gateway.storeFact({ content: 'x' })).rejects.toBeInstanceOf(DaemonHttpError)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:5151/v1/memory/recall')
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://127.0.0.1:5151/v1/memory/store_fact')
  })

  it('fetch qui expire → DaemonTimeoutError (pas une erreur réseau rejouable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }),
    )
    const gateway = new HttpDaemonGateway({ port: 5151 }, 'tok-abc')
    await expect(gateway.captureTurn({ messages: [] })).rejects.toBeInstanceOf(DaemonTimeoutError)
  })
})

describe('boucle de feedback', () => {
  it('verdict "useful" → used:true relayé au daemon', async () => {
    const gateway = fakeGateway()
    const { handlers } = buildServer({
      instanceId: 'i',
      tracker: new ActiveContextTracker(),
      connect: async () => gateway,
    })

    const res = await handlers.feedback({ fact_ids: ['f1', 'f2'], verdict: 'useful' })
    expect(res.isError).toBeFalsy()
    expect(gateway.calls).toEqual([{ method: 'feedback', input: { fact_ids: ['f1', 'f2'], used: true } }])
  })

  it('verdict "noise" → used:false (atténuation, jamais suppression)', async () => {
    const gateway = fakeGateway()
    const { handlers } = buildServer({
      instanceId: 'i',
      tracker: new ActiveContextTracker(),
      connect: async () => gateway,
    })

    await handlers.feedback({ fact_ids: ['f3'], verdict: 'noise' })
    expect(gateway.calls[0]?.input).toEqual({ fact_ids: ['f3'], used: false })
  })

  it('daemon injoignable → erreur MCP propre, jamais de throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { handlers } = buildServer({
      instanceId: 'i',
      tracker: new ActiveContextTracker(),
      connect: async () => ({
        recall: async () => RECALL_EMPTY,
        storeFact: async () => ({}),
        captureTurn: async () => ({}),
        identifyInterlocutor: async () => ({ match: null }),
        feedback: async () => {
          throw new Error('ECONNREFUSED')
        },
      }) as unknown as DaemonGateway,
    })

    const res = await handlers.feedback({ fact_ids: ['f1'], verdict: 'useful' })
    expect(res.isError).toBe(true)
  })
})

describe('instructions serveur et descriptions d’outils — QUAND lire, QUAND écrire', () => {
  // Constat terrain : 12 recalls en 2,5 mois, 0 capture_turn, 0 feedback sur
  // 5 sessions Claude Code. Le canal MCP est en PULL : la seule chose que le
  // serveur contrôle, c'est la clarté des consignes. Elles doivent dire à quel
  // MOMENT appeler chaque outil, avec des exemples concrets — pas juste « call
  // memoria_recall at the start ».
  const descriptions = (): Record<string, string> => {
    const { server } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => fakeGateway() })
    const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools
    return Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v.description ?? '']))
  }

  // Les `.describe()` des schémas d'arguments : concaténés par outil, sérialisés
  // en JSON Schema par le SDK — le LLM les lit autant que la description.
  const argDescriptions = (): Record<string, string> => {
    const { server } = buildServer({ instanceId: 'i', tracker: new ActiveContextTracker(), connect: async () => fakeGateway() })
    const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, { description?: string }> } }> })
      ._registeredTools
    return Object.fromEntries(
      Object.entries(tools).map(([k, v]) => [
        k,
        Object.values(v.inputSchema?.shape ?? {})
          .map(f => f.description ?? '')
          .join('\n'),
      ]),
    )
  }

  it('les instructions serveur donnent des déclencheurs concrets pour recall, store_fact, capture_turn et feedback', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/memoria_recall/)
    expect(SERVER_INSTRUCTIONS).toMatch(/START of every task/i)
    expect(SERVER_INSTRUCTIONS).toMatch(/"as usual"|"like last time"/) // rappel déclenché par une référence implicite
    expect(SERVER_INSTRUCTIONS).toMatch(/memoria_store_fact IMMEDIATELY/)
    expect(SERVER_INSTRUCTIONS).toMatch(/memoria_capture_turn/)
    expect(SERVER_INSTRUCTIONS).toMatch(/memoria_feedback/)
    expect(SERVER_INSTRUCTIONS).toMatch(/e\.g\. "/) // au moins un exemple de requête
    expect(SERVER_INSTRUCTIONS).toMatch(/never invent a memory/)
  })

  it('memoria_recall et memoria_store_fact disent QUAND les appeler, avec des exemples', () => {
    const d = descriptions()
    expect(d['memoria_recall']).toMatch(/start of a task/i)
    expect(d['memoria_recall']).toMatch(/e\.g\. "/)
    expect(d['memoria_store_fact']).toMatch(/as soon as/i)
    expect(d['memoria_store_fact']).toMatch(/e\.g\. "/)
  })

  it('aucun nom de propriétaire codé en dur : le produit sert d’autres utilisateurs que Néto', () => {
    // « the owner (Néto) » dans memoria_identify_interlocutor partait chez
    // TOUTES les installations : chaque LLM apprenait que l'owner s'appelle Néto.
    // Puis les EXEMPLES (« commits must be authored by Nieto42 », « site-primo »,
    // « maroway ») embarquaient le handle GitHub et les clients du propriétaire
    // dans le contexte de chaque LLM — même fuite, autre porte. On vérifie donc
    // une liste de jetons propriétaire sur les descriptions ET les schémas
    // d'arguments (les `.describe()` partent aussi chez le client MCP).
    const ownerTokens = /Néto|Neto|Nieto|primo|maroway/i
    for (const [name, text] of Object.entries(descriptions())) {
      expect(text, name).not.toMatch(ownerTokens)
    }
    for (const [name, text] of Object.entries(argDescriptions())) {
      expect(text, name).not.toMatch(ownerTokens)
    }
    expect(SERVER_INSTRUCTIONS).not.toMatch(ownerTokens)
    expect(descriptions()['memoria_identify_interlocutor']).toMatch(/the owner/)
  })

  it('aucune description ne promet un scoping par repo : seuls project/client/org déclarés comptent', () => {
    // Le core ne regarde que project_id/client_org_id/org_id (scoring.ts) ;
    // repo_path/topic auto-détectés sont envoyés mais inertes. Dire au LLM que
    // le repo « est appliqué automatiquement » lui faisait croire qu'un
    // contexte existait alors qu'aucune isolation ni boost n'était actif.
    const d = descriptions()
    expect(d['memoria_recall']).not.toMatch(/repo\) is applied automatically/)
    expect(d['memoria_recall']).toMatch(/memoria_set_context/)
    expect(d['memoria_get_context']).toMatch(/informational/)
    expect(d['memoria_set_context']).toMatch(/informational/)
  })
})
