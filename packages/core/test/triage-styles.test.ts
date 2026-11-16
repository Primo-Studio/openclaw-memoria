/**
 * Passe styles (`triage/styles-pass.ts`) : la manière d'échanger du
 * propriétaire, mois par mois, et comment échanger avec une fiche Person.
 * Données fictives uniquement (dépôt public) : sessions Claude Code écrites
 * dans un dossier temporaire, faits triés semés à la main, faux LLM.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { priceFor } from '../src/llm/pricing.js'
import type { CompleteOptions, CompletionResult } from '../src/llm/provider.js'
import { estimateTokensFromChars } from '../src/triage/budget.js'
import { isSensitive } from '../src/triage/sensitive.js'
import { RegexRedactor } from '../src/secrets/redaction.js'
import { scanStyleSourcesAsync } from '../src/triage/store.js'
import {
  maskForCut,
  monthClosed,
  monthStats,
  nameMatcher,
  parseStylesOutput,
  runStylesPass,
  SECRET_MAX_CHARS,
  shouldRedo,
  spreadSample,
  type StylesDetailReport,
  type StylesPassOptionsExt,
} from '../src/triage/styles-pass.js'
import type { StylesHost, StylesPassOptions } from '../src/triage/types.js'
import { runUserMessagesPass } from '../src/triage/user-messages.js'
import { RecordingLlm, setupTriage, type TriageEnv } from './triage-fixtures.js'

let env: TriageEnv
afterEach(() => env?.close())

// ---------------------------------------------------------------- faux LLM

interface Observation {
  titre?: string
  texte: string
  appuis: number[]
}

/** Répond aux deux prompts de la passe ; enregistre les éléments reçus (messages ou notes). */
class StylesLlm extends RecordingLlm {
  readonly messages: string[] = []
  readonly notes: string[] = []
  owner: Observation[] = [
    { titre: 'Valide d’un mot', texte: "L'utilisateur valide d'un mot ou deux dès que la proposition lui convient.", appuis: [1, 2, 3] },
    { titre: 'Dicte ses messages', texte: "L'utilisateur dicte souvent de longues phrases enchaînées, sans ponctuation.", appuis: [2, 3, 4] },
    { titre: 'Recadre vite', texte: "L'utilisateur recadre l'assistant dès qu'une réponse s'écarte de sa demande.", appuis: [4, 5, 6] },
    { titre: 'Rafales de messages', texte: "L'utilisateur envoie ses consignes en rafales de messages très courts.", appuis: [1, 5, 9] },
    // Appuyée par deux messages seulement : écartée par le code.
    { titre: 'Faible', texte: "L'utilisateur termine parfois ses messages par un émoji.", appuis: [1, 2] },
  ]
  person: Observation[] = []
  /** Appelé avant de répondre (pause pendant un appel). */
  onCall: ((call: number) => void) | null = null
  /** Erreur levée pour cet appel (null : il répond). */
  fail: ((call: number) => Error | null) | null = null
  constructor(name = 'ollama', model = 'styles-fictif') {
    super(name, model)
  }
  override async completeDetailed(opts: CompleteOptions): Promise<CompletionResult> {
    this.calls++
    this.prompts.push(`${opts.system ?? ''}\n${opts.prompt}`)
    for (const line of opts.prompt.split('\n')) {
      if (!line.startsWith('{')) continue
      const e = JSON.parse(line) as { message?: string; note?: string }
      if (e.message !== undefined) this.messages.push(e.message)
      if (e.note !== undefined) this.notes.push(e.note)
    }
    this.onCall?.(this.calls)
    const failure = this.fail?.(this.calls)
    if (failure) throw failure
    const owner = (opts.system ?? '').includes("SA MANIÈRE D'ÉCHANGER")
    return { text: JSON.stringify({ observations: owner ? this.owner : this.person }) }
  }
}

// ---------------------------------------------------------------- sessions fictives

const at = (month: number, day: number, minute = 0): string => new Date(Date.UTC(2026, month - 1, day, 9, minute)).toISOString()
const user = (text: string, ts: string) => ({ type: 'user', timestamp: ts, entrypoint: 'cli', message: { role: 'user', content: text } })
const assistant = (text: string, ts: string) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } })

function live(rel: string, lines: unknown[]): string {
  const path = join(env.claudeDir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

/** `n` messages fictifs du propriétaire, un par jour du mois, chacun suivi d'une réponse. */
function monthOf(month: number, n: number, text = (k: number) => `ok go pour la suite numéro ${k}`): unknown[] {
  const out: unknown[] = []
  for (let k = 1; k <= n; k++) {
    out.push(user(text(k), at(month, k)))
    out.push(assistant('Fait.', at(month, k, 1)))
  }
  return out
}

const NOW = () => new Date(Date.UTC(2026, 10, 15, 12))

/** Clé fictive au format reconnu par le masquage (jamais une vraie). */
const KEY = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'

/** Texte de `n` caractères exactement, sans espace final (pour placer une clé à une position donnée). */
function pad(head: string, n: number): string {
  let t = head
  while (t.length < n) t += ' ok go pour la suite'
  t = t.slice(0, n)
  return t.endsWith(' ') ? `${t.slice(0, -1)}x` : t
}

async function pass(opts: Partial<StylesPassOptionsExt> = {}): Promise<StylesDetailReport> {
  env.m.registerStylesPass(runStylesPass)
  return (await env.m.triage.runStyles({ mode: 'owner', retryDelayMs: 0, now: NOW, ...opts } as StylesPassOptions)) as StylesDetailReport
}

function llm(): StylesLlm {
  return env.llm as StylesLlm
}

/** Styles écrits par la passe (les faits semés à la main viennent d'un « import »). */
function styles(db: Database = env.db()): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT f.id, f.fact, f.lifecycle_state, f.source, t.genre, t.person_id, t.auteur, t.auteur_source, t.approuve_par_owner,
              t.portee, t.conversation_at, t.prompt_version, t.titre, t.citation, t.sensible, t.secret_found
       FROM facts f JOIN fact_triage t ON t.fact_id = f.id
       WHERE t.genre = 'style' AND f.source != 'transcript-import' ORDER BY f.fact`,
    )
    .all() as Array<Record<string, unknown>>
}

function states(db: Database = env.db()): Array<Record<string, unknown>> {
  return db.prepare('SELECT state_key, mode, person_id, items, closed, facts FROM style_pass_state ORDER BY state_key').all() as Array<Record<string, unknown>>
}

/** Fait trié semé à la main (actif), comme après un passage du moteur. */
function seedTriaged(
  text: string,
  triage: { genre?: string; rubriques?: string[]; conversation_at?: string; sensible?: number; verdict?: string | null; prompt_version?: string } = {},
  instance: string = env.instance,
): string {
  const fact = env.m.storeFact({ instance, content: text, source: 'transcript-import' })
  env
    .dbFor(instance)
    .prepare(
      `INSERT INTO fact_triage (fact_id, genre, rubriques, triaged_at, conversation_at, conversation_at_source, sensible, verdict, prompt_version)
       VALUES (?, ?, ?, ?, ?, 'fichier', ?, ?, ?)`,
    )
    .run(
      fact.id,
      triage.genre ?? 'fait',
      JSON.stringify(triage.rubriques ?? ['projet']),
      '2026-05-01T00:00:00.000Z',
      triage.conversation_at ?? null,
      triage.sensible ?? 0,
      triage.verdict ?? null,
      triage.prompt_version ?? 'tri-v3',
    )
  return fact.id
}

/** Change des colonnes d'un fait semé (remplacé, oublié, archivé, client, expiration…). */
function setFact(id: string, cols: Record<string, string | number | null>, db: Database = env.db()): void {
  const keys = Object.keys(cols)
  db.prepare(`UPDATE facts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => cols[k]), id)
}

