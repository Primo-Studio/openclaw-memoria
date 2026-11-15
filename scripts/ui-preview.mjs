#!/usr/bin/env node
/**
 * Aperçu de l'UI web sur un daemon JETABLE peuplé de données de démo.
 *
 *   npm run ui:preview                      → affiche l'URL, reste ouvert (Ctrl+C pour quitter)
 *   npm run ui:preview -- --screenshot DIR  → capture chaque écran (clair/sombre × bureau/mobile)
 *                                             avec Chrome headless (DevTools), puis ferme tout
 *
 * POURQUOI : relire une refonte d'interface sur des écrans VIDES ne dit rien.
 * Ici, un stockage temporaire reçoit 3 agents (Claude Code / Codex / Koda),
 * ~60 souvenirs en français répartis sur plusieurs thèmes, des souvenirs
 * dormants en revue, 2 personnes avec identifiants, un fait partagé `user`,
 * une révision proposée, du journal et de la consommation — le tout via un
 * provider d'extraction FAUX injecté (patron de packages/daemon/test) :
 * JAMAIS de clé API réelle, aucun réseau, rien ne touche ~/.memoria ni le
 * service launchd de la machine (stockage dans un dossier temporaire supprimé
 * à la fin, hooks launchd/registrar/updater remplacés par des simulacres).
 *
 * Prérequis : `npm run build` (daemon dist + UI dist).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DAEMON_DIST = join(ROOT, 'packages/daemon/dist/index.js')
const UI_DIST = join(ROOT, 'packages/web/dist')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Routes = identifiants d'écran de packages/web/src/app/nav.ts (hash #/<id>).
const ROUTES = [
  'dashboard', 'agents', 'memory', 'review', 'triage', 'themes', 'map',
  'persons', 'patterns', 'procedures', 'revisions', 'sharing', 'vault', 'audit', 'maintenance', 'system', 'docs', 'settings',
]
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]
const THEMES = ['light', 'dark']

// ------------------------------------------------------------ faux provider

/**
 * Extraction FAUSSE et déterministe. Un seul provider répond à tous les
 * usages du moteur, reconnus par leur prompt système :
 *  - extraction de capture  → les messages [user] deviennent des faits ;
 *  - graphe d'entités       → entités connues trouvées dans le texte ;
 *  - libellé de thème       → 2-3 mots pris dans le fait (prompt « Name the SUBJECT ») ;
 *  - confirmation de contradiction → « NO » (l'heuristique décide seule).
 * `completeDetailed` rapporte une consommation plausible (tokens ≈ caractères/4)
 * pour alimenter l'écran de conso et le doctor.
 */
const KNOWN_ENTITIES = [
  ['Claire', 'person'], ['Samuel', 'person'], ['Hélène Rey', 'person'], ['Inès Fabre', 'person'],
  ['Atelier Verso', 'company'], ['GIREM', 'company'], ['Mairie de Belleville', 'company'], ['Institut Lauris', 'company'],
  ['Cartographie', 'project'], ['Mémo Chantier', 'project'], ['Agrinote', 'project'], ['Memoria', 'project'], ['Convoi', 'project'], ['Panneau', 'project'],
  ['Vercel', 'tool'], ['Firebase', 'tool'], ['Directus', 'tool'], ['Xcode', 'tool'], ['TestFlight', 'tool'], ['Ollama', 'tool'], ['Chorus Pro', 'tool'],
  ['DaVinci Resolve', 'tool'], ['Tailscale', 'tool'], ['SQLite', 'tool'], ['Vite', 'tool'], ['React', 'tool'],
  ['Belleville', 'place'], ['Nantes', 'place'], ['Lyon', 'place'],
]

