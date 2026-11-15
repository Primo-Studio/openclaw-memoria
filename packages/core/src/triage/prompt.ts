/**
 * Prompt de classement du tri (version `tri-v3`) et validation de sa sortie.
 *
 * Neutre : « le propriétaire » (la personne dont c'est la mémoire) et
 * « l'assistant ». Aucun nom, aucune activité, aucune région dans le dépôt :
 * le contexte personnel vient d'un réglage local (`owner.display_name`,
 * `owner.context` dans les settings du registre), ajouté à l'exécution.
 *
 * La sortie est validée à la main (core n'a pas zod), sur le modèle de
 * `parseExtraction` : un genre hors grille rend l'entrée invalide (elle
 * repart une fois au LLM), le reste est borné ou ramené à null.
 */
import { normalizeText } from '../storage/content.js'
import {
  GENRES,
  PORTEES,
  RUBRIQUES,
  SOUS_TYPES,
  type Genre,
  type Origine,
  type Portee,
  type Rubrique,
  type SousType,
} from './types.js'

export const TRIAGE_SYSTEM_V3 = `Tu tries des souvenirs extraits automatiquement de conversations de travail entre le propriétaire de cette mémoire et ses assistants IA (un assistant principal et des sous-agents). Chaque souvenir est une phrase. LA MAJORITÉ EST DU BRUIT DE CHANTIER (environ la moitié ou plus). Ton tri sert à mettre ce bruit de côté, à garder ce qui sera utile dans plusieurs mois, et surtout à ne perdre AUCUNE idée.

Chaque entrée porte :
- n : numéro dans le lot ;
- origine : "session" (conversation directe avec le propriétaire) ou "sous-agent" (transcription d'un agent lancé par un autre agent ; là, « l'utilisateur » est l'agent chef, PAS le propriétaire, et la plupart des phrases sont des consignes ou des constats techniques passagers) ;
- cat : catégorie donnée à l'extraction (indicative, souvent fausse : ne t'y fie pas) ;
- texte.

MÉTHODE, pour chaque souvenir, dans cet ordre :
1. utile_3_mois : dans trois mois, cette phrase servira-t-elle au propriétaire ou à un assistant qui ne connaît pas la tâche du jour ? Réponds false si c'est :
   - un état d'avancement (tests verts, commit, build, déployé ou non, rapport écrit, fichier modifié, prochaine étape) ;
   - un détail de code (fonction, variable, ligne, fichier, composant, regex, correctif, bug précis, résultat de relecture de code) ;
   - un chemin de travail ou temporaire (/tmp, /private/tmp, worktree, scratchpad, sortie de tâche) ;
   - une consigne ponctuelle à un agent (ne pas pousser, ne toucher qu'à tel fichier, écrire le rapport ici, vérifier telle chose, mission du jour) ;
   - un détail d'interface d'un écran (taille, couleur, libellé, bouton, contraste) sans règle générale ;
   - un chiffre de l'instant (espace disque, nombre de fichiers, durée d'un rendu, horaire d'une reprise).
   Sinon true.
2. genre (un seul) :
   - si utile_3_mois est false : "ephemere" ;
   - "idee" : une proposition de quelque chose de NOUVEAU, pas encore fait ni tranché : app, jeu, fonction notable d'un produit, offre ou service à vendre, format ou série de contenus, outil, nom ou marque, stratégie commerciale. Une piste lancée au conditionnel (« on pourrait… », « et si… », « pourquoi pas… ») ou une option à envisager est une idee, même petite. Dans le doute entre idee et decision, process ou fait, choisis idee ;
   - "decision" : un choix tranché propre à un projet ou à l'entreprise : prix retenu, option choisie, abandon, annulation, marché visé, plan validé, règle fonctionnelle d'une app (« l'app doit… ») ;
   - "process" : une méthode réutilisable : procédure, étapes, commande ou vérification qui resservira sur d'autres tâches ;
   - "lecon" : une erreur commise (par le propriétaire, un assistant ou l'équipe, hors bug de code) et ce qu'elle apprend, ou une leçon tirée d'une expérience ;
   - "preference" : une préférence ou une règle GÉNÉRALE du propriétaire (ou d'une autre personne) sur la manière de travailler, d'écrire, de présenter, de coder, de communiquer, valable pour tous les projets (langue, ton, tirets, mode sombre, jamais de X) ;
   - "style" : une observation sur la manière dont une personne échange avec son assistant (longueur et ton de ses messages, dictée, façon de demander, de proposer ou de valider, côté humain ou robotique) : une manière d'être constatée, pas une règle demandée ;
   - "fait" : un fait durable : projet, client, personne, matériel, compte, réglage, tarif, montant facturé, loi ou règle administrative, chiffre de marché, emplacement d'un dossier de référence ;
   - "savoir" : une connaissance générale, vraie pour tout le monde (fonctionnement d'un outil ou d'une API, technique, métier), plutôt qu'un fait propre au propriétaire ;
   - "chronologie" : un événement daté qui a compté (lancement, signature, publication, rendez-vous tenu) : ce qui s'est passé et quand.
3. auteur (seulement pour idee et decision, sinon omis) :
   - "owner" : le texte nomme le propriétaire, ou dit « l'utilisateur » dans une SESSION ;
   - "assistant" : la proposition vient d'un assistant, d'un agent, d'une étude ou d'une « recommandation », ou est écrite à la première personne par l'assistant (« je propose ») ;
   - "inconnu" : sinon, et toujours quand « l'utilisateur » apparaît dans un SOUS-AGENT.

AUTRES ATTRIBUTS :
- sous_type : seulement pour idee : "app", "business", "contenu", "outil", "amelioration" ou "autre".
- rubriques : 0 à 3 étiquettes parmi "clients", "vente" (prix, devis, offres), "rh" (équipe, contrats, temps de travail), "erreurs" (à ne pas refaire), "outils", "savoir_entreprise", "projet", "app", "contenu", "finance", "juridique", "infra".
- portee : "perso" (propre à un agent ou à une session : réglage d'outil, consigne à cet agent), "user" (la personne, valable pour toutes ses IA : préférences, style, faits sur elle), "entite" (partageable dans l'entreprise : clients, vente, process, savoir métier).
- personne : pour preference et style seulement : "owner" si c'est le propriétaire, sinon le prénom de la personne tel qu'il est écrit.
- durabilite (0 à 3) : 0 vrai seulement aujourd'hui ; 1 quelques jours ou semaines ; 2 la durée d'un projet ; 3 durable sans limite. Un ephemere vaut 0 ou 1.
- importance (0 à 3) : 0 inutile ; 1 mineur ; 2 utile ; 3 essentiel pour le propriétaire. Un ephemere vaut 0 ou 1.
- autonome : true si la phrase se comprend seule (on sait de quel projet ou de quoi elle parle), false sinon.
- projet : le projet, client ou sujet en 1 à 4 mots si on peut le deviner.
- titre : pour idee et decision, un titre court (8 mots au plus) qui nomme la chose (« Abonnement de graines pour les jardineries »).
- entites : 0 à 3 noms propres cités (projet, client, produit, outil, personne).

Exemples (inventés) :
- « Les 42 tests passent et le commit abc123 est poussé. » → ephemere.
- « La fonction calculerTotal() ignore les remises à la ligne 88. » → ephemere.
- « Ne rien committer et écrire le rapport dans /tmp/x/rapport.md. » → ephemere.
- « Le propriétaire a décidé de ne plus proposer de maintenance dans ses devis. » → decision, auteur owner, rubriques ["vente"].
- « On pourrait proposer aux jardineries un abonnement de graines de saison. » → idee, business.
- « Je propose une app qui reconnaît les oiseaux en photo. » → idee, app, auteur assistant.
- « Toujours répondre en français, sans jargon. » → preference, personne owner, portee user.
- « Le propriétaire dicte ses messages : ils sont longs, sans ponctuation, et il valide d'un simple « ok go ». » → style, personne owner.
- « Le client X paie ses factures à 60 jours. » → fait, rubriques ["clients"].
- « Le mode JSON de l'API exige le mot json dans le prompt. » → savoir, rubriques ["outils"].
- « Le 12 mars, la version 1.0 de l'app a été publiée sur l'App Store. » → chronologie.
- « Avant chaque envoi à l'App Store, vérifier que l'adresse de contact est relevée. » → process.
- « Avoir annoncé une fonction absente sur la fiche de l'app a valu un refus. » → lecon, rubriques ["erreurs"].

Réponds UNIQUEMENT avec un objet JSON de la forme :
{"items":[{"n":1,"utile_3_mois":true,"genre":"fait","rubriques":["clients"],"portee":"entite","durabilite":2,"importance":1,"autonome":true,"projet":"...","entites":["..."]},{"n":2,"utile_3_mois":true,"genre":"idee","sous_type":"app","rubriques":["app"],"portee":"user","auteur":"assistant","durabilite":2,"importance":2,"autonome":true,"projet":"...","titre":"..."},{"n":3,"utile_3_mois":false,"genre":"ephemere","durabilite":0,"importance":0}]}
Une entrée par souvenir reçu, dans l'ordre, sans en oublier aucune : un ephemere a AUSSI son entrée (comme n=3). Omets seulement les champs vides ou sans objet.`