// ---------------------------------------------------------------- outils

describe('passe styles : outils', () => {
  it('statistiques locales, échantillon réparti, mois fini, règle des 50 %', () => {
    const msgs = [5, 10, 40, 200].map(length => ({ length, noFinalPunct: length < 50, question: length === 40 }))
    expect(monthStats(msgs)).toEqual({ messages: 4, longueur_mediane: 25, part_tres_courts: 50, part_sans_ponctuation_finale: 75, part_avec_question: 25 })
    const list = Array.from({ length: 120 }, (_, i) => i)
    const sample = spreadSample(list, 60)
    expect(sample).toHaveLength(60)
    expect(sample[0]).toBe(1)
    expect(sample.at(-1)).toBe(119)
    expect(spreadSample(list, 60)).toEqual(sample)
    expect(monthClosed('2026-10', NOW())).toBe(true)
    expect(monthClosed('2026-11', NOW())).toBe(false)
    const state = { items: 20, last_at: null, closed: true, facts: 3, prompt_version: 'styles-v1', updated_at: '' }
    expect(shouldRedo(null, 10, true)).toBe(true)
    expect(shouldRedo(state, 29, true)).toBe(false)
    expect(shouldRedo(state, 30, true)).toBe(true)
    expect(shouldRedo({ ...state, closed: false }, 21, true)).toBe(true)
    expect(shouldRedo({ ...state, closed: false }, 20, true)).toBe(false)
    expect(shouldRedo({ ...state, closed: false }, 25, false)).toBe(false)
  })

  it('nom cherché : mot entier, sans accents ni casse', () => {
    const match = nameMatcher(['Léonie', 'leo'])!
    expect(match('Point avec LEONIE demain')).toBe(true)
    expect(match('Léo a répondu.')).toBe(true)
    expect(match('Léonard a répondu.')).toBe(false)
    expect(match('cinéléonie')).toBe(false)
  })

  it('sortie du LLM : appuis vérifiés (distincts, dans le lot), sortie illisible levée', () => {
    const out = parseStylesOutput(
      JSON.stringify({ observations: [{ texte: 'Observation assez longue.', appuis: [1, 1, 2, 9] }, { texte: 'Autre observation longue.', appuis: [1, 2, 3] }, { texte: 'court' }] }),
      5,
      3,
    )
    expect(out.items).toEqual([{ texte: 'Autre observation longue.', titre: null, appuis: [1, 2, 3] }])
    expect(out.rejected).toEqual({ appuis: 1, invalide: 1 })
    expect(() => parseStylesOutput('pas du json', 5, 3)).toThrow(/sans JSON/)
  })

  it('masquage sur fenêtre bornée : un secret tronqué par le bord ne repasse jamais avant la coupe, même quand le masquage raccourcit la fenêtre', () => {
    const redactor = new RegexRedactor()
    const redact = (t: string) => {
      const r = redactor.redact(t)
      return { text: r.text, secrets: r.found.length }
    }
    // Bloc PEM fictif de 4 200 caractères au début (masqué, il devient une marque courte), puis une clé à cheval sur le bord de la fenêtre.
    const pem = `-----BEGIN PRIVATE KEY-----${'A'.repeat(4148)}-----END PRIVATE KEY-----`
    const edge = 300 + SECRET_MAX_CHARS
    const text = `${`${pem}${' ok'.repeat(Math.ceil((edge - pem.length) / 3))}`.slice(0, edge - 17)} ${KEY} fin.`
    expect(text.indexOf(KEY)).toBe(edge - 16)
    const masked = maskForCut(redact, text, 300)
    expect(masked.text.slice(0, 300)).not.toContain('sk-proj-')
    expect(masked.secrets).toBe(2)
    // Témoin : sans élargir la fenêtre, le bout de la clé repasserait avant la coupe.
    expect(redact(text.slice(0, edge)).text.slice(0, 300)).toContain('sk-proj-')
    // Texte ordinaire : une seule fenêtre, rien à élargir ; texte court : masqué entier.
    expect(maskForCut(redact, `${KEY} court`, 300).text).toMatch(/^\[secret:/)
  })

  it('parcours des sources par fenêtres de rowid, en rendant la main entre deux fenêtres', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    for (let k = 0; k < 5; k++) seedTriaged(`Note ${k} : Léonie répond vite par message.`)
    seedTriaged('Note sans le prénom.')
    let yields = 0
    const scopeIds = (env.db().prepare('SELECT DISTINCT scope_id AS s FROM facts').all() as Array<{ s: string }>).map(x => x.s)
    const r = await scanStyleSourcesAsync(env.db(), {
      match: nameMatcher(['Léonie'])!,
      excludePromptVersion: 'styles-v1',
      scopeIds,
      window: 2,
      yieldFn: async () => {
        yields++
      },
    })
    expect(r.facts).toHaveLength(5)
    expect(r.scanned).toBe(6)
    expect(yields).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------- mode owner

describe('passe styles : mode owner', () => {
  it('plusieurs observations par mois gardées, en faits DORMANTS du propriétaire ; un mois trop petit est ignoré', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s1.jsonl', [...monthOf(3, 14), ...monthOf(4, 3)])
    const r = await pass()
    expect(r).toMatchObject({ periods_found: 2, periods_small: 1, periods_sent: 1, llm_calls: 1, facts_created: 4, observations_rejected: { appuis: 1 } })
    const rows = styles()
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row).toMatchObject({
        lifecycle_state: 'dormant',
        source: 'user-messages',
        genre: 'style',
        person_id: null,
        auteur: 'owner',
        auteur_source: 'message',
        approuve_par_owner: 0,
        portee: 'user',
        conversation_at: at(3, 14),
        prompt_version: 'styles-v1',
        sensible: 0,
      })
    }
    // Statistiques calculées sur place, données au LLM ; jamais le texte de l'assistant.
    expect(llm().prompts[0]).toContain('"messages":14')
    expect(llm().messages).toHaveLength(14)
    expect(llm().prompts.join('\n')).not.toContain('Fait.')
    expect(states()).toEqual([{ state_key: 'owner:2026-03', mode: 'owner', person_id: null, items: 14, closed: 1, facts: 4 }])
  })

  it('un message répété dans une session reprise ne compte qu’une fois ; doublon d’un mois à l’autre écarté', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s1.jsonl', monthOf(3, 12))
    // Session reprise : elle recopie mars, puis ajoute avril.
    live('-p/s2.jsonl', [...monthOf(3, 12), ...monthOf(4, 12)])
    const r = await pass()
    expect(r).toMatchObject({ messages_repeated: 12, periods_sent: 2, llm_calls: 2, facts_created: 4, facts_duplicate: 4 })
    expect(states().map(s => s['items'])).toEqual([12, 12])
  })

  it('un message sensible n’atteint jamais le LLM (ni l’échantillon, ni les statistiques)', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s.jsonl', [...monthOf(3, 12), user('vérifie le bulletin de salaire de Zorba pour mars', at(3, 20))])
    const r = await pass()
    expect(r).toMatchObject({ messages_sensitive: 1, items_sent: 12 })
    expect(llm().prompts.join('\n')).not.toMatch(/salaire|bulletin|Zorba/)
    expect(llm().prompts[0]).toContain('"messages":12')
  })

  it('les secrets sont masqués juste avant l’envoi', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    live('-p/s.jsonl', [...monthOf(3, 11), user(`garde ${key} pour le test`, at(3, 25))])
    const r = await pass()
    const prompts = llm().prompts.join('\n')
    expect(prompts).not.toContain(key)
    expect(prompts).toMatch(/\[secret:/)
    expect(r.secrets_masked).toBeGreaterThanOrEqual(1)
  })

  it('une observation sensible, sur la vie privée ou qui nomme une autre fiche Person est écartée', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    env.m.createPerson({ display_name: 'Bastien Exemple' })
    llm().owner = [
      { texte: "L'utilisateur parle souvent de son arrêt maladie.", appuis: [1, 2, 3] },
      { texte: "L'utilisateur évoque sa famille en fin de journée.", appuis: [1, 2, 3] },
      { texte: "L'utilisateur transfère les remarques de Bastien sans les reformuler.", appuis: [1, 2, 3] },
      { texte: "L'utilisateur valide d'un mot ou deux dès que la proposition lui convient.", appuis: [1, 2, 3] },
    ]
    live('-p/s.jsonl', monthOf(3, 12))
    const r = await pass()
    expect(r.facts_created).toBe(1)
    expect(r.observations_rejected).toEqual({ sensible: 1, theme: 1, tiers: 1 })
    expect(styles().map(s => s['fact'])).toEqual(["L'utilisateur valide d'un mot ou deux dès que la proposition lui convient."])
  })

  it('le titre passe les mêmes gardes que le texte : secret masqué ; santé, tiers ou vie privée écartent l’observation', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    env.m.createPerson({ display_name: 'Bastien Exemple' })
    // Texte anodin à chaque fois : seul le titre déclenche une garde (une par observation).
    llm().owner = [
      { titre: `Garde ${KEY}`, texte: "L'utilisateur valide d'un mot ou deux dès que la proposition lui convient.", appuis: [1, 2, 3] },
      { titre: 'Arrêt maladie', texte: "L'utilisateur dicte souvent de longues phrases enchaînées, sans ponctuation.", appuis: [2, 3, 4] },
      { titre: 'Relaie Bastien', texte: "L'utilisateur recadre l'assistant dès qu'une réponse s'écarte de sa demande.", appuis: [4, 5, 6] },
      { titre: 'Sa famille le soir', texte: "L'utilisateur envoie ses consignes en rafales de messages très courts.", appuis: [1, 5, 9] },
    ]
    live('-p/s.jsonl', monthOf(3, 12))
    const r = await pass()
    expect(r.facts_created).toBe(1)
    expect(r.observations_rejected).toEqual({ sensible: 1, tiers: 1, theme: 1 })
    const rows = styles()
    expect(rows).toHaveLength(1)
    expect(String(rows[0]!['titre'])).not.toContain(KEY.slice(0, 20))
    expect(String(rows[0]!['titre'])).toMatch(/^Garde \[secret:/)
    expect(rows[0]!['secret_found']).toBe(1)
  })

  it('le texte est masqué ENTIER puis coupé : une clé à cheval sur la coupe ne part pas en morceau', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    // La clé commence au caractère 573 : coupé à 600 avant le masquage, il en partirait 27 caractères.
    const long = `${pad('ok go pour la suite', 572)} ${KEY}`
    expect(long.indexOf(KEY)).toBe(573)
    live('-p/s.jsonl', [...monthOf(3, 11), user(long, at(3, 25))])
    const r = await pass()
    expect(r.items_sent).toBe(12)
    expect(llm().prompts.join('\n')).not.toContain(KEY.slice(0, 12))
    expect(r.secrets_masked).toBeGreaterThanOrEqual(1)
    // Témoin : le message est bien parti, coupé.
    expect(llm().messages.some(m => m.startsWith(pad('ok go pour la suite', 572)))).toBe(true)
  })

  it('titre et texte rendus par le LLM : masqués ENTIERS puis coupés (80 et 400), une clé à cheval sur la coupe ne reste pas en partie', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const titre = `${pad('Valide vite', 62)} ${KEY}`
    const texte = `${pad("L'utilisateur valide d'un mot", 385)} ${KEY}`
    expect(titre.indexOf(KEY)).toBe(63)
    expect(texte.indexOf(KEY)).toBe(386)
    llm().owner = [{ titre, texte, appuis: [1, 2, 3] }]
    live('-p/s.jsonl', monthOf(3, 12))
    const r = await pass()
    expect(r.facts_created).toBe(1)
    const row = styles()[0]!
    expect(String(row['titre'])).not.toContain('sk-proj-')
    expect(String(row['fact'])).not.toContain('sk-proj-')
    expect(row['secret_found']).toBe(1)
    // Témoin : coupés, pas écartés.
    expect(String(row['titre'])).toHaveLength(80)
    expect(String(row['fact']).startsWith(pad("L'utilisateur valide d'un mot", 385))).toBe(true)
  })

  it('règle n°27 : 60 messages pathologiques de 8 000 caractères (motif de masquage quadratique) ne bloquent pas la boucle', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const slow = (k: number): string => {
      let t = `m${k} `
      while (t.length < 8000) t += 'a-'
      return t.slice(0, 8000)
    }
    live(
      '-p/s.jsonl',
      Array.from({ length: 60 }, (_, i) => user(slow(i + 1), at(3, 1 + (i % 28), i))),
    )
    const r = await pass()
    expect(r).toMatchObject({ items_sent: 60, llm_calls: 1 })
    expect(r.max_block_ms).toBeLessThan(200)
  }, 60_000)

  it('second passage : rien ne repart pour un mois fermé ; il repart quand il a gagné 50 % de messages', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s.jsonl', monthOf(3, 14))
    await pass()
    expect(llm().calls).toBe(1)
    const second = await pass()
    expect(second).toMatchObject({ periods_known: 1, periods_sent: 0, llm_calls: 0 })
    expect(llm().calls).toBe(1)
    live('-p/s.jsonl', monthOf(3, 21))
    const third = await pass()
    expect(third).toMatchObject({ periods_sent: 1, llm_calls: 1 })
    expect(states()).toMatchObject([{ state_key: 'owner:2026-03', items: 21, closed: 1 }])
  })

  it('mois encore ouvert : refait seulement une fois fini s’il a gagné des messages', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s.jsonl', monthOf(11, 12))
    await pass()
    expect(states()).toMatchObject([{ state_key: 'owner:2026-11', closed: 0 }])
    expect((await pass()).llm_calls).toBe(0)
    live('-p/s.jsonl', monthOf(11, 13))
    expect((await pass()).llm_calls).toBe(0)
    const later = await pass({ now: () => new Date(Date.UTC(2026, 11, 2)) })
    expect(later).toMatchObject({ periods_sent: 1, llm_calls: 1 })
    expect(states()).toMatchObject([{ state_key: 'owner:2026-11', items: 13, closed: 1 }])
  })

  it('plafond de dépense, réservé au pire cas de sortie : l’appel qui pourrait dépasser ne part pas, arrêt « budget », rien n’est marqué', async () => {
    const price = priceFor('openai', 'gpt-4o-mini')!
    // Entrée de l'appel, mesurée sur un premier passage sans plafond serré.
    env = setupTriage({ llm: new StylesLlm('openai', 'gpt-4o-mini') })
    live('-p/s.jsonl', monthOf(3, 14))
    await pass()
    const inputUsd = (estimateTokensFromChars(llm().prompts[0]!.length - 1) * price.input) / 1e6
    const withOutput = (tokens: number): number => inputUsd + (tokens * price.output) / 1e6
    env.close()
    // Plafond juste sous « entrée + 1 500 jetons de sortie » (le pire cas entier) : refusé.
    env = setupTriage({ llm: new StylesLlm('openai', 'gpt-4o-mini') })
    live('-p/s.jsonl', monthOf(3, 14))
    const r = await pass({ budgetUsd: withOutput(1500) * 0.99 })
    expect(r.stopped).toBe('budget')
    expect(llm().calls).toBe(0)
    expect(states()).toEqual([])
    expect(styles()).toEqual([])
    env.close()
    // Témoin : juste au-dessus du pire cas, l'appel part.
    env = setupTriage({ llm: new StylesLlm('openai', 'gpt-4o-mini') })
    live('-p/s.jsonl', monthOf(3, 14))
    const ok = await pass({ budgetUsd: withOutput(1500) * 1.01 })
    expect(llm().calls).toBe(1)
    expect(ok.facts_created).toBe(4)
  })

  it('jamais reclassés par le moteur : un passage `reclassify` ne relit pas ces faits', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s.jsonl', monthOf(3, 14))
    await pass()
    const before = styles()
    const calls = llm().calls
    const run = await env.m.triage.run({ reclassify: true })
    expect(run.state).toBe('done')
    expect(llm().calls).toBe(calls)
    expect(styles()).toEqual(before)
  })
})

