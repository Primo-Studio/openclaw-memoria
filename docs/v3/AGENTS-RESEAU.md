# Agents Memoria sur le réseau Primo — carte de récupération

> Memoria est multi-instances : chaque agent IA sur chaque poste = une « personne »
> numérique avec SA mémoire privée. Cette page recense les mémoires à récupérer/connecter.
> Source : Néto, 2026-06-10.

## Principe (rappel)

- **Chaque agent est unique** : personnalité, workflows, mémoire privée propre. Tout n'est **pas**
  partagé entre agents.
- Le **partage** passe par les scopes `user` (faits sur l'utilisateur Néto) et `org`/`company`
  (faits d'entreprise communs). C'est **l'utilisateur qui décide** quoi remonter au partagé.
- Donc : on rapatrie chaque mémoire dans la **mémoire privée de SON agent**, puis Néto choisit
  ce qui devient partagé (ex. « je suis Neto Pompeu », préférences perso → scope `user`).

## Inventaire des agents

| Agent | Type | Machine | Mémoire | État |
|---|---|---|---|---|
| **Koda** | OpenClaw | **Mac Studio** (`192.168.1.98`, user `primostudio`) | `~/.openclaw/workspace/memory/memoria.db` (33 Mo, 3573 faits) | ✅ **Rapatriée + adoptée** dans la mémoire privée Koda (instance `405290ba`), 1917 embeddings réindexés |
| **Sol** | OpenClaw | **Mac mini** (⚠️ NE PAS confondre avec Koda) | à localiser (`~/.openclaw/workspace/memory/memoria.db` probable) | ⚪ à récupérer |
| Claude Code | claude-code | postes divers (ce MacBook : instance `72615d82`) | native Claude Code (transcripts) + capture Memoria en cours | 🟡 connecté ici, mémoire propre qui se construit |
| Codex | codex | postes divers | `~/.codex/` (sessions/transcripts) | ⚪ à récupérer (importeur transcripts v1.5) |

## Procédure de récupération (validée sur Koda)

1. Trouver la machine sur le réseau (`ping <nom>.local` ou IP) — SSH user `primostudio`, mdp connu de Néto.
2. Localiser la vraie DB : `find ~ -maxdepth 6 -iname "memoria*.db"` puis vérifier
   `sqlite3 <db> "SELECT COUNT(*) FROM facts"` (la vraie a des milliers de faits + tables
   observations/procedures ; ignorer les `*-backup-*.db`, `cortex.db`, `memory.db` vide).
3. Snapshot cohérent SANS toucher l'original : `sqlite3 <db> ".backup /tmp/<agent>-snapshot.db"`.
4. `scp` vers ce poste, vérifier le `shasum -a 256`.
5. `Memoria.init` → `pairAssistant({type:'openclaw', display_name:'<Agent>'})` →
   `importLegacyDb({legacyPath, memoria})` (backup auto + quarantaine + rollback) →
   `adoptLegacyInto(<instanceId>)` → réindexer les embeddings (Ollama nomic-embed-text 768d).
6. Vérifier le recall et le compteur de faits.

⚠️ **Une instance ≠ une autre** : Sol et Koda sont deux agents OpenClaw distincts → deux instances
Memoria séparées, deux mémoires privées. Ne jamais fusionner sans décision explicite de Néto.

## Partage à décider (plus tard, par Néto)

Koda a sauvegardé des faits **sur Néto lui-même** (identité, préférences) qui ont vocation à être
partagés avec tous les agents via le scope `user` — ex. « le nom d'utilisateur de Neto Pompeu est
primo_frances ». À remonter au scope `user` quand l'UI de partage par référence (P5) sera prête, sur
sélection de Néto. Les faits spécifiques à Koda (workflows, auto-observations) restent privés.
