/**
 * Thèmes, expiration, cognition : défauts relevés par la contre-vérification
 * du 13/11 (zone « thèmes, expiration, cognition »).
 *
 *  1. une expiration écrite dans un autre format qu'ISO Z (« Jan 1 2020 »,
 *     décalage +05:00) paraissait vivante à la garde du thème, qui la comparait
 *     comme du texte ;
 *  2. après un oubli ou un rejet en revue, un thème gardait le nom tiré du fait
 *     effacé ;
 *  3. le graphe n'était nettoyé ni à l'oubli ni à la supersession ;
 *  4. un fait « critical » passait par la cognition (LLM, entités, thème, amas) ;
 *  5. fact_topics(topic_id) n'avait pas d'index ;
 *  6. un rattrapage LLM dont chaque extraction échoue « brûlait » les faits ;
 *  7. le passage ordinaire demandait au LLM le libellé de faits qu'il ne traitait pas ;
 *  9. dormant « backfill » validé jamais relié ; pause ignorée pendant un rattrapage LLM.
 *
 * Données fictives uniquement (dépôt public).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CognitionEngine,
  Memoria,
  TopicEngine,
  runMigrations,
  topicMigrations,
  type CompleteOptions,
  type LlmProvider,
} from '../src/index.js'

/** LLM factice : compte les extractions et les libellés, peut échouer sur demande. */
class FakeLlm implements LlmProvider {
  readonly name = 'openai'
  readonly model = 'gpt-4o-mini'
  available = true
  failGraph = false
  /** Échec ciblé : les faits dont le texte contient ce mot échouent toujours. */
  poison: string | null = null
  graph = 0
  label = 0
  prompts: string[] = []
  onGraph: (() => void) | null = null
  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available)
  }
  async complete(opts: CompleteOptions): Promise<string> {
    this.prompts.push(opts.prompt)
    if ((opts.system ?? '').includes('knowledge graph')) {
      this.graph++
      this.onGraph?.()
      if (this.failGraph || (this.poison && opts.prompt.includes(this.poison))) throw new Error('délai dépassé (simulé)')
      const text = (opts.prompt.match(/Fact: "([\s\S]*)"\n/) ?? [])[1] ?? ''
      const names = [...new Set(text.match(/\b\p{Lu}\p{Ll}+\b/gu) ?? [])]
      return JSON.stringify({ entities: names.map(name => ({ name, type: 'company' })), relations: [] })
    }
    if ((opts.system ?? '').includes('SUBJECT')) {
      this.label++
      return `Sujet ${this.label}`
    }
    return ''
  }
}

let root: string
let m: Memoria
let llm: FakeLlm
let instance: string

function open(withLlm: boolean, keepRoot = false): void {
  if (!keepRoot) root = mkdtempSync(join(tmpdir(), 'memoria-cogclean-'))
  if (!keepRoot || !llm) llm = new FakeLlm()
  m = Memoria.init({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    llm: { extraction: withLlm ? llm : null },
    secretsVault: 'aes-vault',
  })
  if (!keepRoot) instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
  // Pas de passage différé surprise au milieu d'un comptage.
  m.cognitionDebounceMs = 60_000
}
/** Même base, nouveau processus : la mémoire du processus (faits mis de côté, purge) repart de zéro. */
function restart(withLlm: boolean): void {
  m.close()
  open(withLlm, true)
}
function fresh(withLlm: boolean): void {
  m.close()
  rmSync(root, { recursive: true, force: true })
  open(withLlm)
}

beforeEach(() => open(false))
afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

const store = () => m['openContent'](m.paths.assistantDb(instance))
const db = (): Database => store().db as unknown as Database
const n = (sql: string, ...args: unknown[]): number => (db().prepare(sql).get(...args) as { n: number }).n
const marker = (id: string): { via: string; processed_at: string } | undefined =>
  db().prepare('SELECT via, processed_at FROM fact_cognition WHERE fact_id = ?').get(id) as { via: string; processed_at: string } | undefined
