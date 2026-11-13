/**
 * Doublon exact par index (facts.norm_hash, ticket #27). Avant, findDuplicate
 * relisait tout le scope pour chaque fait candidat : avec une file de revue de
 * 67 000 lignes, une fenêtre d'import figeait le daemon jusqu'à 39 s.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Memoria, createSyntheticLegacyDb, importLegacyDb } from '../src/index.js'
import { ContentStore } from '../src/storage/content.js'
import { findDuplicate } from '../src/engine/selective.js'
import { factNormHash } from '../src/util.js'

let root: string
let store: ContentStore
const SCOPE = 'scope-a'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-normhash-'))
  store = new ContentStore(join(root, 'memory.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const hashOf = (id: string): string | null =>
  (store.db.prepare('SELECT norm_hash FROM facts WHERE id = ?').get(id) as { norm_hash: string | null }).norm_hash

describe('facts.norm_hash', () => {
  it('insertFact pose le hash ; doublon exact retrouvé malgré casse et ponctuation', () => {
    const fact = store.insertFact({ fact: 'Le site est déployé sur Vercel.', scope_id: SCOPE })
    expect(hashOf(fact.id)).toBe(factNormHash('le site est déployé sur vercel'))
    const dup = findDuplicate(store, SCOPE, 'LE SITE : est déployé — sur Vercel', { nearDup: false })
    expect(dup?.kind).toBe('exact')
    expect(dup?.existing.id).toBe(fact.id)
    expect(findDuplicate(store, 'autre-scope', 'Le site est déployé sur Vercel.', { nearDup: false })).toBeNull()
  })

  it('un fait supersédé n’est pas un doublon', () => {
    const fact = store.insertFact({ fact: 'Le taux horaire est de 94 euros.', scope_id: SCOPE })
    store.db.prepare('UPDATE facts SET superseded = 1 WHERE id = ?').run(fact.id)
    expect(findDuplicate(store, SCOPE, 'Le taux horaire est de 94 euros.', { nearDup: false })).toBeNull()
  })

  it('ligne SANS hash (écrite par un autre chemin) : toujours trouvée, puis complétée', () => {
    const fact = store.insertFact({ fact: 'Les sauvegardes partent sur le NAS chaque nuit.', scope_id: SCOPE })
    store.db.prepare('UPDATE facts SET norm_hash = NULL WHERE id = ?').run(fact.id)
    const dup = findDuplicate(store, SCOPE, 'les sauvegardes partent sur le nas chaque nuit', { nearDup: false })
    expect(dup?.existing.id).toBe(fact.id)
    expect(hashOf(fact.id)).toBe(factNormHash(fact.fact))
  })

  it('texte modifié sans reposer le hash → hash remis à NULL (jamais un hash périmé)', () => {
    const fact = store.insertFact({ fact: 'La réunion a lieu le 13 octobre.', scope_id: SCOPE })
    store.db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('La réunion a lieu le 14 octobre.', fact.id)
    expect(hashOf(fact.id)).toBeNull()
    expect(findDuplicate(store, SCOPE, 'La réunion a lieu le 13 octobre.', { nearDup: false })).toBeNull()
    expect(findDuplicate(store, SCOPE, 'La réunion a lieu le 14 octobre.', { nearDup: false })?.existing.id).toBe(fact.id)
  })

  it('scope massif : la recherche ne balaie plus le scope', () => {
    const insert = store.db.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        store.insertFact({ fact: `Information numéro ${i} du projet, détail ${i * 7}.`, scope_id: SCOPE })
      }
    })
    insert()
    const started = performance.now()
    for (let i = 0; i < 200; i++) {
      expect(findDuplicate(store, SCOPE, `Une information inédite ${i}`, { nearDup: false })).toBeNull()
    }
    expect(findDuplicate(store, SCOPE, 'information numéro 19999 du projet détail 139993', { nearDup: false })?.kind).toBe('exact')
    // 200 recherches : ~10 ms par index ; l'ancien balayage en prenait plusieurs secondes.
    expect(performance.now() - started).toBeLessThan(1500)
  }, 30_000)

  it('rattrapage des lignes sans hash : une seule instruction préparée, toutes complétées', () => {
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      ids.push(store.insertFact({ fact: `Détail hérité numéro ${i} sans hash.`, scope_id: SCOPE }).id)
    }
    store.db.prepare('UPDATE facts SET norm_hash = NULL WHERE scope_id = ?').run(SCOPE)
    const prepare = vi.spyOn(store.db, 'prepare')
    const dup = findDuplicate(store, SCOPE, 'détail hérité numéro 7 sans hash', { nearDup: false })
    const backfills = prepare.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE facts SET norm_hash'))
    prepare.mockRestore()
    expect(dup?.existing.id).toBe(ids[7])
    // Avant : une préparation et un commit par ligne (50 ici).
    expect(backfills).toHaveLength(1)
    const left = store.db.prepare('SELECT COUNT(*) AS c FROM facts WHERE norm_hash IS NULL').get() as { c: number }
    expect(left.c).toBe(0)
    expect(hashOf(ids[49]!)).toBe(factNormHash('Détail hérité numéro 49 sans hash.'))
  })

  it('rattrapage impossible (écriture refusée) : le doublon est quand même trouvé', () => {
    const fact = store.insertFact({ fact: 'Le rapport part chaque vendredi.', scope_id: SCOPE })
    store.db.prepare('UPDATE facts SET norm_hash = NULL WHERE id = ?').run(fact.id)
    store.db.pragma('query_only = ON')
    try {
      const dup = findDuplicate(store, SCOPE, 'le rapport part chaque vendredi', { nearDup: false })
      expect(dup?.existing.id).toBe(fact.id)
    } finally {
      store.db.pragma('query_only = OFF')
    }
    expect(hashOf(fact.id)).toBeNull()
  })

  it('synchro qui ne change que la ponctuation ou la casse : le hash reste posé', () => {
    const fact = store.insertFact({ fact: 'Le site est sur Vercel', scope_id: SCOPE })
    const row = store.db.prepare('SELECT * FROM facts WHERE id = ?').get(fact.id) as Record<string, unknown>
    const synced = (text: string) =>
      store.upsertSyncedFact({
        id: fact.id,
        fact: text,
        category: row.category as string,
        fact_type: row.fact_type as string,
        confidence: row.confidence as number,
        source: row.source as string,
        scope_id: SCOPE,
        sensitivity: row.sensitivity as string,
        visibility: row.visibility as string,
        tags: row.tags as string,
        entity_ids: row.entity_ids as string,
        lifecycle_state: row.lifecycle_state as string,
        superseded: 0,
        superseded_by: null,
        origin_machine_id: null,
        origin_rev: 2,
        content_hash: null,
        deleted_at: null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      })
    // Même texte normalisé, donc même hash : le trigger de remise à NULL se
    // déclenchait à tort et renvoyait la ligne dans le chemin lent.
    synced('LE SITE est sur Vercel.')
    expect(hashOf(fact.id)).toBe(factNormHash('Le site est sur Vercel'))
    // Vrai changement de texte : le hash suit.
    synced('Le site est sur Netlify.')
    expect(hashOf(fact.id)).toBe(factNormHash('Le site est sur Netlify.'))
  })
})

describe('chemins voisins', () => {
  it('effacement définitif : aucune position ne reste dans fact_projection', () => {
    const gone = store.insertFact({ fact: 'Souvenir à oublier.', scope_id: SCOPE })
    const kept = store.insertFact({ fact: 'Souvenir à garder.', scope_id: SCOPE })
    const place = store.db.prepare('INSERT INTO fact_projection (fact_id, model, x, y, computed_at) VALUES (?, ?, 0.1, 0.2, ?)')
    // Deux modèles : le recalcul de la carte ne nettoie que le modèle courant.
    for (const model of ['modele-courant', 'modele-ancien']) {
      place.run(gone.id, model, '2026-01-01T00:00:00.000Z')
      place.run(kept.id, model, '2026-01-01T00:00:00.000Z')
    }
    expect(store.hardDeleteFacts([gone.id])).toBe(1)
    const rows = store.db.prepare('SELECT DISTINCT fact_id FROM fact_projection').all() as Array<{ fact_id: string }>
    expect(rows.map(r => r.fact_id)).toEqual([kept.id])
  })

  it('import legacy : chaque fait importé a déjà son hash', () => {
    const m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null } })
    try {
      const legacyPath = join(root, 'legacy.db')
      createSyntheticLegacyDb(legacyPath, { factCount: 40, procedureCount: 2 })
      const rep = importLegacyDb({ legacyPath, memoria: m })
      expect(rep.facts_imported).toBeGreaterThan(0)
      const scope = m.registry.getScopeByName('legacy_to_review')!
      const legacyStore = m['openContent'](m.registry.dbForScope(scope.id)!.path)
      const rows = legacyStore.db.prepare('SELECT fact, norm_hash FROM facts').all() as Array<{ fact: string; norm_hash: string | null }>
      expect(rows).toHaveLength(rep.facts_imported)
      for (const r of rows) expect(r.norm_hash).toBe(factNormHash(r.fact))
    } finally {
      m.close()
    }
  })
})
