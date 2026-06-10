# Memoria V3 — État des 24 couches + plan des vagues

> Topo au 2026-06-10 (fin session 2). Les 24 couches viennent de la spec §12 (4 buckets).
> ✅ fait · 🟡 partiel · ⚪ à faire.

## L'essentiel d'abord

La **fondation V3** (ce qui n'existait PAS dans le plugin) est faite et c'est elle qui change tout :
daemon local, MCP multi-agent, pairing, connexion/déconnexion 1 commande, UI web, secrets (coffre),
migration + import (Koda + transcripts), partage gouverné, choix du moteur d'IA, recall hybride
sqlite-vec, app bureau Tauri. **C'est le gros du travail et c'est livré.**

Sur les 24 **couches cognitives** héritées : **8 faites, 6 partielles, ~10 à faire**. La fondation
(bucket A) est quasi complète ; la profondeur cognitive (B/C/D) est commencée (embeddings, graphe,
observations) et c'est là qu'on continue.

## Bucket A — Actif (fondation, tourne toujours) — 11 couches

| # | Couche | État | Note |
|---|---|---|---|
| 1 | db (schéma) | ✅ | schéma gouverné registry + contenu, FTS, triggers |
| 2 | scoring (+hot-tier) | 🟡 | scoring récence/confiance/usage/lifecycle/boost contexte fait ; **hot-tier** pas porté |
| 3 | selective (dedup/contradiction) | 🟡 | dedup exact+near fait ; **détection de contradiction** sémantique pas portée |
| 4 | lifecycle | ✅ | active/dormant/archived + review |
| 5 | budget (cap tokens) | ✅ | cap dur global (corrige le bug legacy) |
| 6 | procedural | 🟡 | table + **import** faits ; moteur (matching trigger, recordExecution) pas porté |
| 7 | feedback | ⚪ | renforcement par retour d'usage |
| 8 | expertise | ⚪ | niveau de maîtrise par domaine |
| 9 | context-tree | 🟡 | `active_context` (projet/client courant) fait ; arbre de contexte legacy non |
| 10 | config/identity | ✅ | config.toml + identités/instances |
| 11 | WAL | ✅ | source de vérité, replay au boot, cleanup borné |

## Bucket B — Async (enrichissement hors réponse) — 7 couches

| # | Couche | État | Note |
|---|---|---|---|
| 12 | embeddings (index) | ✅ | sqlite-vec + indexer + recall hybride |
| 13 | graph (entités/relations) | ✅ | + expansion au recall + decay |
| 14 | **topics (thèmes)** | 🟡 | table + import ; **PAS de génération/classement auto** ← *le manque que tu signales* |
| 15 | observations | ✅ | agrégation par sujet |
| 16 | fact-clusters | ⚪ | regroupement de faits proches |
| 17 | continuous | 🟡 | capture en continu (captureTurn) faite ; modes legacy non |
| 18 | revision | ⚪ | révision proactive des faits obsolètes |

## Bucket C — Opt-in — 3 couches

| # | Couche | État | Note |
|---|---|---|---|
| 19 | self-observation | ⚪ | l'agent observe son propre comportement |
| 20 | markdown sync | ⚪ | miroir .md de la mémoire |
| 21 | dialectic | ⚪ | confrontation de points de vue (outil) |

## Bucket D — Sur validation — 3 couches

| # | Couche | État | Note |
|---|---|---|---|
| 22 | **patterns (récurrences)** | ⚪ | **détecte les faits récurrents pour les consolider** ← *le manque que tu signales* |
| 23 | auto-skill | ⚪ | crée des compétences/procédures depuis les patterns |
| 24 | revision (mutations) | ⚪ | applique les révisions (supersede) sur validation |

## Le manque que tu as identifié (juste !)

Dans la **Revue**, on ne voit pas **dans quel sujet/thème** un souvenir va être rangé, et Memoria
ne **détecte pas encore les récurrences** (ce que faisait le plugin : repérer ce qui revient souvent
pour le consolider). Ce sont les couches **14 (topics)** et **22 (patterns)** — partielles/à faire.

## Plan des vagues à venir

### Vague 5 — Thèmes & récurrences (ta priorité)
- **topics auto** (couche 14) : à la capture, classer chaque fait dans un **sujet** (génération +
  affectation) → on sait où ça se range. Afficher le **thème dans la Revue et la Mémoire** + filtrer
  par thème.
- **patterns** (couche 22) : détecter les faits **récurrents** → proposer une consolidation (« tu as
  dit 5× que tu préfères X »). En bucket D (sur validation, pas automatique).
- UI : colonne/puce « sujet » dans Revue, filtre par thème, vue par sujet dans Mémoire.

### Vague 6 — Compléter la fondation cognitive
- scoring **hot-tier** (2), **contradiction** sémantique (3), moteur **procedural** (6),
  **feedback** (7) + **expertise** (8), **context-tree** complet (9), **fact-clusters** (16).

### Vague 7 — Couches profondes opt-in / validation
- self-observation (19), markdown sync (20), dialectic (21), auto-skill (23), revision (18/24).

### En parallèle / quand tu veux
- **UI** : améliorations que tu pointeras (thèmes, vue Mémoire par sujet, etc.).
- **Reconnecter OpenClaw** (adaptateur, diagnostic fait).
- **3D** (carte UMAP), **publication npm**, signature app, launchd.
- **Approuver/trier la quarantaine** (2266 faits) + **partager** les faits sur toi.

## Méthode
On garde la même : vagues d'agents en parallèle (worktrees), intégration + tests par moi, chaque
phase verte avant la suivante, doc + TODO à jour. 220 tests verts, CI verte.
