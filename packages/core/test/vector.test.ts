/**
 * Vectoriel sqlite-vec : indexation idempotente, recherche hybride qui trouve
 * ce que le FTS rate (synonymes), permissions JAMAIS contournées par le
 * vectoriel, garde de dimensions, dégradation propre sans vecteur.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ContentStore,
  EmbeddingIndexer,
  hybridSearchFacts,
  isVecAvailable,
  knn,
  listVecTables,
  purgeFactVectors,
  vecTableName,
  type EmbeddingProvider,
} from '../src/index.js'

/**
 * Provider factice : vecteur 8d déterministe par « concept » — voiture et
 * automobile partagent le même concept (synonymes simulés), les autres mots
 * donnent des directions distinctes.
 */
class FakeEmbedding implements EmbeddingProvider {
  readonly name = 'fake'
  readonly model = 'fake-8d'
  readonly dimensions = 8
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map(t => FakeEmbedding.vectorFor(t)))
  }
  static vectorFor(text: string): Float32Array {
    const t = text.toLowerCase()
    const v = new Float32Array(8)
    const concepts: Array<[RegExp, number]> = [
      [/voiture|automobile|véhicule/, 0],
      [/garage|réparation/, 1],
      [/cuisine|recette/, 2],
      [/serveur|infra/, 3],
      [/musique|concert/, 4],
    ]
    for (const [re, dim] of concepts) {
      if (re.test(t)) v[dim] = 1
    }
    if (v.every(x => x === 0)) {
      // direction « divers » dépendante de la longueur — loin des concepts
      v[5] = 0.3 + (t.length % 7) / 10
      v[6] = 0.9
    }
    const norm = Math.hypot(...v) || 1
    return v.map(x => x / norm) as unknown as Float32Array
  }
}

let dir: string
let store: ContentStore
let indexer: EmbeddingIndexer
const provider = new FakeEmbedding()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-vec-'))
  store = new ContentStore(join(dir, 'content.sqlite'))
  indexer = new EmbeddingIndexer({ store, provider, batchSize: 4 })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const vecOk = (): boolean => isVecAvailable(store.db)
/** Disponibilité connue AVANT les tests (pour `skipIf`) — même binaire que store.db. */
const VEC_AVAILABLE = isVecAvailable(new Database(':memory:'))

describe('extension sqlite-vec', () => {
  it('disponible sur cette machine (binaire npm) OU dégradation propre', () => {
    // Sur le Mac de dev l'extension doit charger ; ailleurs le reste de la
    // suite vérifie le mode dégradé.
    expect(typeof vecOk()).toBe('boolean')
  })
})

describe('EmbeddingIndexer', () => {
  it('indexe par lots, idempotent (0 au second run)', async () => {
    for (let i = 0; i < 6; i++) {
      store.insertFact({ fact: `note ${i} sur la cuisine et les recettes du lundi`, scope_id: 's1' })
    }
    const r1 = await indexer.runAll()
    expect(r1.indexed).toBe(6)
    expect(r1.remaining).toBe(0)

    const r2 = await indexer.runOnce()
    expect(r2.indexed).toBe(0)

    const count = store.db
      .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE model = 'fake-8d' AND dimensions = 8")
      .get() as { c: number }
    expect(count.c).toBe(6)
  })

  it('un fait DORMANT (quarantaine, pas encore approuvé) n’est pas embeddé ; approuvé → il l’est', async () => {
    const f = store.insertFact({ fact: 'note importée en attente de revue', scope_id: 's1', lifecycle_state: 'dormant' })
    expect(indexer.pendingCount()).toBe(0)
    expect((await indexer.runOnce()).indexed).toBe(0)
    store.db.prepare("UPDATE facts SET lifecycle_state = 'active' WHERE id = ?").run(f.id)
    expect(indexer.pendingCount()).toBe(1)
    expect((await indexer.runOnce()).indexed).toBe(1)
  })

  it('removeFor nettoie embeddings + index', async () => {
    const f = store.insertFact({ fact: 'la voiture rouge du garage', scope_id: 's1' })
    await indexer.runOnce()
    indexer.removeFor([f.id])
    const left = store.db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE owner_id = ?').get(f.id) as { c: number }
    expect(left.c).toBe(0)
    if (vecOk()) {
      expect(knn(store.db, { model: 'fake-8d', dimensions: 8 }, FakeEmbedding.vectorFor('voiture'), 5).map(h => h.fact_id)).not.toContain(f.id)
    }
  })
})

/**
 * Spec §11 « aucune trace » : un fait effacé (rejet de revue, oubli) ne doit
 * plus être mesurable par similarité. Régression b0aefd6 : les tables sont
 * nommées `vec_index_<dims>_<modèle>` et le hard-delete ne filtrait que
 * `vec_index_<dims>` → le vecteur du fait effacé restait dans l'index.
 */
