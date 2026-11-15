/**
 * Passe sur les messages de l'utilisateur (`triage/user-messages.ts`).
 * Données fictives uniquement (dépôt public) : sessions Claude Code, historique
 * Codex et export ChatGPT écrits dans un dossier temporaire.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompleteOptions, CompletionResult } from '../src/llm/provider.js'
import { parseClaudeCodeTranscript } from '../src/migration/transcript-parsers.js'
import { isSensitive } from '../src/triage/sensitive.js'
import type { TriageHost, UserMessagesPassOptions } from '../src/triage/types.js'
import {
  cleanHumanText,
  findQuote,
  MESSAGE_MAX_CHARS,
  runUserMessagesPass,
  settleAuthor,
  streamClaudeCodeTranscript,
  type ProposedFact,
  type UserMessagesDetailReport,
  type UserMessagesPassOptionsExt,
} from '../src/triage/user-messages.js'
import { RecordingLlm, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

// ---------------------------------------------------------------- faux LLM

interface Entry {
  m: number
  date?: string
  contexte?: string
  message: string
}

interface MessagesBehaviour {
  /** Erreur à lever à cet appel (null : répondre). */
  fail?: (call: number) => Error | null
  /** Réponse illisible à cet appel. */
  garbage?: (call: number) => boolean
  /** Numéro de message décalé (le LLM se trompe de m). */
  shiftM?: boolean
  /** Le LLM dit « owner » pour une idée tirée du contexte. */
  lieOwner?: boolean
  /** Le fait produit d'une idée contient un motif sensible. */
  sensitiveFact?: boolean
  onCall?: (call: number) => void
}

/** Répond selon le texte des messages : `IDEE …`, `oui` après « je propose », `toujours …`, `STYLE`. */
class MessagesLlm extends RecordingLlm {
  readonly entries: Entry[] = []
  constructor(
    public mb: MessagesBehaviour = {},
    name = 'ollama',
    model = 'messages-fictif',
  ) {
    super(name, model)
  }
  override async completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
    this.calls++
    this.prompts.push(`${opts.system ?? ''}\n${opts.prompt}`)
    this.mb.onCall?.(this.calls)
    const failure = this.mb.fail?.(this.calls)
    if (failure) throw failure
    if (this.mb.garbage?.(this.calls)) return { text: 'pas du json' }
    const entries = opts.prompt
      .split('\n')
      .filter(l => l.startsWith('{'))
      .map(l => JSON.parse(l) as Entry)
    this.entries.push(...entries)
    const items: Record<string, unknown>[] = []
    for (const e of entries) {
      const m = this.mb.shiftM ? (e.m % entries.length) + 1 : e.m
      const idea = /^IDEE (.+)$/.exec(e.message)
      if (idea) {
        items.push({
          m,
          genre: 'idee',
          sous_type: 'app',
          auteur: 'owner',
          titre: `Idée ${idea[1]!.slice(0, 20)}`,
          texte: `L'utilisateur a l'idée ${idea[1]}${this.mb.sensitiveFact ? ' avec son bulletin de paie' : ''}.`,
          citation: idea[1],
          rubriques: ['app'],
          portee: 'user',
          importance: 2,
          durabilite: 2,
          projet: 'Projet Fictif',
        })
      }
      const proposal = /je propose (.+?)[.!]?$/.exec(e.contexte ?? '')
      if (/^oui\b/i.test(e.message) && proposal) {
        items.push({
          m,
          genre: 'idee',
          sous_type: 'app',
          auteur: this.mb.lieOwner ? 'owner' : 'ia_approuvee',
          titre: 'Idée de l’assistant',
          // Menteur : texte sans recouvrement avec le contexte, seule la citation trahit l'IA.
          texte: this.mb.lieOwner ? "L'utilisateur valide la proposition faite pour le groupe." : `L'utilisateur approuve ${proposal[1]}.`,
          citation: this.mb.lieOwner ? proposal[1] : e.message,
        })
      }
      if (/\btoujours\b/.test(e.message)) {
        items.push({ m, genre: 'preference', personne: 'owner', texte: `L'utilisateur veut ${e.message}.`, citation: e.message, portee: 'user' })
      }
      if (/\bSTYLE\b/.test(e.message)) {
        for (const k of [1, 2, 3]) items.push({ m, genre: 'style', personne: 'owner', texte: `L'utilisateur écrit des messages très courts, variante ${k}.` })
      }
    }
    return { text: JSON.stringify({ items }) }
  }
}