const entitiesOf = (id: string): number => n('SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?', id)
const topicsOf = (id: string): number => n('SELECT COUNT(*) AS n FROM fact_topics WHERE fact_id = ?', id)
const relationsCiting = (id: string): number => n('SELECT COUNT(*) AS n FROM relations WHERE context LIKE ?', `%${id}%`)
const topicNames = (): string[] => (db().prepare('SELECT name FROM topics').all() as Array<{ name: string }>).map(r => r.name)

/** Deux faits lisibles et deux faits « Zephyrcorp » rangés dans un même thème nommé d'après Zephyrcorp. */
async function seedTopic(): Promise<{ shown: string[]; hidden: string[] }> {
  const shown = [
    m.storeFact({ instance, content: 'Le déploiement Brumehost utilise le compte Solstice' }).id,
    m.storeFact({ instance, content: 'Le déploiement Brumehost passe par le portail Lumen' }).id,
  ]
  const hidden = [
    m.storeFact({ instance, content: 'Zephyrcorp paie le déploiement Brumehost de Zephyrcorp' }).id,
    m.storeFact({ instance, content: 'Zephyrcorp valide chaque déploiement Brumehost Zephyrcorp' }).id,
  ]
  await m.processCognition(instance)
  // Le rangement dépend de l'ordre de traitement (dates égales à la ms près) :
  // on pose l'état visé, un seul thème nommé d'après les faits Zephyrcorp.
  const d = db()
  const topicId = (d.prepare('SELECT topic_id FROM fact_topics WHERE fact_id = ?').get(hidden[0]) as { topic_id: string }).topic_id
  d.prepare("UPDATE topics SET name = 'Brumehost Zephyrcorp' WHERE id = ?").run(topicId)
  for (const id of [...shown, ...hidden]) {
    d.prepare('DELETE FROM fact_topics WHERE fact_id = ?').run(id)
    d.prepare('INSERT INTO fact_topics (fact_id, topic_id) VALUES (?, ?)').run(id, topicId)
  }
  d.prepare('DELETE FROM topics WHERE id NOT IN (SELECT topic_id FROM fact_topics)').run()
  return { shown, hidden }
}
const recallText = (): string => {
  const res = m.recall({ instance, query: 'déploiement Brumehost', links: true, format: 'blocks', preview: true })
  return JSON.stringify({ items: res.items, blocks: res.blocks })
}

describe('1. expiration : écrite en ISO, jugée sans dépendre du format', () => {
  it('setExpiry normalise en ISO Z et refuse une date illisible', () => {
    const f = m.storeFact({ instance, content: 'Le parking Tamaris est fermé pour travaux' })
    m.setExpiry(instance, f.id, 'Jan 1 2020')
    expect((db().prepare('SELECT expires_at FROM facts WHERE id = ?').get(f.id) as { expires_at: string }).expires_at).toBe(
      new Date('Jan 1 2020').toISOString(),
    )
    m.setExpiry(instance, f.id, '2030-01-01T05:00:00+05:00')
    expect((db().prepare('SELECT expires_at FROM facts WHERE id = ?').get(f.id) as { expires_at: string }).expires_at).toBe(
      '2030-01-01T00:00:00.000Z',
    )
    expect(() => m.setExpiry(instance, f.id, 'pas une date')).toThrow(/invalide/)
  })

  const pastPlus5 = (): string => `${new Date(Date.now() - 30 * 60_000 + 5 * 3_600_000).toISOString().slice(0, 19)}+05:00`
  it.each([
    ['« Jan 1 2020 »', (): string => 'Jan 1 2020'],
    ['il y a 30 min, écrit +05:00', pastPlus5],
  ])('valeur héritée %s : le thème n’est pas nommé', async (_label, value) => {
    const { shown, hidden } = await seedTopic()
    // Valeurs écrites avant la normalisation (setExpiry ne peut plus les produire).
    for (const id of hidden) db().prepare('UPDATE facts SET expires_at = ? WHERE id = ?').run(value(), id)
    const res = m.recall({ instance, query: 'déploiement Brumehost', expand_graph: false, format: 'blocks', preview: true })
    for (const id of shown) expect(res.items.find(i => i.id === id)).not.toHaveProperty('topic')
    expect(recallText()).not.toContain('Zephyrcorp')
  })

  it('la migration réécrit en ISO les dates lisibles, sans toucher updated_at ni une date illisible', () => {
    const a = m.storeFact({ instance, content: 'Le local Tamaris est loué à la société Ardoise' })
    const b = m.storeFact({ instance, content: 'Le parking Tamaris rouvre au printemps' })
    const c = m.storeFact({ instance, content: 'Le chantier Tamaris reprend en mars' })
    const d = db()
    d.prepare('UPDATE facts SET expires_at = ? WHERE id = ?').run('Jan 1 2020', a.id)
    d.prepare('UPDATE facts SET expires_at = ? WHERE id = ?').run('2030-01-01T05:00:00+05:00', b.id)
    d.prepare('UPDATE facts SET expires_at = ? WHERE id = ?').run('pas une date', c.id)
    const updatedBefore = d.prepare('SELECT id, updated_at FROM facts ORDER BY id').all()
    // Base « d'avant » : la migration n'a pas encore tourné.
    const version = topicMigrations.find(mig => mig.name === 'facts-expires-at-iso')!.version
    d.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version)
    runMigrations(d, topicMigrations)
    const exp = (id: string): string => (d.prepare('SELECT expires_at FROM facts WHERE id = ?').get(id) as { expires_at: string }).expires_at
    expect(exp(a.id)).toBe(new Date('Jan 1 2020').toISOString())
    expect(exp(b.id)).toBe('2030-01-01T00:00:00.000Z')
    expect(exp(c.id)).toBe('pas une date')
    expect(d.prepare('SELECT id, updated_at FROM facts ORDER BY id').all()).toEqual(updatedBefore)
  })
})