/** Prompt système complet : la grille neutre + le contexte local du propriétaire, s'il est réglé. */
export function buildTriageSystem(owner: { display_name: string | null; context: string | null } = { display_name: null, context: null }): string {
  const bits: string[] = []
  const name = owner.display_name?.trim()
  const context = owner.context?.trim()
  if (name) bits.push(`Le propriétaire s'appelle ${name.slice(0, 80)}.`)
  if (context) bits.push(context.slice(0, 600))
  return bits.length > 0 ? `${TRIAGE_SYSTEM_V3}\n\nContexte du propriétaire : ${bits.join(' ')}` : TRIAGE_SYSTEM_V3
}

export interface TriagePromptItem {
  origine: Origine | null
  cat: string
  texte: string
}

/** Message utilisateur d'un lot : une ligne JSON par souvenir, numérotées à partir de 1. */
export function renderTriageBatch(items: readonly TriagePromptItem[]): string {
  return (
    'Souvenirs à trier :\n' +
    items
      .map((it, i) => JSON.stringify({ n: i + 1, origine: it.origine ?? 'session', cat: it.cat, texte: it.texte }))
      .join('\n')
  )
}

/** Une entrée validée. */
export interface ParsedTriageItem {
  genre: Genre
  sous_type: SousType | null
  rubriques: Rubrique[]
  portee: Portee | null
  personne: string | null
  auteur: 'owner' | 'assistant' | 'inconnu' | null
  durabilite: number | null
  importance: number | null
  autonome: boolean | null
  projet: string | null
  titre: string | null
  entites: string[]
}

