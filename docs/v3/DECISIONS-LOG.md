# Memoria V3 — Journal des décisions

> Journal append-only. Chaque décision : date, qui, quoi, pourquoi. Les specs amont vivent dans
> `~/Downloads/Memoria-V3-Dossier-Dev-2026-06-10/` (spec gelée = `PLAN-Memoria-v3-2026-06-03.md`).

## 2026-06-10 — Kickoff build (Néto + Claude)

1. **Stratégie : monorepo V3 direct.** Pas de Phase 0 « réparer l'ancien code » : l'ancien plugin
   est cassé par le nouvel OpenClaw et devient jetable. Les 24 couches sont portées une par une
   depuis `legacy/` **en appliquant les 15 fixes certains + un test de non-régression par bug**
   au moment du port. Même garantie qualité que la Phase 0 de la spec, zéro effort jeté.
2. **Ancienne `memoria.db` (mémoire de Koda)** : vit sur le **Mac Studio** (même réseau). À
   récupérer au moment de valider la migration réelle — Néto guidera. En attendant, la migration
   se développe et se teste sur des bases synthétiques au schéma v3.34 exact.
3. **Objectif de session : avancer le plus loin possible**, chaque phase documentée
   (`STATUS.md` + `TODO.md`) pour reprise dans une autre session.
4. **Questions ouvertes §18 tranchées** :
   - Transport daemon = **HTTP `127.0.0.1` + token** (identique Mac/Windows/Linux, debuggable).
   - Front = **React** (Vite).
   - `active_context` = **outil MCP `memoria_set_context` + auto-détection du repo git**.
   - **Tauri : ne PAS repousser par principe** (« pourquoi repousser ce qu'on peut faire
     maintenant ? pourquoi avoir une dette technique ? » — Néto). À faire dans la session si le
     temps le permet ; sinon documentation détaillée pour le dev suivant.
5. **Versionnage** : les packages `@memoria/*` démarrent à `0.1.0` (nouveaux packages). Le nom de
   version produit public (« Memoria 1.0 nouvelle génération » vs « 4.0 ») = décision marketing
   à trancher avant release — noté dans TODO.
6. **Repo** : on reste dans `Primo-Studio/openclaw-memoria`, branche `memoria-v1`. L'ancien code
   v3.34 est déplacé dans `legacy/` (corpus de référence pour le port, ne compile plus, ne se
   maintient plus). Un renommage du repo (`openclaw-memoria` → `memoria`) sera pertinent à la
   release — décision Néto.
7. **CI remplacée** : l'ancienne CI tolérait 51 erreurs TS et skippait les imports en échec. La
   nouvelle : 0 erreur `tsc`, tests exécutés réellement, boot-test daemon, matrice
   Node 20/22/24 × (ubuntu, macos).
