/**
 * Réparation de l'index vectoriel (vec0) depuis la table `embeddings` :
 * exacte (une ligne vec0 périmée ne compense jamais un vecteur manquant),
 * incrémentale après la dernière vérification, sans doublon ni retour d'un
 * fait effacé, et sans figer la boucle d'événements (règle n°27). Mesuré le
 * 15/11 : l'anti-jointure synchrone tenait la boucle 1 250 ms sur la vraie base.
 * Données fictives uniquement.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentStore, EmbeddingIndexer, ensureVecTable, isVecAvailable, vecTableName, type EmbeddingProvider } from '../src/index.js'

const VEC_AVAILABLE = isVecAvailable(new Database(':memory:'))

class FixedEmbedding implements EmbeddingProvider {
  readonly name = 'fake'
  embeds = 0
  constructor(
    readonly model: string,
    readonly dimensions: number,
  ) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }
  embed(texts: string[]): Promise<Float32Array[]> {
    this.embeds += texts.length
    return Promise.resolve(texts.map((_, i) => FixedEmbedding.unit(this.dimensions, i)))
  }
  static unit(dims: number, i: number): Float32Array {
    const v = new Float32Array(dims)
    v[i % dims] = 1
    return v
  }
}

let dir: string
let store: ContentStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-vec-repair-'))
  store = new ContentStore(join(dir, 'content.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Vecteur rangé dans `embeddings` SANS passer par l'index (écriture d'un autre processus, index absent à ce moment…). */
function embedOnly(factId: string, provider: FixedEmbedding, i = 0): void {
  store.db
    .prepare(
      `INSERT INTO embeddings (id, owner_type, owner_id, model, dimensions, vector, created_at)
       VALUES (?, 'fact', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(`emb-${factId}`, factId, provider.model, provider.dimensions, Buffer.from(FixedEmbedding.unit(provider.dimensions, i).buffer))
}

/** Lignes vec0 par fait (un fait indexé deux fois serait un doublon au rappel). */
function vecRows(provider: FixedEmbedding): Map<string, number> {
  const table = vecTableName({ model: provider.model, dimensions: provider.dimensions })
  const rows = store.db.prepare(`SELECT fact_id FROM ${table}`).all() as Array<{ fact_id: string }>
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.fact_id, (out.get(r.fact_id) ?? 0) + 1)
  return out
}

function insertVecRow(provider: FixedEmbedding, factId: string): void {
  ensureVecTable(store.db, { model: provider.model, dimensions: provider.dimensions })
  const table = vecTableName({ model: provider.model, dimensions: provider.dimensions })
  store.db
    .prepare(`INSERT INTO ${table} (embedding, fact_id) VALUES (?, ?)`)
    .run(Buffer.from(FixedEmbedding.unit(provider.dimensions, 1).buffer), factId)
}

/** Multiplie un fait par SQL (insertFact un par un serait trop lent pour des milliers). */
function multiplyFact(id: string, n: number): void {
  const cols = (store.db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map(c => c.name)
  const sel = cols
    .map(c => (c === 'id' ? `'copie-' || n` : c === 'fact' ? `fact || ' (copie ' || n || ')'` : c === 'norm_hash' ? 'NULL' : c))
    .join(', ')
  store.db
    .prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${n})
       INSERT INTO facts (${cols.join(', ')}) SELECT ${sel} FROM facts, seq WHERE facts.id = ?`,
    )
    .run(id)
}

/** Un vecteur `embeddings` (nul, mais aux bonnes dimensions) pour chaque fait de la base, sans l'index. */
function embedAllBySql(provider: FixedEmbedding): number {
  return store.db
    .prepare(
      `INSERT INTO embeddings (id, owner_type, owner_id, model, dimensions, vector, created_at)
       SELECT 'emb-' || id, 'fact', id, ?, ?, zeroblob(?), '2026-01-01T00:00:00.000Z' FROM facts`,
    )
    .run(provider.model, provider.dimensions, provider.dimensions * 4).changes
}