class FakeExtraction {
  name = 'fake'
  // Nom au TARIF CONNU (préfixe gpt-4o-mini) : le tri refuse de démarrer quand
  // le prix d'un modèle est inconnu, et l'écran Tri affiche une dépense
  // plausible. Aucun appel réseau : ce fournisseur ne parle à personne.
  model = 'gpt-4o-mini-apercu'
  calls = 0
  isAvailable() {
    return Promise.resolve(true)
  }
  async complete(opts) {
    return (await this.completeDetailed(opts)).text
  }
  async completeDetailed(opts) {
    this.calls++
    const system = opts.system ?? ''
    let text
    if (system.includes('Tu tries des souvenirs')) {
      text = JSON.stringify({ items: triageItems(opts.prompt) })
    } else if (system.includes('extract the entities')) {
      const fact = (opts.prompt.match(/Fact: "([\s\S]*)"/) ?? [])[1] ?? opts.prompt
      const entities = KNOWN_ENTITIES.filter(([name]) => fact.includes(name)).map(([name, type]) => ({ name, type }))
      const relations = entities.length >= 2 ? [{ from: entities[0].name, to: entities[1].name, type: 'related_to' }] : []
      text = JSON.stringify({ entities, relations })
    } else if (system.includes('Name the SUBJECT of this memory')) {
      const words = opts.prompt.split(/\s+/).filter(w => /^[A-ZÀ-Ý]/.test(w)).slice(0, 3)
      text = words.length >= 2 ? words.join(' ') : opts.prompt.split(/\s+/).slice(0, 3).join(' ')
    } else if (system.includes('compare two statements')) {
      text = 'NO'
    } else {
      // Extraction de capture : chaque message [user] devient un fait durable.
      const facts = [...opts.prompt.matchAll(/^- \[user\] (.+)$/gm)].map(m => ({
        fact: m[1].trim(),
        category: /préf|aime|veut|jamais/i.test(m[1]) ? 'preference' : /décid|on part|choisi/i.test(m[1]) ? 'decision' : 'general',
        confidence: 0.85,
      }))
      text = JSON.stringify({ facts })
    }
    // Un petit délai simulé : la conso affiche des durées non nulles.
    await new Promise(r => setTimeout(r, 3))
    return {
      text,
      usage: { input_tokens: Math.ceil((system.length + opts.prompt.length) / 4), output_tokens: Math.ceil(text.length / 4) },
    }
  }
}

// ------------------------------------------------------------ tri (faux classement)

/** Genre d'un souvenir de démo : mots-clés, puis catégorie d'origine. */
function demoGenre(text, cat) {
  if (/salaire|paie/i.test(text)) return 'fait'
  if (/tests passent|commit du correctif/i.test(text)) return 'ephemere'
  if (/^idée|créer une application|proposer aux clients|série de vidéos|vendre un forfait/i.test(text)) return 'idee'
  if (/écrit des messages/i.test(text)) return 'style'
  if (/^leçon/i.test(text) || cat === 'error') return 'lecon'
  if (/^le \d+ \w+ \d{4}/i.test(text)) return 'chronologie'
  if (/est mieux indexé|se dessine dans le navigateur/i.test(text)) return 'savoir'
  if (cat === 'decision' || /a été décidé|reste hébergé/i.test(text)) return 'decision'
  if (cat === 'process' || /^pour publier/i.test(text)) return 'process'
  if (cat === 'preference' || /préfère/i.test(text)) return 'preference'
  return 'fait'
}

const DEMO_IDEA_TITLES = [
  [/jardins partagés/, 'app', 'App de planification des semis'],
  [/tableau de bord des devis/, 'outil', 'Tableau de bord des devis signés'],
  [/série de vidéos/, 'contenu', 'Série vidéo sur les métiers du chantier'],
  [/forfait annuel/, 'business', 'Forfait de maintenance pour associations'],
]

/** Réponse au prompt de tri (une entrée par ligne `{"n":…,"cat":…,"texte":…}`). */
function triageItems(prompt) {
  const items = []
  for (const line of prompt.split('\n').slice(1)) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const genre = demoGenre(e.texte, e.cat)
    const idea = DEMO_IDEA_TITLES.find(([re]) => re.test(e.texte))
    const entites = KNOWN_ENTITIES.filter(([name]) => e.texte.includes(name)).map(([name]) => name).slice(0, 4)
    items.push({
      n: e.n,
      utile_3_mois: genre !== 'ephemere',
      genre,
      ...(genre === 'idee' ? { sous_type: idea?.[1] ?? 'autre', titre: idea?.[2] ?? e.texte.split(/\s+/).slice(0, 6).join(' '), auteur: 'owner' } : {}),
      ...(genre === 'decision' ? { auteur: 'owner' } : {}),
      ...(genre === 'style' || genre === 'preference' ? { personne: 'owner' } : {}),
      rubriques: genre === 'ephemere' ? [] : /devis|client|mairie/i.test(e.texte) ? ['clients', 'vente'] : /site|app|application/i.test(e.texte) ? ['app'] : ['projet'],
      durabilite: genre === 'ephemere' ? 0 : 2,
      importance: genre === 'ephemere' ? 0 : genre === 'idee' || genre === 'decision' ? 3 : 2,
      autonome: true,
      projet: /Mémo Chantier/.test(e.texte) ? 'Mémo Chantier' : /Atelier Verso|site/i.test(e.texte) ? 'Site de l’atelier' : /jardins/.test(e.texte) ? 'Jardins partagés' : null,
      entites,
    })
  }
  return items
}