// ---------------------------------------------------------------- dry-run

describe('passe styles : dry-run', () => {
  it('aucun appel, aucune écriture, ni masquage (qui écrit au coffre) ; coût estimé', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s.jsonl', monthOf(3, 14))
    const forbid = (name: string) => (): never => {
      throw new Error(`interdit en dry-run : ${name}`)
    }
    const host: StylesHost = {
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
      person: id => (id === 'p1' ? { id, display_name: 'Léonie Exemple', aliases: [] } : null),
      personNames: () => ['Léonie Exemple'],
      agentOf: () => 'claude',
      styleSourceFacts: async () => ({
        facts: [1, 2, 3].map(k => ({ id: `f${k}`, text: `Léonie préfère un vocal court, note ${k}.`, at: at(3, k), at_source: 'fichier' as const, rubriques: [] })),
        scanned: 3,
      }),
      completionsFit: forbid('completionsFit'),
      styleCallMemo: forbid('styleCallMemo'),
      rememberStyleCall: forbid('rememberStyleCall'),
      stylesState: () => null,
      markStyles: forbid('markStyles'),
    }
    const owner = await runStylesPass(host, { mode: 'owner', dryRun: true })
    expect(owner).toMatchObject({ periods_sent: 1, items_sent: 14, llm_calls: 0, llm_calls_estimate: 1, facts_created: 0, errors: [] })
    expect(owner.estimate_usd).toBeGreaterThan(0)
    const person = await runStylesPass(host, { mode: 'person', person_id: 'p1', dryRun: true })
    expect(person).toMatchObject({ periods_sent: 1, items_sent: 3, llm_calls: 0, llm_calls_estimate: 1 })
    // Par le vrai service : rien d'écrit, pas même une ligne d'audit.
    const audits = (): number => env.m.registry.auditTail(1000).filter(a => a.action === 'triage_styles').length
    const real = await pass({ dryRun: true })
    expect(real).toMatchObject({ periods_sent: 1, llm_calls: 0 })
    expect(llm().calls).toBe(0)
    expect(states()).toEqual([])
    expect(styles()).toEqual([])
    expect(audits()).toBe(0)
    // Témoin : un vrai passage, lui, laisse sa ligne d'audit.
    await pass()
    expect(audits()).toBe(1)
  })
})