/** Pire écart de la boucle d'événements pendant `fn` (sonde toutes les ms, plus le dernier morceau synchrone). */
async function worstGap<T>(fn: () => Promise<T>): Promise<{ result: T; worst: number }> {
  let last = performance.now()
  let worst = 0
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 1)
  try {
    const result = await fn()
    worst = Math.max(worst, performance.now() - last)
    return { result, worst }
  } finally {
    clearInterval(timer)
  }
}

describe.skipIf(!VEC_AVAILABLE)('réparation exacte', () => {
  it('un vecteur manquant est réparé MÊME quand une ligne vec0 périmée compense le compte', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    const indexed = store.insertFact({ fact: 'le portail fictif Lumen est en ligne', scope_id: 's1' })
    await new EmbeddingIndexer({ store, provider }).runAll()
    expect(vecRows(provider).get(indexed.id)).toBe(1)

    // Ligne vec0 d'un fait qui n'existe plus (effacé hors du code) : 1 vecteur de trop…
    insertVecRow(provider, 'fait-disparu')
    // … et un fait au vecteur rangé mais jamais indexé : 1 vecteur de moins.
    const missing = store.insertFact({ fact: 'la serre fictive de Zorba est chauffée', scope_id: 's1' })
    embedOnly(missing.id, provider)
    // Les comptes sont égaux (2 vecteurs, 2 lignes vec0) : seul un calcul exact voit le manquant.
    const table = vecTableName({ model: provider.model, dimensions: provider.dimensions })
    expect((store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c).toBe(2)

    // Redémarrage : nouvel indexeur, réparation complète.
    const run = await new EmbeddingIndexer({ store, provider }).runAll()
    expect(run.indexed).toBe(0)
    const rows = vecRows(provider)
    expect(rows.get(missing.id)).toBe(1)
    expect(rows.get(indexed.id)).toBe(1)
    expect(provider.embeds).toBe(1) // aucun appel au fournisseur pour réparer
  })

  it('un vecteur d’un autre état (fait existant, vecteur retiré d’embeddings) ne compense pas non plus', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    const dormant = store.insertFact({ fact: 'note fictive mise en attente', scope_id: 's1', lifecycle_state: 'dormant' })
    insertVecRow(provider, dormant.id) // ligne vec0 restée, sans vecteur dans embeddings
    const missing = store.insertFact({ fact: 'note fictive jamais indexée', scope_id: 's1', lifecycle_state: 'dormant' })
    embedOnly(missing.id, provider)
    await new EmbeddingIndexer({ store, provider }).runAll()
    expect(vecRows(provider).get(missing.id)).toBe(1)
  })

  it('un vecteur rangé APRÈS la dernière vérification est réparé au passage suivant, sans attendre 10 minutes', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    store.insertFact({ fact: 'premier fait fictif', scope_id: 's1' })
    const indexer = new EmbeddingIndexer({ store, provider })
    await indexer.runAll() // vérification complète (démarrage)

    const late = store.insertFact({ fact: 'fait fictif rangé par un autre processus', scope_id: 's1' })
    embedOnly(late.id, provider)
    await indexer.runAll() // même indexeur, moins de 10 minutes après
    expect(vecRows(provider).get(late.id)).toBe(1)
    expect(provider.embeds).toBe(1)
  })

  it('repère invalidé (dernière ligne effacée puis rowid réutilisé) : vérification complète, le vecteur est réparé', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    store.insertFact({ fact: 'fait fictif ancien', scope_id: 's1' })
    const top = store.insertFact({ fact: 'fait fictif le plus récent', scope_id: 's1' })
    const indexer = new EmbeddingIndexer({ store, provider })
    await indexer.runAll()
    const topRowid = (store.db.prepare('SELECT MAX(rowid) AS r FROM embeddings').get() as { r: number }).r

    expect(store.hardDeleteFacts([top.id])).toBe(1) // la ligne repère disparaît
    const reused = store.insertFact({ fact: 'fait fictif rangé ensuite par un autre processus', scope_id: 's1' })
    embedOnly(reused.id, provider)
    // SQLite redonne le même rowid (max + 1) : « rowid > repère » ne le verrait pas.
    expect((store.db.prepare('SELECT rowid AS r FROM embeddings WHERE owner_id = ?').get(reused.id) as { r: number }).r).toBe(topRowid)

    await indexer.runAll()
    expect(vecRows(provider).get(reused.id)).toBe(1)
    expect(vecRows(provider).has(top.id)).toBe(false)
  })

  it('une ligne vec0 retirée (vecteur gardé) est réparée par la vérification complète périodique', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    const f = store.insertFact({ fact: 'fait fictif à réindexer', scope_id: 's1' })
    const indexer = new EmbeddingIndexer({ store, provider })
    await indexer.runAll()
    const table = vecTableName({ model: provider.model, dimensions: provider.dimensions })
    store.db.prepare(`DELETE FROM ${table} WHERE fact_id = ?`).run(f.id)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await indexer.runAll()
    } finally {
      vi.useRealTimers()
    }
    expect(vecRows(provider).get(f.id)).toBe(1)
  })

  it('deux réparations simultanées (deux indexeurs) : chaque vecteur une seule fois', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    const seed = store.insertFact({ fact: 'fait fictif multiplié', scope_id: 's1' })
    multiplyFact(seed.id, 2999)
    expect(embedAllBySql(provider)).toBe(3000)
    await Promise.all([new EmbeddingIndexer({ store, provider }).runAll(), new EmbeddingIndexer({ store, provider }).runAll()])
    const rows = vecRows(provider)
    expect(rows.size).toBe(3000)
    expect([...rows.values()].every(n => n === 1)).toBe(true)
  })

  it('un fait effacé pendant la réparation n’est jamais réinjecté dans l’index (aucune trace)', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    const seed = store.insertFact({ fact: 'fait fictif multiplié', scope_id: 's1' })
    multiplyFact(seed.id, 2999)
    embedAllBySql(provider)
    const repair = new EmbeddingIndexer({ store, provider }).runAll()
    await new Promise(resolve => setImmediate(resolve)) // la réparation a commencé et rendu la main
    expect(store.hardDeleteFacts([seed.id])).toBe(1) // oubli : fait, vecteur et index
    // Fait effacé sans son vecteur (vecteur orphelin) : la vérité n'a plus de fait, l'index non plus.
    store.db.prepare('DELETE FROM facts WHERE id = ?').run('copie-1')
    await repair
    const rows = vecRows(provider)
    expect(rows.has(seed.id)).toBe(false)
    expect(rows.has('copie-1')).toBe(false)
    expect(rows.size).toBe(2998)
  })

  it('un vecteur orphelin (fait absent de `facts`) n’entre jamais dans l’index', async () => {
    const provider = new FixedEmbedding('fake-8d', 8)
    const kept = store.insertFact({ fact: 'fait fictif présent', scope_id: 's1' })
    embedOnly(kept.id, provider)
    embedOnly('fait-orphelin', provider)
    await new EmbeddingIndexer({ store, provider }).runAll()
    const rows = vecRows(provider)
    expect(rows.get(kept.id)).toBe(1)
    expect(rows.has('fait-orphelin')).toBe(false)
  })
})

