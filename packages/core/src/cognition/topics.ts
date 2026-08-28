/**
 * Couche TOPICS (thèmes, couche 14, bucket B async) — ENTITÉ-first.
 *
 * Produit : chaque fait est rangé dans un ou plusieurs SUJETS lisibles
 * (« Déploiement Vercel », « Client Transport Rino ») → l'utilisateur voit OÙ
 * un souvenir va, et filtre par thème. 0 LLM par défaut : le label dérive des
 * ENTITÉS déjà extraites par la couche graph (`fact_entities`/`entities`) et,
 * à défaut, des mots-clés saillants du fait.
 *
 * Réutilise les tables `topics` + `fact_topics` (content-schema). Une migration
 * additive (versions 20-29, sans collision avec cognition ≥10) ajoute les
 * colonnes de gestion (slug, fact_count, updated_at) + une jointure
 * topic_entities pour un matching robuste.
 */
import type { Database } from 'better-sqlite3'
import type { ContentStore, FactRow } from '../storage/content.js'
import { runMigrations, type Migration } from '../storage/migrations.js'
import { fromJsonArray, newId, nowISO, toJson } from '../util.js'
import { normalizeText, isContentWord } from '../storage/content.js'
import type { LlmProvider } from '../llm/provider.js'

export interface TopicSummary {
  id: string
  name: string
  fact_count: number
  importance_score: number
  keywords: string[]
}

export interface AssignResult {
  topic_ids: string[]
  topic_names: string[]
  created: boolean
}

/** Une arête du graphe des thèmes : deux thèmes liés + ce qui les relie. */
export interface TopicRelation {
  a: string
  b: string
  /** Poids = 2×faits partagés + entités partagées (fortes comptées double). */
  weight: number
  shared_facts: number
  shared_entities: number
  /** Quelques entités communes lisibles (« liés par : Néto, AutoCare »). */
  via: string[]
}

export interface TopicGraph {
  nodes: TopicSummary[]
  edges: TopicRelation[]
}

export const topicMigrations: Migration[] = [
  {
    version: 20,
    name: 'topics-management-columns',
    up(db) {
      // Colonnes ajoutées de façon défensive (la table topics vient du tronc).
      const cols = (db.pragma('table_info(topics)') as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('slug')) db.exec("ALTER TABLE topics ADD COLUMN slug TEXT DEFAULT ''")
      if (!cols.includes('fact_count')) db.exec('ALTER TABLE topics ADD COLUMN fact_count INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('updated_at')) db.exec("ALTER TABLE topics ADD COLUMN updated_at TEXT DEFAULT ''")
      db.exec(`
        CREATE TABLE IF NOT EXISTS topic_entities (
          topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          entity_id TEXT NOT NULL,
          PRIMARY KEY (topic_id, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_topic_entities_entity ON topic_entities(entity_id);
      `)
    },
  },
  {
    version: 21,
    name: 'topics-anchor-entity',
    up(db) {
      // L'entité « ancre » = celle qui NOMME le thème. Un fait qui la porte
      // rejoint le thème même s'il ne partage rien d'autre — sans ça, chaque
      // fait « devis GCSMS » créait son propre thème « GCSMS » (89 % de thèmes
      // à 1 fait sur la mémoire réelle). Rétro-remplissage des thèmes existants :
      // le libellé heuristique commence toujours par le nom de l'entité dominante.
      const cols = (db.pragma('table_info(topics)') as Array<{ name: string }>).map(c => c.name)
      if (!cols.includes('anchor_entity_id')) db.exec("ALTER TABLE topics ADD COLUMN anchor_entity_id TEXT DEFAULT ''")
      const hasEntities = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entities'").get()
      if (hasEntities) {
        db.exec(`
          UPDATE topics SET anchor_entity_id = COALESCE((
            SELECT te.entity_id FROM topic_entities te JOIN entities e ON e.id = te.entity_id
            WHERE te.topic_id = topics.id AND instr(lower(topics.name), lower(e.name)) = 1
            ORDER BY length(e.name) DESC LIMIT 1
          ), '') WHERE anchor_entity_id = ''
        `)
      }
    },
  },
]

/**
 * Sigles-unités et bruit d'ALLCAPS qui ne nomment rien (« Environ GB »,
 * « Token OK », « Memoria AM » sur la mémoire réelle) : jamais un libellé, jamais
 * une ancre de thème. Comparaison en majuscules.
 */
const LABEL_NOISE = new Set([
  'GB', 'MB', 'KB', 'TB', 'GO', 'MO', 'KO', 'TO', 'RAM', 'CPU', 'GPU', 'SSD', 'HDD',
  'API', 'URL', 'URI', 'HTTP', 'HTTPS', 'ID', 'UI', 'UX', 'OK', 'KO', 'AM', 'PM',
  'JSON', 'CSV', 'PDF', 'PNG', 'JPG', 'JPEG', 'MP4', 'MP3', 'HTML', 'CSS', 'SQL',
  'USD', 'EUR', 'BRL', 'TTC', 'HT', 'TVA', 'KM', 'CM', 'MM', 'MS', 'FPS', 'MHZ', 'GHZ',
])

/** Mots vides FR/EN à exclure des keywords de thème. */
const STOPWORDS = new Set([
  'avec', 'pour', 'dans', 'sur', 'les', 'des', 'une', 'que', 'qui', 'est', 'son', 'sa', 'ses', 'par',
  'plus', 'fait', 'avoir', 'etre', 'cette', 'cet', 'aux', 'leur', 'the', 'and', 'for', 'with', 'that',
  'this', 'from', 'are', 'was', 'has', 'have', 'not', 'utilisateur', 'preference', 'doit', 'peut',
])

/** Priorité de typage pour choisir l'entité « dominante » d'un fait. */
const TYPE_RANK: Record<string, number> = { person: 5, company: 4, project: 4, client: 4, place: 3, tool: 2, concept: 1 }

export function ensureTopicSchema(db: Database): void {
  runMigrations(db, topicMigrations)
}

export function topicKeywords(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(w => w.length > 3 && !STOPWORDS.has(w) && isContentWord(w))
}

/**
 * Mêmes mots-clés, mais TELS QU'ÉCRITS dans le fait (accents, majuscules).
 *
 * POURQUOI : `topicKeywords` passe par `normalizeText`, qui met en minuscules
 * ET retire les accents — c'est ce qu'il faut pour comparer deux faits, jamais
 * pour NOMMER un thème. C'est de là que venaient « Prefere », « Neto » et
 * « Boitier » : le libellé était fabriqué avec des mots déjà mutilés, et aucun
 * rafistolage de casse ne pouvait rendre l'accent perdu.
 *
 * Les mots-outils de libellé sont écartés ici (voir LABEL_STOPWORDS) : ils font
 * des noms de sujet qui commencent par une préposition.
 */
export function topicKeywordSurfaces(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of text.split(/[^\p{L}\p{N}_-]+/u)) {
    if (token === '') continue
    const norm = fold(token)
    if (norm.length <= 3 || STOPWORDS.has(norm) || LABEL_STOPWORDS.has(norm) || !isContentWord(norm)) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(token)
  }
  return out
}