describe('2. oubli et rejet : aucun thème ne garde le nom d’un fait effacé', () => {
  it('forget supprime les thèmes touchés ; le passage suivant range les restants avec un nom tiré d’eux', async () => {
    const { shown, hidden } = await seedTopic()
    expect(topicNames().some(name => name.includes('Zephyrcorp'))).toBe(true) // témoin
    m.forget({ ids: hidden })
    expect(topicNames().some(name => name.includes('Zephyrcorp'))).toBe(false)
    expect(n('SELECT COUNT(*) AS n FROM topic_entities WHERE topic_id NOT IN (SELECT id FROM topics)')).toBe(0)
    expect(recallText()).not.toContain('Zephyrcorp')

    await m.processCognition(instance)
    for (const id of shown) expect(topicsOf(id)).toBe(1)
    expect(topicNames().some(name => name.includes('Zephyrcorp'))).toBe(false)
    expect(recallText()).not.toContain('Zephyrcorp')
  })

  it('rejet en revue d’un dormant rangé avant le correctif : même nettoyage', async () => {
    m.storeFact({ instance, content: 'Le déploiement Brumehost utilise le compte Solstice' })
    m.storeFact({ instance, content: 'Le déploiement Brumehost passe par le portail Lumen' })
    await m.processCognition(instance)
    m.setCaptureMode('review-first')
    const dormant = m.declareFact({ instance, content: 'Zephyrcorp paie le déploiement Brumehost de Zephyrcorp' }).fact!
    m.setCaptureMode('auto-private')
    // Base héritée : le dormant a été relié et rangé avant le correctif de la cognition.
    await new CognitionEngine({ store: store() }).processFact(dormant.id)
    await new TopicEngine({ store: store() }).assignFact(dormant.id)
    const touched = (db().prepare('SELECT topic_id FROM fact_topics WHERE fact_id = ?').all(dormant.id) as Array<{ topic_id: string }>).map(
      r => r.topic_id,
    )
    expect(touched).toHaveLength(1)

    const item = m.listReview().find(i => i.fact_id === dormant.id)!
    expect(m.reviewDecision([item.id], 'rejected').updated).toBe(1)
    expect(entitiesOf(dormant.id)).toBe(0)
    expect(relationsCiting(dormant.id)).toBe(0)
    // Le thème que le dormant avait rejoint (ou créé) n'existe plus.
    expect(n('SELECT COUNT(*) AS n FROM topics WHERE id = ?', touched[0])).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM fact_topics WHERE topic_id = ?', touched[0])).toBe(0)
    expect(topicNames().some(name => name.includes('Zephyrcorp'))).toBe(false)
    expect(recallText()).not.toContain('Zephyrcorp')
  })
})

