/**
 * Rappel STRUCTURÉ (T30) : chaque souvenir dit pourquoi il est sorti, de quoi
 * il parle, quel crédit lui donner et à quoi il est relié. Et un aperçu humain
 * peut exécuter le vrai rappel sans rien modifier.
 *
 * Données fictives uniquement (dépôt public).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CognitionEngine, Memoria, applyRecallCutoff, rankEntities, type EmbeddingProvider } from '../src/index.js'

/** Deux directions : « véhicule » (voiture, automobile...) et tout le reste. */
class FakeEmbedding implements EmbeddingProvider {
  readonly name = 'fake'
  readonly model = 'fake-8d'
  readonly dimensions = 8
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(
      texts.map(t => {
        const v = new Float32Array(8)
        if (/voiture|automobile|véhicule/i.test(t)) v[0] = 1
        else v[6] = 1
        return v
      }),
    )
  }
}

let root: string
let m: Memoria
let instance: string

function init(embeddings?: EmbeddingProvider): void {
  root = mkdtempSync(join(tmpdir(), 'memoria-enrich-'))
  m = Memoria.init({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: null, ...(embeddings ? { embeddings } : {}) },
    secretsVault: 'aes-vault',
  })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
}

/** Base de contenu privée de l'instance (pour préparer un état que l'API ne produit pas). */
function privateDb(): Database {
  const path = m.registry.dbForInstance(instance)!.path
  return (m as unknown as { openContent(p: string): { db: Database } }).openContent(path).db
}

function recallCount(id: string): number {
  return (privateDb().prepare('SELECT recall_count AS c FROM facts WHERE id = ?').get(id) as { c: number }).c
}

function recallAudits(): number {
  return m.registry.auditTail(1000).filter(a => a.action === 'recall').length
}