/**
 * Mots de tête retirés d'un libellé de thème, dans les 5 langues de l'interface :
 * articles, puis prépositions courantes. « Le Memoria CLI » et « Sur Hello-Primo
 * Vercel » sont des débuts de phrase ; « Memoria CLI » et « Hello-Primo Vercel »
 * sont des noms de sujet. Comparaison sans accent ni casse.
 */
const LEADING_FILLERS = new Set([
  // articles — français
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd',
  // articles — anglais
  'the', 'a', 'an',
  // articles — espagnol
  'el', 'los', 'las', 'unos', 'unas',
  // articles — portugais
  'o', 'os', 'as', 'um', 'uma', 'uns', 'umas',
  // articles — allemand
  'der', 'die', 'das', 'ein', 'eine', 'einen', 'dem', 'den',
  // prépositions de tête (français)
  'sur', 'dans', 'avec', 'pour', 'chez', 'par', 'sous', 'vers', 'au', 'aux', 'en', 'a',
  // prépositions de tête (autres langues)
  'on', 'in', 'at', 'with', 'for', 'about', 'con', 'para', 'por', 'sobre', 'em', 'com',
  'auf', 'mit', 'fur', 'uber',
])

/**
 * Mots-outils EXCLUS DES LIBELLÉS seulement (jamais du matching : STOPWORDS
 * sert au Jaccard et aux mots-clés stockés, y toucher déplacerait des faits).
 *
 * POURQUOI : sans eux, le libellé heuristique attrape le premier mot « plein »
 * venu et le thème s'appelle « Part Tarif Horaire » ou « Nouveau Boitier Chez ».
 * Un nom de sujet ne commence pas par une préposition.
 */
const LABEL_STOPWORDS = new Set([
  'chez', 'sans', 'sous', 'vers', 'dont', 'quand', 'aussi', 'donc', 'alors', 'ainsi', 'encore',
  'toujours', 'jamais', 'tres', 'bien', 'faut', 'part', 'plutot', 'depuis', 'entre', 'apres',
  'avant', 'pendant', 'comme', 'meme', 'tout', 'tous', 'toute', 'toutes', 'celui', 'celle',
  'ceux', 'elles', 'nous', 'vous', 'leurs', 'notre', 'votre', 'chaque', 'autre', 'autres',
  'then', 'than', 'when', 'also', 'still', 'always', 'never', 'very', 'well', 'must', 'should',
  'would', 'could', 'into', 'over', 'under', 'about', 'after', 'before', 'because', 'their',
])

