# Journal des étapes — consolidation Memoria (2026-08-24)

> Demande de Néto : consolider l'existant, **approuver** la quarantaine, documenter les étapes,
> et produire une **lecture par sujet/thème** de ce que Memoria a appris.
> Machine : **MacBook-Pro-de-Primo.local** (192.168.1.23) — poste qui héberge la mémoire principale.

## 1. Réalignement du runtime (fait avant tout)
- `git fetch` : le dépôt local était **60 commits en retard** sur `origin/memoria-v1` → `git merge --ff-only`.
- **Vérif branche** : `memoria-v1` est la ligne vivante (141 commits devant `main`, figée en mars) ;
  tag `v4.0.0` (21/07) est SUR memoria-v1. Tip = `6fb0bcf`.
- **Mesuré sur ce poste** (Node v22.22.2) : `npm install && npm run build` → `tsc -b` + vite **OK** ;
  `npm test` → **682 tests / 64 fichiers PASSENT** (pas de souci ABI better-sqlite3).
- **Demi-migration résolue** : marqueur `.memoria-built-sha` posé sur HEAD + `memoria stop && start`
  → daemon **redémarré** (pid 6068), `/v1/admin/version` = SHA `6fb0bcf`. Port 52999→59062.
  Motif : sinon le daemon tournait l'ancien code et le bouton « Mise à jour » de l'UI aurait menti.

## 2. Sauvegarde AVANT toute écriture
- `cp -R ~/.memoria/data ~/.memoria/backup-pre-approve-20260824` (**208 Mo**). Restauration = recopier ce dossier.

