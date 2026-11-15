/**
 * AUTEUR VÉRIFIÉ dans les vrais messages, pour une IDÉE dont la transcription
 * existe encore (fichier ou archive). Pas pour une décision : l'assistant
 * reformule souvent la décision du propriétaire, et la règle n'a pas été
 * mesurée sur des décisions.
 *
 * Mesure (120 faits « idée » étiquetés à la main, hors dépôt) : les faits sont
 * des paraphrases à la troisième personne, et l'assistant reformule presque
 * toujours ce que l'utilisateur a dit. Le recouvrement de mots CONFIRME donc
 * bien une idée de l'IA (44 bonnes sur 46 décidées parmi les vraies idées,
 * seuil 0,5 et marge 0,2), mais ne reconnaît presque jamais une idée de
 * l'utilisateur (1 sur 12). D'où la règle :
 *  - assistant ≥ 0,5 et ≥ utilisateur + 0,2 → `ia:<agent>`, source `message` ;
 *  - utilisateur ≥ 0,6 et ≥ assistant + 0,3 → `owner`, source `message` (rare) ;
 *  - sinon : on garde ce qu'a dit le LLM (source `llm`).
 * Les idées du propriétaire viennent de la passe sur ses propres messages.
 *
 * Lecture bornée (taille maximale de fichier) et en cache par transcription.
 */
import { readFile, stat } from 'node:fs/promises'
import { normalizeText } from '../storage/content.js'
import { detectTranscriptFormat, parseTranscript } from '../migration/transcript-parsers.js'
import type { AuteurPreuve } from './types.js'

export const AUTHOR_IA_MIN_SCORE = 0.5
export const AUTHOR_IA_MARGIN = 0.2
export const AUTHOR_OWNER_MIN_SCORE = 0.6
export const AUTHOR_OWNER_MARGIN = 0.3
/** Au-delà, la transcription n'est pas analysée (l'analyse est synchrone : elle figerait le daemon). */
export const AUTHOR_MAX_FILE_BYTES = 8 * 1024 * 1024

const STOP = new Set(
  'pour dans avec une des les est que qui sur pas par plus aux son ses ont elle sont cette comme tout tous mais leur etre fait faire doit peut avoir utilisateur assistant cela cette ceux celle aussi tres donc alors quand sans entre apres avant'.split(
    ' ',
  ),
)

/** Mots de contenu (4 lettres et plus, sans accents ni mots vides). */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of normalizeText(text).match(/[a-z0-9]{4,}/g) ?? []) if (!STOP.has(w)) out.add(w)
  return out
}

interface Message {
  tokens: Set<string>
  ts: string | null
}

export interface TranscriptMessages {
  user: Message[]
  assistant: Message[]
}

/** Messages humains et messages de l'assistant d'une transcription, ou null (absente, trop grosse, illisible). */
export async function loadTranscriptMessages(path: string, maxBytes = AUTHOR_MAX_FILE_BYTES): Promise<TranscriptMessages | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > maxBytes) return null
    const content = await readFile(path, 'utf8')
    const format = detectTranscriptFormat(path, content.slice(0, 4096))
    if (format === 'unknown') return null
    const turns = parseTranscript(format, content)
    const out: TranscriptMessages = { user: [], assistant: [] }
    for (const turn of turns) {
      const ts = turn.ts ?? null
      if (turn.role === 'assistant') out.assistant.push({ tokens: contentTokens(turn.text), ts })
      else if (!turn.source) {
        // Seul l'humain : pas les notifications, résumés ni sorties d'outils (Turn.source).
        out.user.push({ tokens: contentTokens(turn.text), ts })
        for (const q of [...(turn.queuedBefore ?? []), ...(turn.queuedAfter ?? [])]) out.user.push({ tokens: contentTokens(q), ts })
      }
    }
    return out
  } catch {
    return null
  }
}

function best(fact: Set<string>, messages: Message[]): { score: number; ts: string | null } {
  let top = { score: 0, ts: null as string | null }
  if (fact.size === 0) return top
  for (const m of messages) {
    let common = 0
    for (const t of fact) if (m.tokens.has(t)) common++
    const score = common / fact.size
    if (score > top.score) top = { score, ts: m.ts }
  }
  return top
}

export interface AuthorJudgement {
  verdict: 'ia' | 'owner' | null
  preuve: AuteurPreuve
}

/** Juge l'auteur d'un fait d'après les messages de sa transcription. */
export function judgeAuthor(fact: string, messages: TranscriptMessages): AuthorJudgement {
  const tokens = contentTokens(fact)
  const u = best(tokens, messages.user)
  const a = best(tokens, messages.assistant)
  const round = (x: number): number => Math.round(x * 100) / 100
  if (a.score >= AUTHOR_IA_MIN_SCORE && a.score >= u.score + AUTHOR_IA_MARGIN) {
    return { verdict: 'ia', preuve: { role: 'assistant', score: round(a.score), other: round(u.score), ts: a.ts } }
  }
  if (u.score >= AUTHOR_OWNER_MIN_SCORE && u.score >= a.score + AUTHOR_OWNER_MARGIN) {
    return { verdict: 'owner', preuve: { role: 'user', score: round(u.score), other: round(a.score), ts: u.ts } }
  }
  const role = a.score >= u.score ? 'assistant' : 'user'
  return {
    verdict: null,
    preuve: { role, score: round(Math.max(a.score, u.score)), other: round(Math.min(a.score, u.score)), ts: role === 'assistant' ? a.ts : u.ts },
  }
}