/**
 * Conversations FICTIVES (format Claude Code) : le tri y lit la date de la
 * conversation et vérifie l'auteur d'une idée dans les vrais messages.
 */
const DEMO_SESSIONS = [
  {
    file: 'session-semis.jsonl',
    turns: [
      ['user', '2026-09-03T08:12:00.000Z', 'Et si on créait une application qui aide les jardins partagés à planifier leurs semis ? Je vois bien un calendrier par parcelle.'],
      ['assistant', '2026-09-03T08:13:00.000Z', 'Bonne piste : un calendrier par parcelle et des rappels de semis.'],
      ['user', '2026-09-03T08:20:00.000Z', 'Les tests passent après le correctif du bouton d’envoi, on peut continuer.'],
    ],
    facts: [
      'Créer une application qui aide les jardins partagés à planifier leurs semis.',
      'Les tests passent après le correctif du bouton d’envoi.',
      'Claire écrit des messages courts et directs, et attend une réponse en trois lignes au plus.',
    ],
  },
  {
    file: 'session-devis.jsonl',
    turns: [
      ['user', '2026-09-21T14:02:00.000Z', 'Comment mieux suivre les devis signés ?'],
      ['assistant', '2026-09-21T14:03:00.000Z', 'Je propose aux clients un tableau de bord des devis signés, mis à jour chaque lundi, avec le montant restant à facturer.'],
      ['user', '2026-09-21T14:05:00.000Z', 'Oui, vas-y. Et les devis importants passent par une relecture à deux avant l’envoi.'],
    ],
    facts: [
      'Proposer aux clients un tableau de bord des devis signés, mis à jour chaque lundi.',
      'Les devis importants passent par une relecture à deux avant l’envoi.',
      'Pour publier une démo, exporter la maquette, la vérifier sur téléphone, puis l’envoyer par lien privé.',
    ],
  },
  {
    file: 'session-site.jsonl',
    turns: [
      ['user', '2026-10-08T09:30:00.000Z', 'On garde Vercel pour le site de l’Atelier Verso, pas de migration cette année.'],
      ['assistant', '2026-10-08T09:31:00.000Z', 'Noté. Autre idée : vendre un forfait annuel de maintenance des sites aux associations.'],
    ],
    facts: [
      'Le site de l’Atelier Verso reste hébergé sur Vercel : pas de migration cette année.',
      'Vendre un forfait annuel de maintenance des sites aux associations.',
      'Un site vitrine pré-rendu au build est mieux indexé qu’une application qui se dessine dans le navigateur.',
      'Le salaire brut de l’apprenti fictif est de 1 200 euros par mois.',
    ],
  },
  {
    file: 'session-videos.jsonl',
    turns: [
      ['user', '2026-10-27T17:45:00.000Z', 'Idée : une série de vidéos courtes sur les métiers du chantier pour les réseaux sociaux.'],
      ['assistant', '2026-10-27T17:46:00.000Z', 'Très bien, je note la série et je reprends l’idée des jardins partagés.'],
      ['user', '2026-10-27T17:50:00.000Z', 'Oui, créer une application qui aide les jardins partagés à planifier les semis, je veux toujours le faire.'],
    ],
    facts: [
      'Lancer une série de vidéos courtes sur les métiers du chantier pour les réseaux sociaux.',
      'Créer une application qui aide les jardins partagés à planifier les semis.',
      'Idée : créer une application qui aide les jardins partagés à planifier leurs semis.',
      'Leçon : une maquette envoyée sans relecture sur téléphone a dû être refaite ; toujours vérifier à 390 px.',
      'Le 14 octobre 2026, la maquette du salon du livre a été présentée à la mairie de Belleville.',
      'Commit du correctif de mise en page poussé sur la branche.',
    ],
  },
]

// ------------------------------------------------------------ données de démo

const AGENTS = [
  { type: 'claude-code', name: 'Claude Code' },
  { type: 'codex', name: 'Codex' },
  { type: 'openclaw', name: 'Koda' },
]