describe('3. graphe nettoyé à l’oubli et à chaque supersession', () => {
  it('forget : ni lien fait-entité, ni contexte de relation, ni entité orpheline, ni amas', async () => {
    m.storeFact({ instance, content: 'Brumehost est notre hébergeur principal pour les sites' })
    const secret = m.storeFact({ instance, content: 'Zephyrcorp va racheter Brumehost en janvier' })
    m.storeFact({ instance, content: 'Brumehost héberge le portail Lumen' })
    await m.processCognition(instance, { includeBackfill: true })
    expect(entitiesOf(secret.id)).toBeGreaterThan(0)
    expect(relationsCiting(secret.id)).toBeGreaterThan(0)

    m.forget({ ids: [secret.id] })
    expect(entitiesOf(secret.id)).toBe(0)
    expect(relationsCiting(secret.id)).toBe(0)
    // L'entité n'était citée que par le fait oublié : son nom venait de lui.
    expect(n("SELECT COUNT(*) AS n FROM entities WHERE name = 'Zephyrcorp'")).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM cluster_members WHERE fact_id = ?', secret.id)).toBe(0)
  })

  it('forget : un amas qui survit perd les mots du fait oublié', async () => {
    for (const name of ['Lumen', 'Solstice', 'Kestrel']) m.storeFact({ instance, content: `Brumehost héberge le portail ${name}` })
    const secret = m.storeFact({ instance, content: 'Brumehost héberge le portail Zephyrcorp de Zephyrcorp et Zephyrcorp' })
    await m.processCognition(instance, { includeBackfill: true })
    const labels = (): string[] =>
      (db().prepare('SELECT label || centroid_keywords AS l FROM fact_clusters').all() as Array<{ l: string }>).map(r => r.l)
    expect(labels().some(l => l.includes('zephyrcorp'))).toBe(true) // témoin
    m.forget({ ids: [secret.id] })
    expect(labels()).toHaveLength(1)
    expect(labels().some(l => l.includes('zephyrcorp'))).toBe(false)
  })

  it('correctFact, mergeFacts et révision acceptée détachent l’ancien fait du graphe', async () => {
    const corrected = m.storeFact({ instance, content: 'Brumehost facture Zephyrcorp chaque mois' })
    const merged = m.storeFact({ instance, content: 'Brumehost facture Kestrel chaque trimestre' })
    const keep = m.storeFact({ instance, content: 'Brumehost facture Kestrel tous les trimestres' })
    const revised = m.storeFact({ instance, content: 'Brumehost héberge Nimbus depuis mars' })
    await m.processCognition(instance)
    for (const f of [corrected, merged, revised]) expect(entitiesOf(f.id)).toBeGreaterThan(0)

    m.correctFact(instance, corrected.id, 'Brumehost facture Ardoise chaque mois')
    m.mergeFacts(instance, keep.id, [merged.id])
    db()
      .prepare(
        "INSERT INTO revision_proposals (id, fact_id, kind, reason, replacement_fact_id, status, created_at) VALUES ('rev-1', ?, 'obsolete', 'test', NULL, 'proposed', ?)",
      )
      .run(revised.id, new Date().toISOString())
    expect(m.decideRevision(instance, 'rev-1', 'accept').ok).toBe(true)

    for (const f of [corrected, merged, revised]) {
      expect(entitiesOf(f.id)).toBe(0)
      expect(relationsCiting(f.id)).toBe(0)
    }
    expect(entitiesOf(keep.id)).toBeGreaterThan(0)
  })

  it('oublier le remplaçant rend la parole à l’original, qui est relié de nouveau', async () => {
    const original = m.storeFact({ instance, content: 'Brumehost facture Zephyrcorp chaque mois' })
    await m.processCognition(instance)
    const { replacement } = m.correctFact(instance, original.id, 'Brumehost facture Ardoise chaque mois')
    await m.processCognition(instance)
    expect(entitiesOf(original.id)).toBe(0)

    m.forget({ ids: [replacement!.id] })
    await m.processCognition(instance)
    expect(entitiesOf(original.id)).toBeGreaterThan(0)
  })

  it('remplaçant partagé puis oublié : l’original, resté dans la base privée, redevient rappelable', () => {
    const target = m.registry.listScopes().find(s => s.type !== 'private' && s.type !== 'legacy_to_review')
    expect(target).toBeDefined()
    const original = m.storeFact({ instance, content: 'Le serveur Ventoux est loué chez Brumehost' })
    const { replacement } = m.correctFact(instance, original.id, 'Le serveur Ventoux est loué chez Brumehost depuis mars')
    expect(m.shareFacts([replacement!.id], target!.id).shared).toBe(1)
    expect(n('SELECT COUNT(*) AS n FROM facts WHERE id = ?', replacement!.id)).toBe(0) // déplacé

    m.forget({ ids: [replacement!.id] })
    const row = db().prepare('SELECT superseded, superseded_by FROM facts WHERE id = ?').get(original.id)
    expect(row).toEqual({ superseded: 0, superseded_by: null })
    expect(m.recall({ instance, query: 'serveur Ventoux' }).items.map(i => i.id)).toContain(original.id)
  })

  it('mention_count ne garde pas la trace des faits oubliés ou remplacés', async () => {
    const keep = m.storeFact({ instance, content: 'Brumehost héberge le portail Lumen' })
    const gone = [1, 2, 3].map(i => m.storeFact({ instance, content: `Brumehost héberge la vitrine Kestrel numéro ${i}` }).id)
    const old = m.storeFact({ instance, content: 'Brumehost facture le portail Lumen chaque mois' })
    await m.processCognition(instance, { includeBackfill: true })
    const count = (): number => n("SELECT mention_count AS n FROM entities WHERE name = 'Brumehost'")
    expect(count()).toBe(5)

    m.forget({ ids: gone })
    expect(count()).toBe(2)
    m.correctFact(instance, old.id, 'Brumehost facture le portail Lumen chaque trimestre')
    expect(count()).toBe(1)
    expect(entitiesOf(keep.id)).toBeGreaterThan(0)
  })
})

