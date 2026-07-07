/**
 * Docs — centre de documentation intégré. Aucune donnée, aucun appel réseau :
 * du contenu statique, organisé en SECTIONS (sous-onglets) regroupées par
 * thème, pour que quelqu'un qui ouvre Memoria comprenne le produit de fond en
 * comble — concepts, onglets, moteur d'IA, partage, multi-machines, CLI, FAQ.
 *
 * Tenir à jour quand on ajoute un écran, une commande CLI ou un provider.
 * Le contenu reflète le code réel (cli/commands, core/llm, core/sync,
 * core/cognition, docs/v3). Pas de promesse non tenue.
 */
import { useState, type ReactNode } from 'react'

// --------------------------------------------------------------- présentation

function Lead({ children }: { children: ReactNode }) {
  return <p className="docs-lead">{children}</p>
}

function Callout({ kind = 'info', children }: { kind?: 'info' | 'tip' | 'warn'; children: ReactNode }) {
  return <div className={`docs-callout${kind === 'info' ? '' : ` ${kind}`}`}>{children}</div>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-block">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

// ------------------------------------------------------------------- sections

function Bienvenue() {
  return (
    <div className="docs-body">
      <h1>Bienvenue dans Memoria</h1>
      <Lead>
        Memoria est la mémoire locale et persistante de tes assistants IA (Claude Code, Codex,
        OpenClaw…). Chaque agent garde une mémoire privée qui ne repart jamais de zéro — et c'est toi qui
        décides de ce qui se partage. Tout vit sur cette machine.
      </Lead>

      <div className="vault-explainer">
        <strong>En une phrase :</strong> tes agents discutent avec toi, Memoria en extrait des
        « souvenirs », les range par sujet, et les leur ressert au bon moment — sans que rien ne parte
        dans le cloud.
      </div>

      <Section title="Les 5 principes">
        <ul>
          <li>
            <strong>100 % local.</strong> Rien ne quitte cette machine sans une action explicite de ta
            part. Pas de cloud imposé, pas de télémétrie.
          </li>
          <li>
            <strong>Une mémoire par agent.</strong> Chaque assistant est comme une personne avec sa
            mémoire privée. Le partage est opt-in, sujet par sujet.
          </li>
          <li>
            <strong>Memoria gouverne, les agents proposent.</strong> Le rangement, la déduplication, la
            protection des secrets, l'audit et la suppression appartiennent à Memoria. Les agents
            suggèrent, tu valides.
          </li>
          <li>
            <strong>Les secrets n'entrent jamais en mémoire.</strong> Un filtre bloque clés et mots de
            passe avant le stockage ; seules des références sont gardées (voir le Coffre).
          </li>
          <li>
            <strong>Isolation des clients, non négociable.</strong> Un souvenir lié à un client ne fuite
            jamais vers un autre — c'est vérifié automatiquement à chaque version.
          </li>
        </ul>
      </Section>

      <Callout kind="tip">
        Nouveau ici ? Va dans <strong>Démarrage rapide</strong> pour connecter ton premier agent en
        quelques minutes, puis <strong>Comment ça marche</strong> pour comprendre la mécanique.
      </Callout>
    </div>
  )
}

function Demarrage() {
  return (
    <div className="docs-body">
      <h1>Démarrage rapide</h1>
      <Lead>De zéro à un agent qui mémorise, en quatre étapes.</Lead>

      <Section title="1. Installer (déjà fait si tu lis ceci)">
        <p>Une seule commande dans le Terminal (nécessite Node.js 22 LTS) :</p>
        <pre className="command">curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/memoria-v1/scripts/install-memoria.sh | sh</pre>
        <p className="muted">
          Le script installe Memoria, démarre le service local, l'ajoute au démarrage automatique et
          ouvre cette interface. Tu peux la rouvrir à tout moment avec <code>memoria ui</code>.
        </p>
      </Section>

      <Section title="2. Choisir le moteur d'intelligence">
        <p>
          C'est l'IA qui transforme tes conversations en souvenirs. L'onboarding t'oblige à en choisir un
          (anti-« mort silencieuse ») :
        </p>
        <ul>
          <li><strong>Ollama</strong> — recommandé, 100 % local et gratuit.</li>
          <li><strong>LM Studio</strong> — alternative locale.</li>
          <li><strong>Clé API</strong> — OpenAI, Anthropic ou OpenRouter (cloud, payant).</li>
        </ul>
        <p className="muted">
          Détails dans la section <strong>Le moteur d'intelligence</strong>. Tu peux en changer à tout
          moment dans <strong>Réglages</strong>.
        </p>
      </Section>

      <Section title="3. Connecter un agent">
        <p>
          Dans l'onglet <strong>Agents</strong> → section « Sur cette machine », Memoria détecte tes
          assistants (Claude Code, Codex, OpenClaw…). Clique <strong>Connecter</strong> : c'est branché.
        </p>
        <p className="muted">
          Pour un agent à distance ou non détecté, utilise un <strong>code de pairing</strong> (valable
          10 min) à coller dans le chat de l'agent — ou en terminal <code>memoria pair claude-code</code>.
        </p>
      </Section>

      <Section title="4. (Optionnel) Importer ses anciens souvenirs">
        <p>
          Toujours dans <strong>Agents</strong>, le bouton <strong>Importer</strong> récupère les
          souvenirs existants d'un agent (transcripts de conversations, ou mémoire OpenClaw legacy), avec
          une barre de progression. Ils passent par la <strong>Revue</strong> avant d'être actifs.
        </p>
      </Section>

      <Callout kind="tip">
        Et après ? Laisse les agents travailler : en mode <strong>Capture auto</strong>, ils mémorisent
        tout seuls. Reviens voir <strong>Thèmes</strong> pour découvrir la carte de ce qu'ils savent.
      </Callout>
    </div>
  )
}

function CommentCaMarche() {
  return (
    <div className="docs-body">
      <h1>Comment ça marche</h1>
      <Lead>Memoria n'est pas un plugin fragile : c'est un petit service local que tes agents consultent.</Lead>

      <Section title="Les pièces du moteur">
        <div className="layer-grid">
          {[
            { t: 'Le service (daemon)', d: 'Un seul processus local, gardien des bases de données. Il écoute sur 127.0.0.1 derrière un jeton ; lui seul écrit. C\'est lui qui sert cette interface.' },
            { t: 'Le pont MCP', d: 'Un petit serveur MCP par agent, qui relaie les demandes de l\'agent vers le service. L\'agent ne touche jamais les fichiers directement.' },
            { t: 'Le cœur', d: 'La logique : rangement, recall, extraction, secrets, audit, couches cognitives. Aucune dépendance à un hôte, aucun réseau sortant.' },
            { t: 'Cette interface', d: 'L\'UI web, servie par le service en local. Aucune donnée ne sort : elle ne parle qu\'au service sur ta machine.' },
          ].map(x => (
            <div key={x.t} className="layer-card">
              <strong>{x.t}</strong>
              <p className="layer-desc muted">{x.d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Le cycle d'un souvenir">
        <ol className="docs-steps">
          <li><strong>Capture.</strong> Tu discutes avec un agent. À la fin du tour, la conversation est mise en file (journal WAL — rien ne se perd, même si ça plante).</li>
          <li><strong>Extraction.</strong> Le moteur d'intelligence lit l'échange et en sort des faits courts et utiles. Les secrets sont retirés avant d'aller plus loin.</li>
          <li><strong>Rangement.</strong> Chaque fait est classé par sujet (thème), relié à des entités (personnes, projets) et indexé pour la recherche par mots ET par sens.</li>
          <li><strong>Rappel (recall).</strong> Au tour suivant, quand c'est pertinent, l'agent reçoit automatiquement les bons souvenirs — sans que tu aies à les chercher.</li>
        </ol>
      </Section>

      <Callout>
        Selon le <strong>mode de capture</strong>, l'étape 2 est automatique (Capture auto), mise en
        attente de ta validation (Revue d'abord), ou suspendue (Pause). Voir la section suivante.
      </Callout>
    </div>
  )
}

function Souvenirs() {
  return (
    <div className="docs-body">
      <h1>Souvenirs &amp; espaces de mémoire</h1>
      <Lead>Comprendre ce qu'est un « souvenir » et où il est rangé.</Lead>

      <Section title="Un souvenir">
        <p>
          C'est un fait court et autonome extrait de tes échanges : une préférence, une décision, une
          info sur un projet, un savoir-faire. Memoria garde sa <strong>provenance</strong> (quel agent,
          quand) et sait s'il est actif, en sommeil ou archivé. Un souvenir effacé l'est{' '}
          <strong>vraiment</strong> (hard-delete), partout.
        </p>
      </Section>

      <Section title="Une mémoire par agent — et des espaces partagés">
        <p>
          Chaque agent a son <strong>espace privé</strong> : sa personnalité, ses workflows, ses notes.
          Personne d'autre n'y accède. À côté, des <strong>espaces partagés</strong> (scopes) regroupent
          ce qui peut être commun :
        </p>
        <ul>
          <li><strong>user</strong> — les faits sur toi (identité, préférences). Tous les agents autorisés y accèdent.</li>
          <li><strong>org</strong> — les conventions de l'entreprise.</li>
          <li><strong>client</strong> / <strong>project</strong> — par client, par projet.</li>
          <li><strong>sujet partagé</strong> — un thème d'équipe que tu ouvres explicitement.</li>
        </ul>
        <p className="muted">
          Rien ne passe du privé au partagé sans ton clic (onglet <strong>Partage</strong>).
        </p>
      </Section>

      <Callout kind="tip">
        L'onglet <strong>Thèmes</strong> est la meilleure façon de visualiser tout ça : une carte par
        agent, où la taille d'un sujet reflète son importance.
      </Callout>
    </div>
  )
}

function Capture() {
  const modes = [
    { label: 'Capture auto', body: 'Les agents mémorisent en privé, automatiquement. C\'est le mode par défaut, le plus simple.' },
    { label: 'Revue d\'abord', body: 'Chaque souvenir attend ta validation dans l\'onglet Revue avant d\'exister. Aucun agent ne le voit tant qu\'il est en attente.' },
    { label: 'Pause', body: 'Plus aucune capture, nulle part. Idéal pour une conversation sensible. Tu reprends quand tu veux.' },
  ]
  return (
    <div className="docs-body">
      <h1>Modes de capture</h1>
      <Lead>
        Le sélecteur « Capture », toujours visible en bas de la barre de gauche, décide si — et comment —
        les agents mémorisent. C'est ton interrupteur principal.
      </Lead>
      <div className="layer-grid">
        {modes.map(m => (
          <div key={m.label} className="layer-card">
            <strong>{m.label}</strong>
            <p className="layer-desc muted">{m.body}</p>
          </div>
        ))}
      </div>
      <Callout>
        Tu peux aussi piloter ça en terminal : <code>memoria disable</code> met en pause,{' '}
        <code>memoria enable</code> relance.
      </Callout>
    </div>
  )
}

function Moteur() {
  return (
    <div className="docs-body">
      <h1>Le moteur d'intelligence</h1>
      <Lead>
        C'est l'IA qui transforme tes conversations en souvenirs (extraction) et qui permet la recherche
        par le sens (embeddings). Tu choisis le tien dans <strong>Réglages</strong>.
      </Lead>

      <Section title="Fournisseurs pour l'extraction">
        <table className="docs-table">
          <thead>
            <tr><th>Fournisseur</th><th>Type</th><th>Modèle conseillé</th><th>Note</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Ollama</strong></td><td>Local</td><td><code>qwen2.5:3b</code></td><td>Recommandé — gratuit, 100 % local</td></tr>
            <tr><td>LM Studio</td><td>Local</td><td>modèle chargé</td><td>Alternative locale</td></tr>
            <tr><td>OpenAI</td><td>Cloud</td><td><code>gpt-4o-mini</code></td><td>Bon rapport qualité/coût</td></tr>
            <tr><td>Anthropic</td><td>Cloud</td><td><code>claude-haiku-4-5</code></td><td>Rapide et fin</td></tr>
            <tr><td>OpenRouter</td><td>Cloud</td><td>+300 modèles</td><td>Un seul accès, large catalogue</td></tr>
          </tbody>
        </table>
        <p className="muted">
          Les clés API peuvent être saisies dans l'UI ou lues depuis un fichier (chmod 600) ; elles ne
          sont jamais loggées. Une clé déjà présente dans OpenClaw peut être réutilisée.
        </p>
      </Section>

      <Section title="Embeddings (recherche par le sens)">
        <p>
          En plus des mots-clés, Memoria comprend le <em>sens</em> de tes souvenirs. En V1, les embeddings
          passent par <strong>Ollama uniquement</strong>, avec le modèle <code>nomic-embed-text</code>{' '}
          (768 dimensions, vérifiées strictement). Si les embeddings sont indisponibles, la recherche
          retombe proprement sur le plein-texte (mots-clés) — sans planter.
        </p>
      </Section>

      <Section title="Mode dégradé (anti-mort-silencieuse)">
        <p>
          Si aucun moteur n'est configuré, Memoria <strong>ne fait pas semblant</strong> : il te le dit en
          rouge (bannière du Tableau de bord). Dans ce mode, il enregistre quand même tes conversations en
          file d'attente, mais n'en extrait aucun souvenir. Dès que tu branches un moteur, la file est
          traitée automatiquement — rien n'est perdu.
        </p>
      </Section>

      <Callout kind="tip">
        Avec Ollama, télécharge les deux modèles d'un coup : <code>ollama pull qwen2.5:3b</code> et{' '}
        <code>ollama pull nomic-embed-text</code>. L'onboarding peut le faire pour toi avec une barre de
        progression.
      </Callout>
    </div>
  )
}

function Couches() {
  const buckets = [
    {
      name: 'A — Le socle (toujours actif)',
      desc: 'Capture, stockage, scoring, cycle de vie, contradictions, procédures, expertise, contexte, journal WAL. La fondation : rien ne se perd, tout est rangé, la mémoire s\'affine par l\'usage.',
    },
    {
      name: 'B — Enrichissement (en arrière-plan)',
      desc: 'Embeddings (sens), graphe d\'entités & relations, thèmes, observations, clusters, capture continue. Tourne hors du chemin de réponse pour mieux comprendre et relier tes souvenirs.',
    },
    {
      name: 'C — Optionnel',
      desc: 'Auto-observation, export Markdown, dialectique. Des fonctions avancées à activer selon tes besoins.',
    },
    {
      name: 'D — Sur validation',
      desc: 'Récurrences, auto-compétences, fusions de doublons. Memoria détecte et PROPOSE, mais n\'applique jamais sans ton accord.',
    },
  ]
  return (
    <div className="docs-body">
      <h1>Les couches cognitives</h1>
      <Lead>
        Sous le capot, Memoria fait tourner <strong>24 couches</strong> regroupées en 4 familles. C'est
        « le cerveau » — tu peux le voir vivre, compteurs à l'appui, dans l'onglet <strong>Système</strong>.
      </Lead>
      <div className="layer-grid">
        {buckets.map(b => (
          <div key={b.name} className="layer-card">
            <strong>{b.name}</strong>
            <p className="layer-desc muted">{b.desc}</p>
          </div>
        ))}
      </div>

      <Section title="Comment un souvenir est retrouvé (recall)">
        <p>Quand un agent a besoin de contexte, Memoria combine plusieurs chemins, puis garde le meilleur :</p>
        <ul>
          <li><strong>Plein-texte</strong> — recherche par mots-clés (FTS5).</li>
          <li><strong>Sémantique</strong> — recherche par le sens (vecteurs), fusionnée avec le plein-texte (RRF).</li>
          <li><strong>Graphe</strong> — extension via les entités liées (« tu as parlé de X et Y ensemble »).</li>
          <li><strong>Hot-tier</strong> — les souvenirs récemment utiles remontent.</li>
        </ul>
        <p className="muted">
          Un budget limite la quantité injectée pour rester concis. Et l'isolation client garantit qu'un
          souvenir d'un client ne ressort jamais pour un autre.
        </p>
      </Section>
    </div>
  )
}

const TAB_GROUPS: Array<{ title: string; tabs: Array<{ label: string; goal: string; details: string[] }> }> = [
  {
    title: 'Pilotage',
    tabs: [
      { label: 'Tableau de bord', goal: 'L\'état de la mémoire en un coup d\'œil.', details: ['Santé du service, compteurs, file de souvenirs à traiter.', 'Alerte rouge si aucun moteur d\'extraction n\'est disponible.', 'Raccourcis pour connecter un agent ou ouvrir les réglages.'] },
      { label: 'Agents', goal: 'Connecter et gérer les assistants de la machine.', details: ['Détection auto, connexion en 1 clic, ou code de pairing (10 min).', 'Import des souvenirs existants avec progression.', 'Révocation d\'un agent à tout moment.'] },
    ],
  },
  {
    title: 'Ta mémoire',
    tabs: [
      { label: 'Mémoire', goal: 'Chercher dans les souvenirs d\'un agent — et en oublier.', details: ['Recherche plein-texte ; requête vide = derniers souvenirs.', 'Oubli définitif fait par fait (hard-delete).'] },
      { label: 'Thèmes', goal: 'La carte de ce que sait l\'agent, rangée par sujet.', details: ['Chaque sujet est une tuile dont la taille reflète son importance.', 'Cliquer un thème montre les souvenirs qu\'il contient.'] },
      { label: 'Récurrences', goal: '« Memoria a remarqué que… » — tes habitudes repérées.', details: ['Regroupe ce que tu dis ou fais souvent.', 'Tu confirmes (souvenir consolidé) ou tu écartes. Rien n\'est appliqué sans accord.'] },
      { label: 'Procédures', goal: '« Comment faire les choses » — les savoir-faire d\'un agent.', details: ['Commandes et workflows, avec leur taux de réussite.', 'Ce qui marche remonte, ce qui rate est annoté.'] },
    ],
  },
  {
    title: 'Contrôle & validation',
    tabs: [
      { label: 'Revue', goal: 'Valider les souvenirs en attente avant qu\'un agent les voie.', details: ['Reçoit le mode « Revue d\'abord » et les imports en quarantaine.', 'Approuver = actif ; rejeter = effacé. En attente = invisible aux agents.'] },
      { label: 'Révisions', goal: 'Le « ménage » : doublons et contradictions.', details: ['Memoria repère ce qui se contredit ou fait doublon.', 'Il propose de ranger (garder le récent). Rien sans ta validation.'] },
    ],
  },
  {
    title: 'Partage & personnes',
    tabs: [
      { label: 'Partage', goal: 'Décider qui peut lire quoi, et ce qu\'on partage sur toi.', details: ['Matrice « qui peut lire quoi » par sujet partagé.', 'Faits sur toi à remonter vers la mémoire commune « user ».', 'Memoria propose, tu décides — rien sans ton clic.'] },
      { label: 'Personnes', goal: 'Qui peut parler aux agents, et comment les reconnaître.', details: ['Identifiants (Telegram/WhatsApp, e-mail, handle) pour reconnaître l\'interlocuteur.', 'Notes par personne : rôle, ce qu\'on peut partager.'] },
    ],
  },
  {
    title: 'Sécurité & système',
    tabs: [
      { label: 'Coffre', goal: 'Les secrets détectés, mis à l\'abri automatiquement.', details: ['Clés et mots de passe ne sont jamais stockés en clair.', 'Seule une référence est gardée ; la valeur vit dans le Keychain (ou un coffre chiffré).', 'Cet écran montre ce qui est protégé — jamais la valeur.'] },
      { label: 'Système', goal: 'Le « cerveau » de Memoria, rendu visible.', details: ['Les 24 couches cognitives par famille, avec compteurs en direct.', 'Entités, thèmes, procédures… : on voit la machine tourner.'] },
      { label: 'Journal', goal: 'L\'historique d\'activité, neutre et traçable.', details: ['Les dernières actions du service, sans jamais exposer le contenu.', 'Sert d\'audit : qui a fait quoi, quand.'] },
      { label: 'Réglages', goal: 'Choisir le moteur d\'IA et l\'emplacement de stockage.', details: ['Provider + modèle d\'extraction (local ou cloud), avec recommandations.', 'Où sont stockées les bases de données.'] },
    ],
  },
]

function GuideOnglets() {
  return (
    <div className="docs-body">
      <h1>Guide des onglets</h1>
      <Lead>Le but de chacun des 14 onglets de la barre de gauche, et ce que tu peux y faire.</Lead>
      {TAB_GROUPS.map(group => (
        <Section key={group.title} title={group.title}>
          <div className="layer-grid">
            {group.tabs.map(tab => (
              <div key={tab.label} className="layer-card">
                <strong>{tab.label}</strong>
                <p className="layer-desc">{tab.goal}</p>
                <ul className="docs-points muted">
                  {tab.details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ))}
    </div>
  )
}

function Partage() {
  return (
    <div className="docs-body">
      <h1>Partage entre agents</h1>
      <Lead>Par défaut, chaque agent est cloisonné. Le partage est un choix conscient, sujet par sujet.</Lead>

      <Section title="Deux outils dans l'onglet Partage">
        <ul>
          <li>
            <strong>Matrice « qui peut lire quoi ».</strong> Pour chaque espace partagé (user, org,
            client, projet, sujet), tu coches les agents autorisés en lecture.
          </li>
          <li>
            <strong>Faits sur toi.</strong> Memoria repère les faits d'identité/préférences dans la
            mémoire d'un agent et te propose de les remonter vers l'espace commun « user », accessible aux
            agents autorisés.
          </li>
        </ul>
      </Section>

      <Section title="Et les personnes ?">
        <p>
          L'onglet <strong>Personnes</strong> répond à une autre question : <em>qui parle à l'agent ?</em>{' '}
          Toi le plus souvent, mais aussi des collègues, des stagiaires, un client. En leur associant des
          identifiants (numéro Telegram/WhatsApp, e-mail, handle), l'agent <strong>reconnaît</strong> son
          interlocuteur et sait ce qu'il peut partager avec lui.
        </p>
      </Section>

      <Callout kind="warn">
        Règle d'or : <strong>Memoria propose, tu décides.</strong> Rien ne sort de l'espace privé d'un
        agent sans une action explicite de ta part.
      </Callout>
    </div>
  )
}

function MultiMachines() {
  return (
    <div className="docs-body">
      <h1>Synchro multi-machines</h1>
      <Lead>
        Plusieurs Mac ? Memoria peut partager la mémoire commune entre eux, en restant 100 % sur ton
        réseau local — jamais le cloud.
      </Lead>

      <Section title="Le modèle : hub &amp; spokes">
        <p>
          Une machine toujours allumée devient le <strong>hub</strong> (la référence). Les autres
          (<strong>spokes</strong>) en gardent une copie locale complète et se synchronisent avec lui. Chaque
          spoke fonctionne <strong>hors-ligne</strong> ; quand le hub revient, tout converge.
        </p>
      </Section>

      <Section title="Mettre en place (en terminal ou via Réglages → Synchro)">
        <ol className="docs-steps">
          <li>Sur la machine-hub : <code>memoria sync init-hub</code>, puis redémarre le service.</li>
          <li>Toujours sur le hub : <code>memoria sync invite</code> — affiche un code (valable 10 min) et l'adresse du hub.</li>
          <li>Sur la nouvelle machine : <code>memoria sync join --hub &lt;ip:port&gt; --code XXXX-XXXX</code>.</li>
        </ol>
        <p className="muted">
          La nouvelle machine reçoit alors les espaces partagés et le coffre, et devient opérationnelle —
          même hors-ligne.
        </p>
      </Section>

      <Section title="Ce qui circule (et ce qui ne circule jamais)">
        <ul>
          <li><strong>Synchronisé :</strong> les espaces partagés (user, org, client, projet, sujets) et, sur opt-in explicite, certains secrets — toujours chiffrés en transit.</li>
          <li><strong>Jamais synchronisé :</strong> la mémoire privée de chaque agent, la quarantaine de revue, les métriques d'usage locales. Les routes d'admin restent strictement en local (127.0.0.1).</li>
        </ul>
      </Section>

      <Callout>
        Les clés de chiffrement vivent dans le Keychain, jamais en clair sur le disque. Chaque requête
        réseau est signée (anti-interception, anti-rejeu). En cas d'édition concurrente du même fait, une
        règle déterministe tranche et le perdant est conservé pour audit.
      </Callout>
    </div>
  )
}

function Securite() {
  return (
    <div className="docs-body">
      <h1>Sécurité &amp; vie privée</h1>
      <Lead>La confidentialité n'est pas une option de Memoria : c'est sa raison d'être.</Lead>

      <Section title="Local d'abord, absolument">
        <p>
          Tout vit sur ta machine. Cette interface ne parle qu'au service local. Pas de télémétrie, pas
          de compte, pas de serveur distant. La synchro multi-machines, si tu l'actives, reste sur ton
          réseau local.
        </p>
      </Section>

      <Section title="Les secrets ne deviennent jamais des souvenirs">
        <p>
          Avant tout stockage, un filtre détecte clés API et mots de passe et les retire. La valeur part
          dans le <strong>Coffre</strong> (Keychain macOS, ou un coffre chiffré AES-256-GCM) ; la mémoire
          n'en garde qu'une <strong>référence</strong>. La valeur n'apparaît jamais dans les logs, ni à
          l'écran, ni sur le réseau.
        </p>
      </Section>

      <Section title="Isolation des clients">
        <p>
          Un souvenir rattaché à un client ne peut pas ressortir pour un autre. Cette garantie est
          mesurée à chaque version par un test de référence qui exige <strong>0 % de fuite</strong>.
        </p>
      </Section>

      <Section title="Tout est traçable, rien n'est espionné">
        <p>
          L'onglet <strong>Journal</strong> enregistre les actions (qui, quoi, quand) <em>sans jamais</em>{' '}
          stocker le contenu des souvenirs. Et la suppression est réelle : un <code>forget</code> efface
          partout, définitivement.
        </p>
      </Section>
    </div>
  )
}

const CLI_GROUPS: Array<{ title: string; cmds: Array<[string, string]> }> = [
  {
    title: 'Démarrage',
    cmds: [
      ['memoria', 'Ouvre cette interface (c\'est la commande par défaut = memoria ui).'],
      ['memoria init', 'Initialise Memoria (config + stockage) et démarre le service.'],
      ['memoria start / stop', 'Démarre / arrête le service en arrière-plan.'],
      ['memoria autostart on|off', 'Active / désactive le lancement au login (launchd).'],
      ['memoria update', 'Met Memoria à jour (git pull + build) et redémarre.'],
    ],
  },
  {
    title: 'Agents',
    cmds: [
      ['memoria pair <type>', 'Génère un code de pairing pour connecter un agent.'],
      ['memoria agents', 'Liste les agents connus (type, machine, état).'],
      ['memoria revoke <id>', 'Révoque un agent : son jeton n\'est plus accepté.'],
      ['memoria delete-agent <id>', 'Supprime un agent ET efface sa mémoire privée (irréversible).'],
    ],
  },
  {
    title: 'Mémoire',
    cmds: [
      ['memoria import --instance <id>', 'Importe les souvenirs d\'un agent (--transcripts ou --legacy).'],
      ['memoria export', 'Exporte la mémoire en fichiers Markdown (un par thème).'],
      ['memoria forget --id … / --query …', 'Supprime définitivement des souvenirs (hard-delete).'],
      ['memoria stats', 'Compteurs globaux (souvenirs, bases, instances).'],
      ['memoria doctor', 'Vérifie la santé du stockage (DB, garde réseau, WAL).'],
      ['memoria audit', 'Affiche le journal d\'audit (sans contenu).'],
    ],
  },
  {
    title: 'Contrôle',
    cmds: [
      ['memoria disable / enable', 'Met en pause / relance la capture et le recall.'],
      ['memoria move --to <chemin>', 'Déplace toute la mémoire (ex. clé USB) et met à jour la config.'],
    ],
  },
  {
    title: 'Synchro multi-machines',
    cmds: [
      ['memoria sync status', 'État de la synchro (rôle, hub, pairs).'],
      ['memoria sync init-hub', 'Désigne cette machine comme hub.'],
      ['memoria sync invite', 'Génère un code one-shot pour relier une machine.'],
      ['memoria sync join --hub … --code …', 'Relie cette machine à un hub.'],
      ['memoria sync now', 'Force une passe de synchro.'],
      ['memoria sync leave', 'Quitte le groupe (garde les souvenirs déjà reçus).'],
    ],
  },
]

function Cli() {
  return (
    <div className="docs-body">
      <h1>Commandes CLI</h1>
      <Lead>
        Tout ce que fait cette interface est aussi accessible en terminal avec la commande{' '}
        <code>memoria</code>. Ajoute <code>--help</code> à n'importe quelle commande pour le détail.
      </Lead>
      {CLI_GROUPS.map(group => (
        <Section key={group.title} title={group.title}>
          <table className="docs-table">
            <tbody>
              {group.cmds.map(([cmd, desc]) => (
                <tr key={cmd}>
                  <td><code>{cmd}</code></td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ))}
    </div>
  )
}

const FAQ: Array<{ q: string; a: ReactNode }> = [
  {
    q: 'Le Tableau de bord affiche une alerte rouge « moteur indisponible ».',
    a: <>Aucun moteur d'extraction n'est joignable. Va dans <strong>Réglages</strong>, choisis un provider (Ollama recommandé) et clique « Tester ». Tes conversations en attente seront traitées dès qu'un moteur répond — rien n'est perdu.</>,
  },
  {
    q: 'Cette interface dit « Le service Memoria ne répond pas ».',
    a: <>Le service local n'est pas lancé. Dans un terminal : <code>memoria start</code> (ou simplement <code>memoria</code> pour rouvrir l'UI).</>,
  },
  {
    q: 'Je viens de mettre à jour mais je ne vois pas mes changements.',
    a: <>Le service sert une version en cache. Relance-le (<code>memoria stop &amp;&amp; memoria start</code>) puis recharge la page (Cmd-Shift-R pour vider le cache du navigateur).</>,
  },
  {
    q: 'Un agent ne mémorise rien.',
    a: <>Vérifie le sélecteur <strong>Capture</strong> en bas à gauche : s'il est sur <strong>Pause</strong>, rien n'est écrit. Vérifie aussi que l'agent est bien connecté (onglet <strong>Agents</strong>) et qu'un moteur est prêt.</>,
  },
  {
    q: 'Comment supprimer définitivement un souvenir ?',
    a: <>Onglet <strong>Mémoire</strong> → cherche-le → « Oublier ». La suppression est réelle et partout. En terminal : <code>memoria forget --query "…"</code>.</>,
  },
  {
    q: 'Mes données partent-elles quelque part ?',
    a: <>Non. Tout reste sur ta machine. Seule exception : si tu choisis un moteur <em>cloud</em> (OpenAI/Anthropic/OpenRouter), le texte à analyser est envoyé à ce fournisseur pour l'extraction. Avec Ollama/LM Studio, même ça reste 100 % local.</>,
  },
  {
    q: 'Comment mettre à jour Memoria ?',
    a: <><code>memoria update</code> en terminal (git pull + build + redémarrage), ou le bouton de mise à jour dans <strong>Réglages</strong>.</>,
  },
]

function Faq() {
  return (
    <div className="docs-body">
      <h1>FAQ &amp; dépannage</h1>
      <Lead>Les questions et blocages les plus courants.</Lead>
      {FAQ.map((item, i) => (
        <Section key={i} title={item.q}>
          <p>{item.a}</p>
        </Section>
      ))}
      <Callout kind="tip">
        Un souci non listé ? Le bouton « Signaler un bug » du site Memoria, ou{' '}
        <code>memoria doctor</code> pour un diagnostic du stockage.
      </Callout>
    </div>
  )
}

// --------------------------------------------------------------------- navigation

type DocSection = { id: string; label: string; group: string; render: () => ReactNode }

const SECTIONS: DocSection[] = [
  { id: 'welcome', label: 'Bienvenue', group: 'Démarrer', render: () => <Bienvenue /> },
  { id: 'start', label: 'Démarrage rapide', group: 'Démarrer', render: () => <Demarrage /> },
  { id: 'how', label: 'Comment ça marche', group: 'Démarrer', render: () => <CommentCaMarche /> },
  { id: 'memories', label: 'Souvenirs & mémoire', group: 'Concepts', render: () => <Souvenirs /> },
  { id: 'capture', label: 'Modes de capture', group: 'Concepts', render: () => <Capture /> },
  { id: 'engine', label: 'Moteur d\'intelligence', group: 'Concepts', render: () => <Moteur /> },
  { id: 'layers', label: 'Couches cognitives', group: 'Concepts', render: () => <Couches /> },
  { id: 'tabs', label: 'Guide des onglets', group: 'Utiliser', render: () => <GuideOnglets /> },
  { id: 'sharing', label: 'Partage entre agents', group: 'Utiliser', render: () => <Partage /> },
  { id: 'sync', label: 'Synchro multi-machines', group: 'Utiliser', render: () => <MultiMachines /> },
  { id: 'security', label: 'Sécurité & vie privée', group: 'Référence', render: () => <Securite /> },
  { id: 'cli', label: 'Commandes CLI', group: 'Référence', render: () => <Cli /> },
  { id: 'faq', label: 'FAQ & dépannage', group: 'Référence', render: () => <Faq /> },
]

const GROUP_ORDER = ['Démarrer', 'Concepts', 'Utiliser', 'Référence']

export function Docs() {
  const [active, setActive] = useState<string>(SECTIONS[0]?.id ?? 'welcome')
  const current = SECTIONS.find(s => s.id === active) ?? SECTIONS[0]

  if (!current) return null

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Docs</h1>
          <p className="muted">Le mode d'emploi complet de Memoria — concepts, onglets, moteur d'IA, partage, multi-machines, CLI.</p>
        </div>
      </header>

      <div className="docs-layout">
        <nav className="docs-subnav" aria-label="Sections de la documentation">
          {GROUP_ORDER.map(group => (
            <div key={group}>
              <div className="docs-subnav-group">{group}</div>
              {SECTIONS.filter(s => s.group === group).map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={`${active === s.id ? 'docs-active' : ''}`}
                  onClick={() => setActive(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div>{current.render()}</div>
      </div>
    </section>
  )
}