/** [agent, catégorie, fait] — français, thèmes variés, faits « durables ». */
const FACTS = [
  // Claude Code — développement, infra, process
  [0, 'config', 'Le site de l’Atelier Verso est déployé sur Vercel ; les commits doivent être signés par le compte de publication, sinon le déploiement est bloqué.'],
  [0, 'config', 'Mémo Chantier utilise Firebase (Firestore en région eur3) pour l’authentification et les données.'],
  [0, 'process', 'Avant tout envoi sur TestFlight, l’application doit être compilée sur un iPhone réel : le simulateur ne valide pas les entitlements.'],
  [0, 'decision', 'Memoria stocke tout en local dans SQLite ; aucune donnée ne part vers un cloud sans activation explicite d’un profil cloud.'],
  [0, 'config', 'Le daemon Memoria est servi par launchd sous le label fr.primo-studio.memoria et écoute sur un port éphémère écrit dans daemon.json.'],
  [0, 'preference', 'Claire préfère des messages courts : le résultat et les actions dans la réponse, le détail dans un fichier du dépôt.'],
  [0, 'preference', 'Claire pilote par prompt et ne lit pas le code : jamais de hooks de formatage, d’IDE ou de diffs dans les réponses.'],
  [0, 'process', 'Les liens vers des fichiers sont toujours donnés en chemin absolu cliquable, jamais relatif ni avec le tilde.'],
  [0, 'error', 'Leçon Cartographie : la première version a été rejetée pour Sign in with Apple absent sur iPad et compte démo manquant — les deux sont obligatoires.'],
  [0, 'config', 'Le compte démo utilisé pour la revue des applications est demo@example.com.'],
  [0, 'process', 'Les tests d’interface tournent avec l’outil Maestro ; toujours ouvrir les captures après un run.'],
  [0, 'decision', 'Les applications de l’atelier sortent en 5 langues dès la V1 : français, anglais, espagnol, portugais, allemand.'],
  [0, 'config', 'La clé API du fournisseur d’IA est stockée dans un fichier du dossier personnel avec les droits 600.'],
  [0, 'process', 'Le déploiement Firebase utilise un compte de service isolé plutôt qu’un jeton qui expire.'],
  [0, 'config', 'Le rendu des devis passe par des gabarits HTML et un navigateur sans interface.'],
  [0, 'decision', 'Agrinote, l’application agricole, reste en pause après le build 32 tant que deux réponses manquent.'],
  [0, 'config', 'Convoi est une application web en production pour la gestion des transporteurs ; la démo se redate avec un script dédié.'],
  [0, 'error', 'Le correctif de luminosité n’est pas commité et la version publiée est encore boguée.'],
  [0, 'process', 'Sur le dépôt interne, les commits doivent être signés par le compte de l’atelier : l’hébergeur bloque l’autre compte.'],
  [0, 'preference', 'Claire ne veut pas qu’on propose d’arrêter la session : c’est elle qui dit stop.'],
  [0, 'config', 'Le daemon Memoria expose l’UI web sous /ui/ depuis packages/web/dist, avec un token admin passé dans l’URL par le CLI.'],
  [0, 'process', 'Un test rouge est écrit avant chaque correctif, et on regarde l’écran avant de conclure.'],
  [0, 'decision', 'Panneau, la régie d’affichage LED, est en production en version 1.1 ; il reste à déclarer les 5 écrans.'],
  [0, 'config', 'La version 0.6.0 a été notarisée sous l’ancien identifiant de bundle : la release doit être refaite.'],
  [0, 'process', 'Pour créer un article de blog dans Directus, passer par curl : le pare-feu bloque la bibliothèque standard.'],
  [0, 'decision', 'Règle coût base de données : si l’hébergement dépasse 20 % du revenu de l’application, on change d’architecture.'],
  [0, 'config', 'Le poste principal accède à la machine distante via Tailscale et SSH.'],
  [0, 'preference', 'Les avertissements sur la rotation des clés API ne sont donnés qu’une fois ; ensuite on avance.'],
  // Codex — site web, SEO, contenu
  [1, 'config', 'Le site est une application Vite + React, pas Next.js : le pré-rendu SEO se fait par snapshots au build.'],
  [1, 'process', 'Après toute modification de contenu d’une page, régénérer les snapshots SEO avant de déployer.'],
  [1, 'decision', 'Le proxy Directus ne renvoie jamais de brouillons : la fuite de contenus non publiés a été fermée.'],
  [1, 'config', 'Le fichier robots.txt autorise l’API de contenu et les pages brouillon portent X-Robots-Tag: noindex.'],
  [1, 'process', 'Toute nouvelle route du site doit être déclarée dans le script de pré-rendu, sinon elle répond 404 en accès direct.'],
  [1, 'decision', 'Samuel s’occupe du CMS et du SEO ; chaque fonctionnalité du site vit sur sa propre branche.'],
  [1, 'config', 'La prise de rendez-vous du site attend un compte chez le prestataire ; la branche est prête.'],
  [1, 'general', 'Une page produit est passée de 225 à 19 418 caractères indexables grâce au pré-rendu et au balisage structuré.'],
  [1, 'process', 'Il reste à soumettre le sitemap dans la console de recherche et à poser les balises hreflang.'],
  [1, 'preference', 'Les articles de blog se rédigent d’abord en français, puis sont traduits dans les quatre autres langues.'],
  [1, 'config', 'L’adresse officielle de contact est contact@example.com ; bonjour@ n’est qu’un alias.'],
  [1, 'decision', 'Le capital social figure désormais sur tous les pieds de page des devis et du site.'],
  [1, 'general', 'L’Atelier Verso est une société basée à Belleville.'],
  [1, 'config', 'Les devis sont établis en net sans TVA, en application du régime fiscal local.'],
  // Koda (messagerie) — clients, devis, terrain
  [2, 'general', 'Hélène Rey est la contact du GIREM pour la plénière annuelle de novembre ; le devis V2 est à 1 200 € avec option vidéo à 750 €.'],
  [2, 'general', 'Inès Fabre, du pôle lecture de la mairie de Belleville, a reçu le devis du salon du livre jeunesse (5 500 € net).'],
  [2, 'decision', 'Si la mairie négocie le devis du salon, on retire des capsules à 560 € l’unité — jamais les taux horaires.'],
  [2, 'general', 'L’institut Lauris a reçu quatre devis de rentrée : atelier 1 280 €, accueil 750 €, film anniversaire 3 250 €, gala 1 960 €.'],
  [2, 'process', 'Un devis se construit à partir d’un prix cible, décomposé en heures × grille tarifaire.'],
  [2, 'process', 'La page acompte/RIB d’un devis est relue en dernier, juste avant l’envoi.'],
  [2, 'config', 'Les paiements des collectivités passent par la plateforme publique, sans acompte.'],
  [2, 'general', 'Le marché de transport fluvial compte trois devis envoyés dont la validité expire en fin de mois.'],
  [2, 'preference', 'Claire veut que l’agent de messagerie réponde aux clients en français, avec le vouvoiement, et signale tout devis à faire.'],
  [2, 'general', 'Un groupe de BTP s’intéresse à un agent de conformité hébergé de façon souveraine.'],
  [2, 'decision', 'Le message au groupe part le jeudi ; la prochaine échéance est le 19 septembre.'],
  [2, 'general', 'La climatisation du studio se pilote uniquement via le cloud du fabricant ; il n’existe pas d’API locale.'],
  [2, 'general', 'Le SMS vers l’étranger coûte environ 0,28 € : c’est le piège budgétaire du projet de transport.'],
  [2, 'process', 'Chaque facture suit un devis accepté et rappelle l’objet exact du devis.'],
  [2, 'general', 'L’Institut Lauris attend la refonte de son site de formation : maquette 7 pages et devis envoyé.'],
  [2, 'general', 'Le logiciel de pilotage de crèches a une démo publique en version 0.6.'],
]

