# Memoria V3 — État des 24 couches cognitives

> Les 24 couches viennent de la spec §12 (4 buckets). Tableau vérifié contre le code le 2026-08-27
> (routes `packages/daemon/src/server.ts`, moteurs `packages/core/src/cognition/`, écrans
> `packages/web/src/screens/`). ✅ fait · 🟡 partiel · ⚪ à faire. État global : `STATUS.md`.

## L'essentiel d'abord

La **fondation V3** (ce qui n'existait PAS dans le plugin) est livrée : daemon local, MCP multi-agent
(12 outils), pairing, UI web 16 écrans (5 langues), secrets (Trousseau / coffre AES), migration +
import (legacy + transcripts, auto-import launchd), partage gouverné + scope `user` inscriptible par
les agents, choix du moteur d'IA (OpenAI recommandé, Ollama/LM Studio en local) avec journal cloud et
consommation par modèle, recall hybride sqlite-vec, synchro inter-machines, app bureau signée.

Sur les 24 **couches cognitives** héritées : **les 24 sont portées**, corrigées, testées et pour la
plupart visibles dans l'UI (écran Système = compteurs en direct). Ce qui reste relève de la
distribution (scope npm, notarisation) et de quelques raffinements listés dans `TODO.md`.

## Bucket A — Actif (fondation, tourne toujours) — 11 couches

| # | Couche | État | Note |
|---|---|---|---|
| 1 | db (schéma) | ✅ | schéma gouverné registry (v5) + contenu (v4), FTS, triggers |
| 2 | scoring (+hot-tier) | ✅ | scoring complet + hot-tier (fait récemment accédé = chaud) ; boost plafonné ×2 |
| 3 | selective (dedup/contradiction) | ✅ | dedup exact (déclarations) / near-dup Jaccard (capture, scopes partagés compris) + détection de contradiction (port/valeurs/négation, « plus de »/« sans » exclus) |
| 4 | lifecycle | ✅ | active/dormant/archived + review ; un dormant n'est jamais rappelé ni embeddé |
| 5 | budget (cap tokens) | ✅ | cap dur global (corrige le bug legacy) + `token_budget` sur `memoria_recall` |
| 6 | procedural | ✅ | moteur match + recordExecution (failure_reasons), UI Procédures |
| 7 | feedback | ✅ | reinforce par usage réel (relevance_weight), outil `memoria_feedback` |
| 8 | expertise | ✅ | domaines de maîtrise par agent + UI Agents (amorce depuis les thèmes corrigée 27/08) |
| 9 | context-tree | ✅ | projet→client→org résolu, boost sur l'arbre ; identifiants slugifiés côté MCP |
| 10 | config/identity | ✅ | config.toml + identités/instances + `machine_caps` |
| 11 | WAL | ✅ | source de vérité, replay au boot, cleanup borné, consommation sérialisée par instance |

## Bucket B — Async (enrichissement hors réponse) — 7 couches

| # | Couche | État | Note |
|---|---|---|---|
| 12 | embeddings (index) | ✅ | sqlite-vec, index nommé (dimensions, modèle), OpenAI 1536 ou Ollama 768, recall hybride RRF, DB partagées indexées |
| 13 | graph (entités/relations) | ✅ | + expansion au recall + decay (méthode `decayCognition` — ⚪ planificateur, cf. TODO) |
| 14 | topics (thèmes) | ✅ | classement entité-first, consolidation par entité ancre (v21), UI Thèmes + graphe de relations + puces dans Revue/Mémoire |
| 15 | observations | ✅ | agrégation par sujet |
| 16 | fact-clusters | ✅ | regroupement structurel, route `GET /v1/admin/clusters` (⚪ pas d'écran dédié) |
| 17 | continuous | ✅ | captureTurn par tour ; les « modes » de déclenchement sont côté adaptateur d'hôte ; marqueur `fact_cognition` (v11) évite les re-traitements cloud |
| 18 | revision | ✅ | propose contradits/doublons (écran Révisions), supersède sur validation |

## Bucket C — Opt-in — 3 couches

| # | Couche | État | Note |
|---|---|---|---|
| 19 | self-observation | ✅ | forces/faiblesses dérivées des procédures, UI Agents |
| 20 | markdown sync | ✅ | export .md par thème, `memoria export [--agent] [--flat]` |
| 21 | dialectic | ✅ | pour/contre/nuance depuis la mémoire, route `POST /v1/admin/dialectic` (⚪ pas d'outil MCP ni d'écran) |

## Bucket D — Sur validation — 3 couches

| # | Couche | État | Note |
|---|---|---|---|
| 22 | patterns (récurrences) | ✅ | détection + UI Récurrences (accepter consolide réellement, canonique gardé) |
| 23 | auto-skill | ✅ | propose des procédures depuis les récurrences (`skill_proposals`, scope hérité des faits) — ⚪ acceptation non exposée |
| 24 | revision (mutations) | ✅ | applique la supersession sur validation |

## Ce qui reste autour des couches (détail `TODO.md`)
- Planificateur `decayCognition` (quotidien) — la méthode existe, personne ne l'appelle.
- Brancher ou retirer les routes sans client : `clusters`, `dialectic`, `skill_proposals`,
  `/v1/memory/merge`.
- Seuils topics (Jaccard 0,4 → ~0,25 + chevauchement absolu) et détection de doublons en révision par
  seuil (0,85) proposés dans `AUDIT-AMELIORATIONS.md` — non faits.
- Carte 3D UMAP : ⛔ hors périmètre (décision Néto 24/08).

## Méthode
Vagues d'agents en parallèle (worktrees), intégration + tests, chaque phase verte avant la suivante,
doc + TODO à jour. **980 tests verts / 105 fichiers** au 27/08, CI verte.