// ---------------------------------------------------------------- sessions fictives

const ts = (minute: number): string => new Date(Date.UTC(2026, 2, 1, 10, minute)).toISOString()
const user = (text: string, minute: number, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  timestamp: ts(minute),
  entrypoint: 'cli',
  message: { role: 'user', content: text },
  ...extra,
})
const assistant = (text: string, minute: number) => ({
  type: 'assistant',
  timestamp: ts(minute),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
const queued = (text: string, minute: number) => ({
  type: 'attachment',
  timestamp: ts(minute),
  attachment: { type: 'queued_command', commandMode: 'prompt', prompt: text },
})

function writeLines(path: string, lines: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}
const live = (rel: string, lines: unknown[]): string => writeLines(join(env.claudeDir, rel), lines)
const archived = (rel: string, lines: unknown[]): string => writeLines(join(env.archiveDir, rel), lines)

async function pass(opts: UserMessagesPassOptionsExt = {}): Promise<UserMessagesDetailReport> {
  env.m.registerUserMessagesPass(runUserMessagesPass)
  return (await env.m.triage.runUserMessages({ retryDelayMs: 0, ...opts } as UserMessagesPassOptions)) as UserMessagesDetailReport
}

function llm(): MessagesLlm {
  return env.llm as MessagesLlm
}
const sent = (): string[] => llm().entries.map(e => e.message)

function rows(): Array<Record<string, unknown>> {
  return env
    .db()
    .prepare(
      `SELECT f.id, f.fact, f.lifecycle_state, t.genre, t.auteur, t.auteur_source, t.approuve_par_owner, t.citation, t.conversation_at,
              t.conversation_at_source, t.origine, t.sensible, t.titre
       FROM facts f JOIN fact_triage t ON t.fact_id = f.id ORDER BY t.conversation_at, f.fact`,
    )
    .all() as Array<Record<string, unknown>>
}
function states(db = env.db()): Array<{ status: string; facts: number; source_key: string }> {
  return db.prepare('SELECT status, facts, source_key FROM user_message_state ORDER BY ts, msg_key').all() as Array<{ status: string; facts: number; source_key: string }>
}

/** Session riche : tous les tours `user` qui ne sont pas de l'humain, plus un message en file. */
function richSession(): unknown[] {
  return [
    { type: 'summary', summary: 'Session fictive' },
    user('IDEE une app de troc de vélos', 1),
    assistant('Je regarde.', 2),
    queued('IDEE une carte des fontaines publiques', 3),
    assistant('Voilà le plan.', 4),
    user('<task-notification>MARQUE-NOTIF tâche finie</task-notification>', 5),
    user('This session is being continued from a previous conversation. MARQUE-RESUME', 6, { isCompactSummary: true }),
    user('MARQUE-META compétence chargée', 7, { isMeta: true }),
    user('<command-name>/clear</command-name> MARQUE-COMMANDE', 8),
    user('Another Claude session sent a message: MARQUE-PAIR', 9),
    user('MARQUE-PROGRAMME tâche programmée', 10, { scheduledTaskId: 'tache-1' }),
    { type: 'user', timestamp: ts(11), message: { role: 'user', content: [{ type: 'tool_result', content: 'MARQUE-OUTIL' }] } },
    user('toujours répondre en phrases courtes', 12),
    // Message en file déjà présent comme tour humain : pas doublé.
    queued('toujours répondre en phrases courtes', 13),
  ]
}

// ---------------------------------------------------------------- tests

describe('passe sur les messages : ce qui part au LLM', () => {
  it('ne garde que ce que l’humain a tapé (file d’attente comprise), jamais un sous-agent ni une session lancée par un programme', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-projet-a/s1.jsonl', richSession())
    live('-projet-a/s1/subagents/agent-1.jsonl', [user('IDEE MARQUE-SOUS-AGENT', 1, { isSidechain: true })])
    live('-projet-b/s2.jsonl', [user('IDEE MARQUE-SDK lancée par un script', 1, { entrypoint: 'sdk-cli' })])
    live('-projet-b/s3.jsonl', [user('<artifact-content-authored-by-others>IDEE MARQUE-AUTRUI</artifact-content-authored-by-others>', 1)])
    const r = await pass()
    expect(sent().sort()).toEqual(['IDEE une app de troc de vélos', 'IDEE une carte des fontaines publiques', 'toujours répondre en phrases courtes'])
    expect(llm().prompts.join('\n')).not.toMatch(/MARQUE-/)
    expect(r.not_human).toMatchObject({ notification: 1, summary: 1, system: 1, command: 1, peer: 1, scheduled: 1, automated: 1 })
    expect(r).toMatchObject({ messages_seen: 3, messages_queued: 1, messages_third_party: 1, messages_sent: 3, facts_created: 3 })
  })

  it('lecture en flux : mêmes tours, mêmes auteurs réels et même file d’attente que parseClaudeCodeTranscript', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    const path = live('-projet-a/s1.jsonl', [...richSession(), user('x'.repeat(20_500), 20), queued('IDEE dernier message en file', 21)])
    const streamed = await streamClaudeCodeTranscript(path)
    expect(streamed.turns).toEqual(parseClaudeCodeTranscript(readFileSync(path, 'utf8')))
    // En plus du parseur : l'horodatage du message en file est celui de sa propre ligne.
    expect(streamed.meta.find(m => m.queuedBefore.length > 0)!.queuedBefore[0]).toEqual({ text: 'IDEE une carte des fontaines publiques', ts: ts(3) })
  })

  it('contexte : les 500 derniers caractères du texte de l’assistant depuis le message humain précédent', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [
      user('premier message', 1),
      assistant(`DEBUT-ANCIEN ${'a'.repeat(700)}`, 2),
      assistant('je propose une app de recettes de saison.', 3),
      user('oui vas-y', 4),
      user('encore un message', 5),
    ])
    await pass()
    // Deux messages humains d'affilée : le second n'a pas de contexte.
    expect(llm().entries.find(e => e.message === 'encore un message')!.contexte).toBeUndefined()
    const second = llm().entries.find(e => e.message === 'oui vas-y')!
    expect(second.contexte!.length).toBe(500)
    expect(second.contexte).toMatch(/je propose une app de recettes de saison\.$/)
    expect(second.contexte).not.toContain('DEBUT-ANCIEN')
    expect(llm().entries.find(e => e.message === 'premier message')!.contexte).toBeUndefined()
  })

  it('nettoyage : rappels et hooks insérés, images, contenus collés et longs blocs retirés ; message coupé au-delà du plafond', () => {
    const c = cleanHumanText(
      'avant <system-reminder>RAPPEL secret</system-reminder> milieu [Image #1] <pasted_content id="p1">COLLÉ</pasted_content> ' +
        `<user-prompt-submit-hook>HOOK</user-prompt-submit-hook> \`\`\`\n${'log '.repeat(200)}\n\`\`\` fin \`\`\`court\`\`\``,
    )
    expect(c.text).toBe('avant milieu [contenu collé retiré] [bloc collé retiré] fin ```court```')
    expect(c.removed).toBe(5)
    expect(cleanHumanText('<artifact-content-authored-by-others>x</artifact-content-authored-by-others>')).toMatchObject({ text: null, reason: 'third_party' })
    expect(cleanHumanText('<system-reminder>seul</system-reminder>')).toMatchObject({ text: null, reason: 'empty' })
    const long = cleanHumanText('mot '.repeat(3000))
    expect(long.truncated).toBe(true)
    expect(long.text!.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS + 20)
  })

  it('un message de paie n’est JAMAIS envoyé (ni au LLM ni aux vecteurs), un contexte de paie non plus ; état « sensitive »', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [
      user('IDEE le salaire de Zorba passe à 2 100 euros brut', 1),
      assistant('Voici la fiche de paie de Zorba pour mars.', 2),
      user('oui envoie', 3),
      assistant('Je regarde la suite.', 4),
      user('IDEE une app de troc de vélos', 5),
    ])
    const r = await pass()
    expect(sent()).toEqual(['IDEE une app de troc de vélos'])
    const everything = [...llm().prompts, ...env.embedder.texts].join('\n')
    expect(everything).not.toMatch(/salaire|Zorba|fiche de paie|oui envoie/)
    expect(r).toMatchObject({ messages_sensitive: 2, messages_sensitive_context: 1 })
    expect(states().map(s => s.status).sort()).toEqual(['done', 'sensitive', 'sensitive'])
  })

  it('un fait produit qui porte un motif sensible n’a jamais de vecteur et naît marqué sensible', async () => {
    env = setupTriage({ llm: new MessagesLlm({ sensitiveFact: true }) })
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1)])
    await pass()
    expect(env.embedder.texts.join('\n')).not.toMatch(/bulletin/)
    expect(rows()).toMatchObject([{ sensible: 1 }])
  })

  it('les secrets du message et du contexte sont masqués avant l’envoi', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    live('-p/s.jsonl', [assistant(`la clé est ${key}`, 1), user(`IDEE une app qui garde ${key} au chaud`, 2)])
    const r = await pass()
    const prompts = llm().prompts.join('\n')
    expect(prompts).not.toContain(key)
    expect(prompts).toMatch(/\[secret:/)
    expect(r.secrets_masked).toBe(2)
  })
})

