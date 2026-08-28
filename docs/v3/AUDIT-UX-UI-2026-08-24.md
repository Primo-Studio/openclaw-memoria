# Memoria — État des lieux UX/UI (2026-08-24)

> ⚠️ **Snapshot du 24/08** — les P0/P1 sont faits ; l'état des P2 est re-daté au 27/08 en § 9. État courant : `STATUS.md`.

> **Cible : utilisateur NON-TECHNIQUE.** Audit de l'app web (les 16 écrans + coquille +
> design system + composants), pour préparer des tests et prioriser les améliorations.
> Méthode : 3 explorations parallèles (écrans cœur / connexions-onboarding / gouvernance-design)
> + lecture de `App.tsx`. Tout est en `file:line` dans le corps. **Rien n'a été modifié.**

## Résumé en une page
Le **socle est sain** : i18n propre (toutes les clés résolvent), un helper `humanError()` qui
traduit les erreurs techniques en langage humain (`ui.tsx:38-48`), des composants d'état
(`useLoad`/`Spinner`/`ErrorBanner`/`EmptyState`/`ConfirmButton`) bien pensés, une vraie
vulgarisation par endroits (scopes « Privé » / « Partagé avec tous vos agents »). **Le problème
n'est pas le moteur, c'est que l'UX a grossi par accumulation** (le commentaire de `App.tsx` dit
« 5 écrans », il y en a 16) et que le bon socle n'est appliqué qu'à moitié.

**Les 6 chantiers qui comptent le plus pour un débutant :**
1. **Le parcours de connexion d'un agent** — le chemin facile (détecter + 1 clic) existe mais est
   **absent de l'Onboarding**, qui impose le chemin dur (coller une commande dans un terminal), et
   **ne vérifie pas** que la connexion a réussi → l'utilisateur boucle sans comprendre.
2. **Navigation** — 16 onglets à plat, plusieurs très techniques, **pas de regroupement**, et **pas
   de routeur** (le bouton Précédent du navigateur ne fait rien).
3. **Recherche de souvenirs** — pas de compteur, pas de pagination, pas de recherche au frappé,
   **badges non cliquables** (occasion en or : badge → filtre), et une **suppression qui peut mentir**.
4. **Suppressions en 1 clic sans filet** — plusieurs actions destructrices/de sécurité sans
   confirmation ni annulation (Revue, Mémoire, matrice de partage, identifiants).
5. **Design** — **pas de thème clair** (que du sombre), **focus clavier quasi invisible**,
   contrastes limites, texte descriptif trop petit, tableaux non responsive.
6. **Confiance** — l'app promet « 100 % local, rien ne part dans le cloud » mais **recommande par
   défaut l'option cloud** (OpenAI), et laisse des **noms/numéros personnels du dev** dans les textes.

---

## 0. Ce qui est DÉJÀ BIEN (à préserver, ne pas régresser)
- `humanError()` : 401 → « Session expirée, relancez memoria », TypeError → « le service ne répond
  pas ». Excellent (`ui.tsx:38-48`).
- `useLoad` : loading→ready|error avec `reload`, jamais de « mort silencieuse » (`ui.tsx:61-90`).
- Vulgarisation des scopes (`Memory.tsx:189-194`), messages de vide **différenciés** (rien vs rien
  pour cette recherche).
- Tableau de bord : **anti-mort-silencieuse** (bannière « moteur d'extraction indisponible » + file
  en attente + bouton Configurer), meilleure gestion d'états de l'app (`Dashboard.tsx:168-217`).
- `ConfirmButton` deux-temps sans `window.confirm` moche (`ui.tsx:152-189`).
- Chemin de connexion « facile » `MachineAgents` : détecter → 1 clic → import avec barre de
  progression (`Agents.tsx:203-347`). Très bon — mais mal placé (cf. §2).

---

## 1. Navigation & architecture de l'information
- **16 entrées à plat** sans regroupement (`App.tsx:33-36`) : Tableau de bord, Agents, Mémoire,
  Thèmes, Récurrences, Procédures, Revue, Révisions, Maintenance, Partage, Personnes, Coffre,
  Système, Journal, Réglages, Docs. Un débitant n'en comprend spontanément que ~5. La doc, elle,
  les range déjà en **5 familles** (`Docs.tsx:325-423` : Pilotage / Mémoire / Contrôle / Partage /
  Sécurité) — **à réutiliser dans la nav** + replier **Système, Journal, Coffre, Révisions,
  Maintenance, Récurrences** sous « Avancé ».