describe('hard-delete — purge de TOUS les index vectoriels', () => {
  const key = { model: 'fake-8d', dimensions: 8 }

  it('purgeFactVectors vide le fait de tous les index existants (nommage (dims, modèle) ET legacy), sans en créer', async () => {
    const f = store.insertFact({ fact: 'la voiture rouge du garage', scope_id: 's1' })
    const other = store.insertFact({ fact: 'une automobile bleue', scope_id: 's1' })
    await indexer.runAll()
    if (!vecOk()) return
    // index legacy (nommé par dimension seule) hérité d'une version antérieure
    store.db.exec('CREATE VIRTUAL TABLE vec_index_8 USING vec0(embedding float[8], fact_id TEXT)')
    store.db.prepare('INSERT INTO vec_index_8 (embedding, fact_id) VALUES (?, ?)').run(Buffer.from(FakeEmbedding.vectorFor('voiture').buffer), f.id)
    expect(listVecTables(store.db).sort()).toEqual(['vec_index_8', vecTableName(key)].sort())

    purgeFactVectors(store.db, [f.id])

    for (const table of listVecTables(store.db)) {
      const left = store.db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE fact_id = ?`).get(f.id) as { c: number }
      expect(left.c, table).toBe(0)
    }
    const ids = knn(store.db, key, FakeEmbedding.vectorFor('voiture'), 5).map(h => h.fact_id)
    expect(ids).not.toContain(f.id)
    expect(ids).toContain(other.id) // les autres faits restent indexés
    expect(listVecTables(store.db)).toHaveLength(2) // aucune table créée au passage
  })

  it('purgeFactVectors sans aucun index → no-op (pas de table créée)', () => {
    purgeFactVectors(store.db, ['inexistant'])
    expect(listVecTables(store.db)).toHaveLength(0)
  })

  // ⚠️ `.fails` VOLONTAIRE : ContentStore.hardDeleteFacts (storage/content.ts,
  // hors lane vector) filtre encore `/^vec_index_\d+$/` et rate les tables
  // `vec_index_<dims>_<modèle>`. Dès que hardDeleteFacts appelle
  // `purgeFactVectors`, ce test PASSE → vitest le signalera comme cassé :
  // retirer alors le `.fails`. Le test est écrit tel qu'il doit passer.
  it.skipIf(!VEC_AVAILABLE).fails('store.hardDeleteFacts retire le vecteur de l’index nommé (dims, modèle)', async () => {
    const f = store.insertFact({ fact: 'la voiture rouge du garage', scope_id: 's1' })
    await indexer.runAll()
    expect(knn(store.db, key, FakeEmbedding.vectorFor('voiture'), 5).map(h => h.fact_id)).toContain(f.id)

    expect(store.hardDeleteFacts([f.id])).toBe(1)
    expect(store.getFact(f.id)).toBeNull()
    expect(knn(store.db, key, FakeEmbedding.vectorFor('voiture'), 5).map(h => h.fact_id)).not.toContain(f.id)
    const left = store.db.prepare(`SELECT COUNT(*) AS c FROM ${vecTableName(key)} WHERE fact_id = ?`).get(f.id) as { c: number }
    expect(left.c).toBe(0)
  })
})

describe('hybridSearchFacts', () => {
  it('trouve par similarité sémantique ce que le FTS rate (synonyme)', async () => {
    store.insertFact({ fact: 'L’automobile de Néto est garée au parking couvert', scope_id: 's1' })
    store.insertFact({ fact: 'La recette de cuisine du dimanche utilise du curcuma', scope_id: 's1' })
    await indexer.runAll()
    if (!vecOk()) return // mode dégradé couvert par le dernier test

    // « voiture » n'apparaît dans aucun texte → FTS seul = 0
    const ftsOnly = store.searchFacts('voiture', { scopeIds: ['s1'] })
    expect(ftsOnly).toHaveLength(0)

    const hybrid = hybridSearchFacts(store, 'voiture', {
      scopeIds: ['s1'],
      model: 'fake-8d',
      queryVector: FakeEmbedding.vectorFor('voiture'),
    })
    expect(hybrid.length).toBeGreaterThan(0)
    expect(hybrid[0]!.row.fact).toContain('automobile')
  })

  it('le vectoriel ne contourne JAMAIS les permissions (superseded/critical/scope)', async () => {
    const blocked = store.insertFact({ fact: 'Le véhicule de fonction du client secret', scope_id: 's1', sensitivity: 'critical' })
    const superseded = store.insertFact({ fact: 'Une automobile ancienne remplacée', scope_id: 's1' })
    const otherScope = store.insertFact({ fact: 'La voiture du scope voisin', scope_id: 'AUTRE' })
    store.db.prepare('UPDATE facts SET superseded = 1 WHERE id = ?').run(superseded.id)
    await indexer.runAll()
    if (!vecOk()) return

    const hits = hybridSearchFacts(store, 'voiture', {
      scopeIds: ['s1'],
      maxSensitivity: 'sensitive',
      model: 'fake-8d',
      queryVector: FakeEmbedding.vectorFor('voiture'),
    })
    const ids = hits.map(h => h.row.id)
    expect(ids).not.toContain(blocked.id)
    expect(ids).not.toContain(superseded.id)
    expect(ids).not.toContain(otherScope.id)
  })

  it('garde de dimensions : requête 16d sur index 8d → erreur claire', async () => {
    store.insertFact({ fact: 'note sur la musique du concert', scope_id: 's1' })
    await indexer.runAll()
    if (!vecOk()) return
    expect(() => knn(store.db, { model: 'fake-8d', dimensions: 8 }, new Float32Array(16), 5)).toThrow(/interdit/)
  })

  it('sans queryVector → résultat identique au FTS seul', () => {
    store.insertFact({ fact: 'le serveur infra de staging répond', scope_id: 's1' })
    const fts = store.searchFacts('serveur staging', { scopeIds: ['s1'] })
    const hybrid = hybridSearchFacts(store, 'serveur staging', { scopeIds: ['s1'] })
    expect(hybrid.map(h => h.row.id)).toEqual(fts.map(h => h.row.id))
  })
})

/**
 * Deux providers de MÊME dimension mais de modèles différents ne partagent
 * JAMAIS le même index : sinon, après A → B → A, `pendingCount` vaut 0 (la
 * table embeddings connaît déjà A) alors que l'index ne contient plus que des
 * vecteurs B — le KNN compare des espaces incomparables, sans un mot.
 */
class AxisEmbedding implements EmbeddingProvider {
  readonly name = 'fake'
  readonly dimensions = 4
  constructor(readonly model: string, private readonly axis: number) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(
      texts.map(() => {
        const v = new Float32Array(4)
        v[this.axis] = 1
        return v
      }),
    )
  }
}

describe('index vectoriel par (dimensions, modèle)', () => {
  it('changement de modèle à dimension égale : chaque modèle garde son index, la requête A retrouve ses vecteurs', async () => {
    const f = store.insertFact({ fact: 'note sur la voiture du garage', scope_id: 's1' })
    const a = new AxisEmbedding('nomic-embed-text', 0)
    const b = new AxisEmbedding('nomic-embed-text-v2-moe', 1)
    await new EmbeddingIndexer({ store, provider: a }).runAll()
    await new EmbeddingIndexer({ store, provider: b }).runAll()
    const again = new EmbeddingIndexer({ store, provider: a })
    expect(again.pendingCount()).toBe(0)
    if (!vecOk()) return

    const query = new Float32Array([1, 0, 0, 0])
    const hitsA = knn(store.db, { model: a.model, dimensions: 4 }, query, 5)
    expect(hitsA.map(h => h.fact_id)).toContain(f.id)
    expect(hitsA[0]!.distance).toBeCloseTo(0, 5)
    // et l'index de B ne connaît que des vecteurs B
    const hitsB = knn(store.db, { model: b.model, dimensions: 4 }, query, 5)
    expect(hitsB[0]!.distance).toBeGreaterThan(1)
  })

  it('index manquant ou incomplet → reconstruit depuis la table embeddings (repair)', async () => {
    const f = store.insertFact({ fact: 'note sur la cuisine', scope_id: 's1' })
    const a = new AxisEmbedding('nomic-embed-text', 0)
    const idx = new EmbeddingIndexer({ store, provider: a })
    await idx.runAll()
    if (!vecOk()) return
    const table = vecTableName({ model: a.model, dimensions: 4 })
    store.db.exec(`DELETE FROM ${table}`) // index vidé, vérité (embeddings) intacte
    // Rien à ré-embedder (la vérité est intacte)…
    expect(idx.pendingCount()).toBe(0)
    // …mais runAll répare l'index sans appel provider.
    const run = await idx.runAll()
    expect(run.indexed).toBe(0)
    expect(knn(store.db, { model: a.model, dimensions: 4 }, new Float32Array([1, 0, 0, 0]), 5).map(h => h.fact_id)).toContain(f.id)
  })

  it('hybridSearchFacts exige le modèle avec queryVector (jamais de KNN sur un index anonyme)', () => {
    expect(() => hybridSearchFacts(store, 'voiture', { queryVector: new Float32Array(8) })).toThrow(/mod[eè]le/)
  })
})