describe('passe sur les messages : écriture, idempotence, reprise', () => {
  it('fait EN ATTENTE + ligne de tri (auteur owner vérifié, citation, date du message) sous une source « user-messages » ; second passage : rien ne repart', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    const path = live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 7), assistant('Noté.', 8), user('rien de neuf', 9)])
    const first = await pass()
    expect(first).toMatchObject({ messages_sent: 2, facts_created: 1, llm_calls: 1 })
    expect(rows()).toMatchObject([
      {
        lifecycle_state: 'dormant',
        genre: 'idee',
        auteur: 'owner',
        auteur_source: 'message',
        approuve_par_owner: 0,
        citation: 'une app de troc de vélos',
        conversation_at: ts(7),
        conversation_at_source: 'fichier',
        origine: 'session',
      },
    ])
    expect(env.db().prepare("SELECT source_path FROM memory_sources WHERE source_type = 'user-messages'").all()).toEqual([{ source_path: path }])
    expect(states()).toEqual([
      { status: 'done', facts: 1, source_key: 'claude-code:-p/s.jsonl' },
      { status: 'done', facts: 0, source_key: 'claude-code:-p/s.jsonl' },
    ])
    const calls = llm().calls
    const second = await pass()
    expect(llm().calls).toBe(calls)
    expect(second).toMatchObject({ messages_seen: 2, messages_known: 2, messages_sent: 0, facts_created: 0 })
    expect(rows()).toHaveLength(1)
  })

  it('archive et ~/.claude/projects : un même chemin n’est lu qu’une fois, la clé ne dépend pas de l’endroit lu', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    archived('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1)])
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1), assistant('Noté.', 2), user('IDEE un jeu de cartes sur les oiseaux', 3)])
    archived('-p/ancienne.jsonl', [user('IDEE une carte des fontaines publiques', 4)])
    const r = await pass()
    expect(sent().sort()).toEqual(['IDEE un jeu de cartes sur les oiseaux', 'IDEE une app de troc de vélos', 'IDEE une carte des fontaines publiques'])
    expect(r).toMatchObject({ sessions_found: 2, sessions_twin: 1, facts_created: 3 })
    const bySource = Object.fromEntries(rows().map(x => [String(x['citation']), x['conversation_at_source']]))
    expect(bySource).toEqual({ 'une app de troc de vélos': 'fichier', 'un jeu de cartes sur les oiseaux': 'fichier', 'une carte des fontaines publiques': 'archive' })
  })

  it('appels en échec : coupe-circuit après 3 échecs d’affilée, rien n’est marqué ; le passage suivant reprend tout', async () => {
    const failing = new MessagesLlm({ fail: () => new Error('panne fictive') })
    env = setupTriage({ llm: failing })
    for (const k of [1, 2, 3, 4]) live(`-p/s${k}.jsonl`, [user(`IDEE idée numéro ${k} pour le club`, k)])
    const r = await pass()
    expect(r.stopped).toBe('circuit')
    expect(failing.calls).toBe(3)
    expect(r.errors.filter(e => e.includes('panne fictive'))).toHaveLength(3)
    expect(states()).toEqual([])
    expect(rows()).toEqual([])
    failing.mb.fail = undefined
    const again = await pass()
    expect(again).toMatchObject({ stopped: null, messages_sent: 4, facts_created: 4 })
  })

  it('échec passager (429) : une reprise, puis le lot passe', async () => {
    env = setupTriage({ llm: new MessagesLlm({ fail: call => (call === 1 ? new Error('HTTP 429 rate limit') : null) }) })
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1)])
    const r = await pass()
    expect(r).toMatchObject({ llm_calls: 2, facts_created: 1, errors: [] })
  })

  it('sortie illisible deux fois : messages « failed » (repris plus tard), aucun fait', async () => {
    env = setupTriage({ llm: new MessagesLlm({ garbage: () => true }) })
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1)])
    const r = await pass()
    expect(r).toMatchObject({ llm_calls: 2, facts_created: 0, messages_failed: 1 })
    expect(states().map(s => s.status)).toEqual(['failed'])
    llm().mb.garbage = undefined
    expect(await pass()).toMatchObject({ messages_known: 0, facts_created: 1 })
  })

  it('plafond de dépense : l’appel qui pourrait dépasser ne part pas, arrêt « budget », rien n’est marqué', async () => {
    env = setupTriage({ llm: new MessagesLlm({}, 'openai', 'gpt-4o-mini') })
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1)])
    const r = await pass({ budgetUsd: 0.000001 })
    expect(r.stopped).toBe('budget')
    expect(llm().calls).toBe(0)
    expect(states()).toEqual([])
  })

  it('annulation entre deux lots, et plafond de messages', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [1, 2, 3, 4, 5].map(k => user(`IDEE idée numéro ${k} pour le club`, k)))
    const capped = await pass({ maxMessages: 3, batchSize: 2 })
    expect(capped).toMatchObject({ stopped: 'max_facts', messages_sent: 3, facts_created: 3 })
    llm().mb.onCall = () => void env.m.triage.cancel()
    const cancelled = await pass({ batchSize: 1 })
    expect(cancelled).toMatchObject({ stopped: 'cancelled', messages_sent: 1 })
  })

  it('rend la main à la boucle d’événements entre deux lots', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [1, 2, 3, 4, 5, 6].map(k => user(`IDEE idée numéro ${k} pour le club`, k)))
    const real = globalThis.setImmediate
    let yields = 0
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
      yields++
      return real(fn, ...args)
    }) as unknown as typeof setImmediate)
    const atCall: number[] = []
    llm().mb.onCall = () => void atCall.push(yields)
    try {
      await pass({ batchSize: 2 })
    } finally {
      spy.mockRestore()
    }
    expect(atCall).toHaveLength(3)
    for (let k = 1; k < atCall.length; k++) expect(atCall[k]!).toBeGreaterThan(atCall[k - 1]!)
  })

  it('lecture d’une grosse session : la main est rendue pendant la lecture', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    const lines: unknown[] = []
    for (let k = 0; k < 400; k++) lines.push(user(`message numéro ${k} ${'z'.repeat(200)}`, k % 60), assistant('ok', k % 60))
    const path = live('-p/grosse.jsonl', lines)
    const real = globalThis.setImmediate
    let yields = 0
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
      yields++
      return real(fn, ...args)
    }) as unknown as typeof setImmediate)
    try {
      const s = await streamClaudeCodeTranscript(path, { sliceMs: 0 })
      expect(s.turns).toHaveLength(800)
    } finally {
      spy.mockRestore()
    }
    expect(yields).toBeGreaterThan(400)
  })
})