- **Pas de routeur** : l'écran courant est un `useState` (`App.tsx:68`) → **bouton Précédent mort**,
  rafraîchir ramène au Tableau de bord, aucun lien partageable/marquable. Friction majeure.
- **Pas de badge de compteur** sur « Revue » alors que le nombre en attente est déjà connu
  (`walPending`, `Dashboard.tsx:74`).
- **Sélecteur de langue** en 2ᵉ position permanente (`App.tsx:93`), **drapeaux = langues**
  (anti-pattern : 🇵🇹 pour tous les lusophones), `lang.hint` jamais affiché, pas de retour à
  « langue du système ». → le descendre dans Réglages/pied, noms de langues au lieu de drapeaux.
- **Écran d'accueil `Welcome` non traduit** (français en dur, `App.tsx:214-232`) et demande de
  **lancer une commande terminal** — barrière frontale pour qui arrive par le navigateur.

## 2. Connexions d'agents & Onboarding (le parcours le plus critique)
Deux chemins coexistent, et le débutant subit le pire en premier.
- **Chemin facile** (`MachineAgents`, `Agents.tsx:203-347`) : détection + « Connecter » 1 clic +
  import. **N'existe QUE sur l'écran Agents, après l'onboarding.**
- **Chemin dur** (pairing) : générer un code, copier une commande, aller dans le terminal de
  l'agent, coller, revenir. C'est **ce que l'Onboarding impose à l'étape 4** (`Onboarding.tsx:258-293`).

**P0 :**
- **Aucune vérification de connexion à l'étape 4** (`Onboarding.tsx:279-289`) : pas de « en
  attente… ✓ connecté », « Terminer » actif quoi qu'il arrive. Or `App.tsx:74-77` relance
  l'onboarding tant que 0 agent → l'utilisateur qui « termine » sans coller la commande **est
  renvoyé au début sans explication**. Boucle inexpliquée.
- **Le chemin facile est absent de l'onboarding.** Réutiliser `MachineAgents` à l'étape 4 = la
  reco la plus rentable de tout l'audit.
- **La détection n'est pas automatique** : la section « Sur cette machine » démarre vide, il faut
  cliquer « 🔍 Détecter » (`Agents.tsx:300`). Un débutant ne sait pas qu'il y a quelque chose à faire.
  → lancer `detect()` au montage.
- **Impasses d'erreur** : `flow.step==='failed'` n'affiche qu'une bannière sans « Réessayer » ni
  « Fermer » (`Agents.tsx:342`) ; l'import peut rester en **spinner infini** (erreurs de polling en
  `console.warn` seulement, pas de timeout, `Agents.tsx:288-291`).

**Onboarding — ce qui perd un non-technophile :**
- **Étape 3 « Moteur d'intelligence » surchargée** : 5-6 cartes de fournisseurs + guides + le
  composant embeddings entier + bouton Tester + encart « mode dégradé », dans une seule vue
  (`Onboarding.tsx:397-467`). À scinder / masquer les fournisseurs avancés.
- **Jargon massif** : embeddings, vecteurs, extraction, OAuth, MCP, daemon, « mode dégradé ».
- **Contradiction de confiance (P1 mais critique)** : l'app dit « Rien ne part dans le cloud »
  (`foot.local`, `onboarding.welcome`), mais l'embeddings **recommandé** est OpenAI avec l'indice
  « tes souvenirs sont envoyés à OpenAI » (`EmbeddingsChooser.tsx:142` + `fr.ts:15`), le local étant
  étiqueté « avancé ». **On vend le local et on recommande le cloud.** À réconcilier (recommander le
  local sur machine capable — les `caps` existent déjà — ou reformuler la promesse).
- **Contradiction clé API** : `onboarding.apikey.note` dit « Memoria ne te demandera jamais de
  coller ta clé ici » (`fr.ts:629`) juste au-dessus d'une commande shell à taper, alors que le champ
  mot de passe pour coller la clé est juste en dessous (`EmbeddingsChooser.tsx:150-160`).
- **Mode dégradé = seule issue sans moteur**, présentée comme une action dangereuse `btn-danger`
  (`Onboarding.tsx:461`) ; le `Wizard` a un bouton « Passer » (`Wizard.tsx:70`) jamais fourni.
- **Repères d'étape absents** : dots `aria-hidden` (`Wizard.tsx:52`), pas de « Étape 3 sur 4 ».