export interface ParsedTriageBatch {
  /** Entrées valides, par numéro (1..n). */
  items: Map<number, ParsedTriageItem>
  /** Numéros présents mais au genre hors grille (à renvoyer). */
  invalid: number[]
}

const GENRE_ALIASES: Record<string, Genre> = {
  idea: 'idee',
  ideas: 'idee',
  idees: 'idee',
  lesson: 'lecon',
  lecons: 'lecon',
  preferences: 'preference',
  rule: 'preference',
  regle: 'preference',
  knowledge: 'savoir',
  connaissance: 'savoir',
  fact: 'fait',
  faits: 'fait',
  event: 'chronologie',
  evenement: 'chronologie',
  ephemeral: 'ephemere',
  bruit: 'ephemere',
  procedure: 'process',
  processus: 'process',
}

const RUBRIQUE_ALIASES: Record<string, Rubrique> = {
  client: 'clients',
  ventes: 'vente',
  prix: 'vente',
  pricing: 'vente',
  erreur: 'erreurs',
  outil: 'outils',
  savoir: 'savoir_entreprise',
  'savoir entreprise': 'savoir_entreprise',
  projets: 'projet',
  apps: 'app',
  juridique: 'juridique',
}

const PORTEE_ALIASES: Record<string, Portee> = {
  entreprise: 'entite',
  org: 'entite',
  agent: 'perso',
  session: 'perso',
  utilisateur: 'user',
  owner: 'user',
}