describe('4. un fait critical ne passe pas par la cognition', () => {
  it('ni LLM, ni entités, ni thème, ni amas', async () => {
    fresh(true)
    m.storeFact({ instance, content: 'Brumehost est notre hébergeur principal pour les sites clients' })
    const crit = m.storeFact({ instance, content: 'Brumehost a pour mot de passe racine Quartzfalcon', sensitivity: 'critical' })
    m.storeFact({ instance, content: 'Brumehost héberge aussi le site Quartzfalcon de démonstration' })
    m.storeFact({ instance, content: 'Brumehost facture Quartzfalcon chaque mois' })
    await m.processCognition(instance)
    await m.processCognition(instance, { includeBackfill: true })

    expect(marker(crit.id)).toBeUndefined()
    expect(entitiesOf(crit.id)).toBe(0)
    expect(topicsOf(crit.id)).toBe(0)
    expect(llm.prompts.some(p => p.includes('mot de passe'))).toBe(false)
    expect(n('SELECT COUNT(*) AS n FROM cluster_members WHERE fact_id = ?', crit.id)).toBe(0)
  })

  it('liens hérités d’un fait critical purgés au premier passage du processus', async () => {
    const { shown, hidden } = await seedTopic()
    await m.processCognition(instance, { includeBackfill: true })
    // Base héritée : un fait critical relié, rangé et mis en amas avant le correctif.
    db().prepare("UPDATE facts SET sensitivity = 'critical' WHERE id = ?").run(hidden[0])
    expect(entitiesOf(hidden[0]!)).toBeGreaterThan(0)

    restart(false)
    await m.processCognition(instance)
    expect(entitiesOf(hidden[0]!)).toBe(0)
    expect(topicsOf(hidden[0]!)).toBe(0)
    expect(relationsCiting(hidden[0]!)).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM cluster_members WHERE fact_id = ?', hidden[0])).toBe(0)
    // Le thème touché a été supprimé, les autres faits rangés de nouveau.
    for (const id of shown) expect(topicsOf(id)).toBe(1)
  })
})