8. **Stack verrouillée** (spec §2.3) : TS/Node≥20 ESM strict, better-sqlite3 12.x,
   sqlite-vec 0.1.9 (sorti d'alpha), smol-toml, @modelcontextprotocol/sdk 1.29, clipanion 3.x
   (stable, pas la 4 RC), Vite+React, vitest 4, Tauri (apps/desktop).
9. **Modèles locaux** : Ollama présent sur la machine mais sans modèles → `nomic-embed-text`
   (768d) + `qwen2.5:3b` téléchargés au kickoff. Clé Anthropic dispo (`~/.anthropic/api_key`)
   pour le profil cloud (Haiku 4.5). Le défaut legacy `gpt-5.4-nano` (modèle inexistant) est
   banni du code V3.

## 2026-06-10 (session 2) — Choix du moteur d'IA par l'utilisateur (Néto)

- **Principe (cahier des charges §14)** : c'est **l'utilisateur qui choisit** son provider et son
  modèle d'extraction, avec des **recommandations** pour ne pas être perdu. Local pour qui veut du
  local, cloud pour les autres. Réglages → sélecteur provider+modèle.
- **Providers supportés** : Ollama (local, gratuit), **OpenAI** (recommandé, `gpt-4o-mini` par
  défaut), Anthropic (Haiku), **OpenRouter** (une clé, des centaines de modèles). L'utilisateur peut
  mettre sa propre clé.
- **Clés** : pattern fichier chmod 600 par provider — `~/.anthropic/api_key`, `~/.openai/api_key`,
  `~/.openrouter/api_key` (+ env `OPENAI_API_KEY`/`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`).
  Clé OpenAI de Néto fournie 2026-06-10 → sécurisée dans `~/.openai/api_key`. (Avertir 1× sur la
  rotation puis avancer — cf. règle mémoire.)
- **Qualité d'extraction des transcripts** : qwen2.5:3b trop granulaire → **gpt-4o-mini** retenu
  pour le bulk import (faits durables propres, ~0,3 € pour tout le corpus). Choix `config.llm.extraction
  = {provider:'openai', model:'gpt-4o-mini'}`.
- gpt-5*/o-series : API exige `max_completion_tokens` (pas `max_tokens`) + pas de `temperature`
  custom — géré dans `OpenAiProvider`.

## 2026-08-24 — Consolidation avant features (Néto)

- **Moteur recommandé par défaut = OpenAI** (clé API, le plus simple : `gpt-4o-mini` extraction +
  `text-embedding-3-small` embeddings 1536 d). **Ollama = avancé** (le parc n'est pas assez puissant ;
  l'onboarding scanne la machine — `machine_caps` — et ne propose l'install 1-clic que si pertinent).
  Badges « recommandé » / « avancé » dans Réglages et Onboarding (`EmbeddingsChooser`, `Settings.tsx`).
- **Pas de nouvelles features avant la distribution** : ⛔ carte 3D UMAP, clusters en écran,
  continuous-learning OpenClaw (`llm_output`), relais NAS. Priorité = dernier kilomètre (tests
  install/update/launchd, quarantaine, partage des faits sur Néto, npm, signature/notarisation).
- Indicateur d'activité = icône dans la barre de menus de **Memoria.app** (pas OpenClaw).

## 2026-08-27 — Décisions produit de l'audit multi-agents (implémentées, **à confirmer par Néto**)

- **Les agents écrivent dans la mémoire partagée `user`** : `memoria_store_fact` accepte
  `scope: 'private' | 'user'` ; policy `can_write=1` sur `user` posée au pairing et par migration douce
  (seules les policies jamais réglées à la main sont relevées — `grantDefaultUserWrite`). Motif : avant,
  10 faits partagés pour ~4 000 privés, aucun agent ne pouvait y écrire, chaque modèle re-découvrait
  les mêmes préférences.
- **Exception sécurité** : un agent de type `openclaw` (bot de canal WhatsApp/Telegram, exposé à des
  tiers) reste en **lecture seule** sur `user` (surface d'injection inter-agents) → `403` ; son
  partage passe par la Revue.
- **Le passage privé → partagé reste manuel** (écran Partage, `shareFacts`). Partager un fait dormant
  le valide et clôt son item de revue.
- **Modes de capture unifiés** : `Revue d'abord` et `Pause` s'appliquent aussi aux faits déclarés par
  un agent (`store_fact`), pas seulement à la capture (Pause → « ignoré : en pause »).
- Un fait **déclaré** n'est dédoublonné qu'en **exact** (le near-dup Jaccard > 0,85 avalait
  « 13 octobre » vs « 14 octobre ») ; le near-dup reste réservé à la capture.
- `forget({query})` = ET sémantique + `confirm_bulk` obligatoire sans ids + `dry_run`.
- `identifyInterlocutor` : `known` borné aux scopes lisibles de l'agent appelant.
- Index vectoriel nommé par **(dimensions, modèle)**.
- **Consommation par modèle** visible (table `llm_usage`, Réglages, `memoria doctor`) — le compteur a
  révélé une boucle LLM (231 appels après une capture) corrigée par `fact_cognition`.
- **launchd d'abord** : `memoria start` fait `launchctl kickstart` si le service cible ce stockage.
