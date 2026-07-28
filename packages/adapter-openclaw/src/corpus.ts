/**
 * Memoria comme SUPPLÉMENT DE CORPUS d'OpenClaw — résolution de la cohabitation.
 *
 * Le problème : depuis 2026.4, le slot mémoire (`plugins.slots.memory`) est
 * EXCLUSIF et appartient par défaut au plugin bundlé `memory-core` (prompt
 * mémoire, budget, dreaming). Quand Memoria injecte en plus son propre bloc via
 * `before_prompt_build`, deux systèmes écrivent dans le même prompt sans se
 * connaître : double injection, budgets qui se marchent dessus, et un même fait
 * qui peut revenir sous deux formulations. C'est exactement ce que remontent les
 * retours bêta (« doublons », « blocs qui prennent beaucoup de place »).
 *
 * La résolution n'est pas de prendre le slot à `memory-core` (il faudrait
 * réimplémenter son prompt builder), mais d'utiliser le point d'extension
 * NON exclusif prévu pour ça :
 *
 *     registerMemoryCorpusSupplement('memoria', { search, get })
 *
 * `memory-core` garde le slot et fusionne les suppléments dans SON unique
 * section mémoire, avec SON budget. Memoria n'injecte plus rien elle-même :
 * elle répond à des recherches. Un seul bloc, un seul budget, plus de doublon
 * structurel.
 *
 * Bénéfice secondaire, demandé par les deux retours : le contrat `search`/`get`
 * est précisément le « index court puis détail à la demande » — `search` ne
 * renvoie que des extraits, `get` ne charge le contenu complet que si l'agent le
 * demande vraiment. Et `MemoryCorpusSearchResult` porte nativement les champs de
 * traçabilité réclamés : `provenanceLabel`, `sourceType`, `updatedAt`, `citation`.
 *
 * ⚠️ Ce module fait le SEUL import runtime de l'hôte de tout l'adaptateur
 * (`openclaw/plugin-sdk/memory-core`, entrée publique déclarée dans les
 * `exports` du paquet openclaw). L'import est dynamique et tout échec est avalé :
 * sur un hôte trop ancien, on retombe simplement sur le mode `hooks`.
 */
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sanitizeMemory, type RecallItem } from './index.js'

/** Sous-ensemble de `MemoryCorpusSearchResult` (SDK) que Memoria remplit. */
export interface CorpusSearchResult {
  corpus: string
  path: string
  title?: string
  kind?: string
  score: number
  snippet: string
  id?: string
  citation?: string
  provenanceLabel?: string
  sourceType?: string
  updatedAt?: string
}

/** Sous-ensemble de `MemoryCorpusGetResult` (SDK). */
export interface CorpusGetResult {
  corpus: string
  path: string
  title?: string
  kind?: string
  content: string
  fromLine: number
  lineCount: number
  id?: string
  provenanceLabel?: string
  sourceType?: string
  updatedAt?: string
}

export interface CorpusSupplement {
  search(params: { query: string; maxResults?: number; agentSessionKey?: string }): Promise<CorpusSearchResult[]>
  get(params: { lookup: string; fromLine?: number; lineCount?: number; agentSessionKey?: string }): Promise<CorpusGetResult | null>
}

export const CORPUS_NAME = 'memoria'

const TITLE_MAX = 72

/**
 * Libellés par type — l'agent doit voir qu'une observation n'est pas une règle.
 * En anglais comme le reste de la structure injectée (issue #1) : ces étiquettes
 * atterrissent dans le prompt, pas dans une interface humaine.
 */
const KIND_LABEL: Record<string, string> = {
  fact: 'fact',
  procedure: 'procedure',
  observation: 'observation',
}

/** Chemin pseudo-URI STABLE : sert d'identifiant de citation côté OpenClaw. */
export function corpusPath(item: RecallItem): string {
  return `memoria://${item.kind}/${item.id ?? slug(item.content)}`
}

function slug(content: string): string {
  return sanitizeMemory(content).slice(0, 40).replace(/\s+/g, '-').toLowerCase()
}