/** Tours capturés en mode « Revue d’abord » → souvenirs DORMANTS à valider. */
const REVIEW_TURNS = [
  ['La plénière du GIREM aura finalement lieu le 14 novembre.', 'Noté : 14 novembre.'],
  ['On part sur un tarif horaire de 85 € pour les nouveaux devis de développement à partir de janvier.', 'Compris, 85 €/h dès janvier.'],
  ['Le nouveau boîtier photo est un Sony A7 IV, acheté pour les reportages institutionnels.', 'Je le retiens pour l’inventaire matériel.'],
  ['Samuel reprend le suivi de Mémo Chantier pendant mon déplacement en septembre.', 'D’accord, Samuel est référent Mémo Chantier en septembre.'],
  ['Le devis de l’Institut Lauris est accepté, il faut préparer la facture d’acompte.', 'Je prépare la facture d’acompte.'],
  ['Je préfère qu’on m’appelle Claire dans tous les documents internes, jamais par mon nom complet.', 'Entendu.'],
]

// ------------------------------------------------------------ script

function parseArgs(argv) {
  const out = { screenshot: null, routes: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--screenshot') out.screenshot = resolve(argv[++i] ?? '')
    else if (argv[i] === '--routes') out.routes = (argv[++i] ?? '').split(',').filter(r => ROUTES.includes(r))
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage : node scripts/ui-preview.mjs [--screenshot DOSSIER] [--routes dashboard,triage]')
      process.exit(0)
    }
  }
  return out
}