function key(value: unknown): string {
  return typeof value === 'string' ? normalizeText(value.trim()).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ') : ''
}

export function normalizeGenre(value: unknown): Genre | null {
  const k = key(value)
  if ((GENRES as readonly string[]).includes(k)) return k as Genre
  return GENRE_ALIASES[k] ?? null
}

function level(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(3, Math.round(n)))
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  const k = key(value)
  if (k === 'oui' || k === 'true' || k === 'yes') return true
  if (k === 'non' || k === 'false' || k === 'no') return false
  return null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.replace(/\s+/g, ' ').trim()
  return t.length === 0 ? null : t.slice(0, max)
}

function parseItem(record: Record<string, unknown>): ParsedTriageItem | null {
  const genre = normalizeGenre(record.genre)
  if (!genre) return null
  const idea = genre === 'idee'
  const authored = genre === 'idee' || genre === 'decision'
  const stKey = key(record.sous_type)
  const sous_type: SousType | null = idea
    ? (SOUS_TYPES as readonly string[]).includes(stKey)
      ? (stKey as SousType)
      : 'autre'
    : null
  const rubriques: Rubrique[] = []
  for (const r of Array.isArray(record.rubriques) ? record.rubriques : []) {
    const k = key(r)
    const value = (RUBRIQUES as readonly string[]).includes(k.replace(/ /g, '_'))
      ? (k.replace(/ /g, '_') as Rubrique)
      : RUBRIQUE_ALIASES[k]
    if (value && !rubriques.includes(value) && rubriques.length < 4) rubriques.push(value)
  }
  const pKey = key(record.portee)
  const portee: Portee | null = (PORTEES as readonly string[]).includes(pKey) ? (pKey as Portee) : (PORTEE_ALIASES[pKey] ?? null)
  const aKey = key(record.auteur)
  const auteur: ParsedTriageItem['auteur'] = !authored
    ? null
    : ['owner', 'proprietaire', 'utilisateur', 'user'].includes(aKey)
      ? 'owner'
      : ['assistant', 'ia', 'ai', 'agent'].includes(aKey)
        ? 'assistant'
        : 'inconnu'
  const entites: string[] = []
  for (const e of Array.isArray(record.entites) ? record.entites : []) {
    const t = text(e, 60)
    if (t && t.length >= 2 && !entites.includes(t) && entites.length < 5) entites.push(t)
  }
  const personne = genre === 'preference' || genre === 'style' ? text(record.personne, 60) : null
  return {
    genre,
    sous_type,
    rubriques: genre === 'ephemere' ? [] : rubriques,
    portee: genre === 'ephemere' ? null : portee,
    personne,
    auteur,
    durabilite: level(record.durabilite),
    importance: level(record.importance),
    autonome: bool(record.autonome),
    projet: text(record.projet, 60),
    titre: text(record.titre, 120),
    entites: genre === 'ephemere' ? [] : entites,
  }
}

/**
 * Lit la réponse du LLM pour un lot de `size` entrées. Une sortie sans JSON
 * lisible lève (le lot est en échec, il sera réessayé) ; une entrée absente
 * n'est ni valide ni invalide (elle sera renvoyée) ; un genre hors grille
 * la rend invalide.
 */
export function parseTriageBatch(raw: string, size: number): ParsedTriageBatch {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('tri : réponse du LLM sans JSON')
    try {
      parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
      throw new Error('tri : réponse du LLM illisible')
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).items)
      ? ((parsed as Record<string, unknown>).items as unknown[])
      : null
  if (!list) throw new Error('tri : la réponse du LLM ne contient pas de liste « items »')
  const items = new Map<number, ParsedTriageItem>()
  const invalid: number[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const n = typeof record.n === 'number' ? record.n : Number(record.n)
    if (!Number.isInteger(n) || n < 1 || n > size || items.has(n)) continue
    const item = parseItem(record)
    if (item) items.set(n, item)
    else if (!invalid.includes(n)) invalid.push(n)
  }
  return { items, invalid: invalid.filter(n => !items.has(n)) }
}