## 3. Recherche & Mémoire (`Memory.tsx`)
- **P0 — la suppression peut mentir** : si le serveur renvoie `deleted===0`, on log un warning
  puis **on retire quand même la ligne** (`Memory.tsx:83-91`). L'utilisateur croit avoir supprimé ;
  rien n'a bougé côté serveur. Et `forget` est un **hard-delete sans annulation** (`api.ts:290`).
- **Pas de compteur de résultats** (`facts.length` jamais affiché), **pas de pagination** (elle
  existe pourtant dans Journal, `Audit.tsx:140-151`) → sur un gros corpus, liste tronquée en silence
  ou interminable.
- **Recherche à soumission manuelle** (clic « Rechercher »), pas de recherche au frappé/debounce →
  « ça fait lent » pour qui vient de Google/Spotlight.
- **Badges non cliquables** (thème/catégorie/scope, `Memory.tsx:170-175`) : impossible de filtrer
  « tous les souvenirs de ce thème » d'un clic. **Amélioration la plus rentable de l'écran.**
- **Pas de surlignage** du terme trouvé ; **changer d'agent efface les résultats** mais garde le
  texte (lu comme un bug) ; **course de requêtes** possible (pas de garde `cancelled`).
- `machine_id` brut dans le sélecteur d'agent (`Memory.tsx:115`) ; repli de scope peut afficher un
  identifiant tronqué (`:193`).
- **Bien** : recherche globale multi-agents présente et différenciée, messages de vide distincts.

## 4. Thèmes (`Themes.tsx`)
- **P0 — bannière d'erreur COLLANTE** : `setError` appelé 6×, `setError(null)` **jamais** → une
  erreur affichée persiste toute la session, survit aux actions réussies et au changement d'agent.
- **`refineTopics` réussi mais 0 résultat = affiché comme ERREUR** (`Themes.tsx:100`) — alarmant à tort.
- **Thèmes à 1 souvenir masqués** (`minFacts=2` en dur, `:51`) sans le dire ni bascule « tout afficher ».
- **Slug d'agent brut** (`assistant_type`, `:115`) alors que `agentTypeLabel()` existe — **3
  mécanismes de libellé d'agent coexistent** dans l'app (brut ici / helper dans Mémoire / map locale
  dans Dashboard). À unifier.
- Graphe SVG **hover-only** → inutilisable au tactile ; pas de passerelle « Voir dans Mémoire ».

## 5. Écrans trop techniques (à simplifier / replier)
- **Système** (`System.tsx`) : « 24 couches cognitives » avec `wal_buffer`, `embeddings`,
  `fact_clusters`… = écran de debug déguisé. **Sortir de la nav**, mettre derrière « Sous le capot ».
- **Journal/Audit** (`Audit.tsx`) : hashes tronqués, actions `pair_assistant`/`revoke_instance`,
  colonne « Scope » abstraite → regrouper sous « Sécurité / Avancé ».
- **Récurrences / Procédures / Révisions** : même schéma « choisir un agent → trier des cartes » que
  Revue et Maintenance → **regrouper les 5 sous une seule section « À valider »** avec un badge de
  compteur, au lieu de 5 entrées de nav.
- Sélecteurs d'agent = `assistant_type` brut partout (`Patterns.tsx:80`, `Procedures.tsx:50`,
  `Revisions.tsx:85`) alors que `agentTypeLabel()` existe.

## 6. Suppressions & actions de sécurité (filet manquant)
- **Revue** : rejeter un souvenir individuel = **suppression définitive en 1 clic sans confirmation**
  (`Review.tsx:112-119`), alors que le rejet de masse, lui, confirme (`:66`). Incohérent, pas d'undo.
- **Matrice de partage** : cocher une case **accorde l'accès en lecture instantanément** sans
  confirmation ni annulation (`Sharing.tsx:112-118`) — une action de sécurité traitée comme un
  réglage anodin.
- **Personnes** : retirer un identifiant = ✕ brut sans confirmation (`Persons.tsx:206`), alors que
  supprimer une personne passe par `ConfirmButton`. Deux poids deux mesures.
- **Bien** : « Effacer la mémoire d'un agent » est bien protégé (`Agents.tsx:570`).

## 7. Design system, thème, responsive, accessibilité (`styles.css`)
- **Pas de thème clair** : uniquement sombre en dur, aucun `prefers-color-scheme`, aucune bascule
  (`styles.css:1-20`). Manque majeur pour la lisibilité en plein jour et l'accessibilité. **Priorité haute.**