/**
 * Étiquette de provenance affichée à l'agent : d'où vient ce souvenir et de
 * quand il date. Les deux retours bêta demandent de pouvoir répondre à
 * « pourquoi ce souvenir est apparu ? » sans quitter la conversation.
 */
export function provenanceLabel(item: RecallItem): string {
  const parts = ['Memoria', KIND_LABEL[item.kind] ?? item.kind]
  if (item.created_at) parts.push(item.created_at.slice(0, 10))
  if (item.category && item.category !== 'general') parts.push(item.category)
  // La contestation passe AUSSI par la provenance : en mode corpus, c'est elle
  // que l'hôte affiche à côté de l'extrait.
  if (item.origin && item.origin !== 'extracted') parts.push(item.origin)
  if (item.revision) parts.push(`⚠ ${item.revision.kind}`)
  return parts.join(' · ')
}

/** Traduit un item de recall Memoria en résultat de corpus OpenClaw. */
export function toCorpusResult(item: RecallItem): CorpusSearchResult {
  const text = sanitizeMemory(item.content)
  return {
    corpus: CORPUS_NAME,
    path: corpusPath(item),
    title: text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text,
    kind: item.kind,
    score: item.score ?? 0,
    snippet: text,
    ...(item.id ? { id: item.id } : {}),
    citation: corpusPath(item),
    provenanceLabel: provenanceLabel(item),
    sourceType: item.kind,
    ...(item.created_at ? { updatedAt: item.created_at } : {}),
  }
}

export interface CorpusDeps {
  /** Interroge le daemon ; `null` = indisponible (daemon arrêté, timeout…). */
  recall(query: string, limit: number): Promise<RecallItem[] | null>
  /** Plancher relatif au meilleur score (anti-bruit), 0 = désactivé. */
  relevanceFloor?: number
  /**
   * Signal d'usage RÉEL, appelé quand l'agent demande le contenu complet d'un
   * souvenir. C'est le seul signal automatique non spéculatif du parcours :
   * `search` ne prouve rien (l'hôte remonte des extraits que l'agent n'a
   * peut-être pas lus), tandis que `get` est une demande explicite de détail.
   * Sans lui, la boucle de feedback dépendrait entièrement de la discipline de
   * l'agent à appeler `memoria_feedback` — et resterait vide en pratique.
   */
  onUsed?(factId: string): void
}

/** Nb d'entrées conservées pour résoudre `get` sans re-solliciter le daemon. */
const LOOKUP_CACHE_MAX = 256

/**
 * Construit le supplément. `search` interroge le daemon ; `get` résout d'abord
 * dans le cache alimenté par les `search` précédents (le parcours réel est
 * toujours search → get), et ne retombe sur le daemon qu'en dernier recours.
 */
