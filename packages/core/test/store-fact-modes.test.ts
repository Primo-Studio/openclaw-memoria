/**
 * Le mode de capture s'applique AUSSI à la déclaration explicite d'un fait par
 * un agent (`declareFact`, derrière POST /v1/memory/store_fact et l'outil MCP
 * memoria_store_fact). Avant : seul captureTurn le consultait — en « Pause »
 * un agent mémorisait quand même, en « Revue d'abord » le fait naissait actif,
 * rappelable, absent de la revue. Contraire aux promesses de l'UI.
 *
 *  - auto-private  → fait actif (inchangé) ;
 *  - review-first  → fait DORMANT + item de revue, invisible au recall ;
 *  - incognito     → rien n'est écrit, réponse annoncée `skipped: 'paused'`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/index.js'

let root: string
let m: Memoria
let instance: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-store-modes-'))
  m = Memoria.init({ storageRoot: root, configPath: join(root, 'config.toml'), llm: { extraction: null }, secretsVault: 'aes-vault' })
  instance = m.pairAssistant({ type: 'claude-code' }).assistant_instance_id
})

afterEach(() => {
  m.close()
  rmSync(root, { recursive: true, force: true })
})

describe('declareFact — auto-private', () => {
  it('fait actif, rappelable immédiatement', () => {
    const r = m.declareFact({ instance, content: 'Le café du studio est un Nespresso' })
    expect(r.skipped).toBe(false)
    expect(r.mode).toBe('auto-private')
    expect(r.fact?.lifecycle_state).toBe('active')
    expect(m.recall({ instance, query: 'café studio nespresso' }).items).toHaveLength(1)
    expect(m.listReview()).toHaveLength(0)
  })
})

describe('declareFact — review-first', () => {
  beforeEach(() => m.setCaptureMode('review-first'))

  it('fait DORMANT + item de revue ; invisible au recall ; approbation → visible', () => {
    const r = m.declareFact({ instance, content: 'Le café du studio est un Nespresso' })
    expect(r.skipped).toBe(false)
    expect(r.mode).toBe('review-first')
    expect(r.fact?.lifecycle_state).toBe('dormant')

    expect(m.recall({ instance, query: 'café studio nespresso' }).items).toHaveLength(0)
    const pending = m.listReview()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.fact_id).toBe(r.fact!.id)
    expect(pending[0]!.source_type).toBe('capture-review')

    expect(m.reviewDecision([pending[0]!.id], 'accepted').updated).toBe(1)
    expect(m.recall({ instance, query: 'café studio nespresso' }).items).toHaveLength(1)
    expect(m.listReview()).toHaveLength(0)
  })

  it('même chose dans le scope partagé « user » (DB partagée) : revue puis visible par un autre agent', () => {
    const other = m.pairAssistant({ type: 'codex' }).assistant_instance_id
    const r = m.declareFact({ instance, scope: 'user', content: 'Le studio déploie sur Vercel' })
    expect(r.fact?.lifecycle_state).toBe('dormant')
    expect(m.recall({ instance: other, query: 'déploiement vercel' }).items).toHaveLength(0)

    const pending = m.listReview()
    expect(pending).toHaveLength(1)
    m.reviewDecision([pending[0]!.id], 'accepted')
    expect(m.recall({ instance: other, query: 'déploiement vercel' }).items).toHaveLength(1)
  })

  it('redéclarer un fait en attente ne le valide PAS (la validation reste à l’utilisateur)', () => {
    const first = m.declareFact({ instance, content: 'Le café du studio est un Nespresso' })
    const again = m.declareFact({ instance, content: 'Le café du studio est un Nespresso' })
    expect(again.fact?.id).toBe(first.fact?.id)
    expect(again.fact?.lifecycle_state).toBe('dormant')
    expect(m.listReview()).toHaveLength(1) // pas de doublon d'item
    expect(m.recall({ instance, query: 'café studio nespresso' }).items).toHaveLength(0)
  })

  it('rejet → le fait déclaré disparaît sans trace', () => {
    m.declareFact({ instance, content: 'Le café du studio est un Nespresso' })
    const pending = m.listReview()
    m.reviewDecision([pending[0]!.id], 'rejected')
    expect(m.stats().facts).toBe(0)
  })
})

describe('declareFact — incognito (pause)', () => {
  beforeEach(() => m.setCaptureMode('incognito'))

  it('rien n’est écrit, et c’est annoncé', () => {
    const r = m.declareFact({ instance, content: 'Résultat d’analyse médicale : tout va bien' })
    expect(r.skipped).toBe(true)
    expect(r.fact).toBeNull()
    if (r.skipped) expect(r.reason).toBe('paused')
    expect(r.mode).toBe('incognito')
    expect(m.stats().facts).toBe(0)
    expect(m.listReview()).toHaveLength(0)
    expect(m.recall({ instance, query: 'analyse médicale' }).items).toHaveLength(0)
  })

  it('une instance inconnue reste une erreur, pause ou pas', () => {
    expect(() => m.declareFact({ instance: 'inexistant', content: 'x' })).toThrow(/instance inconnue/)
  })

  it('storeFact (primitive interne : import, partage, tests) n’est PAS soumis au mode', () => {
    const f = m.storeFact({ instance, content: 'Fait posé par un import utilisateur' })
    expect(f.lifecycle_state).toBe('active')
  })
})
