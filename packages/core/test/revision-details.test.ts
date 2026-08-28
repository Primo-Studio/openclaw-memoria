/**
 * REVISION — le CONTENU des deux souvenirs d'une proposition (couches 18/24).
 *
 * POURQUOI ce fichier : l'écran Révisions demandait d'arbitrer une
 * contradiction en n'affichant que des identifiants. On prouve ici que
 * `listProposalsDetailed()` transporte de quoi DÉCIDER — texte, catégorie,
 * date, agent d'origine, état — pour l'ancien ET pour le remplaçant, et qu'un
 * souvenir supprimé entre-temps revient à `null` (l'écran le dit) au lieu de
 * faire tomber la liste.
 *
 * Sans réseau, sans LLM, DB en tmpdir.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContentStore } from '../src/storage/content.js'
import { RevisionEngine } from '../src/cognition/revision.js'

let dir: string
let store: ContentStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoria-revdetails-'))
  store = new ContentStore(join(dir, 'content.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Fait actif à date EXPLICITE (l'ordre récent→ancien doit être déterministe). */
function factAt(
  text: string,
  createdAt: string,
  opts: { scope?: string; category?: string; instance?: string } = {},
): string {
  const f = store.insertFact({
    fact: text,
    scope_id: opts.scope ?? 's1',
    category: opts.category ?? 'savoir',
    assistant_instance_id: opts.instance ?? 'claude-code@macbook-primo',
  })
  store.db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(createdAt, f.id)
  return f.id
}

describe('RevisionEngine.listProposalsDetailed', () => {
  it('une contradiction transporte le TEXTE des deux souvenirs, pas seulement leurs ids', async () => {
    const oldId = factAt('Le port du serveur de production est 8080', '2026-01-01T00:00:00.000Z', {
      category: 'technique',
      instance: 'codex@macbook-primo',
    })
    const newId = factAt('Le port du serveur de production est 9090', '2026-02-01T00:00:00.000Z', {
      category: 'technique',
    })

    const engine = new RevisionEngine({ store })
    await engine.propose({ limit: 50 })
    const detailed = engine.listProposalsDetailed()

    expect(detailed).toHaveLength(1)
    const p = detailed[0]!
    expect(p.kind).toBe('contradicted')
    // L'ANCIEN (celui qui serait rangé) : texte lisible, pas un id.
    expect(p.fact_id).toBe(oldId)
    expect(p.fact?.fact).toBe('Le port du serveur de production est 8080')
    expect(p.fact?.category).toBe('technique')
    expect(p.fact?.created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(p.fact?.assistant_instance_id).toBe('codex@macbook-primo')
    expect(p.fact?.lifecycle_state).toBe('active')
    expect(p.fact?.superseded).toBe(0)
    // Le REMPLAÇANT (le plus récent) : idem, c'est lui qu'on garde.
    expect(p.replacement_fact_id).toBe(newId)
    expect(p.replacement?.fact).toBe('Le port du serveur de production est 9090')
    expect(p.replacement?.created_at).toBe('2026-02-01T00:00:00.000Z')
  })

  it('un doublon transporte aussi les deux souvenirs', async () => {
    const oldId = factAt('Le NAS QNAP héberge les sauvegardes vidéo', '2026-01-01T00:00:00.000Z', { scope: 'sd' })
    const newId = factAt('Le NAS QNAP héberge les sauvegardes vidéo', '2026-02-01T00:00:00.000Z', { scope: 'sd' })

    const engine = new RevisionEngine({ store })
    await engine.propose({ limit: 50 })
    const dup = engine.listProposalsDetailed().find(p => p.kind === 'duplicate')!

    expect(dup.fact?.id).toBe(oldId)
    expect(dup.replacement?.id).toBe(newId)
    expect(dup.fact?.fact).toContain('NAS QNAP')
    expect(dup.replacement?.fact).toContain('NAS QNAP')
  })

  it('souvenir SUPPRIMÉ entre-temps → null, la liste tient debout (pas de mort silencieuse)', async () => {
    const oldId = factAt('Le port du serveur de production est 8080', '2026-01-01T00:00:00.000Z')
    factAt('Le port du serveur de production est 9090', '2026-02-01T00:00:00.000Z')

    const engine = new RevisionEngine({ store })
    await engine.propose({ limit: 50 })
    // Suppression DURE, hors du chemin de révision (import, purge, sync…).
    store.db.prepare('DELETE FROM facts WHERE id = ?').run(oldId)

    const detailed = engine.listProposalsDetailed()
    expect(detailed).toHaveLength(1)
    expect(detailed[0]!.fact).toBeNull()
    // Le remplaçant, lui, est toujours là : on montre ce qu'on a.
    expect(detailed[0]!.replacement?.fact).toBe('Le port du serveur de production est 9090')
    // La raison du moteur reste disponible comme repli d'affichage.
    expect(detailed[0]!.reason.length).toBeGreaterThan(0)
  })

  it('un obsolète pur (sans remplaçant) → replacement null, sans erreur', () => {
    const factId = factAt('Ancienne procédure de sauvegarde sur bandes', '2026-01-01T00:00:00.000Z')
    const engine = new RevisionEngine({ store })
    engine.db
      .prepare(
        `INSERT INTO revision_proposals (id, fact_id, kind, reason, replacement_fact_id, status, created_at)
         VALUES ('p-obs', ?, 'obsolete', 'Procédure périmée', NULL, 'proposed', '2026-03-01T00:00:00.000Z')`,
      )
      .run(factId)

    const p = engine.listProposalsDetailed()[0]!
    expect(p.kind).toBe('obsolete')
    expect(p.fact?.fact).toBe('Ancienne procédure de sauvegarde sur bandes')
    expect(p.replacement).toBeNull()
  })

  it('même ordre et mêmes propositions que listProposals (aucun appelant cassé)', async () => {
    factAt('Le port du serveur de production est 8080', '2026-01-01T00:00:00.000Z')
    factAt('Le port du serveur de production est 9090', '2026-02-01T00:00:00.000Z')
    factAt('Le NAS QNAP héberge les sauvegardes vidéo', '2026-01-05T00:00:00.000Z', { scope: 'sd' })
    factAt('Le NAS QNAP héberge les sauvegardes vidéo', '2026-02-05T00:00:00.000Z', { scope: 'sd' })

    const engine = new RevisionEngine({ store })
    await engine.propose({ limit: 50 })
    const plain = engine.listProposals()
    const detailed = engine.listProposalsDetailed()

    expect(detailed.map(p => p.id)).toEqual(plain.map(p => p.id))
    expect(detailed.map(p => p.kind)).toEqual(plain.map(p => p.kind))
    expect(detailed.map(p => p.replacement_fact_id)).toEqual(plain.map(p => p.replacement_fact_id))
  })

  it('une proposition ÉCARTÉE ne revient pas dans la liste détaillée', async () => {
    factAt('Le port du serveur de production est 8080', '2026-01-01T00:00:00.000Z')
    factAt('Le port du serveur de production est 9090', '2026-02-01T00:00:00.000Z')
    const engine = new RevisionEngine({ store })
    const id = (await engine.propose({ limit: 50 })).proposals[0]!.id
    expect(engine.dismiss(id)).toBe(true)
    expect(engine.listProposalsDetailed()).toHaveLength(0)
  })
})