/**
 * Particules qui peuvent appartenir à un NOM plutôt qu'introduire une phrase :
 * « De Souza », « Du Bellay », « D'Artagnan ». Les retirer rendrait le nom
 * indistinct — le défaut même qu'on corrige.
 */
const NAME_PARTICLES = new Set(['de', 'd', 'du'])

/**
 * Faut-il GARDER ce mot de tête ? Oui si c'est une particule de nom suivie
 * d'une majuscule (« De Souza contrat »). « De la mairie… », suivi d'une
 * minuscule, reste un début de phrase et se retire.
 */
function keepsParticle(head: string, rest: string): boolean {
  return NAME_PARTICLES.has(fold(head)) && /^\p{Lu}/u.test(rest)
}

/** Minuscule sans accent — pour comparer un mot à une liste, jamais pour l'afficher. */
function fold(word: string): string {
  return normalizeText(word)
}

/** Un sigle garde sa casse : CLI, API, MCP, RSMA, GCSMS. */
function isAcronym(word: string): boolean {
  return word.length >= 2 && word === word.toUpperCase() && /\p{Lu}/u.test(word)
}

/** Casse interne (JamBoard, PixConsent, macOS) : jamais retouchée. */
function hasInnerCase(word: string): boolean {
  return /\p{Ll}\p{Lu}/u.test(word) || /^\p{Ll}+\p{Lu}/u.test(word)
}

/** Majuscule initiale, frontière Unicode (« neto » → « Néto », pas « NÉTo »). */
function upperFirst(word: string): string {
  return word.replace(/^\p{L}/u, c => c.toUpperCase())
}

/**
 * NETTOIE un libellé de thème : article de tête retiré, casse de PHRASE (et
 * non Title Case), accents et noms propres intacts, longueur bornée.
 *
 * POURQUOI cette fonction existe (et est exportée) : sur la mémoire réelle les
 * thèmes s'appelaient « Le Memoria CLI », « Part Tarif Horaire »,
 * « Prefere Appelle Neto » — article de tête gardé, chaque mot re-capitalisé
 * (un prénom devient indistinct d'un mot commun), et le Title Case n'existe pas
 * en français. Elle est le SEUL endroit qui décide de la forme d'un libellé :
 * heuristique et LLM y passent tous les deux, et un futur
 * `memoria retitle-topics` pourra la réutiliser sur les thèmes déjà en base.
 *
 * `source` = le texte du fait d'origine, quand on l'a. Il sert d'arbitre pour
 * la casse : un mot n'est démajusculé QUE s'il apparaît aussi en minuscules
 * dans le fait. « Hélène Rey » (jamais écrit en minuscules) reste intact,
 * « Tarif Horaire » (écrit « tarif horaire » dans le fait) redevient minuscule.
 */