describe('passe sur les messages : auteur, citation, doublons', () => {
  it('idée de l’IA approuvée : auteur ia:claude, approuve_par_owner, citation = les mots de l’accord', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [assistant('Pour le club, je propose une app de covoiturage entre membres.', 1), user('oui vas-y', 2)])
    await pass()
    expect(rows()).toMatchObject([{ genre: 'idee', auteur: 'ia:claude', auteur_source: 'message', approuve_par_owner: 1, citation: 'oui vas-y' }])
  })

  it('le LLM dit « owner » mais cite le contexte : le code en fait une idée de l’IA approuvée', async () => {
    env = setupTriage({ llm: new MessagesLlm({ lieOwner: true }) })
    live('-p/s.jsonl', [assistant('Pour le club, je propose une app de covoiturage entre membres.', 1), user('oui pourquoi pas', 2)])
    await pass()
    expect(rows()).toMatchObject([{ auteur: 'ia:claude', approuve_par_owner: 1, citation: 'oui pourquoi pas' }])
  })

  it('le LLM se trompe de numéro : la citation rattache le fait au bon message (et à sa date)', async () => {
    env = setupTriage({ llm: new MessagesLlm({ shiftM: true }) })
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1), assistant('Noté.', 2), user('rien de neuf', 30)])
    await pass()
    expect(rows()).toMatchObject([{ citation: 'une app de troc de vélos', conversation_at: ts(1) }])
  })

  it('settleAuthor et findQuote : recouvrement de mots, citation recopiée du message avec ses fautes', () => {
    const base: ProposedFact = {
      m: 1,
      genre: 'idee',
      sous_type: 'app',
      texte: "L'utilisateur veut une application de covoiturage entre membres du club de rugby",
      titre: null,
      citation: null,
      auteur: 'owner',
      personne: null,
      rubriques: [],
      portee: null,
      importance: null,
      durabilite: null,
      projet: null,
      entites: [],
    }
    const context = 'Je propose une application de covoiturage entre membres du club de rugby, avec un tableau des trajets.'
    expect(settleAuthor(base, 'ok', context)).toEqual({ approved: true, citation: 'ok' })
    // Le LLM dit « IA » mais le fait reprend le message : le propriétaire.
    expect(settleAuthor({ ...base, auteur: 'ia' }, 'je veux une application de covoiturage entre membres du club de rugby', 'Voici le planning.')).toEqual({
      approved: false,
      citation: null,
    })
    // Une idée « de l'IA » sans aucun contexte n'a pas de preuve : le propriétaire.
    expect(settleAuthor({ ...base, auteur: 'ia', texte: "L'utilisateur veut un herbier numérique" }, 'un herbier', '')).toEqual({ approved: false, citation: null })
    expect(findQuote('bon alors je veu une aplication de covoiturage pour le club', 'je veux une application de covoiturage pour le club')).toBe(
      'je veu une aplication de covoiturage pour le club',
    )
    expect(findQuote('rien à voir ici', 'une application de covoiturage')).toBeNull()
  })

  it('doublon par le sens d’un fait déjà en attente : rien n’est écrit ; un chiffre différent n’est pas un doublon', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/a.jsonl', [user('IDEE une app de covoiturage pour 3 festivals', 1)])
    await pass()
    // Mots courts en plus : trop loin pour le quasi-doublon par les mots (Jaccard), même sens pour les vecteurs.
    live('-p/b.jsonl', [
      user('IDEE oh la et tu en ok si on y va une app de covoiturage pour 3 festivals', 2),
      assistant('Noté.', 3),
      user('IDEE oh la et tu en ok si on y va une app de covoiturage pour 4 festivals', 4),
    ])
    const r = await pass()
    expect(r).toMatchObject({ facts_created: 1, facts_duplicate: 1 })
    expect(rows().map(x => x['citation'])).toEqual(['une app de covoiturage pour 3 festivals', 'oh la et tu en ok si on y va une app de covoiturage pour 4 festivals'])
  })

  it('un même message (date et texte) dans deux sessions : envoyé une fois, l’autre copie marquée « skipped »', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/a.jsonl', [user('IDEE une app de troc de vélos', 1)])
    live('-p/b.jsonl', [user('IDEE une app de troc de vélos', 1), assistant('Noté.', 2), user('IDEE un jeu de cartes sur les oiseaux', 3)])
    const r = await pass()
    expect(sent()).toEqual(['IDEE une app de troc de vélos', 'IDEE un jeu de cartes sur les oiseaux'])
    expect(r.messages_repeated).toBe(1)
    expect(states().map(s => s.status).sort()).toEqual(['done', 'done', 'skipped'])
  })

  it('since : seuls les messages postérieurs à la date partent', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1), assistant('Noté.', 2), user('IDEE un jeu de cartes sur les oiseaux', 30)])
    const r = await pass({ since: ts(10) })
    expect(sent()).toEqual(['IDEE un jeu de cartes sur les oiseaux'])
    expect(r.messages_before_since).toBe(1)
  })

  it('au plus un style par lot', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [user('STYLE ok go', 1)])
    const r = await pass()
    expect(r.by_genre).toEqual({ style: 1 })
  })
})