beforeEach(() => init())

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('pourquoi un souvenir est sorti (matched_by)', () => {
  it('trouvé par les mots : text, avec ses éléments de confiance', () => {
    const f = m.storeFact({ instance, content: 'Le portail Lumen est hébergé chez Brumehost', confidence: 0.8 })
    const item = m.recall({ instance, query: 'portail Lumen' }).items[0]!
    expect(item.id).toBe(f.id)
    expect(item.matched_by).toEqual(['text'])
    expect(item.trust).toEqual({ confidence: 0.8, used_count: 0, recall_count: 0 })
    // Rien d'inventé : pas de statut, pas de voisins, pas d'entité de passage.
    expect(item).not.toHaveProperty('status')
    expect(item).not.toHaveProperty('links')
    expect(item).not.toHaveProperty('via_entity')
  })

  it('contexte actif et épinglage sont nommés', () => {
    const own = m.registry.ownCompany()!
    const project = m.registry.createProject('Projet Calypso', own.id)
    const inCtx = m.storeFact({ instance, content: 'La maquette Calypso utilise la police Mirabelle', project_id: project.id })
    const pinned = m.storeFact({ instance, content: 'La maquette Odessa utilise la police Quetsche' })
    m.setPinned(instance, pinned.id, true)

    const res = m.recall({ instance, query: 'maquette police', active_context: { project_id: project.id } })
    expect(res.items.find(i => i.id === inCtx.id)?.matched_by).toEqual(['text', 'context'])
    expect(res.items.find(i => i.id === pinned.id)?.matched_by).toEqual(['text', 'pinned'])
  })

  it('voisin de graphe : graph + nom de l’entité de passage', async () => {
    const seed = m.storeFact({ instance, content: 'Le chantier Zephyr dépend du service Kestrel' })
    const neighbor = m.storeFact({ instance, content: 'Kestrel tourne sur la machine Halcyon' })
    await m.processCognition(instance)

    const res = m.recall({ instance, query: 'chantier Zephyr' })
    expect(res.items[0]!.id).toBe(seed.id)
    const viaGraph = res.items.find(i => i.id === neighbor.id)
    expect(viaGraph, 'le voisin par entité doit remonter').toBeDefined()
    expect(viaGraph!.matched_by).toEqual(['graph'])
    expect(viaGraph!.via_entity).toBe('Kestrel')

    // Sans expansion, plus de voisin (et donc plus de raison « graph »).
    const plain = m.recall({ instance, query: 'chantier Zephyr', expand_graph: false })
    expect(plain.items.some(i => i.matched_by?.includes('graph'))).toBe(false)
  })

  it('voisins de graphe : 8 demandés comme avant, relus en une seule requête', async () => {
    m.storeFact({ instance, content: 'Le chantier Zephyr dépend du service Kestrel' })
    const BASES = ['Orvalis', 'Quintor', 'Belmira', 'Sartane', 'Kevrona', 'Talvane', 'Morvane', 'Pelisse', 'Ravelin', 'Ostrane', 'Velmour', 'Carnis']
    for (const base of BASES) m.storeFact({ instance, content: `Kestrel héberge la base ${base}` })
    await m.processCognition(instance)

    const expand = vi.spyOn(CognitionEngine.prototype, 'expandEntities')
    const db = privateDb()
    const prepare = db.prepare.bind(db)
    const prepared: string[] = []
    db.prepare = ((sql: string) => {
      prepared.push(sql.replace(/\s+/g, ' ').trim())
      return prepare(sql)
    }) as typeof db.prepare
    let res: ReturnType<typeof m.recall>
    let calls: unknown[][]
    try {
      res = m.recall({ instance, query: 'chantier Zephyr', limit: 30, preview: true })
      calls = [...expand.mock.calls]
    } finally {
      db.prepare = prepare
      expand.mockRestore()
    }

    // Un voisin déjà trouvé par les mots compte dans ces 8 : l'échelle du rappel
    // sans option reste celle d'avant (demander 24 pour en garder 8 en ajoutait).
    expect(calls).toHaveLength(1)
    expect(calls[0]![2]).toMatchObject({ maxFacts: 8 })
    expect(res.items.filter(i => i.matched_by?.includes('graph'))).toHaveLength(8)
    // Plus une requête par voisin.
    expect(prepared.filter(sql => sql.includes('FROM facts WHERE id = ?'))).toEqual([])
  })

  it('trouvé par le sens seul : meaning', async () => {
    m.close()
    rmSync(root, { recursive: true, force: true })
    init(new FakeEmbedding())
    const f = m.storeFact({ instance, content: "L'automobile de service est garée au sous-sol" })
    await m.indexEmbeddings(instance)

    const res = await m.recallSemantic({ instance, query: 'véhicule' })
    const item = res.items.find(i => i.id === f.id)
    expect(item?.matched_by).toEqual(['meaning'])

    // Mots ET sens : les deux raisons.
    const both = await m.recallSemantic({ instance, query: 'automobile' })
    expect(both.items.find(i => i.id === f.id)?.matched_by).toEqual(['text', 'meaning'])
  })
})