export function cleanTopicLabel(raw: string, opts: { source?: string; maxWords?: number } = {}): string {
  const maxWords = opts.maxWords ?? 4
  const source = opts.source ?? ''
  const lowerSource = source.toLowerCase()

  let text = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  // Ponctuation et guillemets de bord (le LLM rend parfois « "Titre." »).
  text = text.replace(/^[\s"'“”«»*#\-–—:.]+/u, '').replace(/[\s"'“”«»*#\-–—:;,.!?]+$/u, '')
  if (text === '') return raw.trim()

  // Article de tête, y compris élidé (« L'application » → « application »).
  // Deux passes au plus : « De la mairie » → « mairie ».
  for (let pass = 0; pass < 2; pass++) {
    const elided = text.match(/^(\p{L}+)['’]\s*(?=\p{L})/u)
    if (elided && LEADING_FILLERS.has(fold(elided[1] ?? ''))) {
      const rest = text.slice(elided[0].length)
      if (!keepsParticle(elided[1] ?? '', rest)) {
        text = rest
        continue
      }
    }
    const parts = text.split(' ')
    if (parts.length > 1 && LEADING_FILLERS.has(fold(parts[0] ?? ''))) {
      const rest = parts.slice(1).join(' ')
      if (!keepsParticle(parts[0] ?? '', rest)) {
        text = rest
        continue
      }
    }
    break
  }

  const words = text.split(' ').filter(w => w !== '')
  if (words.length === 0) return raw.trim()

  const kept = words.slice(0, maxWords).map((word, i) => {
    if (i === 0) {
      // Un sigle ou une casse interne (iPhone, macOS) ne se « corrige » pas.
      return isAcronym(word) || hasInnerCase(word) ? word : upperFirst(word)
    }
    if (isAcronym(word) || hasInnerCase(word)) return word
    if (!/^\p{Lu}/u.test(word)) return word
    // Démajusculer SEULEMENT si le fait l'écrit aussi en minuscules : c'est la
    // preuve que ce n'est pas un nom propre.
    return lowerSource.includes(word.toLowerCase()) && !source.includes(word) ? word.toLowerCase() : word
  })

  return kept.join(' ').slice(0, 60).trim()
}

interface EntityInfo {
  id: string
  name: string
  type: string
  mention_count: number
}

/** Entité qui ne peut ni nommer un thème ni servir d'ancre (sigle-unité, bruit). */
function isLabelNoise(name: string): boolean {
  const upper = name.toUpperCase()
  if (LABEL_NOISE.has(upper)) return true
  return name === upper && name.length <= 2 // « OK », « AM », « X »
}

/**
 * Vrai si le nom n'apparaît dans le fait QU'EN TÊTE DE PHRASE : un mot courant
 * capitalisé par la ponctuation (« Environ 12 GB… », « Token expiré… ») que
 * l'heuristique d'entités prend pour un nom propre. On ne le retire pas — on le
 * DÉCLASSE : il ne nomme le thème que faute de mieux, ou s'il est déjà connu
 * ailleurs (mention_count ≥ 2 → c'est un vrai nom, « Néto prend son café… »).
 */
function isSentenceInitialOnly(name: string, text: string): boolean {
  if (name.includes(' ')) return false
  if (name === name.toUpperCase()) return false // sigle
  if (/\p{Ll}\p{Lu}/u.test(name)) return false // CamelCase (JamBoard)
  let idx = text.indexOf(name)
  if (idx === -1) return false
  while (idx !== -1) {
    const before = text.slice(0, idx).trimEnd()
    const atStart = before === '' || /[.!?:;]$/.test(before)
    if (!atStart) return false
    idx = text.indexOf(name, idx + name.length)
  }
  return true
}

export interface TopicEngineOptions {
  store: ContentStore
  llm?: LlmProvider | null
}

export class TopicEngine {
  private readonly store: ContentStore
  private llm: LlmProvider | null

  constructor(opts: TopicEngineOptions) {
    this.store = opts.store
    this.llm = opts.llm ?? null
    ensureTopicSchema(this.store.db)
  }

  /** Un LLM de libellé est-il branché ? */
  get hasLlm(): boolean {
    return this.llm !== null
  }

  /** Branche le LLM après coup (cache par store côté Memoria — voir CognitionEngine.setLlm). */
  setLlm(llm: LlmProvider | null): void {
    this.llm = llm
  }

  private get db(): Database {
    return this.store.db
  }

  /** Entités d'un fait (via la jointure du graphe), bruit « fichier/chemin » exclu. */
  private entitiesOf(factId: string): EntityInfo[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.name, e.type, e.mention_count FROM fact_entities fe
         JOIN entities e ON e.id = fe.entity_id WHERE fe.fact_id = ? ORDER BY e.rowid`,
      )
      .all(factId) as EntityInfo[]
    return rows.filter(e => !isFileLike(e.name))
  }

  /**
   * Entités candidates à NOMMER le thème (et donc à l'ancrer), les meilleures
   * d'abord : bruit exclu, puis rang de type, puis récurrence (une entité vue
   * souvent consolide mieux qu'une entité d'un jour), les mots de tête de phrase
   * en dernier. Retourne [] si tout est bruit.
   */
  private labelCandidates(entities: EntityInfo[], text: string): EntityInfo[] {
    const demoted = (e: EntityInfo): number => (e.mention_count < 2 && isSentenceInitialOnly(e.name, text) ? 1 : 0)
    return entities
      .filter(e => !isLabelNoise(e.name))
      .map((e, i) => ({ e, i }))
      .sort((a, b) =>
        demoted(a.e) - demoted(b.e) ||
        (TYPE_RANK[b.e.type] ?? 0) - (TYPE_RANK[a.e.type] ?? 0) ||
        b.e.mention_count - a.e.mention_count ||
        a.i - b.i,
      )
      .map(x => x.e)
  }

  /** Rang de typage d'une entité (pour préférer person/company/project au matching). */
  private highRank(e: EntityInfo): boolean {
    return (TYPE_RANK[e.type] ?? 0) >= 4
  }

  /**
   * Range UN fait dans un (ou plusieurs) topic(s). Idempotent, 0 LLM par défaut.
   * Match si le fait porte l'entité ANCRE d'un thème (celle qui le nomme), OU
   * ≥2 entités partagées, OU 1 entité forte, OU Jaccard de keywords > 0.4.
   */
  async assignFact(factId: string): Promise<AssignResult> {
    const fact = this.store.getFact(factId)
    if (!fact || fact.superseded) return { topic_ids: [], topic_names: [], created: false }

    const entities = this.entitiesOf(factId)
    const keywords = topicKeywords(fact.fact).slice(0, 12)

    // 1) Candidat par entités partagées. Le bruit (GB, API, OK…) ne compte pas :
    //    deux faits qui ne partagent qu'une unité ne parlent pas du même sujet.
    //    Ancre partagée d'abord (c'est LE signal de consolidation), puis le
    //    nombre d'entités communes.
    let topicId: string | null = null
    const matchable = entities.filter(e => !isLabelNoise(e.name))
    if (matchable.length > 0) {
      const placeholders = matchable.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT te.topic_id, COUNT(*) AS shared,
                  MAX(CASE WHEN e.type IN ('person','company','project','client') THEN 1 ELSE 0 END) AS strong,
                  MAX(CASE WHEN t.anchor_entity_id = te.entity_id THEN 1 ELSE 0 END) AS anchor
           FROM topic_entities te
           JOIN entities e ON e.id = te.entity_id
           JOIN topics t ON t.id = te.topic_id
           WHERE te.entity_id IN (${placeholders})
           GROUP BY te.topic_id ORDER BY anchor DESC, shared DESC`,
        )
        .all(...matchable.map(e => e.id)) as Array<{ topic_id: string; shared: number; strong: number; anchor: number }>
      const hit = rows.find(r => r.anchor === 1 || r.shared >= 2 || r.strong === 1)
      if (hit) topicId = hit.topic_id
    }

    // 2) Sinon, candidat par recouvrement de keywords (Jaccard > 0.4).
    if (!topicId && keywords.length > 0) {
      const all = this.db.prepare('SELECT id, keywords FROM topics').all() as Array<{ id: string; keywords: string }>
      const set = new Set(keywords)
      let best: { id: string; score: number } | null = null
      for (const t of all) {
        const tk = new Set(fromJsonArray(t.keywords))
        if (tk.size === 0) continue
        const inter = [...set].filter(k => tk.has(k)).length
        const union = new Set([...set, ...tk]).size
        const score = union > 0 ? inter / union : 0
        if (score > 0.4 && (!best || score > best.score)) best = { id: t.id, score }
      }
      if (best) topicId = best.id
    }

    let created = false
    if (!topicId) {
      topicId = await this.createTopic(fact, entities, keywords)
      created = true
    }

    // Lien fact↔topic + entités du topic + recompte.
    this.db.prepare('INSERT OR IGNORE INTO fact_topics (fact_id, topic_id) VALUES (?, ?)').run(factId, topicId)
    const linkEnt = this.db.prepare('INSERT OR IGNORE INTO topic_entities (topic_id, entity_id) VALUES (?, ?)')
    for (const e of entities) linkEnt.run(topicId, e.id)
    this.recompute(topicId, keywords)

    const name = (this.db.prepare('SELECT name FROM topics WHERE id = ?').get(topicId) as { name: string }).name
    return { topic_ids: [topicId], topic_names: [name], created }
  }

  private async createTopic(fact: { id: string; fact: string; scope_id: string }, entities: EntityInfo[], keywords: string[]): Promise<string> {
    const candidates = this.labelCandidates(entities, fact.fact)
    let label = cleanTopicLabel(this.heuristicLabel(candidates, fact.fact), { source: fact.fact })
    // LLM SEULEMENT si le label heuristique est faible (1 mot générique) et provider fourni.
    if (this.llm && label.split(' ').length < 2) {
      try {
        if (await this.llm.isAvailable()) {
          const raw = await this.llm.complete({
            // Le prompt imposait « Title Case » : ça n'existe pas en français,
            // et ça transformait « tarif horaire » en « Tarif Horaire ». On
            // demande un NOM DE SUJET, en casse de phrase, sans article, et on
            // interdit explicitement de retoucher l'orthographe des noms.
            system:
              'Name the SUBJECT of this memory as a short noun phrase of 2 to 4 words, in the same language as the memory. ' +
              'No leading article. Sentence case: capitalise only the first word, proper nouns and acronyms. ' +
              'Keep the exact spelling, accents and capitalisation of names and acronyms (Néto, JamBoard, CLI). ' +
              'A subject name, not a sentence fragment. Reply with the title ONLY.',
            prompt: fact.fact,
            maxTokens: 16,
            temperature: 0.2,
          })
          const cleaned = raw.trim().replace(/^["'#\s]+|["'.\s]+$/g, '').slice(0, 60)
          // Même nettoyage que l'heuristique : un LLM qui ignore la consigne
          // (Title Case, article de tête) ne salit pas la base pour autant.
          if (isUsableLlmLabel(cleaned)) label = cleanTopicLabel(cleaned, { source: fact.fact })
          else if (cleaned !== '') {
            // Pas de mort silencieuse : on DIT qu'on a jeté la réponse du modèle.
            console.warn(`[memoria:topics] libellé LLM inutilisable (fait ${fact.id}) — heuristique : ${cleaned.slice(0, 40)}`)
          }
        }
      } catch (err) {
        console.warn(`[memoria:topics] libellé LLM en échec (fait ${fact.id}) — heuristique :`, (err as Error).message)
      }
    }
    // Jamais deux thèmes du même nom : un libellé déjà pris désigne le thème
    // existant (c'est le filet de sécurité de la consolidation par ancre).
    const slug = topicSlug(label)
    const same = this.db.prepare('SELECT id FROM topics WHERE slug = ?').get(slug) as { id: string } | undefined
    if (same) return same.id

    const id = newId()
    const ts = nowISO()
    this.db
      .prepare(
        `INSERT INTO topics (id, name, scope_id, sensitivity, importance_score, keywords, slug, fact_count, created_at, updated_at, anchor_entity_id)
         VALUES (?, ?, ?, 'normal', 0, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, label, fact.scope_id, toJson(keywords.slice(0, 8)), slug, ts, ts, candidates[0]?.id ?? '')
    return id
  }

  /**
   * Label lisible sans LLM. Trois sources, dans cet ordre :
   *  1. l'entité dominante (déjà triée par labelCandidates) + un qualificatif ;
   *  2. faute d'entité extraite, les NOMS PROPRES et sigles du fait — c'est le
   *     rattrapage de ce que la couche graph n'a pas vu, et ça donne un vrai
   *     nom de sujet (« Néto ») au lieu d'un bout de phrase
   *     (« Prefere Appelle Neto ») ;
   *  3. à défaut, deux mots-clés saillants (« Tarif horaire »). DEUX et pas
   *     trois : au-delà, le libellé redevient un extrait de phrase.
   *
   * Dans tous les cas les mots viennent du texte D'ORIGINE : accents et casse
   * des noms propres intacts. La mise en forme finale est faite une seule fois,
   * par `cleanTopicLabel`.
   */
  private heuristicLabel(candidates: EntityInfo[], source: string): string {
    // Une entité qui n'apparaît qu'EN TÊTE DE PHRASE est le plus souvent un mot
    // commun capitalisé par la ponctuation, que l'extracteur a pris pour une
    // entité (« Préfère qu'on l'appelle Néto » donnait « Néto Préfère »). Elle
    // ne sert donc de libellé QUE si rien de mieux n'existe — sinon un fait qui
    // commence par un vrai nom (« Néto prend son café… ») perdrait son sujet.
    const strong = candidates.filter(e => !(e.mention_count < 2 && isSentenceInitialOnly(e.name, source)))
    const usable = strong.length > 0 ? strong : candidates
    const dominant = usable[0]
    if (dominant) {
      const second = usable[1]
      return second ? `${dominant.name} ${second.name}` : dominant.name
    }
    const surfaces = topicKeywordSurfaces(source)
    const names = surfaces.filter(w => looksLikeName(w, source))
    if (names.length > 0) return names.slice(0, 2).join(' ')
    if (surfaces.length > 0) return surfaces.slice(0, 2).join(' ')
    return 'Divers'
  }

  /** Recompte fact_count + importance + fusionne les keywords. */
  private recompute(topicId: string, extraKeywords: string[]): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM fact_topics WHERE topic_id = ?').get(topicId) as { c: number }).c
    if (count === 0) {
      this.db.prepare('DELETE FROM topics WHERE id = ?').run(topicId)
      return
    }
    // récence : dernier fait du topic
    const last = this.db
      .prepare(
        `SELECT MAX(f.created_at) AS m FROM fact_topics ft JOIN facts f ON f.id = ft.fact_id WHERE ft.topic_id = ?`,
      )
      .get(topicId) as { m: string | null }
    const ageDays = last.m ? Math.max(0, (Date.now() - Date.parse(last.m)) / 86_400_000) : 999
    const recency = Math.exp((-Math.LN2 * ageDays) / 120)
    const importance = count * (0.5 + 0.5 * recency)

    const existing = new Set(fromJsonArray((this.db.prepare('SELECT keywords FROM topics WHERE id = ?').get(topicId) as { keywords: string }).keywords))
    for (const k of extraKeywords) existing.add(k)
    this.db
      .prepare('UPDATE topics SET fact_count = ?, importance_score = ?, keywords = ?, updated_at = ? WHERE id = ?')
      .run(count, importance, toJson([...existing].slice(0, 12)), nowISO(), topicId)
  }

  /** Range tous les faits actifs sans topic (post-capture async + rattrapage boot). */
  async assignPending(limit = 200): Promise<number> {
    const pending = this.db
      .prepare(
        `SELECT f.id FROM facts f
         WHERE f.superseded = 0
           AND NOT EXISTS (SELECT 1 FROM fact_topics ft WHERE ft.fact_id = f.id)
         ORDER BY f.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>
    let done = 0
    for (const row of pending) {
      const r = await this.assignFact(row.id)
      if (r.topic_ids.length > 0) done++
    }
    return done
  }

  listTopics(opts: { minFacts?: number } = {}): TopicSummary[] {
    const min = opts.minFacts ?? 1
    const rows = this.db
      .prepare('SELECT id, name, fact_count, importance_score, keywords FROM topics WHERE fact_count >= ? ORDER BY importance_score DESC')
      .all(min) as Array<{ id: string; name: string; fact_count: number; importance_score: number; keywords: string }>
    return rows.map(r => ({ ...r, keywords: fromJsonArray(r.keywords) }))
  }

  /**
   * Graphe des thèmes : deux thèmes sont LIÉS s'ils partagent des faits (signal
   * fort : un même souvenir range dans deux thèmes) ou des entités (Néto, un
   * client, un projet apparaissent dans les deux). C'est le « où voir les
   * relations entre thèmes » du panneau Réglages/Thèmes — purement lecture, 0 LLM.
   */
  relations(opts: { minFacts?: number; minWeight?: number; topNodes?: number; maxEdges?: number } = {}): TopicGraph {
    // On borne le graphe pour qu'il reste LISIBLE : seuls les thèmes les plus
    // importants (déjà triés par importance) entrent dans la carte, et on plafonne
    // le nombre d'arêtes (les plus fortes d'abord). Sans ça, une grosse mémoire
    // produit des centaines d'arêtes illisibles.
    const topNodes = opts.topNodes ?? 28
    const maxEdges = opts.maxEdges ?? 70
    const nodes = this.listTopics({ minFacts: opts.minFacts ?? 2 }).slice(0, topNodes)
    const keep = new Set(nodes.map(n => n.id))
    const minWeight = opts.minWeight ?? 1

    // 1) faits partagés (a < b pour ne compter chaque paire qu'une fois)
    const sharedFacts = this.db
      .prepare(
        `SELECT ft1.topic_id AS a, ft2.topic_id AS b, COUNT(*) AS n
         FROM fact_topics ft1 JOIN fact_topics ft2
           ON ft1.fact_id = ft2.fact_id AND ft1.topic_id < ft2.topic_id
         GROUP BY ft1.topic_id, ft2.topic_id`,
      )
      .all() as Array<{ a: string; b: string; n: number }>

    // 2) entités partagées (+ noms lisibles, fortes comptées double, fortes d'abord
    //    pour que « via » montre Néto/un client/un projet avant les entités faibles)
    const sharedEnt = this.db
      .prepare(
        `SELECT te1.topic_id AS a, te2.topic_id AS b, e.name AS name,
                CASE WHEN e.type IN ('person','company','project','client') THEN 2 ELSE 1 END AS strength
         FROM topic_entities te1
         JOIN topic_entities te2 ON te1.entity_id = te2.entity_id AND te1.topic_id < te2.topic_id
         JOIN entities e ON e.id = te1.entity_id
         ORDER BY strength DESC`,
      )
      .all() as Array<{ a: string; b: string; name: string; strength: number }>

    const edges = new Map<string, TopicRelation>()
    const key = (a: string, b: string): string => `${a}|${b}`
    const ensure = (a: string, b: string): TopicRelation | null => {
      if (!keep.has(a) || !keep.has(b)) return null
      const k = key(a, b)
      let e = edges.get(k)
      if (!e) {
        e = { a, b, weight: 0, shared_facts: 0, shared_entities: 0, via: [] }
        edges.set(k, e)
      }
      return e
    }

    for (const r of sharedFacts) {
      const e = ensure(r.a, r.b)
      if (e) { e.shared_facts = r.n; e.weight += 2 * r.n }
    }
    const viaNoise = (name: string): boolean => name.length <= 2 || STOPWORDS.has(name.toLowerCase())
    for (const r of sharedEnt) {
      const e = ensure(r.a, r.b)
      if (!e) continue
      e.shared_entities += 1
      e.weight += r.strength
      if (e.via.length < 5 && !viaNoise(r.name) && !e.via.includes(r.name)) e.via.push(r.name)
    }

    const out = [...edges.values()]
      .filter(e => e.weight >= minWeight)
      .sort((x, y) => y.weight - x.weight)
      .slice(0, maxEdges)
    // ne garder que les nœuds réellement reliés (sinon des points isolés flottent)
    const linked = new Set<string>()
    for (const e of out) { linked.add(e.a); linked.add(e.b) }
    return { nodes: nodes.filter(n => linked.has(n.id)), edges: out }
  }

  topicsForFact(factId: string): TopicSummary[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.fact_count, t.importance_score, t.keywords
         FROM fact_topics ft JOIN topics t ON t.id = ft.topic_id WHERE ft.fact_id = ?`,
      )
      .all(factId) as Array<{ id: string; name: string; fact_count: number; importance_score: number; keywords: string }>
    return rows.map(r => ({ ...r, keywords: fromJsonArray(r.keywords) }))
  }

  factsForTopic(topicId: string, opts: { limit?: number } = {}): FactRow[] {
    return this.db
      .prepare(
        `SELECT f.* FROM fact_topics ft JOIN facts f ON f.id = ft.fact_id
         WHERE ft.topic_id = ? AND f.superseded = 0 ORDER BY f.created_at DESC LIMIT ?`,
      )
      .all(topicId, opts.limit ?? 50) as FactRow[]
  }

  /** Oubli : retire les faits des topics, recompte, supprime les topics vides. Retourne nb topics supprimés. */
  onForget(factIds: string[]): number {
    if (factIds.length === 0) return 0
    const placeholders = factIds.map(() => '?').join(',')
    const affected = this.db
      .prepare(`SELECT DISTINCT topic_id FROM fact_topics WHERE fact_id IN (${placeholders})`)
      .all(...factIds) as Array<{ topic_id: string }>
    this.db.prepare(`DELETE FROM fact_topics WHERE fact_id IN (${placeholders})`).run(...factIds)
    let removed = 0
    for (const a of affected) {
      const before = this.db.prepare('SELECT id FROM topics WHERE id = ?').get(a.topic_id)
      this.recompute(a.topic_id, [])
      const after = this.db.prepare('SELECT id FROM topics WHERE id = ?').get(a.topic_id)
      if (before && !after) removed++
    }
    return removed
  }
}

/**
 * Clé de dédoublonnage d'un thème : le nom, sans accent ni casse. C'est elle
 * qui garantit « jamais deux thèmes du même nom » — un renommage doit donc la
 * mettre à jour, sinon le prochain thème homonyme repart sur l'ancien slug.
 */
export function topicSlug(s: string): string {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/**
 * La réponse du modèle peut-elle NOMMER un thème ? Un modèle qui répond à côté
 * rend du JSON (« {"facts":[]} »), une balise ou une phrase entière — et ça
 * devenait un nom de thème affiché à l'utilisateur. On retombe alors sur
 * l'heuristique, qui produit toujours quelque chose de lisible.
 */
function isUsableLlmLabel(s: string): boolean {
  if (s.length < 3) return false
  if (!/\p{L}/u.test(s)) return false
  if (/[{}[\]<>]/u.test(s)) return false
  return s.split(/\s+/).length <= 8
}

/**
 * Ce mot du fait ressemble-t-il à un NOM (personne, produit, sigle) plutôt qu'à
 * un mot commun ? Sert quand la couche graph n'a extrait aucune entité : c'est
 * le mot qui a le plus de chances de nommer le sujet.
 *
 * Une majuscule ne suffit pas : le premier mot d'une phrase en porte une
 * (« Nouveau boîtier… »). On exige donc une occurrence AILLEURS qu'en tête de
 * phrase — sauf casse interne (JamBoard) ou sigle (CLI, RSMA), qui parlent
 * d'eux-mêmes.
 */
function looksLikeName(word: string, source: string): boolean {
  if (isLabelNoise(word)) return false
  if (hasInnerCase(word)) return true
  if (isAcronym(word)) return true
  if (!/^\p{Lu}/u.test(word)) return false
  return !isSentenceInitialOnly(word, source)
}

/** Une entité « fichier/chemin » (AppsPage.tsx, config.env, /Users/…) pollue les thèmes. */
function isFileLike(name: string): boolean {
  return /\.[a-z0-9]{1,5}\b/i.test(name) || name.includes('/') || name.includes('\\')
}