## 3. Approbation de la quarantaine (2266 faits dormants)
- **Mécanisme officiel utilisé** (pas de SQL brut) : routes daemon
  `GET /v1/admin/review` (liste les items `pending`) + `POST /v1/admin/review/approve` (`reviewDecision`
  → `lifecycle_state='active'` + trace d'audit `review_accepted`).
- **Boucle par lots** (100/lot, l'API plafonne à 500) jusqu'à file vide : **23 lots → 2266 approuvés**.
- **Vérif après** (lecture SQLite en base) : **0 dormant**. Répartition active :
  - Claude Code (`72615d82`) : **1027** (était 6 actifs + 1021 dormants)
  - Codex (`0b5322e1`) : **1245** (était 1245 dormants)
  - Koda / OpenClaw (`405290ba`) : **3515** (déjà actifs)
  - 3 bases vides. **Total = 5787 faits actifs.**
  > ⚠️ **27/08** : l'auto-import launchd (toutes les 6 h, 1 523 fichiers Claude Code le 27/08 14:12) a **recréé des milliers
  > de dormants** (4 238 des 5 286 vecteurs de la base Claude Code sont des faits en quarantaine). Lu seul, ce § ferait croire
  > que la Revue est vide : elle se re-remplit à chaque passage → tri récurrent (TODO).

## 4. Lecture par sujet et par thème (livrable Néto)
- **Fichier** : `/Users/primostudio/Memoria-Lecture-Par-Theme.html` (~1,3 Mo, autonome, hors-ligne,
  clair/sombre, **recherche instantanée**, **filtre par agent**). Reste **local** (données perso, ne quitte pas la machine).
- **Source** : faits lus en base (readonly) + thèmes via `GET /v1/admin/topics` (seuil **≥3 faits** =
  thème lisible) + `GET /v1/admin/topic_facts`. Chaque fait n'apparaît qu'une fois.
- **Contenu** : Claude Code **28 thèmes**, Codex **32 thèmes**, Koda **71 thèmes** (131 au total) ;
  le reste (faits isolés) regroupé par agent sous « **Autres (hors grand thème)** » — **rien n'est masqué**.
  > Note honnête : la majorité des faits sont des one-offs → le bloc « Autres » est volumineux
  > (c'est la vraie longue traîne, pas une troncature). Baisser le seuil créerait des centaines de
  > micro-thèmes illisibles ; ≥3 est le bon compromis.
- **Régénérer** : ⚠️ le script `gen-lecture.js` vivait dans le scratchpad d'une session Claude Code et **n'est pas dans le
  dépôt** — la régénération n'est plus disponible ; le fichier HTML existant reste consultable. Alternative versionnée :
  `memoria export` (Markdown par thème, `--agent`, `--flat`). Idée d'évolution : `memoria export --by-theme` (⚪) ou un écran UI.

## 5. Scope commun « user » semé (fait)
- Constat : `suggestIdentityFacts` renvoyait **150 candidats mais ~90 % de bruit de tâche** (« souhaite
  auditer tel dépôt », « token expiré »…) — détecteur trop large (P2 « raffiner le tri » confirmé).
  Décision Néto : **ne pas partager le bruit**, semer une liste propre à la main.
- **10 règles durables** écrites et stockées via `memoria_store_fact` (privé, actif) puis **partagées**
  vers le scope `user` (`POST /v1/admin/share` → `{shared:10}`). Vérifié : `shared/user.sqlite` = 10 faits ;
  rappel cross-agent OK (`scopes_searched: ["user", ...]`, faits retrouvés depuis `shared/user.sqlite`).
- Contenu (préférences + infra + identité) : pilotage par prompt · réponses courtes · liens absolus ·
  5 langues V1 · ne pas proposer d'arrêter · clé API avertir 1× · TVA Guyane art. 294 · e-mail officiel ·
  grille 80 €/h + checklist devis · identité Néto/Primo (`primo_frances`).

## 6. UX/UI — choix du moteur d'embeddings (fait) + P0 embeddings épinglé
Demande Néto : l'utilisateur choisit son moteur d'embeddings (local / clé API), reco par défaut =
le plus simple, option avancée possible. **Constat honnête** : « login/OAuth » n'existe pas pour les
embeddings (refusé par design) → deux moteurs réels seulement : **OpenAI (clé API)** et **Ollama (local)**.
Décision Néto : **reco par défaut = OpenAI** (le plus simple), Ollama en avancé.

Livré (2 temps) :
- **(a) Moteur/route/santé + tests** : `setEmbeddingsProvider(provider,model?,dims?,baseUrl?)` (core,
  écrit `[llm.embeddings]`, invalide le cache profil + indexeurs), route `POST /v1/admin/llm_embeddings`
  (restreinte à ollama|openai, lance une **réindexation incrémentale** de fond, renvoie `pending`),
  `embeddingsPending()`, `getLlmProfile()` renvoie désormais `embeddings`, **fix du bloc santé** qui
  imposait « installe Ollama » même avec une clé OpenAI (`llmHealth` recommande selon `options`),
  `LlmEngineHealth.pending`. **3 tests daemon** + 2 tests core mis à jour. **Suite = 685 verts.**
- **(b) UI** : bloc « Recherche sémantique (embeddings) » dans Settings — 2 cartes (OpenAI *recommandé*
  / Ollama *avancé*) pilotées par `llm_health.options`, état sélectionné, saisie de clé OpenAI inline,
  compteur de réindexation (`pending`), note « login non disponible », i18n **FR/EN/ES/PT/DE**.
- **Vérifié live** : `POST llm_embeddings {openai}` → écrit `[llm.embeddings]` dans `config.toml`
  (**P0 « épingler les embeddings » = FAIT**), `pending` 11→0 en 1 s (réindexation OK), faits semés
  désormais retrouvés par la recherche. UI servie par le daemon (bundle à jour).
- ⚠️ L'indexation est **incrémentale** (`NOT EXISTS`) : changer de moteur ne réindexe que les faits
  sans vecteur pour le nouveau modèle (la base porte déjà nomic+openai, d'où un coût quasi nul aujourd'hui).
  Un modèle jamais utilisé (ex. 3-large 3072d) réindexerait tout → coût réel, d'où le compteur `pending`.

## 7. Scan matériel + install locale 1-clic + Onboarding (fait)
Demande Néto : un bouton pour installer vite un modèle **local** si la config le permet ; scanner la
machine, proposer le local si assez puissant, sinon dire que ce n'est pas recommandé.
- **Backend** : `machineCaps()` (core, `node:os` : RAM/cœurs/arch/apple_silicon → verdict great|ok|weak +
  `recommend_local`) + route `GET /v1/admin/machine_caps` + `api.getMachineCaps()` + **1 test daemon**.
  Barème : Apple Silicon ≥16 Go = great, ≥8 = ok, <8 = weak ; sinon x86 ≥32 = great, ≥16 = ok, <16 = weak.
- **Composant partagé** `components/EmbeddingsChooser.tsx` (utilisé par **Settings ET Onboarding**) :
  scan intégré, carte locale qui affiche le verdict, **bouton « Installer le modèle local (1 clic) »**
  (`startOllamaPull(nomic-embed-text)` + polling → bascule auto sur ollama) quand Ollama tourne & machine
  OK ; « Ollama pas lancé → installe l'app sur ollama.com » sinon ; « Non recommandé + Installer quand
  même » si machine faible. i18n +11 clés ×5 langues.
- **Vérifié live** (ce poste) : scan = `{arch:arm64, ram_gb:32, cores:10, apple_silicon:true, verdict:great,
  recommend_local:true}` ; UI servie contient le scan/install. **686 tests verts.**
- Note : le modèle d'embeddings local (`nomic-embed-text`, ~0,3 Go, 768d) est léger — tourne partout ;
  le verdict vise le local « en général » (extraction comprise), la RAM étant le facteur clé.

## 8. Barre d'état Memoria (menu bar macOS / tray Windows) — fait
> ⚠️ **Remplacé le 27/08** (`JOURNAL-2026-08-27.md` sessions 2-3) : icône **M** (`m-green/m-red/m-gray.png`, gris = démarrage/inconnu),
> « Ouvrir Memoria » **ré-affiche la fenêtre Tauri** (plus le navigateur), fermer la fenêtre cache l'app, **19 tests Rust**,
> app **signée Developer ID** installée dans `/Applications`. Le texte ci-dessous décrit la première version du 24/08.

Demande Néto : voir d'un coup d'œil si Memoria est active, via une icône de barre.
- **App Tauri v2** (`apps/desktop/src-tauri`) : ajout features Cargo `tray-icon` + `image-png` ;
  icônes générées `icons/dot-green.png` / `dot-red.png` (pastilles 32×32, générées via encodeur PNG maison).
- `lib.rs` : `.setup()` construit une **pastille de barre d'état** (`TrayIconBuilder`, id `memoria-status`)
  avec menu **Ouvrir Memoria · Démarrer le daemon · Quitter** (`on_menu_event`), et une **sonde de fond
  toutes les 5 s** (`daemon_is_healthy()` = `read_daemon_state` + `http_health` déjà présents) qui bascule
  l'icône **verte (actif) / rouge (éteint)** + info-bulle. « Ouvrir » lance l'URL UI dans le navigateur ;
  « Démarrer » appelle `start_daemon_blocking`. Cross-platform (macOS/Windows/Linux openers).
- **Vérifié** : `cargo check` = 0 erreur ; `cargo test` = **9 tests Rust verts** ; 0 warning après nettoyage.
  App construite via `cargo tauri build` (Memoria.app + DMG) — bundle non signé (process Igara pour la signature).
- Choix Néto : indicateur sur **Memoria** (pas OpenClaw) car l'app-coquille Tauri existait déjà.

## 9. Reste (non fait ici, cf. AUDIT-CONSOLIDATION-2026-08-24.md)
- Dette de tests du dernier kilomètre (update/autostart/service) + distribution npm/app.
- (facultatif) Refaire tourner la lecture par thème après de nouveaux imports.
- (bloat) Purger les vecteurs nomic morts si on reste sur OpenAI (non destructif à décider).