/**
 * Embeddings de démo, sans réseau : chaque mot allume une case d'un vecteur de
 * 48 dimensions (hachage). Deux souvenirs qui partagent des mots sont proches —
 * assez pour que l'écran Carte montre des groupes sur les données fictives.
 */
class FakeEmbeddings {
  name = 'fake'
  // Préfixe au tarif connu, pour la même raison que le faux moteur d'extraction.
  model = 'text-embedding-3-small-apercu'
  dimensions = 48
  isAvailable() {
    return Promise.resolve(true)
  }
  embed(texts) {
    return Promise.resolve(
      texts.map(text => {
        const v = new Float32Array(this.dimensions)
        for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
          if (word.length < 4) continue
          let h = 2166136261
          for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
          v[h % this.dimensions] += 1
        }
        const norm = Math.hypot(...v) || 1
        return v.map(x => x / norm)
      }),
    )
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(DAEMON_DIST) || !existsSync(join(UI_DIST, 'index.html'))) {
    console.error('Build manquant : lancez `npm run build` (daemon dist + UI dist).')
    process.exit(1)
  }
  const { startDaemon } = await import(DAEMON_DIST)

  const root = mkdtempSync(join(tmpdir(), 'memoria-ui-preview-'))
  // Racines des transcriptions lues par le tri : DANS le stockage temporaire.
  // Sans elles, le tri lirait les vraies sessions (~/.claude, ~/.codex).
  writeFileSync(
    join(root, 'config.toml'),
    `[triage]\nclaude_projects_dir = "${join(root, 'claude-projects')}"\narchive_dir = "${join(root, 'archive')}"\ncodex_sessions_dir = "${join(root, 'codex')}"\ncodex_history_file = "${join(root, 'codex-history.jsonl')}"\n`,
  )
  const fake = new FakeExtraction()
  const noAutostart = { supported: false, installed: false, loaded: false, running: false, pid: null, runs: 0, last_exit_code: null, plistPath: join(root, 'fake.plist') }
  const daemon = await startDaemon({
    storageRoot: root,
    configPath: join(root, 'config.toml'),
    uiDist: UI_DIST,
    // Vecteurs FAUX (sac de mots haché) : sans eux l'écran Carte reste vide.
    llm: { extraction: fake, embeddings: new FakeEmbeddings() },
    agentsHome: join(root, 'home'),
    credentialsDir: join(root, 'creds'),
    checkCli: () => false,
    registrar: (host) => ({ host, registered: false, detail: 'aperçu : enregistrement MCP simulé' }),
    control: {
      isSupervised: () => false,
      autostartStatus: () => noAutostart,
      enableAutostart: () => noAutostart,
      disableAutostart: () => noAutostart,
      handoverAutostart: () => {
        throw new Error('aperçu : lancement auto désactivé')
      },
    },
    updater: {
      pullAndBuild: async () => ({ ok: false, is_git: false, before: null, after: null, changed: false, built: false, log: 'aperçu : mise à jour désactivée' }),
      scheduleRestart: () => {},
    },
  })
  const { memoria, state } = daemon
  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    await daemon.close()
    rmSync(root, { recursive: true, force: true })
  }
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)))
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)))

  try {
    await seed(memoria, fake, root)
    // Carte : vecteurs puis positions calculés AVANT les captures (sinon l'écran
    // est pris en plein calcul).
    await memoria.indexEmbeddings()
    memoria.rebuildMemoryMap()
    await memoria.memoryMapSettled()
    const url = `http://127.0.0.1:${state.port}/ui/#token=${state.admin_token}`
    console.log(`\nAperçu Memoria : ${url}`)
    console.log(`  stockage temporaire : ${root}`)
    console.log(`  appels au faux moteur d’extraction : ${fake.calls}`)

    if (args.screenshot) {
      await screenshots(args.screenshot, state, args.routes ?? ROUTES)
      await shutdown()
      return
    }
    console.log('\nCtrl+C pour arrêter (le stockage temporaire est supprimé à la fermeture).')
    await new Promise(() => {})
  } catch (err) {
    console.error(err)
    await shutdown()
    process.exit(1)
  }
}