- **Focus clavier quasi absent** : seuls `select`/`input[search]` ont un `:focus`. **Aucun**
  `:focus-visible` sur boutons, nav, cartes, cases → navigation clavier invisible. + pas de skip-link,
  focus non déplacé sur `<main>` au changement d'écran. **Priorité haute (accessibilité).**
- **Contrastes limites** : `--text-muted #9b99b4` sur fond sombre (~4:1, sous le seuil AA 4.5:1)
  utilisé massivement, y compris pour les explications principales.
- **Texte descriptif trop petit** : beaucoup de hints/descriptions sous 13px (0.68–0.84rem).
- **Tableaux non responsive** (Journal, Coffre) : pas de conteneur `overflow-x:auto` → débordent sur
  téléphone. **Nav mobile** = barre de 16 onglets à défilement horizontal, pas de menu repliable.
- **Variables CSS fantômes** (`--card`, `--muted`, `--surface`, `--err`, `--bg-input`, un `--danger`
  divergent `#d84a3f`) → deux gris et deux rouges cohabitent. À unifier sur `:root`.
- Pas de `prefers-reduced-motion` (spinner tourne en continu).

## 8. Cohérence & finitions
- **Le bon socle `ui.tsx` n'est utilisé qu'à moitié** : Revue/Récurrences/Procédures/Révisions/
  Maintenance/Thèmes **réimplémentent** spinner/erreur/vide à la main → **bannières d'erreur sans
  bouton « Réessayer »**, messages bruts qui ne passent pas par `humanError`. À faire converger.
- **Vocabulaire** : « faits » (Partage) vs « souvenirs » (Agents/Onboarding) = le même objet.
  **Choisir un seul mot** (« souvenirs »).
- **Noms/numéros personnels du dev dans les textes livrés (P1, gênant en prod)** : « l'utilisateur
  (Néto) » (`fr.ts:720`), « ex. Badette », « Ajoute Néto, Badette, tes stagiaires », numéros
  `+594 6xx` (Guyane) en placeholders. → exemples neutres (Alice, +33…).
- **Libellés codés en français en dur** malgré le sélecteur de langue : Wizard (« Retour / Passer /
  Terminer »), `ui.tsx` (« Réessayer », « Copié ! », « Chargement… », messages `humanError`,
  `AGENT_TYPE_LABELS`). En changeant de langue, erreurs et pied d'onboarding restent en français.
- Scope technique `user` montré à l'utilisateur (« Partager vers "user" ») → « Tous mes agents ».
- `IdentifyTester` (outil de vérif) placé **au-dessus** de l'ajout de personne (`Persons.tsx:57`).

---

## 9. Plan priorisé (consolidé, dédupliqué)

### P0 — l'utilisateur reste bloqué ou cassé en silence — ✅ TOUS FAITS le 24/08
1. ✅ Onboarding étape 4 : **vérifier la connexion** (polling `getAgents` toutes les 3 s, « en attente →
   ✓ connecté »), « Terminer » désactivé tant que 0 agent (`Onboarding.tsx`).
2. ✅ **`MachineAgents` (détecter + 1 clic) réutilisé dans l'onboarding** en chemin principal ; pairing
   par commande replié dans un `<details>` « connexion manuelle ».
3. ✅ **Détection auto au montage** de « Sur cette machine » (`Agents.tsx` : `useEffect(detect, [])`).
4. ✅ **Mémoire : ligne conservée si `deleted===0`** + avertissement `memory.forget_no_effect` (5 langues).
5. ✅ **Thèmes : bannière collante corrigée** (`setError(null)` sur chaque chargement/action ;
   `refineTopics`=0 → note neutre, plus une alerte).
6. ✅ **Impasses d'erreur** : `flow==='failed'` a « Fermer » + « Réessayer » ; **timeout** sur l'import
   (abandon après ~8 s sans réponse) et sur `getMachineCaps` (message de repli, plus de spinner infini).

> **Vérifié** : build (tsc+vite) OK, **686 tests verts**, parité i18n 5 langues.

### P1 — il termine mais se méfie ou se trompe — ✅ TOUS FAITS le 24/08 (build + 686 tests verts, i18n 5 langues)
> Nav regroupée (Essentiel/Avancé) + badge Revue · routeur par hash (bouton Précédent OK) · Mémoire
> compteur + badges cliquables (filtres) · confidentialité reformulée + contradiction clé API levée ·
> confirmations sécurité (Revue/Partage/Personnes) · exemples perso neutralisés + « Faits »→« Souvenirs »
> + libellés en dur traduits (Wizard/ui.tsx) · **thème clair + bascule** + focus clavier + skip-link +
> reduced-motion. `humanError` traduit le 25/08 (`translate('error.*')`). L'exemple perso restant
> (« le Mac Studio de Koda » dans `settings.sync.makeHubDesc`, 5 langues) a été neutralisé le 27/08.