describe('de quoi parle un souvenir (topic, entities)', () => {
  it('thème principal et entités après la passe de cognition', async () => {
    const a = m.storeFact({ instance, content: 'Le déploiement Brumehost utilise le compte Solstice' })
    m.storeFact({ instance, content: 'Brumehost échoue quand le cache Solstice est corrompu' })
    await m.processCognition(instance)

    const item = m.recall({ instance, query: 'déploiement Brumehost' }).items.find(i => i.id === a.id)!
    expect(item.topic?.id).toBeTruthy()
    expect(item.topic?.name).toBeTruthy()
    expect(item.entities).toEqual(expect.arrayContaining(['Brumehost', 'Solstice']))
    expect(item.entities!.length).toBeLessThanOrEqual(4)
  })

  it('sans cognition : ni thème ni entités, jamais de tableau vide', () => {
    m.storeFact({ instance, content: 'Le déploiement Brumehost utilise le compte Solstice' })
    const item = m.recall({ instance, query: 'déploiement Brumehost' }).items[0]!
    expect(item).not.toHaveProperty('topic')
    expect(item).not.toHaveProperty('entities')
  })

  it('rankEntities : types forts, puis rares, bruit écarté, 4 au plus', () => {
    const ranked = rankEntities([
      { name: 'Pour', type: 'concept', mention_count: 1 },
      { name: '2026-03-14', type: 'concept', mention_count: 1 },
      { name: 'README', type: 'concept', mention_count: 2 },
      { name: 'Postgres', type: 'tool', mention_count: 40 },
      { name: 'Halcyon', type: 'tool', mention_count: 2 },
      { name: 'Atelier Borealis', type: 'company', mention_count: 12 },
      { name: 'Projet Calypso', type: 'project', mention_count: 3 },
      { name: 'Mirabelle', type: 'concept', mention_count: 1 },
      { name: 'Quetsche', type: 'concept', mention_count: 5 },
    ])
    expect(ranked.map(e => e.name)).toEqual(['Projet Calypso', 'Atelier Borealis', 'Mirabelle', 'Halcyon'])
  })
})