async function seed(memoria, fake, root) {
  const instances = []
  for (const a of AGENTS) {
    const paired = memoria.pairAssistant({ type: a.type, display_name: a.name })
    const done = memoria.completePairing(paired.pairing_code)
    if (!done) throw new Error(`pairing ${a.name} non complété`)
    instances.push(done.assistant_instance_id)
  }

  const storedIds = []
  for (const [agent, category, content] of FACTS) {
    const fact = memoria.storeFact({ instance: instances[agent], content, category, source: 'demo' })
    storedIds.push(fact.id)
  }

  // Fait partagé dans l'espace `user` (déclaré par Claude Code, lisible par tous).
  memoria.shareFacts([storedIds[5]], 'user')

  // Contradiction → proposition de révision (heuristique de négation, sans LLM).
  memoria.storeFact({ instance: instances[0], content: 'Claire utilise Vercel pour héberger le site de l’atelier.', category: 'config', source: 'demo' })
  memoria.storeFact({ instance: instances[0], content: 'Claire n’utilise plus Vercel pour héberger le site de l’atelier.', category: 'config', source: 'demo' })

  // Personnes + identifiants (interlocuteurs WhatsApp/e-mail de Koda).
  const helene = memoria.createPerson({ display_name: 'Hélène Rey', relation: 'cliente — GIREM', notes: 'Organise la plénière annuelle.' })
  memoria.addPersonIdentifier(helene.id, 'email', 'h.rey@girem.example', 'pro')
  memoria.addPersonIdentifier(helene.id, 'phone', '+33 6 00 00 00 01', 'mobile')
  const ines = memoria.createPerson({ display_name: 'Inès Fabre', relation: 'cliente — Mairie de Belleville', notes: 'Pôle lecture, salon du livre jeunesse.' })
  memoria.addPersonIdentifier(ines.id, 'email', 'i.fabre@ville-belleville.example', 'pro')
  memoria.addPersonIdentifier(ines.id, 'whatsapp', '+33 6 00 00 00 02', 'WhatsApp')

  // Souvenirs DORMANTS : capture en mode « Revue d'abord » via le faux extracteur.
  memoria.setCaptureMode('review-first')
  for (const [user, assistant] of REVIEW_TURNS) {
    await memoria.captureTurn({
      instance: instances[0],
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ],
    })
  }
  memoria.setCaptureMode('auto-private')

  // Thèmes, entités, expertise, révisions.
  await memoria.processCognition()
  for (const id of instances) {
    try {
      memoria.bootstrapExpertise(id)
    } catch (err) {
      console.warn('bootstrapExpertise :', err.message)
    }
  }
  await seedTriage(memoria, instances[0], root)
  const rev = await memoria.proposeRevisions(instances[0])
  const review = memoria.listReview().length
  const stats = memoria.stats()
  console.log(`Démo : ${stats.facts} faits · ${stats.instances} agents · ${review} en revue · ${rev.proposed} révision(s) · ${fake.calls} appels LLM simulés`)
}

/**
 * Tri des souvenirs : quatre conversations fictives sur disque, leurs faits
 * EN ATTENTE (comme un import de transcription), puis un VRAI passage de tri
 * avec le faux moteur. Accès internes du moteur (openContent) : script de
 * démonstration seulement, sur un stockage jetable.
 */