describe('5. index des thèmes', () => {
  it('fact_topics(topic_id) indexé, y compris sur une base créée par l’ancien code', () => {
    const indexes = (): string[] => (db().pragma('index_list(fact_topics)') as Array<{ name: string }>).map(i => i.name)
    expect(indexes()).toContain('idx_fact_topics_topic')
    // Base « d'avant » : ni l'index ni la ligne de migration.
    const version = topicMigrations.find(mig => mig.name === 'topics-fact-topics-topic-index')!.version
    db().exec('DROP INDEX idx_fact_topics_topic')
    db().prepare('DELETE FROM schema_migrations WHERE version = ?').run(version)
    restart(false)
    expect(indexes()).toContain('idx_fact_topics_topic')
    const plan = db()
      .prepare('EXPLAIN QUERY PLAN SELECT fact_id FROM fact_topics WHERE topic_id IN (?, ?)')
      .all('a', 'b') as Array<{ detail: string }>
    expect(plan.map(p => p.detail).join(' | ')).toContain('idx_fact_topics_topic')
  })
})

describe('6. rattrapage LLM : un fait en échec n’est jamais « brûlé »', () => {
  /** Faits dans l'état « d'avant la migration 11 » : marqués backfill, sans graphe ni thème. */
  function seedBackfill(names: string[]): string[] {
    const ids = names.map(name => m.storeFact({ instance, content: `Le projet ${name} est suivi par Brumehost` }).id)
    const d = db()
    d.prepare('DELETE FROM fact_entities').run()
    d.prepare('DELETE FROM fact_topics').run()
    d.prepare('DELETE FROM fact_cognition').run()
    d.prepare(
      "INSERT INTO fact_cognition (fact_id, processed_at, via, entities) SELECT id, '2020-01-01T00:00:00.000Z', 'backfill', 0 FROM facts",
    ).run()
    return ids
  }

  it('fournisseur « disponible » mais en panne : arrêt après 3 échecs, rien n’est marqué, tout est repris ensuite', async () => {
    fresh(true)
    const ids = seedBackfill(['Orion', 'Kestrel', 'Nimbus', 'Borealis', 'Tamaris', 'Halcyon'])
    llm.failGraph = true
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 500 })).rejects.toThrow(/d’affilée/)
    expect(llm.graph).toBe(3)
    for (const id of ids) {
      expect(marker(id)).toEqual({ via: 'backfill', processed_at: '2020-01-01T00:00:00.000Z' })
      expect(entitiesOf(id)).toBe(0)
    }

    // L'API revient : le rattrapage suivant reprend TOUS les faits.
    llm.failGraph = false
    llm.graph = 0
    const r = await m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 500 })
    expect(r.llm_facts).toBe(ids.length)
    expect(llm.graph).toBe(ids.length)
    // Et un passage ordinaire n'appelle rien de plus.
    await m.processCognition(instance)
    expect(llm.graph).toBe(ids.length)
  })

  it('des faits qui échouent toujours ne bloquent pas les suivants', async () => {
    fresh(true)
    const poison = seedBackfill(['Poison1', 'Poison2', 'Poison3'])
    const ok = ['Orion', 'Kestrel'].map(name => m.storeFact({ instance, content: `Le projet ${name} est suivi par Brumehost` }).id)
    db().prepare("INSERT OR REPLACE INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, '2020-01-01T00:00:00.000Z', 'backfill', 0)").run(ok[0])
    db().prepare("INSERT OR REPLACE INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, '2020-01-01T00:00:00.000Z', 'backfill', 0)").run(ok[1])
    llm.poison = 'Poison'
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 500 })).rejects.toThrow(/d’affilée/)
    await m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 500 }).catch(() => undefined)
    for (const id of ok) expect(marker(id)?.via).toBe('llm')
    for (const id of poison) expect(marker(id)?.via).toBe('backfill')
  })

  it('échec persistant au passage ordinaire : borné d’un redémarrage à l’autre, sans réécrire le graphe', async () => {
    fresh(true)
    llm.failGraph = true
    const ids = ['Orion', 'Kestrel'].map(name => m.storeFact({ instance, content: `Le projet ${name} est suivi par Brumehost` }).id)
    const calls: number[] = []
    let mentions: unknown = null
    for (let boot = 0; boot < 5; boot++) {
      const before = llm.graph
      await m.processCognition(instance)
      await m.processCognition(instance)
      calls.push(llm.graph - before)
      const now = db().prepare('SELECT name, mention_count FROM entities ORDER BY name').all()
      // Un nouvel essai raté ne réempile pas les entités heuristiques.
      if (boot > 0) expect(now).toEqual(mentions)
      mentions = now
      restart(true)
    }
    expect(calls).toEqual([2, 2, 2, 0, 0])
    for (const id of ids) expect(marker(id)?.via).toBe('heuristic')
  })
})