describe('passe sur les messages : dry-run et autres sources', () => {
  it('dry-run : aucun appel, aucune écriture, ni masquage (qui écrit au coffre) ; coût estimé', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    live('-p/s.jsonl', [user('IDEE une app de troc de vélos', 1), assistant('Noté.', 2), user('IDEE un jeu de cartes sur les oiseaux', 3)])
    const forbid = (name: string) => (): never => {
      throw new Error(`interdit en dry-run : ${name}`)
    }
    const host: TriageHost = {
      roots: { claudeProjectsDir: env.claudeDir, archiveDir: env.archiveDir, codexHistoryFile: join(env.root, 'absent'), codexSessionsDir: join(env.root, 'absent') },
      owner: { display_name: null, context: null },
      redact: forbid('redact'),
      isSensitive,
      complete: forbid('complete'),
      embed: forbid('embed'),
      estimateCost: (chars, out) => chars / 1e6 + out / 1e6,
      findSemanticDuplicate: forbid('findSemanticDuplicate'),
      storePendingTriaged: forbid('storePendingTriaged'),
      resolveInstanceForSource: () => 'instance-fictive',
      messageDone: () => false,
      markMessage: forbid('markMessage'),
      shouldStop: () => null,
      spentUsd: () => 0,
    }
    const r = await runUserMessagesPass(host, { dryRun: true })
    expect(r).toMatchObject({ messages_sent: 2, llm_calls: 0, llm_calls_estimate: 1, facts_created: 0, errors: [] })
    expect(r.estimate_usd).toBeGreaterThan(0)
    // Par le vrai service : rien d'écrit.
    const real = await pass({ dryRun: true })
    expect(real).toMatchObject({ messages_sent: 2, llm_calls: 0 })
    expect(llm().calls).toBe(0)
    expect(states()).toEqual([])
    expect(rows()).toEqual([])
  })

  it('historique Codex : une source par session, sans le bruit système, dans la base de l’instance codex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memoria-codex-'))
    const file = join(dir, 'history.jsonl')
    writeFileSync(
      file,
      [
        { session_id: 'sess-a', ts: 1_767_261_600, text: 'IDEE une app de troc de vélos' },
        { session_id: 'sess-a', ts: 1_767_261_660, text: '<environment_context>MARQUE-SYSTEME</environment_context>' },
        { session_id: 'sess-b', ts: 1_767_261_720, text: 'toujours répondre en phrases courtes' },
      ]
        .map(l => JSON.stringify(l))
        .join('\n') + '\n',
    )
    try {
      env = setupTriage({ llm: new MessagesLlm(), config: `codex_history_file = "${file}"` })
      const codex = env.m.pairAssistant({ type: 'codex' }).assistant_instance_id
      const r = await pass({ sources: ['codex-history'] })
      expect(sent().sort()).toEqual(['IDEE une app de troc de vélos', 'toujours répondre en phrases courtes'])
      expect(llm().prompts.join('\n')).not.toContain('MARQUE-SYSTEME')
      expect(r).toMatchObject({ sessions_found: 2, facts_created: 2 })
      expect(states(env.dbFor(codex)).map(s => s.source_key).sort()).toEqual(['codex-history:sess-a', 'codex-history:sess-b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('export ChatGPT : tours user seuls, réponse précédente en contexte ; sans chemin, la source est sautée et c’est dit', async () => {
    env = setupTriage({ llm: new MessagesLlm() })
    const node = (id: string, parent: string, role: string, text: string, time: number) => ({
      id,
      parent,
      children: [] as string[],
      message: { id, author: { role }, create_time: time, content: { content_type: 'text', parts: [text] }, weight: 1, metadata: {}, recipient: 'all' },
    })
    const mapping: Record<string, ReturnType<typeof node> | { id: string; parent: null; children: string[]; message: null }> = {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: node('u1', 'root', 'user', 'IDEE une app de troc de vélos', 1_767_261_600),
      a1: node('a1', 'u1', 'assistant', 'Pour le club, je propose une app de covoiturage entre membres.', 1_767_261_660),
      u2: node('u2', 'a1', 'user', 'oui vas-y', 1_767_261_720),
    }
    mapping['u1']!.children.push('a1')
    mapping['a1']!.children.push('u2')
    const exportFile = join(env.root, 'conversations.json')
    writeFileSync(exportFile, JSON.stringify([{ id: 'conv-fictive', title: 'Fictif', create_time: 1_767_261_600, update_time: 1_767_261_720, mapping, current_node: 'u2' }]))
    const without = await pass({ sources: ['chatgpt'] })
    expect(without.errors.join(' ')).toMatch(/chatgptExport/)
    expect(llm().calls).toBe(0)
    const gpt = env.m.ensureChatGptInstance()
    const r = await pass({ sources: ['chatgpt'], chatgptExport: exportFile })
    expect(sent()).toEqual(['IDEE une app de troc de vélos', 'oui vas-y'])
    expect(llm().entries[1]!.contexte).toBe('Pour le club, je propose une app de covoiturage entre membres.')
    expect(r).toMatchObject({ facts_created: 2, facts_ia_approved: 1 })
    expect(states(env.dbFor(gpt)).map(s => s.source_key)).toEqual(['chatgpt:conv-fictive', 'chatgpt:conv-fictive'])
    const auteurs = env.dbFor(gpt).prepare('SELECT auteur FROM fact_triage ORDER BY conversation_at').all()
    expect(auteurs).toEqual([{ auteur: 'owner' }, { auteur: 'ia:gpt' }])
  })
})