describe.skipIf(!VEC_AVAILABLE)('réparation sans boucle figée', () => {
  it('6 000 vecteurs de 1 536 dimensions : reconstruction puis vérification, jamais plus de 100 ms sans rendre la main', async () => {
    const provider = new FixedEmbedding('fake-1536', 1536)
    const seed = store.insertFact({ fact: 'Le projet fictif du jardin partagé de la rue des Lilas avance', scope_id: 's1' })
    multiplyFact(seed.id, 5999)
    expect(embedAllBySql(provider)).toBe(6000)

    // Index vide, vérité pleine : tout est réinséré (le pire cas, ex. index renommé).
    const rebuild = await worstGap(() => new EmbeddingIndexer({ store, provider }).runAll())
    const rows = vecRows(provider)
    expect(rows.size).toBe(6000)
    expect([...rows.values()].every(n => n === 1)).toBe(true)
    expect(rebuild.worst).toBeLessThan(100)

    // Démarrage suivant : rien ne manque, la vérification complète rend aussi la main.
    const check = await worstGap(() => new EmbeddingIndexer({ store, provider }).runAll())
    expect(vecRows(provider).size).toBe(6000)
    expect(check.worst).toBeLessThan(100)
    expect(provider.embeds).toBe(0)
  }, 120_000)
})