7. **Regrouper la nav** (Essentiel / Avancé, 5 familles) + **badge « en attente » sur Revue**.
8. **Routeur / URL par écran** (bouton Précédent, rafraîchissement stable, liens).
9. **Badges cliquables = filtres** dans Mémoire + **compteur de résultats** + pagination.
10. **Résoudre la contradiction confidentialité vs défaut cloud** (recommander le local sur machine
    capable, ou reformuler la promesse) + **supprimer la contradiction clé API**.
11. **Confirmer les actions de sécurité** (toggles de partage, suppression d'identifiant, rejet
    individuel en Revue) + **undo** là où c'est irréversible.
12. **Remplacer noms/numéros perso** par des exemples neutres ; **unifier « souvenirs »** ;
    **traduire les libellés en dur** (Wizard/ui.tsx).
13. **Thème clair + bascule** (et `prefers-color-scheme`) ; **focus-visible global** + skip-link.

### P2 — finition (état re-daté 27/08)
14. ⚪ Uniformiser tous les écrans sur `Spinner`/`ErrorBanner(+Réessayer)`/`EmptyState`/`humanError` (Settings sans ErrorBanner ; Dashboard/Audit/System/Review/Vault sans humanError).
15. 🟡 Recherche au frappé (debounce) + garde anti-course : ✅ Maintenance (27/08, `a963083`) ; ⚪ Mémoire (formulaire à soumission) ; ⚪ surlignage.
16. ✅ Libellé d'agent unifié via `agentTypeLabel()` (25/08).
17. ✅ Tableaux responsive (25/08) ; ✅ menu hamburger mobile (27/08, `1854b4a`) ; ✅ en-têtes de tri au clavier (27/08, `7c913ef`). Reste : focus trap / retour de focus du hamburger.
18. ✅ « Étape X sur 4 » (`wizard.progress`) ; ✅ « Copié » honnête + reset (27/08, `4ef55b4`).
19. ⚪ Vulgariser `doctor.warnings` et tout repli qui montre un identifiant brut.
20. ✅ `prefers-reduced-motion` ; 🟡 variables CSS fantômes aliasées (`f163b6d`, thème clair) ; ⚪ taille plancher du texte.

---

## 10. Checklist de tests (à faire passer à un vrai non-technophile)
Faire réaliser ces tâches **sans aide et sans jamais ouvrir un terminal**, et noter où ça bloque :
1. **Première mise en route** : depuis zéro, connecter son premier agent. (Attendu : réussir sans
   coller de commande — aujourd'hui ✗ dans l'onboarding.)
2. **Trouver un souvenir précis** par mot-clé, puis « tous les souvenirs de ce thème ». (Attendu :
   compteur, filtre par badge — aujourd'hui ✗.)
3. **Supprimer un souvenir** puis vérifier qu'il est vraiment parti (recharger). (Attendu : pas de
   fausse suppression — aujourd'hui ✗ possible.)
4. **Se tromper puis revenir en arrière** (bouton Précédent du navigateur). (Attendu : marche —
   aujourd'hui ✗.)
5. **Changer de langue** et vérifier que TOUT suit, y compris les erreurs et le bas de l'onboarding.
   (Attendu : tout traduit — aujourd'hui ✗ partiel.)
6. **Utiliser l'app sur téléphone** (naviguer, chercher, lire un tableau). (Attendu : lisible —
   aujourd'hui ✗ partiel.)
7. **Naviguer entièrement au clavier** (Tab) : voir où on est. (Attendu : focus visible —
   aujourd'hui ✗.)
8. **Comprendre l'écran d'accueil** : « qu'est-ce que je fais ici ? » sans jargon.
9. **Partager un réglage de sécurité** (qui peut lire quoi) et pouvoir annuler. (Attendu :
   confirmation + undo — aujourd'hui ✗.)
10. **Provoquer une erreur** (couper le service) : le message est-il humain + « Réessayer » ?
    (Attendu : oui partout — aujourd'hui ✗ selon l'écran.)

> Ordre conseillé de chantier : **P0 (parcours de connexion + suppressions honnêtes + impasses)**
> avant tout — c'est ce qui fait qu'un débutant réussit ou abandonne. Puis **navigation + thème
> clair + accessibilité**. Le reste est finition.
