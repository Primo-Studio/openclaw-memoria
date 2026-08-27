/**
 * Import de souvenirs (écran Agents) : un job `interrupted` (daemon arrêté
 * pendant l'import) est un ÉCHEC EXPLICITE — message + relance — jamais un
 * spinner sans fin ; et un statut interrompu persisté est montré au chargement.
 */
import { describe, expect, it } from 'vitest'
import type { DetectedAgent, ImportJobStatus } from '../src/api'
import { importFailureMessage, importPollOutcome, interruptedImport } from '../src/lib/import-flow'

const t = (key: string): string => `<${key}>`

function status(state: ImportJobStatus['state'], over: Partial<ImportJobStatus> = {}): ImportJobStatus {
  return {
    state,
    kind: 'transcripts',
    instance_id: 'inst-claude',
    progress: { files_done: 508, files_total: 1355, facts_imported: 146 },
    error: null,
    errors: [],
    started_at: '2026-08-27T10:00:00.000Z',
    finished_at: null,
    ...over,
  }
}

function agent(kind: DetectedAgent['kind'], instance: string | null): DetectedAgent {
  return { kind, name: kind, installed: true, data_found: { transcript_files: 12 }, already_connected: instance }
}

const INTERRUPTED_MSG = 'import interrompu (arrêt du daemon) après 508/1355 fichier(s), 146 souvenir(s) — relance l\'import pour continuer'

describe('importPollOutcome — polling pendant l’étape « running »', () => {
  it('running → on continue d’afficher la progression', () => {
    const s = status('running')
    expect(importPollOutcome(s, t)).toEqual({ kind: 'running', status: s })
  })

  it('done → étape terminée', () => {
    const s = status('done', { finished_at: '2026-08-27T11:00:00.000Z' })
    expect(importPollOutcome(s, t)).toEqual({ kind: 'done', status: s })
  })

  it('error → échec avec le message du daemon', () => {
    expect(importPollOutcome(status('error', { error: 'integrity_check non-ok' }), t)).toEqual({ kind: 'failed', message: 'integrity_check non-ok' })
  })

  it('interrupted → échec EXPLICITE avec le message du daemon (pas un spinner sans fin)', () => {
    expect(importPollOutcome(status('interrupted', { error: INTERRUPTED_MSG }), t)).toEqual({ kind: 'failed', message: INTERRUPTED_MSG })
  })

  it('interrupted sans message → texte de repli dédié, jamais vide', () => {
    expect(importPollOutcome(status('interrupted'), t)).toEqual({ kind: 'failed', message: '<agents.import.interrupted>' })
    expect(importFailureMessage(status('error'), t)).toBe('<agents.import.unknownError>')
  })

  it('idle pendant un run = le job a disparu → échec dit clairement', () => {
    expect(importPollOutcome(status('idle', { instance_id: null, kind: null }), t)).toEqual({ kind: 'failed', message: '<agents.import.vanished>' })
  })
})

describe('interruptedImport — statut persisté lu au chargement de l’écran', () => {
  const agents = [agent('claude-code', 'inst-claude'), agent('codex', 'inst-codex'), agent('openclaw', null)]

  it('statut interrompu → message + agent dont l’instance est celle du job', () => {
    const r = interruptedImport(status('interrupted', { error: INTERRUPTED_MSG }), agents, t)
    expect(r?.message).toBe(INTERRUPTED_MSG)
    expect(r?.agent?.kind).toBe('claude-code')
  })

  it('agent du job plus détecté → message quand même, agent null (pas de bouton relancer)', () => {
    const r = interruptedImport(status('interrupted', { instance_id: 'inst-parti' }), agents, t)
    expect(r).toEqual({ message: '<agents.import.interrupted>', agent: null })
  })

  it('détection pas encore faite (null) → message quand même', () => {
    expect(interruptedImport(status('interrupted'), null, t)?.agent).toBeNull()
  })

  it('un agent non connecté (already_connected null) ne matche jamais, même avec instance_id null', () => {
    expect(interruptedImport(status('interrupted', { instance_id: null }), agents, t)?.agent).toBeNull()
  })

  it('tout autre statut (idle, done, running, error) → rien à montrer', () => {
    for (const s of ['idle', 'done', 'running', 'error'] as const) {
      expect(interruptedImport(status(s), agents, t)).toBeNull()
    }
  })
})
