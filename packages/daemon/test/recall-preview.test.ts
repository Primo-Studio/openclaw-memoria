/**
 * T30, sorties du rappel côté daemon :
 *  - POST /v1/memory/recall laisse passer `format`, `cutoff`, `links`, mais
 *    JAMAIS `preview` (un agent ne rappelle pas sans compteur ni audit) ;
 *  - POST /v1/admin/recall_preview exécute le vrai rappel d'une instance sans
 *    rien modifier, et renvoie pour chaque canal le texte exact que l'agent
 *    reçoit ET le résultat du rappel qui l'a produit ; en pause, la réponse de
 *    pause, sans aucun embedding.
 * Données fictives, aucun réseau LLM (extraction et embeddings à null).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactRecall, estimateTokens, formatRecallBlocks, formatRecallOpenClaw, type RecallResult } from '@memoria/core'
import { DaemonClient, startDaemon, type RunningDaemon } from '../src/index.js'

let root: string
let daemon: RunningDaemon | null = null

afterEach(async () => {
  await daemon?.close()
  daemon = null
  rmSync(root, { recursive: true, force: true })
})

interface Booted {
  agent: DaemonClient
  instance: string
  instanceToken: string
}

async function boot(type = 'claude-code'): Promise<Booted> {
  root = mkdtempSync(join(tmpdir(), 'memoria-recall-preview-'))
  daemon = await startDaemon({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null, embeddings: null } })
  const admin = new DaemonClient(daemon.state, daemon.state.admin_token)
  const paired = await admin.pair(type)
  const done = await new DaemonClient(daemon.state).completePairing(paired.pairing_code)
  const agent = new DaemonClient(daemon.state, done.instance_token)
  await agent.storeFact({ content: 'Le portail Lumen est hébergé chez Brumehost' })
  await agent.storeFact({ content: 'Le portail Lumen se déploie le mardi matin' })
  await agent.storeFact({ content: 'La borne Icare est installée dans le hall Persée' })
  return { agent, instance: done.assistant_instance_id, instanceToken: done.instance_token }
}

interface Rendering {
  id: 'mcp' | 'blocks' | 'openclaw'
  native: boolean
  text: string
  tokens: number
  result: RecallResult
  disabled?: boolean
}

interface Preview {
  instance: string
  agent_type: string
  query: string
  result: RecallResult
  renderings: Rendering[]
  disabled?: boolean
}

async function post(path: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function preview(body: Record<string, unknown>): Promise<Preview> {
  const res = await post('/v1/admin/recall_preview', daemon!.state.admin_token, body)
  expect(res.status).toBe(200)
  return res.json as unknown as Preview
}

const rendering = (p: Preview, id: Rendering['id']): Rendering => p.renderings.find(r => r.id === id)!

describe('POST /v1/memory/recall : options de mise en forme', () => {
  it('sans option nouvelle : ni blocs ni voisins', async () => {
    const { agent } = await boot()
    const r = await agent.recall({ query: 'portail Lumen' })
    expect(r.items.length).toBeGreaterThanOrEqual(2)
    expect(r.blocks).toBeUndefined()
    expect(r.items.every(i => i.links === undefined)).toBe(true)
  })

  it("format: 'blocks' arrive au moteur, une valeur inconnue est ignorée", async () => {
    const { agent } = await boot()
    const blocks = await agent.recall({ query: 'portail Lumen', format: 'blocks' })
    expect(Array.isArray(blocks.blocks)).toBe(true)
    expect(blocks.blocks!.flatMap(b => b.item_ids).sort()).toEqual(blocks.items.map(i => i.id).sort())
    const unknown = await agent.recall({ query: 'portail Lumen', format: 'tableau' })
    expect(unknown.blocks).toBeUndefined()
  })

  it('cutoff arrive au moteur : la queue est coupée et annoncée dans dropped', async () => {
    const { agent } = await boot()
    // Un fait qui porte les deux mots de la requête, six qui n'en portent
    // qu'un : la queue tombe sous le seuil, le plancher en garde 3.
    for (const lieu of ['Atrium', 'Belvédère', 'Cellier', 'Dortoir', 'Entrepôt', 'Fournil']) {
      await agent.storeFact({ content: `Le registre ${lieu} est tenu par le service Quartz` })
    }
    await agent.storeFact({ content: 'Le registre Quartz Opaline Opaline est archivé chaque trimestre sous la référence Opaline' })
    const all = await agent.recall({ query: 'registre Opaline', expand_graph: false })
    const cut = await agent.recall({ query: 'registre Opaline', expand_graph: false, cutoff: 0.9 })
    expect(all.items.length).toBeGreaterThan(3)
    expect(cut.items).toHaveLength(3)
    expect(cut.dropped).toEqual([{ reason: 'cutoff', count: all.items.length - 3 }])
    expect(cut.items.map(i => i.id)).toEqual(all.items.slice(0, 3).map(i => i.id))
  })

  it('limit et token_budget sont bornés (1 à 50, 100 à 4000) et arrondis', async () => {
    const { agent, instanceToken } = await boot()
    const all = await agent.recall({ query: 'portail Lumen borne Icare', expand_graph: false })
    expect(all.items.length).toBeGreaterThanOrEqual(3)
    // limit: 0 ne renvoyait rien du tout ; une valeur à virgule passait telle quelle.
    expect((await agent.recall({ query: 'portail Lumen borne Icare', expand_graph: false, limit: 0 })).items).toHaveLength(1)
    expect((await agent.recall({ query: 'portail Lumen borne Icare', expand_graph: false, limit: -5 })).items).toHaveLength(1)
    expect((await agent.recall({ query: 'portail Lumen borne Icare', expand_graph: false, limit: 1.6 })).items).toHaveLength(2)
    expect((await agent.recall({ query: 'portail Lumen borne Icare', expand_graph: false, limit: 100000 })).items).toHaveLength(all.items.length)
    // token_budget: 1 ne laissait passer qu'un souvenir ; le plancher de 100 en laisse plusieurs.
    const tight = await agent.recall({ query: 'portail Lumen borne Icare', expand_graph: false, token_budget: 1 })
    expect(tight.items.length).toBeGreaterThan(1)
    expect(tight.tokens).toBeLessThanOrEqual(100)
    // Une valeur non finie est ignorée (défaut du moteur), pas relayée.
    const odd = await post('/v1/memory/recall', instanceToken, { query: 'portail Lumen borne Icare', expand_graph: false, limit: 'beaucoup' })
    expect(odd.status).toBe(200)
    expect((odd.json['items'] as unknown[]).length).toBe(all.items.length)
  })

  it("preview n'est JAMAIS relayé sur la route d'agent : le rappel compte", async () => {
    const { agent, instance } = await boot()
    const before = await preview({ instance, query: 'borne Icare' })
    expect(before.result.items[0]!.trust!.recall_count).toBe(0)

    await agent.recall({ query: 'borne Icare', preview: true })

    const after = await preview({ instance, query: 'borne Icare' })
    expect(after.result.items[0]!.trust!.recall_count).toBe(1)
    const audit = await (
      await fetch(`http://127.0.0.1:${daemon!.state.port}/v1/admin/audit`, { headers: { authorization: `Bearer ${daemon!.state.admin_token}` } })
    ).json() as { entries: Array<{ action: string }> }
    expect(audit.entries.filter(e => e.action === 'recall')).toHaveLength(1)
  })
})

describe('POST /v1/admin/recall_preview', () => {
  it('renvoie un résultat PAR RENDU ; le résultat racine est celui du rendu natif (MCP ici)', async () => {
    const { instance } = await boot()
    const p = await preview({ instance, query: 'portail Lumen' })
    expect(p.instance).toBe(instance)
    expect(p.agent_type).toBe('claude-code')
    expect(p.query).toBe('portail Lumen')
    expect(p.disabled).toBeUndefined()
    expect(p.renderings.map(r => [r.id, r.native])).toEqual([
      ['mcp', true],
      ['blocks', false],
      ['openclaw', false],
    ])
    expect(p.renderings.every(r => r.disabled === undefined)).toBe(true)
    expect(p.result).toEqual(rendering(p, 'mcp').result)

    // MCP : le rappel de l'outil par défaut, sans voisins ni blocs.
    const mcp = rendering(p, 'mcp').result
    expect(mcp.items.length).toBeGreaterThanOrEqual(2)
    expect(mcp.items[0]!.matched_by).toContain('text')
    expect(mcp.blocks).toBeUndefined()
    expect(mcp.items.every(i => i.links === undefined)).toBe(true)
    // Blocs : le même rappel, avec ses blocs.
    const blocks = rendering(p, 'blocks').result
    expect(Array.isArray(blocks.blocks)).toBe(true)
    expect(blocks.items.map(i => i.id)).toEqual(mcp.items.map(i => i.id))
  })

  it('chaque texte est celui que produit la fonction de son canal, à partir de SON résultat', async () => {
    const { instance } = await boot()
    const p = await preview({ instance, query: 'portail Lumen' })

    // MCP : JSON compact de son résultat (sans voisins : l'outil ne les demande pas).
    const mcp = rendering(p, 'mcp')
    expect(mcp.text).toBe(JSON.stringify(compactRecall(mcp.result)))
    const parsed = JSON.parse(mcp.text) as { items: Array<Record<string, unknown>> }
    expect(parsed.items[0]).toMatchObject({ id: mcp.result.items[0]!.id, why: expect.arrayContaining(['text']) })
    expect(parsed.items.every(i => !('links' in i) && !('scope_id' in i))).toBe(true)

    // Blocs : le texte du core, plafonné comme le fait l'outil (6 caractères
    // par token du budget par défaut), avec les ids utilisables pour le feedback.
    const blocks = rendering(p, 'blocks')
    expect(blocks.text).toBe(formatRecallBlocks(blocks.result, { maxChars: 1500 * 6 }))
    expect(blocks.text).toMatch(/^Memory: /)
    for (const item of blocks.result.items) expect(blocks.text).toContain(`#${item.id}`)

    // OpenClaw : le bloc injecté. Un match direct ne porte PAS de note.
    const openclaw = rendering(p, 'openclaw').text
    expect(openclaw.startsWith('## 🧠 Relevant memory (Memoria)')).toBe(true)
    expect(openclaw).toContain('### Active facts')
    expect(openclaw).toMatch(/^- Le portail Lumen est hébergé chez Brumehost _\(\d{4}-\d{2}-\d{2}\)_$/m)
    expect(openclaw).not.toMatch(/\[text/)
  })

  it('tokens : estimation propre à chaque rendu (moteur pour MCP et blocs, 4 caractères par token pour OpenClaw)', async () => {
    const { instance } = await boot()
    const p = await preview({ instance, query: 'portail Lumen' })
    for (const id of ['mcp', 'blocks'] as const) expect(rendering(p, id).tokens).toBe(estimateTokens(rendering(p, id).text))
    const openclaw = rendering(p, 'openclaw')
    expect(openclaw.text.length).toBeGreaterThan(0)
    expect(openclaw.tokens).toBe(Math.ceil(openclaw.text.length / 4))
    // La règle du plugin, pas celle du moteur : sinon un bloc plein dépasserait son budget à l'écran.
    expect(openclaw.tokens).toBeLessThan(estimateTokens(openclaw.text))
    expect(openclaw.tokens).toBeLessThanOrEqual(600)
  })

  it('le texte en blocs est plafonné selon le budget demandé', async () => {
    const { agent, instance } = await boot()
    for (const lieu of ['Atrium', 'Belvédère', 'Cellier', 'Dortoir', 'Entrepôt', 'Fournil']) {
      await agent.storeFact({ content: `Le portail Lumen dessert le bâtiment ${lieu} par la passerelle nord depuis la rentrée` })
    }
    const p = await preview({ instance, query: 'portail Lumen', token_budget: 100, cutoff: 0 })
    const blocks = rendering(p, 'blocks')
    expect(blocks.result.items.length).toBeGreaterThan(3)
    expect(blocks.text.length).toBeLessThanOrEqual(100 * 6)
    // Des souvenirs rappelés ne tiennent pas dans le plafond : ils ne sont pas écrits.
    const written = blocks.text.split('\n').filter(l => /^(now|-) /.test(l)).length
    expect(written).toBeGreaterThan(0)
    expect(written).toBeLessThan(blocks.result.items.length)
    expect(blocks.text).toBe(formatRecallBlocks(blocks.result, { maxChars: 600 }))
  })

  it('le rendu OpenClaw rejoue les réglages par défaut du plugin (12 souvenirs, 600 tokens, plancher 0,15)', async () => {
    const { instance } = await boot()
    const p = await preview({ instance, query: 'portail Lumen' })
    const direct = await daemon!.memoria.recallSemantic({ instance, query: 'portail Lumen', limit: 12, token_budget: 600, preview: true })
    expect(rendering(p, 'openclaw').text).toBe(
      formatRecallOpenClaw(direct.items, { relevanceFloor: 0.15, tokenBudget: 600, showProvenance: true }),
    )
  })

  it("un agent OpenClaw a le rendu 'openclaw' pour natif, et le résultat racine est celui de SON rappel", async () => {
    const { agent, instance } = await boot('openclaw')
    for (const lieu of ['Atrium', 'Belvédère', 'Cellier', 'Dortoir', 'Entrepôt', 'Fournil']) {
      await agent.storeFact({ content: `Le registre ${lieu} est tenu par le service Quartz` })
    }
    await agent.storeFact({ content: 'Le registre Quartz Opaline Opaline est archivé chaque trimestre sous la référence Opaline' })
    const p = await preview({ instance, query: 'registre Opaline', expand_graph: false })
    expect(p.agent_type).toBe('openclaw')
    expect(p.renderings.filter(r => r.native).map(r => r.id)).toEqual(['openclaw'])

    const openclaw = rendering(p, 'openclaw')
    const mcp = rendering(p, 'mcp')
    expect(p.result).toEqual(openclaw.result)
    // Le rappel MCP coupe au seuil 0,3 en gardant au moins 3 souvenirs ; le
    // plugin OpenClaw applique son plancher 0,15 SANS minimum : les deux
    // résultats diffèrent, l'écran doit lire celui du rendu natif.
    expect(mcp.result.items).toHaveLength(3)
    expect(openclaw.result.items).toHaveLength(1)
    expect(openclaw.result.items[0]!.content).toContain('Opaline')
    // Ce que le plancher écarte est annoncé, comme un seuil.
    expect(openclaw.result.dropped).toEqual([{ reason: 'cutoff', count: 6 }])
    expect(openclaw.result.blocks).toBeUndefined()
    // Le résultat liste exactement les souvenirs écrits dans le bloc.
    expect(openclaw.result.items).toHaveLength(openclaw.text.split('\n').filter(l => l.startsWith('- ')).length)
    for (const item of openclaw.result.items) expect(openclaw.text).toContain(item.content)
  })

  it('OpenClaw : un souvenir rappelé mais non écrit (budget du bloc, plancher) sort du résultat et passe dans dropped', async () => {
    const { agent, instance } = await boot('openclaw')
    for (const lieu of ['Atrium', 'Belvédère', 'Cellier', 'Dortoir', 'Entrepôt', 'Fournil']) {
      await agent.storeFact({ content: `Le portail Lumen dessert le bâtiment ${lieu}` })
    }
    // 100 tokens : le moteur compte le contenu seul (3,6 caractères par token),
    // le plugin compte tout le bloc, titres compris (400 caractères).
    const p = await preview({ instance, query: 'portail Lumen', token_budget: 100, expand_graph: false })
    const openclaw = rendering(p, 'openclaw')
    const direct = await daemon!.memoria.recallSemantic({ instance, query: 'portail Lumen', limit: 12, token_budget: 100, expand_graph: true, preview: true })
    const lines = openclaw.text.split('\n').filter(l => l.startsWith('- '))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThan(direct.items.length)
    expect(openclaw.result.items).toHaveLength(lines.length)
    expect(openclaw.result.items.map(i => i.id)).toEqual(direct.items.slice(0, lines.length).map(i => i.id))
    expect(openclaw.result.tokens).toBe(openclaw.result.items.reduce((n, i) => n + estimateTokens(i.content), 0))
    const dropped = Object.fromEntries((openclaw.result.dropped ?? []).map(d => [d.reason, d.count]))
    const before = Object.fromEntries((direct.dropped ?? []).map(d => [d.reason, d.count]))
    const added = (dropped['budget'] ?? 0) + (dropped['cutoff'] ?? 0) - (before['budget'] ?? 0) - (before['cutoff'] ?? 0)
    expect(added).toBe(direct.items.length - lines.length)
    expect(openclaw.text.length).toBeLessThanOrEqual(100 * 4 + 1)
  })

  it('ne touche à rien : ni compteur de rappel, ni audit', async () => {
    const { instance } = await boot()
    for (let i = 0; i < 3; i++) await preview({ instance, query: 'borne Icare' })
    const p = await preview({ instance, query: 'borne Icare' })
    expect(p.result.items[0]!.trust!.recall_count).toBe(0)
    expect(daemon!.memoria.registry.auditTail(200).filter(e => e.action === 'recall')).toHaveLength(0)
  })

  it('applique par défaut le seuil du MCP (0,3) ; cutoff: 0 le lève ; limit est relayé', async () => {
    const { agent, instance } = await boot()
    for (const lieu of ['Atrium', 'Belvédère', 'Cellier', 'Dortoir', 'Entrepôt', 'Fournil']) {
      await agent.storeFact({ content: `Le registre ${lieu} est tenu par le service Quartz` })
    }
    await agent.storeFact({ content: 'Le registre Quartz Opaline Opaline est archivé chaque trimestre sous la référence Opaline' })
    const body = { instance, query: 'registre Opaline', expand_graph: false }
    const byDefault = await preview(body)
    const explicit = await preview({ ...body, cutoff: 0.3 })
    const none = await preview({ ...body, cutoff: 0 })
    expect(byDefault.result.items.map(i => i.id)).toEqual(explicit.result.items.map(i => i.id))
    expect(byDefault.result.dropped).toEqual(explicit.result.dropped)
    expect(none.result.items.length).toBeGreaterThan(3)
    expect((none.result.dropped ?? []).some(d => d.reason === 'cutoff')).toBe(false)

    const two = await preview({ ...body, cutoff: 0, limit: 2 })
    expect(two.result.items).toHaveLength(2)
  })

  it('rien trouvé : JSON « vide » pour le MCP et les blocs, aucune injection pour OpenClaw', async () => {
    const { instance } = await boot()
    const p = await preview({ instance, query: 'zzzintrouvablezzz' })
    expect(p.result.items).toEqual([])
    expect(JSON.parse(rendering(p, 'mcp').text)).toEqual({ items: [], total_found: 0, tokens: 0 })
    expect(rendering(p, 'blocks').text).toBe(rendering(p, 'mcp').text)
    expect(rendering(p, 'openclaw').text).toBe('')
  })

  it('hors pause : deux rappels (MCP et blocs partagent le leur), pas trois', async () => {
    const { instance } = await boot()
    const semantic = vi.spyOn(daemon!.memoria, 'recallSemantic')
    await preview({ instance, query: 'portail Lumen' })
    expect(semantic).toHaveBeenCalledTimes(2)
    semantic.mockRestore()
  })

  it('Memoria en pause : chaque rendu porte le texte RÉEL de la pause, le résultat montre la reprise, aucun embedding', async () => {
    const { agent, instance } = await boot()
    await new DaemonClient(daemon!.state, daemon!.state.admin_token).setEnabled(false)
    // Le rappel sémantique embedde la requête (réseau avec un provider distant) :
    // en pause il ne doit pas être appelé du tout.
    const semantic = vi.spyOn(daemon!.memoria, 'recallSemantic')
    const p = await preview({ instance, query: 'portail Lumen' })
    expect(semantic).not.toHaveBeenCalled()
    semantic.mockRestore()

    expect(p.disabled).toBe(true)
    expect(p.renderings.map(r => r.disabled)).toEqual([true, true, true])
    // Ce que l'agent reçoit vraiment : la réponse de pause de la route de rappel,
    // projetée par l'outil MCP ; rien du tout pour OpenClaw.
    const real = (await agent.recall({ query: 'portail Lumen' })) as RecallResult & { disabled?: boolean }
    expect(real.disabled).toBe(true)
    const pausedJson = JSON.stringify(compactRecall(real))
    expect(pausedJson).toBe('{"items":[],"total_found":0,"tokens":0,"disabled":true}')
    expect(rendering(p, 'mcp').text).toBe(pausedJson)
    expect(rendering(p, 'blocks').text).toBe(pausedJson)
    expect(rendering(p, 'openclaw').text).toBe('')
    expect(rendering(p, 'openclaw').tokens).toBe(0)
    expect(rendering(p, 'mcp').tokens).toBe(estimateTokens(pausedJson))

    // `result` : ce qui serait rappelé à la reprise (plein texte), par rendu.
    expect(p.result).toEqual(rendering(p, 'mcp').result)
    for (const r of p.renderings) {
      expect(r.result.items.length).toBeGreaterThanOrEqual(2)
      expect(r.result.items[0]!.content).toContain('portail Lumen')
    }
    expect(Array.isArray(rendering(p, 'blocks').result.blocks)).toBe(true)
    // Toujours un aperçu : aucun compteur touché.
    expect(rendering(p, 'mcp').result.items[0]!.trust!.recall_count).toBe(0)
  })

  it('refuse un token d’instance, un corps incomplet, une instance inconnue', async () => {
    const { instance, instanceToken } = await boot()
    expect((await post('/v1/admin/recall_preview', instanceToken, { instance, query: 'x' })).status).toBe(401)
    const admin = daemon!.state.admin_token
    expect((await post('/v1/admin/recall_preview', admin, { query: 'x' })).status).toBe(400)
    expect((await post('/v1/admin/recall_preview', admin, { instance, query: '   ' })).status).toBe(400)
    expect((await post('/v1/admin/recall_preview', admin, { instance, query: 42 })).status).toBe(400)
    expect((await post('/v1/admin/recall_preview', admin, { instance: 'inconnue-000', query: 'x' })).status).toBe(404)
  })
})