describe('7. libellés LLM : seulement pour les faits de ce passage', () => {
  it('des faits sans thème hérités sont rangés en heuristique', async () => {
    fresh(true)
    const word = (i: number): string => `Zor${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}ux`
    for (let i = 0; i < 30; i++) m.storeFact({ instance, content: `Le ${word(i)}.` })
    // Faits d'avant la migration 11 : marqués backfill, sans thème.
    const d = db()
    d.prepare('DELETE FROM fact_topics').run()
    d.prepare('DELETE FROM topics').run()
    d.prepare('DELETE FROM fact_cognition').run()
    d.prepare("INSERT INTO fact_cognition (fact_id, processed_at, via, entities) SELECT id, '2020-01-01T00:00:00.000Z', 'backfill', 0 FROM facts").run()
    llm.label = 0
    m.storeFact({ instance, content: 'Le Kestrelux.' })
    await m.processCognition(instance)
    expect(n('SELECT COUNT(*) AS n FROM facts f WHERE NOT EXISTS (SELECT 1 FROM fact_topics ft WHERE ft.fact_id = f.id)')).toBe(0)
    expect(llm.label).toBeLessThanOrEqual(1)
  })
})

describe('9. dormant « backfill » validé, pause pendant un rattrapage LLM', () => {
  it('un dormant marqué par la migration 11 est relié après sa validation', async () => {
    m.setCaptureMode('review-first')
    const dormant = m.declareFact({ instance, content: 'Brumehost facture Zephyrcorp chaque mois' }).fact!
    m.setCaptureMode('auto-private')
    db()
      .prepare("INSERT OR REPLACE INTO fact_cognition (fact_id, processed_at, via, entities) VALUES (?, '2020-01-01T00:00:00.000Z', 'backfill', 0)")
      .run(dormant.id)
    const item = m.listReview().find(i => i.fact_id === dormant.id)!
    m.reviewDecision([item.id], 'accepted')
    await m.processCognition(instance)
    expect(entitiesOf(dormant.id)).toBeGreaterThan(0)
  })

  it('pause posée pendant un rattrapage LLM : arrêt entre deux faits ; en file : refusé', async () => {
    fresh(true)
    for (const name of ['Orion', 'Kestrel', 'Nimbus', 'Borealis']) m.storeFact({ instance, content: `Le projet ${name} est suivi par Brumehost` })
    const d = db()
    d.prepare('DELETE FROM fact_entities').run()
    d.prepare('DELETE FROM fact_cognition').run()
    d.prepare("INSERT INTO fact_cognition (fact_id, processed_at, via, entities) SELECT id, '2020-01-01T00:00:00.000Z', 'backfill', 0 FROM facts").run()
    llm.onGraph = () => {
      if (llm.graph === 1) m.setEnabled(false)
    }
    await expect(m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 500 })).rejects.toThrow(/pause/)
    expect(llm.graph).toBe(1)

    // Rattrapage mis en file AVANT la pause : refusé quand vient son tour.
    llm.onGraph = null
    m.setEnabled(true)
    m.storeFact({ instance, content: 'Le client Kappa appelle lundi' })
    const ordinary = m.processCognition(instance)
    const queued = m.processCognition(instance, { includeBackfill: true, llm: true, maxFacts: 500 })
    m.setEnabled(false)
    const before = llm.graph
    await ordinary
    await expect(queued).rejects.toThrow(/pause/)
    expect(llm.graph - before).toBe(0)
  })
})