describe('statut d’un souvenir', () => {
  it('expiring : une date d’expiration à venir', () => {
    const f = m.storeFact({ instance, content: 'Le local Tamaris est fermé pour travaux' })
    m.setExpiry(instance, f.id, new Date(Date.now() + 86_400_000).toISOString())
    expect(m.recall({ instance, query: 'local Tamaris' }).items[0]!.status).toBe('expiring')
  })

  it('replaces : ce fait en a remplacé un autre', () => {
    const old = m.storeFact({ instance, content: 'Le standard Tamaris ouvre à neuf heures' })
    const { replacement } = m.correctFact(instance, old.id, 'Le standard Tamaris ouvre désormais à huit heures')
    const res = m.recall({ instance, query: 'standard Tamaris' })
    expect(res.items.map(i => i.id)).toEqual([replacement!.id])
    expect(res.items[0]!.status).toBe('replaces')
  })

  it('contested : révision en attente (et prime sur les autres statuts)', () => {
    const old = m.storeFact({ instance, content: 'Le coursier Tamaris passe le mardi' })
    const next = m.storeFact({ instance, content: 'Le coursier Tamaris passe désormais le jeudi' })
    m.setExpiry(instance, old.id, new Date(Date.now() + 86_400_000).toISOString())
    const db = privateDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS revision_proposals (
        id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, kind TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '', replacement_fact_id TEXT,
        status TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL
      )`)
    db.prepare(
      `INSERT INTO revision_proposals (id, fact_id, kind, replacement_fact_id, status, created_at)
       VALUES ('rev-1', ?, 'contradicted', ?, 'proposed', '2026-07-01T00:00:00Z')`,
    ).run(old.id, next.id)

    const res = m.recall({ instance, query: 'coursier Tamaris' })
    expect(res.items.find(i => i.id === old.id)?.status).toBe('contested')
    expect(res.items.find(i => i.id === next.id)).not.toHaveProperty('status')
  })
})

describe('voisins (links)', () => {
  async function seed(): Promise<{ main: string; others: string[] }> {
    const main = m.storeFact({ instance, content: 'La borne Icare est installée dans le hall Persée' })
    const others = [
      'Icare redémarre chaque nuit à trois heures pour appliquer ses mises à jour de sécurité',
      'Le badge Icare est rangé au secrétariat',
      'Icare imprime les tickets en double',
      'La garantie Icare court sur deux ans',
    ].map(content => m.storeFact({ instance, content }).id)
    await m.processCognition(instance)
    return { main: main.id, others }
  }

  it('absents par défaut, calculés seulement sur demande', async () => {
    const { main } = await seed()
    const q = { instance, query: 'borne hall Persée', expand_graph: false, limit: 1 }
    expect(m.recall(q).items[0]).not.toHaveProperty('links')

    const item = m.recall({ ...q, links: true }).items[0]!
    expect(item.id).toBe(main)
    expect(item.links).toBeDefined()
    expect(item.links!.length).toBe(3) // 4 voisins possibles, 3 au plus
    for (const link of item.links!) {
      expect(link.via).toBe('Icare')
      expect(link.excerpt.length).toBeLessThanOrEqual(60)
      expect(link.id).not.toBe(main)
    }
  })

  it('un voisin déjà rendu n’est pas répété en lien', async () => {
    await seed()
    const res = m.recall({ instance, query: 'Icare', links: true })
    const returned = new Set(res.items.map(i => i.id))
    for (const item of res.items) for (const link of item.links ?? []) expect(returned.has(link.id)).toBe(false)
  })

  it('anti-fuite : un voisin d’un autre client n’est jamais lié', async () => {
    const orgA = m.registry.createOrganization('Client Fictif A', 'client')
    const orgB = m.registry.createOrganization('Client Fictif B', 'client')
    const main = m.storeFact({ instance, content: 'La borne Icare est installée dans le hall Persée' })
    const secretB = m.storeFact({ instance, content: 'Icare est facturée au tarif confidentiel du client B', client_org_id: orgB.id })
    const ofA = m.storeFact({ instance, content: 'Icare est louée par le client A', client_org_id: orgA.id })
    await m.processCognition(instance)

    const q = { instance, query: 'borne hall Persée', expand_graph: false, limit: 1, links: true }
    const linkIds = (ctx?: { client_org_id: string }) =>
      (m.recall({ ...q, ...(ctx ? { active_context: ctx } : {}) }).items.find(i => i.id === main.id)?.links ?? []).map(l => l.id)

    expect(linkIds()).toEqual([]) // aucun contexte client : données client masquées
    expect(linkIds({ client_org_id: orgA.id })).toEqual([ofA.id])
    expect(linkIds({ client_org_id: orgA.id })).not.toContain(secretB.id)
  })
})

describe('aperçu humain (preview)', () => {
  it('ne touche ni les compteurs ni l’audit, et rend le même rappel', () => {
    const f = m.storeFact({ instance, content: 'Le portail Lumen est hébergé chez Brumehost' })
    const audits = recallAudits()

    const preview = m.recall({ instance, query: 'portail Lumen', preview: true })
    expect(recallCount(f.id)).toBe(0)
    expect(recallAudits()).toBe(audits)

    const real = m.recall({ instance, query: 'portail Lumen' })
    expect(recallCount(f.id)).toBe(1)
    expect(recallAudits()).toBe(audits + 1)
    expect(preview.items.map(i => i.id)).toEqual(real.items.map(i => i.id))
    expect(preview.items[0]!.trust).toEqual(real.items[0]!.trust) // lus avant tout compteur
  })
})

describe('tables de cognition absentes', () => {
  it('le rappel reste normal', () => {
    const f = m.storeFact({ instance, content: 'Le portail Lumen est hébergé chez Brumehost' })
    const db = privateDb()
    db.pragma('foreign_keys = OFF')
    for (const table of ['fact_topics', 'fact_entities', 'relations', 'entities']) db.exec(`DROP TABLE IF EXISTS ${table}`)

    const res = m.recall({ instance, query: 'portail Lumen', links: true, format: 'blocks' })
    expect(res.items.map(i => i.id)).toEqual([f.id])
    expect(res.items[0]!.matched_by).toEqual(['text'])
    expect(res.items[0]).not.toHaveProperty('topic')
    expect(res.items[0]).not.toHaveProperty('entities')
    expect(res.blocks).toHaveLength(1)
  })
})

describe('ce qui a été écarté (dropped)', () => {
  it('rien d’écarté : pas de champ', () => {
    m.storeFact({ instance, content: 'Le portail Lumen est hébergé chez Brumehost' })
    expect(m.recall({ instance, query: 'portail Lumen' })).not.toHaveProperty('dropped')
  })

  it('limite et budget sont comptés', () => {
    for (let i = 1; i <= 6; i++) m.storeFact({ instance, content: `Le casier Lumen numéro ${i} contient la série de câbles référence ${i * 11}` })
    const limited = m.recall({ instance, query: 'casier Lumen', limit: 2 })
    expect(limited.items).toHaveLength(2)
    expect(limited.dropped).toEqual([{ reason: 'limit', count: 4 }])

    const tight = m.recall({ instance, query: 'casier Lumen', token_budget: 1 })
    expect(tight.items).toHaveLength(1) // le premier passe toujours
    expect(tight.dropped).toEqual([{ reason: 'budget', count: 5 }])
  })

  it('applyRecallCutoff : seuil relatif, plancher de 3, absent = rien', () => {
    const scores = [1, 0.9, 0.2, 0.1, 0.05].map(score => ({ score }))
    const s = (e: { score: number }) => e.score
    expect(applyRecallCutoff(scores, undefined, s)).toEqual({ kept: scores, dropped: 0 })
    expect(applyRecallCutoff(scores, 0, s).dropped).toBe(0)
    // 0,2 est sous le seuil mais protégé par le plancher de 3.
    expect(applyRecallCutoff(scores, 0.5, s)).toEqual({ kept: scores.slice(0, 3), dropped: 2 })
    expect(applyRecallCutoff(scores, 0.08, s)).toEqual({ kept: scores.slice(0, 4), dropped: 1 })
    expect(applyRecallCutoff(scores.slice(0, 3), 1, s).dropped).toBe(0)
  })

  it('un souvenir coupé par le seuil n’est PAS compté comme rappelé', () => {
    const strong = [1, 2, 3].map(i => m.storeFact({ instance, content: `Le portail Lumen expose la page tarifs version ${i}` }).id)
    const weak = m.storeFact({ instance, content: 'Le portail du jardin grince depuis lundi' }).id

    const res = m.recall({ instance, query: 'portail Lumen tarifs', cutoff: 0.3 })
    expect(res.items.map(i => i.id).sort()).toEqual([...strong].sort())
    expect(res.dropped).toEqual([{ reason: 'cutoff', count: 1 }])
    expect(recallCount(weak)).toBe(0)
    expect(recallCount(strong[0]!)).toBe(1)
  })
})

/**
 * MESURE : le seuil retire-t-il du remplissage sans retirer de bonne réponse ?
 *
 * Jeu fictif : 4 sujets de 6 faits + 8 distracteurs qui partagent un mot courant
 * avec les requêtes. Chaque requête liste les ids qu'un humain attend.
 */
describe('qualité : cutoff = 0,3 sur un jeu de 32 faits', () => {
  const SUBJECTS: Record<string, string[]> = {
    orion: [
      'Le site Orion est déployé sur Brumehost depuis la branche principale',
      'Le déploiement du site Orion exige une validation manuelle avant la mise en production',
      'Le site Orion utilise le thème graphique Ardoise',
      'Le formulaire de contact Orion envoie les messages vers la boîte accueil',
      'La base de données Orion est sauvegardée chaque nuit sur le coffre Granit',
      'Le certificat du site Orion est renouvelé automatiquement tous les trois mois',
    ],
    borealis: [
      'La facturation du client Borealis se fait le dernier jour du mois',
      'Le client Borealis règle ses factures à trente jours',
      'Le contact comptable du client Borealis est madame Fictive',
      'Le devis annuel Borealis couvre douze journées de tournage',
      'Les factures Borealis portent toujours le numéro de commande interne',
      'Le client Borealis demande un rapport mensuel des heures',
    ],
    kestrel: [
      'La chaîne Kestrel convertit les rushes en fichiers légers pendant la nuit',
      'Les exports Kestrel sont rangés par date dans le dossier Livraison',
      'La chaîne Kestrel exige au moins cent gigaoctets libres avant un export',
      'Le réglage couleur Kestrel par défaut est le profil Aurore',
      'Les sous-titres Kestrel sont générés en français puis relus à la main',
      'La chaîne Kestrel envoie une alerte quand un export échoue',
    ],
    nimbus: [
      "L'application Nimbus affiche un écran d'accueil animé au premier lancement",
      "Le mode sombre de l'application Nimbus suit le réglage du téléphone",
      "L'application Nimbus est traduite en cinq langues",
      "Les notifications Nimbus sont envoyées le matin à huit heures",
      "L'abonnement Nimbus coûte trois euros par mois",
      "La synchronisation Nimbus fonctionne hors connexion puis rattrape son retard",
    ],
  }
  const DISTRACTORS = [
    'Le site de la mairie ferme ses guichets le vendredi',
    'La facturation électronique devient obligatoire pour les grandes entreprises',
    'Une chaîne de vélo se graisse après chaque sortie sous la pluie',
    "L'application de la recette demande deux cuillères de farine",
    'Le client du café préfère une table près de la fenêtre',
    'Le déploiement des tentes du festival commence à six heures',
    'Les exports de mangues augmentent pendant la saison sèche',
    'Le mode de cuisson lente attendrit la viande',
  ]

  it('aucun souvenir attendu n’est perdu, le remplissage part', () => {
    const ids: Record<string, string[]> = {}
    for (const [subject, facts] of Object.entries(SUBJECTS)) ids[subject] = facts.map(content => m.storeFact({ instance, content }).id)
    for (const content of DISTRACTORS) m.storeFact({ instance, content })

    const QUERIES: Array<{ query: string; expected: string[] }> = [
      { query: 'déploiement site Orion', expected: [ids['orion']![0]!, ids['orion']![1]!] },
      { query: 'site Orion', expected: [ids['orion']![0]!, ids['orion']![1]!, ids['orion']![2]!, ids['orion']![5]!] },
      { query: 'facturation client Borealis', expected: [ids['borealis']![0]!] },
      { query: 'factures client Borealis', expected: [ids['borealis']![1]!, ids['borealis']![4]!] },
      { query: 'chaîne Kestrel export', expected: [ids['kestrel']![2]!, ids['kestrel']![5]!] },
      { query: 'application Nimbus', expected: [ids['nimbus']![0]!, ids['nimbus']![1]!, ids['nimbus']![2]!] },
      { query: 'abonnement Nimbus prix', expected: [ids['nimbus']![4]!] },
    ]

    const measures: string[] = []
    let withoutTotal = 0
    let withTotal = 0
    for (const { query, expected } of QUERIES) {
      // `preview` : la mesure ne doit pas modifier les compteurs d'une requête à l'autre.
      const without = m.recall({ instance, query, preview: true, expand_graph: false })
      const withCut = m.recall({ instance, query, preview: true, expand_graph: false, cutoff: 0.3 })
      const keptIds = new Set(withCut.items.map(i => i.id))
      const baseIds = new Set(without.items.map(i => i.id))

      // Le jeu est bien posé : sans seuil, tout l'attendu est là.
      for (const id of expected) expect(baseIds.has(id), `« ${query} » sans seuil`).toBe(true)
      // Avec le seuil, AUCUN attendu ne disparaît.
      for (const id of expected) expect(keptIds.has(id), `« ${query} » avec cutoff 0,3`).toBe(true)
      // Le seuil ne fait que retirer une queue : jamais d'ajout ni de réordonnancement.
      expect(withCut.items.map(i => i.id)).toEqual(without.items.slice(0, withCut.items.length).map(i => i.id))

      withoutTotal += without.items.length
      withTotal += withCut.items.length
      measures.push(`${query} : ${without.items.length} -> ${withCut.items.length} (attendus ${expected.length})`)
    }
    console.info(`[T30 cutoff 0,3] items rendus ${withoutTotal} -> ${withTotal}\n  ${measures.join('\n  ')}`)

    // Le remplissage part vraiment : nettement moins d'items au total.
    expect(withTotal).toBeLessThan(withoutTotal * 0.7)
  })
})