async function seedTriage(memoria, instance, root) {
  const dir = join(root, 'claude-projects', '-demo-atelier')
  mkdirSync(dir, { recursive: true })
  const db = memoria.openContent(memoria.registry.dbForInstance(instance).path).db
  const ids = {}
  for (const session of DEMO_SESSIONS) {
    const path = join(dir, session.file)
    const lines = [JSON.stringify({ type: 'summary', summary: 'Session de démonstration' })]
    for (const [role, ts, text] of session.turns) {
      lines.push(
        JSON.stringify(
          role === 'user'
            ? { type: 'user', timestamp: ts, message: { role: 'user', content: text } }
            : { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } },
        ),
      )
    }
    writeFileSync(path, lines.join('\n') + '\n')
    const sourceId = `demo-src-${session.file}`
    db.prepare(
      `INSERT INTO memory_sources (id, source_type, source_path, source_hash, imported_at, metadata) VALUES (?, 'transcript', ?, ?, ?, '{}')`,
    ).run(sourceId, path, `demo:${session.file}`, '2026-11-01T10:00:00.000Z')
    for (const content of session.facts) {
      const fact = memoria.storeFact({ instance, content, source: 'transcript-import' })
      db.prepare("UPDATE facts SET lifecycle_state = 'dormant' WHERE id = ?").run(fact.id)
      db.prepare(
        `INSERT INTO memory_import_items (id, source_id, target_memory_id, target_type, proposed_scope_id, status, confidence)
         VALUES (?, ?, ?, 'fact', ?, 'pending', 0.8)`,
      ).run(`demo-item-${fact.id}`, sourceId, fact.id, fact.scope_id)
      ids[content] = fact.id
    }
  }
  memoria.triage.retryDelayMs = 0
  const run = await memoria.triage.run({ budgetUsd: 1 })
  // Une idée validée, une décision validée et une idée d'un collègue : l'écran montre les trois états.
  const vercel = ids['Le site de l’Atelier Verso reste hébergé sur Vercel : pas de migration cette année.']
  const series = ids['Lancer une série de vidéos courtes sur les métiers du chantier pour les réseaux sociaux.']
  memoria.triage.promote({ fact_ids: [vercel, series] })
  const samuel = memoria.createPerson({ display_name: 'Samuel', relation: 'équipe : CMS et SEO' })
  memoria.triage.correct({ fact_id: ids['Vendre un forfait annuel de maintenance des sites aux associations.'], auteur: `person:${samuel.id}` })
  console.log(`Tri de démo : ${run.state}, ${run.facts_done} souvenirs triés, ${run.llm_calls} appels simulés, ${run.spent_usd.toFixed(4)} $`)
}

/**
 * Captures avec Chrome headless piloté par le protocole DevTools (WebSocket
 * natif de Node ≥ 22, zéro dépendance).
 *
 * POURQUOI pas `--screenshot=` en ligne de commande : sur Chrome 151, le
 * process ne se termine pas après l'écriture du PNG (une minute perdue par
 * capture), et macOS impose une largeur de fenêtre minimale (~500 px) — un
 * `--window-size=390,…` produisait une image de 390 px d'une mise en page à
 * 500 px, donc pas le vrai rendu mobile. L'émulation d'appareil
 * (Emulation.setDeviceMetricsOverride) donne le vrai viewport 390×844.
 */
async function screenshots(dir, state, routes = ROUTES) {
  if (!existsSync(CHROME)) throw new Error(`Chrome introuvable : ${CHROME}`)
  mkdirSync(dir, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'memoria-chrome-'))
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const total = routes.length * THEMES.length * VIEWPORTS.length
  let n = 0
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = ''
      chrome.stderr.on('data', d => {
        buf += String(d)
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
        if (m) resolve(m[1])
      })
      chrome.on('exit', code => reject(new Error(`Chrome terminé (code ${code}) avant d’exposer DevTools`)))
      setTimeout(() => reject(new Error('DevTools : délai dépassé (15 s)')), 15000)
    })
    const cdp = await Cdp.connect(wsUrl)
    try {
      for (const route of routes) {
        for (const theme of THEMES) {
          for (const vp of VIEWPORTS) {
            const file = join(dir, `${route}-${theme}-${vp.name}.png`)
            const url = `http://127.0.0.1:${state.port}/ui/?theme=${theme}#token=${state.admin_token}&route=${route}`
            const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
            const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
            try {
              await cdp.send('Page.enable', {}, sessionId)
              await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.name === 'mobile' }, sessionId)
              const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 15000)
              await cdp.send('Page.navigate', { url }, sessionId)
              await loaded
              // Les appels API sont locaux : 1,5 s suffit pour que chaque écran ait ses données.
              await new Promise(r => setTimeout(r, 1500))
              const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
              writeFileSync(file, Buffer.from(data, 'base64'))
            } finally {
              await cdp.send('Target.closeTarget', { targetId })
            }
            n++
            process.stdout.write(`\r  captures : ${n}/${total}`)
          }
        }
      }
    } finally {
      cdp.close()
    }
    console.log(`\nCaptures écrites dans ${dir}`)
  } finally {
    chrome.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 500))
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
}

/** Client DevTools minimal : requêtes numérotées + attente d'un événement. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    ws.onmessage = e => {
      const msg = JSON.parse(String(e.data))
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message}`))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const l of this.listeners) l(msg)
      }
    }
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error(`connexion DevTools impossible : ${url}`))
    })
    return new Cdp(ws)
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  waitFor(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error(`${method} : délai dépassé (${timeoutMs} ms)`))
      }, timeoutMs)
      const listener = msg => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer)
          this.listeners.delete(listener)
          resolve(msg.params)
        }
      }
      this.listeners.add(listener)
    })
  }
  close() {
    this.ws.close()
  }
}

main()