export function createMemoriaCorpus(deps: CorpusDeps): CorpusSupplement {
  const cache = new Map<string, RecallItem>()

  const remember = (item: RecallItem): void => {
    cache.set(corpusPath(item), item)
    if (item.id) cache.set(item.id, item)
    while (cache.size > LOOKUP_CACHE_MAX) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  return {
    async search({ query, maxResults }) {
      const q = query?.trim()
      if (!q) return []
      const items = await deps.recall(q, clamp(maxResults ?? 12, 1, 20))
      if (!items || items.length === 0) return []

      const ranked = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      const floor = deps.relevanceFloor ?? 0
      const top = ranked[0]?.score ?? 0
      const kept = floor > 0 && top > 0 ? ranked.filter(i => (i.score ?? 0) >= top * floor) : ranked

      const out: CorpusSearchResult[] = []
      for (const item of kept) {
        if (!sanitizeMemory(item.content)) continue
        remember(item)
        out.push(toCorpusResult(item))
      }
      return out
    },

    async get({ lookup }) {
      const key = lookup?.trim()
      if (!key) return null
      let item = cache.get(key)
      if (!item) {
        // `get` sur une entrée jamais vue en recherche : on retente une requête
        // à partir du lookup, plutôt que de renvoyer null sur un souvenir réel.
        const items = await deps.recall(key.replace(/^memoria:\/\/[^/]+\//, '').replace(/-/g, ' '), 5)
        item = items?.find(i => corpusPath(i) === key || i.id === key)
        if (item) remember(item)
      }
      if (!item) return null
      // L'agent lit ce souvenir en entier : signal d'usage confirmé.
      if (item.id) deps.onUsed?.(item.id)
      const content = sanitizeMemory(item.content)
      return {
        corpus: CORPUS_NAME,
        path: corpusPath(item),
        title: content.length > TITLE_MAX ? `${content.slice(0, TITLE_MAX - 1)}…` : content,
        kind: item.kind,
        content,
        fromLine: 1,
        lineCount: 1,
        ...(item.id ? { id: item.id } : {}),
        provenanceLabel: provenanceLabel(item),
        sourceType: item.kind,
        ...(item.created_at ? { updatedAt: item.created_at } : {}),
      }
    },
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** Spécifier en variable : TypeScript ne tente pas de résoudre l'hôte à la compilation. */
const SDK_ENTRY = 'openclaw/plugin-sdk/memory-core'
const SDK_SUBPATH = 'dist/plugin-sdk/memory-core.js'

/**
 * Candidats d'import du SDK, du plus propre au plus débrouillard.
 *
 * ⚠ Le spécifieur NU ne résout PAS depuis un plugin : celui-ci vit dans
 * `~/.openclaw/extensions/memoria` (ou un lien vers le dépôt), et Node résout
 * depuis CE dossier — où `openclaw` n'est pas un voisin. OpenClaw étant
 * installé globalement, aucun `node_modules` de la chaîne ne le contient.
 * Vérifié : `require.resolve('openclaw/plugin-sdk/memory-core')` échoue en
 * MODULE_NOT_FOUND depuis le dossier de l'adaptateur.
 *
 * On se rabat donc sur le process HÔTE : le plugin s'exécute DANS OpenClaw,
 * donc `process.argv[1]` pointe son point d'entrée
 * (`…/lib/node_modules/openclaw/openclaw.mjs`). On remonte jusqu'à la racine du
 * paquet et on importe le fichier par chemin absolu.
 *
 * Sans ça, le mode corpus échouait silencieusement et AUCUNE mémoire n'était
 * injectée — pire que de ne pas l'activer du tout.
 */
export function sdkCandidates(argv1: string | undefined): string[] {
  const out = [SDK_ENTRY]
  if (!argv1) return out
  let dir = argv1.endsWith('.mjs') || argv1.endsWith('.js') ? dirname(argv1) : argv1
  // Remonte au plus 6 niveaux à la recherche de la racine du paquet openclaw.
  for (let i = 0; i < 6 && dir && dir !== '/'; i++) {
    if (basename(dir) === 'openclaw') {
      out.push(pathToFileURL(join(dir, SDK_SUBPATH)).href)
      break
    }
    dir = dirname(dir)
  }
  return out
}

/**
 * Enregistre le supplément auprès de l'hôte. Retourne `false` si l'hôte
 * n'expose pas l'API (version antérieure à 2026.4, ou build sans memory-core) —
 * l'appelant doit alors rester en mode `hooks`.
 */
export async function registerCorpusSupplement(
  supplement: CorpusSupplement,
  warn: (m: string) => void,
): Promise<boolean> {
  const tried: string[] = []
  for (const specifier of sdkCandidates(process.argv[1])) {
    try {
      const sdk = (await import(/* @vite-ignore */ specifier)) as {
        registerMemoryCorpusSupplement?: (pluginId: string, s: CorpusSupplement) => void
      }
      if (typeof sdk.registerMemoryCorpusSupplement !== 'function') {
        tried.push(`${specifier} : pas de registerMemoryCorpusSupplement`)
        continue
      }
      sdk.registerMemoryCorpusSupplement(CORPUS_NAME, supplement)
      return true
    } catch (err) {
      tried.push(`${specifier} : ${(err as Error).message}`)
    }
  }
  warn(`mode corpus indisponible — ${tried.join(' ; ')}. Bascule injectionMode sur « hooks ».`)
  return false
}