// ---------------------------------------------------------------- mode person

describe('passe styles : mode person', () => {
  function seedTeam(): { leonie: string; ids: Record<string, string> } {
    const leonie = env.m.createPerson({ display_name: 'Léonie Exemple' }).id
    env.m.addPersonIdentifier(leonie, 'handle', 'leo')
    env.m.addPersonIdentifier(leonie, 'phone', '+33 6 00 00 00 00')
    env.m.createPerson({ display_name: 'Bastien Exemple' })
    const ids: Record<string, string> = {
      messagerie: seedTriaged('Léonie répond plus vite sur la messagerie que par mail.', { conversation_at: at(3, 2) }),
      vocal: seedTriaged('Pour Leonie, un vocal court marche mieux qu’un long mail.', { genre: 'preference', conversation_at: at(3, 5) }),
      exemple: seedTriaged('Léo a demandé un exemple avant de commencer la maquette.', { conversation_at: at(3, 9) }),
      // Jamais envoyés : rubriques interdites, filtre sensible, éphémère, faux, sensible, tiré par la passe, autre prénom.
      avenant: seedTriaged('Léonie a signé son avenant au cabinet.', { rubriques: ['juridique'] }),
      frais: seedTriaged('Léonie a envoyé la note de frais du trimestre.', { rubriques: ['finance', 'projet'] }),
      entretien: seedTriaged('Entretien annuel de Léonie prévu jeudi.', { rubriques: ['rh'] }),
      maladie: seedTriaged('Léonie est en arrêt maladie cette semaine.', { rubriques: ['projet'] }),
      build: seedTriaged('Léonie a relancé le build du site.', { genre: 'ephemere' }),
      faux: seedTriaged('Léonie a demandé MARQUE-FAUX.', { verdict: 'faux' }),
      marque: seedTriaged('Léonie MARQUE-SENSIBLE.', { sensible: 1 }),
      ancien: seedTriaged('Avec Léonie, MARQUE-STYLE-PASSE.', { genre: 'style', prompt_version: 'styles-v1' }),
      autre: seedTriaged('Léonard aime les réunions courtes.'),
    }
    return { leonie, ids }
  }

  it('écrit des styles DORMANTS reliés à la fiche ; les notes rh/finance/juridique, sensibles ou hors sujet ne partent jamais', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const { leonie } = seedTeam()
    llm().person = [
      // Appuis du plus ancien au plus récent : la date retenue est celle du plus récent, pas du premier cité.
      { titre: 'Joindre par messagerie', texte: 'Avec Léonie, la messagerie obtient une réponse plus vite que le mail.', appuis: [3, 1] },
      { titre: 'Tâche avec exemple', texte: 'Une tâche confiée avec un exemple démarre tout de suite.', appuis: [1, 2] },
      { texte: 'Léonie est peu compétente sur les maquettes.', appuis: [1, 2] },
      { texte: 'Léonie répond mieux quand Bastien est en copie.', appuis: [1, 2] },
      { texte: 'Léonie préfère les vocaux aux longs messages.', appuis: [2] },
    ]
    const r = await pass({ mode: 'person', person_id: leonie })
    expect(llm().notes.sort()).toEqual([
      'Léo a demandé un exemple avant de commencer la maquette.',
      'Léonie répond plus vite sur la messagerie que par mail.',
      'Pour Leonie, un vocal court marche mieux qu’un long mail.',
    ])
    expect(llm().prompts.join('\n')).not.toMatch(/avenant|note de frais|Entretien|maladie|build|MARQUE-|Léonard|\+33/)
    expect(r).toMatchObject({
      sources_matched: 7,
      sources_excluded_rubrique: 3,
      sources_sensitive: 1,
      items_sent: 3,
      llm_calls: 1,
      facts_created: 2,
      observations_rejected: { theme: 1, tiers: 1, appuis: 1 },
    })
    const rows = styles()
    expect(rows.map(x => x['fact'])).toEqual([
      'Avec Léonie : Une tâche confiée avec un exemple démarre tout de suite.',
      'Avec Léonie, la messagerie obtient une réponse plus vite que le mail.',
    ])
    for (const row of rows) {
      expect(row).toMatchObject({
        lifecycle_state: 'dormant',
        genre: 'style',
        person_id: leonie,
        auteur: 'ia:claude',
        auteur_source: 'llm',
        approuve_par_owner: 0,
        portee: 'user',
        prompt_version: 'styles-v1',
      })
    }
    // Date du plus récent des faits qui l'appuient (notes de la plus récente à la plus ancienne).
    expect(rows.find(x => String(x['fact']).includes('messagerie'))!['conversation_at']).toBe(at(3, 9))
    expect(states()).toEqual([{ state_key: `person:${leonie}`, mode: 'person', person_id: leonie, items: 3, closed: 1, facts: 2 }])
    // Second passage : rien de nouveau, rien ne repart.
    expect(await pass({ mode: 'person', person_id: leonie })).toMatchObject({ periods_known: 1, llm_calls: 0 })
  })

  it('validés, ils ne ressortent JAMAIS comme styles du propriétaire (et ceux du propriétaire ne ressortent pas pour la personne)', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const { leonie } = seedTeam()
    llm().person = [{ texte: 'Avec Léonie, la messagerie obtient une réponse plus vite que le mail.', appuis: [1, 3] }]
    live('-p/s.jsonl', monthOf(3, 14))
    await pass()
    await pass({ mode: 'person', person_id: leonie })
    const all = styles()
    expect(all.filter(x => x['person_id'] === leonie)).toHaveLength(1)
    expect(all.filter(x => x['person_id'] === null)).toHaveLength(4)
    const promoted = env.m.triage.promote({ fact_ids: all.map(x => String(x['id'])) })
    expect(promoted.promoted).toBe(5)
    const ownerTexts = all.filter(x => x['person_id'] === null).map(x => String(x['fact']))
    const personText = 'Avec Léonie, la messagerie obtient une réponse plus vite que le mail.'
    const ownerStyles = env.m.triage.stylesForInstance(env.instance, {}).items.map(i => i.text)
    // Témoin : les styles du propriétaire ressortent bien ; celui de la personne jamais.
    for (const t of ownerTexts) expect(ownerStyles).toContain(t)
    expect(ownerStyles).not.toContain(personText)
    const leonieStyles = env.m.triage.stylesForInstance(env.instance, { person_id: leonie }).items.map(i => i.text)
    expect(leonieStyles).toEqual([personText])
  })

  it('filtres de vie privée : remplacés, oubliés, archivés, sensibilité non normale, client, expirés, hors scope ou d’une autre instance ne partent jamais ; clés masquées', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const { leonie } = seedTeam()
    const remplace = seedTriaged('Léonie MARQUE-REMPLACE répond le matin.')
    setFact(remplace, { superseded: 1 })
    const oublie = seedTriaged('Léonie MARQUE-OUBLIE répond le soir.')
    setFact(oublie, { deleted_at: '2026-06-01T00:00:00.000Z' })
    const archive = seedTriaged('Léonie MARQUE-ARCHIVE préfère les listes.')
    setFact(archive, { lifecycle_state: 'archived' })
    const sensitive = seedTriaged('Léonie MARQUE-SENSITIVE préfère les appels.')
    setFact(sensitive, { sensitivity: 'sensitive' })
    const critical = seedTriaged('Léonie MARQUE-CRITICAL préfère les captures.')
    setFact(critical, { sensitivity: 'critical' })
    const client = seedTriaged('Léonie MARQUE-CLIENT répond vite au client.')
    setFact(client, { client_org_id: 'client-fictif' })
    const expire = seedTriaged('Léonie MARQUE-EXPIRE répond le dimanche.')
    setFact(expire, { expires_at: '2026-01-01T00:00:00.000Z' })
    const horsScope = seedTriaged('Léonie MARQUE-SCOPE répond en vocal.')
    setFact(horsScope, { scope_id: 'scope-illisible' })
    // Base privée d'une autre instance : jamais lisible par celle où l'on écrit.
    const other = env.m.pairAssistant({ type: 'codex' }).assistant_instance_id
    seedTriaged('Léonie MARQUE-AUTRE-INSTANCE répond par mail.', {}, other)
    // Témoin : une expiration future ne retire rien.
    const future = seedTriaged('Léonie répond aussi le samedi matin.', { conversation_at: at(3, 1) })
    setFact(future, { expires_at: '2099-01-01T00:00:00.000Z' })
    // Une clé entière, et une clé à cheval sur la coupe à 300 caractères (elle commence au caractère 273).
    // Texte écrit en base tel quel : la passe ne compte pas sur un masquage antérieur.
    const whole = seedTriaged('Léonie a collé la valeur dans le fil.', { conversation_at: at(2, 1) })
    setFact(whole, { fact: `Léonie a collé ${KEY} dans le fil.` })
    const straddle = `${pad('Léonie répond vite par message', 272)} ${KEY}`
    expect(straddle.indexOf(KEY)).toBe(273)
    const cut = seedTriaged('Léonie répond vite par message, note longue.', { conversation_at: at(2, 2) })
    setFact(cut, { fact: straddle })
    const r = await pass({ mode: 'person', person_id: leonie })
    const prompts = llm().prompts.join('\n')
    expect(prompts).not.toMatch(/MARQUE-/)
    expect(prompts).not.toContain(KEY.slice(0, 12))
    expect(r.secrets_masked).toBeGreaterThanOrEqual(2)
    expect(llm().notes).toContain('Léonie répond aussi le samedi matin.')
    expect(llm().notes.some(n => n.startsWith('Léonie a collé [secret:'))).toBe(true)
    expect(llm().notes.some(n => n.startsWith(pad('Léonie répond vite par message', 272)))).toBe(true)
    expect(r).toMatchObject({ items_sent: 6, llm_calls: 1 })
  })

  it('doublon par le sens : jamais d’une personne à l’autre (le même conseil pour Bastien s’écrit) ; pour la même personne, écarté', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const { leonie } = seedTeam()
    const bastien = env.m.listPersons().find(p => p.display_name === 'Bastien Exemple')!.id
    seedTriaged('Bastien répond plus vite sur la messagerie que par mail.', { conversation_at: at(3, 3) })
    seedTriaged('Bastien a demandé un exemple avant de commencer.', { conversation_at: at(3, 4) })
    const advice = (name: string) => `Avec ${name}, une tâche confiée par message écrit avec un exemple précis démarre tout de suite.`
    llm().person = [{ texte: advice('Léonie'), appuis: [1, 2] }]
    expect(await pass({ mode: 'person', person_id: leonie })).toMatchObject({ facts_created: 1, facts_duplicate: 0 })
    llm().person = [{ texte: advice('Bastien'), appuis: [1, 2] }]
    expect(await pass({ mode: 'person', person_id: bastien })).toMatchObject({ facts_created: 1, facts_duplicate: 0 })
    expect(styles().filter(x => x['person_id'] === bastien).map(x => x['fact'])).toEqual([advice('Bastien')])
    expect(states().find(s => s['person_id'] === bastien)).toMatchObject({ facts: 1 })
    // Témoin : la même idée pour Léonie, mots dans un autre ordre (texte différent), reste une redite.
    llm().person = [{ texte: 'Avec Léonie, une tâche confiée avec un exemple précis par message écrit démarre tout de suite.', appuis: [1, 2] }]
    expect(await pass({ mode: 'person', person_id: leonie, force: true })).toMatchObject({ facts_created: 0, facts_duplicate: 1 })
  })

  it('redite cherchée parmi les styles de la MÊME personne : un style proche d’une autre fiche, rendu le premier, ne la cache pas', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const { leonie } = seedTeam()
    const bastien = env.m.listPersons().find(p => p.display_name === 'Bastien Exemple')!.id
    seedTriaged('Bastien répond plus vite sur la messagerie que par mail.', { conversation_at: at(3, 3) })
    seedTriaged('Bastien a demandé un exemple avant de commencer.', { conversation_at: at(3, 4) })
    const phrase = 'un message écrit court obtient une réponse dans une journée'
    llm().person = [{ texte: `Avec Léonie, ${phrase}.`, appuis: [1, 2] }]
    expect(await pass({ mode: 'person', person_id: leonie })).toMatchObject({ facts_created: 1 })
    llm().person = [{ texte: `Avec Bastien, ${phrase}, sans relance.`, appuis: [1, 2] }]
    expect(await pass({ mode: 'person', person_id: bastien })).toMatchObject({ facts_created: 1 })
    // Texte proche (à un prénom près) du style de Bastien ; redite par le sens de celui de Léonie.
    llm().person = [{ texte: `Avec Léonie, ${phrase}, sans relance.`, appuis: [1, 2] }]
    expect(await pass({ mode: 'person', person_id: leonie, force: true })).toMatchObject({ facts_created: 0, facts_duplicate: 1 })
    expect(styles().filter(x => x['person_id'] === leonie).map(x => x['fact'])).toEqual([`Avec Léonie, ${phrase}.`])
  })

  it('deux fiches de même prénom : chacune son style, qui la nomme par son nom affiché entier (le prompt ne donne que le prénom)', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const exemple = env.m.createPerson({ display_name: 'Léonie Exemple' }).id
    const autre = env.m.createPerson({ display_name: 'Léonie Autre' }).id
    seedTriaged('Léonie répond plus vite sur la messagerie que par mail.', { conversation_at: at(3, 2) })
    seedTriaged('Pour Léonie, un vocal court marche mieux qu’un long mail.', { conversation_at: at(3, 5) })
    const advice = 'Avec Léonie, la messagerie obtient une réponse plus vite que le mail.'
    llm().person = [{ texte: advice, appuis: [1, 2] }]
    expect(await pass({ mode: 'person', person_id: exemple })).toMatchObject({ facts_created: 1 })
    expect(await pass({ mode: 'person', person_id: autre })).toMatchObject({ facts_created: 1, facts_duplicate: 0 })
    const of = (id: string) => styles().filter(x => x['person_id'] === id).map(x => x['fact'])
    expect(of(exemple)).toEqual([`Avec Léonie Exemple : ${advice}`])
    expect(of(autre)).toEqual([`Avec Léonie Autre : ${advice}`])
    expect(states().find(s => s['person_id'] === autre)).toMatchObject({ facts: 1 })
    expect(llm().prompts.join('\n')).not.toMatch(/Léonie (Exemple|Autre)/)
  })

  it('texte identique au fait d’une autre fiche ou sans fiche : jamais réveillé s’il est expiré ; pas d’état « facts: 0 », la relance ne repaie rien', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const { leonie } = seedTeam()
    const advice = 'Avec Léonie, un message écrit court obtient une réponse dans la journée.'
    // Fait sans fiche, au texte identique, mis à expirer (il n'est pas une source : la passe ne lit pas les expirés).
    const twin = seedTriaged(advice)
    setFact(twin, { expires_at: '2026-02-01T00:00:00.000Z' })
    llm().person = [{ texte: advice, appuis: [1, 2] }]
    const r = await pass({ mode: 'person', person_id: leonie })
    expect(r).toMatchObject({ llm_calls: 1, facts_created: 0, facts_duplicate: 1 })
    expect(llm().notes).not.toContain(advice)
    const expiry = env.db().prepare('SELECT expires_at FROM facts WHERE id = ?').get(twin) as { expires_at: string | null }
    expect(expiry.expires_at).toBe('2026-02-01T00:00:00.000Z')
    expect(states()).toEqual([])
    // Relance : la période n'est pas « connue », et la sortie gardée évite un second appel payé.
    expect(await pass({ mode: 'person', person_id: leonie })).toMatchObject({ periods_known: 0, periods_sent: 1, llm_calls: 0 })
    expect(llm().calls).toBe(1)
  })

  /** 140 notes fictives de 330 caractères qui citent Léonie : plus de STYLE_PERSON_CALL_CHARS, donc deux appels. */
  function seedLongNotes(): string {
    const leonie = env.m.createPerson({ display_name: 'Léonie Exemple' }).id
    for (let k = 1; k <= 140; k++) seedTriaged(pad(`Note ${k} : Léonie répond vite par message`, 330), { conversation_at: at(3, 1 + (k % 28), k % 60) })
    return leonie
  }
  const longAdvice = { texte: 'Avec Léonie, un message écrit court obtient une réponse dans la journée.', appuis: [1, 2] }

  it('deux appels : plafond vérifié au pire cas des DEUX avant le premier ; entre les deux pires cas, aucun appel ne part', async () => {
    const price = priceFor('openai', 'gpt-4o-mini')!
    // Pire cas de chaque appel, mesuré sur un premier passage sans plafond serré.
    env = setupTriage({ llm: new StylesLlm('openai', 'gpt-4o-mini') })
    llm().person = [longAdvice]
    await pass({ mode: 'person', person_id: seedLongNotes() })
    expect(llm().calls).toBe(2)
    const worst = llm().prompts.map(p => (estimateTokensFromChars(p.length - 1) * price.input + 1500 * price.output) / 1e6)
    const both = worst[0]! + worst[1]!
    env.close()
    // Au-dessus du pire cas d'un appel, sous celui des deux : rien ne part, rien n'est dépensé.
    env = setupTriage({ llm: new StylesLlm('openai', 'gpt-4o-mini') })
    llm().person = [longAdvice]
    const budgetUsd = Math.max(...worst) * 1.02
    expect(budgetUsd).toBeLessThan(both)
    const tight = await pass({ mode: 'person', person_id: seedLongNotes(), budgetUsd })
    expect(tight).toMatchObject({ stopped: 'budget', llm_calls: 0, spent_usd: 0, facts_created: 0 })
    expect(llm().calls).toBe(0)
    expect(states()).toEqual([])
    env.close()
    // Témoin : juste au-dessus des deux pires cas, les deux appels partent.
    env = setupTriage({ llm: new StylesLlm('openai', 'gpt-4o-mini') })
    llm().person = [longAdvice]
    const ok = await pass({ mode: 'person', person_id: seedLongNotes(), budgetUsd: both * 1.01 })
    expect(llm().calls).toBe(2)
    expect(ok).toMatchObject({ stopped: null, facts_created: 1 })
  })

  it('deux appels : un échec sur le second n’écrit rien, et la relance ne repaie pas le premier (sortie validée gardée)', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    llm().person = [longAdvice]
    const leonie = seedLongNotes()
    llm().fail = call => (call === 2 ? new Error('refus du fournisseur fictif (400)') : null)
    const first = await pass({ mode: 'person', person_id: leonie })
    expect(first).toMatchObject({ periods_failed: 1, llm_calls: 2, facts_created: 0 })
    expect(states()).toEqual([])
    expect(styles()).toEqual([])
    llm().fail = null
    const second = await pass({ mode: 'person', person_id: leonie })
    expect(second).toMatchObject({ llm_calls: 1, periods_sent: 1, facts_created: 1 })
    expect(llm().calls).toBe(3)
    // Le second appel de la relance est celui du morceau en échec.
    expect(llm().prompts[2]).toBe(llm().prompts[1])
    expect(states()).toMatchObject([{ state_key: `person:${leonie}`, facts: 1 }])
  })

  it('deux appels : une pause entre les deux n’écrit rien, et la reprise ne repaie pas le premier', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    llm().person = [longAdvice]
    const leonie = seedLongNotes()
    llm().onCall = call => {
      if (call === 1) env.m.setEnabled(false)
    }
    const first = await pass({ mode: 'person', person_id: leonie })
    expect(first).toMatchObject({ stopped: 'paused', llm_calls: 1, facts_created: 0 })
    expect(states()).toEqual([])
    env.m.setEnabled(true)
    llm().onCall = null
    const second = await pass({ mode: 'person', person_id: leonie })
    expect(second).toMatchObject({ stopped: null, llm_calls: 1, facts_created: 1 })
    expect(llm().calls).toBe(2)
  })

  it('règle n°27 : faits sources pathologiques de 16 000 caractères (aucune borne sur un fait), masqués sur une fenêtre bornée, main rendue entre deux', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    const leonie = env.m.createPerson({ display_name: 'Léonie Exemple' }).id
    // Texte écrit en base tel quel : masqué entier, un seul de ces faits bloquerait la boucle plus de 200 ms.
    for (let k = 1; k <= 20; k++) {
      const id = seedTriaged(`Note ${k} : Léonie répond vite.`, { conversation_at: at(3, k) })
      let t = `Léonie n${k} `
      while (t.length < 16_000) t += 'a-'
      setFact(id, { fact: t.slice(0, 16_000) })
    }
    llm().person = [longAdvice]
    const r = await pass({ mode: 'person', person_id: leonie })
    expect(r).toMatchObject({ items_sent: 20, llm_calls: 1 })
    expect(r.max_block_ms).toBeLessThan(200)
  }, 60_000)

  it('personne inconnue ou absente : refus clair, rien ne part', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    await expect(pass({ mode: 'person', person_id: 'personne-inconnue' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(pass({ mode: 'person' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(pass({ mode: 'autre' as 'owner' })).rejects.toMatchObject({ code: 'bad-request' })
    expect(llm().calls).toBe(0)
  })

  it('un seul travail de tri à la fois : pendant la passe styles, une autre passe styles, la passe sur les messages et le tri sont refusés', async () => {
    env = setupTriage({ llm: new StylesLlm() })
    live('-p/s.jsonl', monthOf(3, 14))
    env.m.registerStylesPass(runStylesPass)
    // Branchée, sinon elle serait refusée pour une autre raison (`not-registered`).
    env.m.registerUserMessagesPass(runUserMessagesPass)
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const original = llm().completeDetailed.bind(llm())
    llm().completeDetailed = async (opts: CompleteOptions) => {
      await gate
      return original(opts)
    }
    const running = env.m.triage.runStyles({ mode: 'owner', retryDelayMs: 0, now: NOW } as StylesPassOptions)
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(env.m.triage.runStyles({ mode: 'owner' })).rejects.toMatchObject({ code: 'running' })
    await expect(env.m.triage.runUserMessages()).rejects.toMatchObject({ code: 'running' })
    await expect(env.m.triage.start({})).rejects.toMatchObject({ code: 'running' })
    release()
    expect((await running).facts_created).toBe(4)
  })
})
