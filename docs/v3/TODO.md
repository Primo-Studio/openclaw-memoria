# Memoria V3 — TODO de passation

> **But** : reprendre le travail SANS contexte oral. Lire d'abord `STATUS.md`, puis ce fichier,
> puis `DECISIONS-LOG.md`. Spec gelée = `~/Downloads/Memoria-V3-Dossier-Dev-2026-06-10/PLAN-Memoria-v3-2026-06-03.md`.
> Carte des agents/mémoires à récupérer = `AGENTS-RESEAU.md`.

## Reprendre le travail

```bash
cd ~/openclaw-memoria        # branche memoria-v1
npm install && npm run build && npm test   # doit être 100% vert AVANT toute modif
```

- Le « juge du produit » = `packages/core/test/benchmark.test.ts` (anti-fuite = 0). Toute
  évolution du recall doit le laisser vert.
- Règle anti « mort silencieuse » : aucun catch muet ; tout chemin actif a un test qui le prouve.
  ~106 bugs legacy documentés `docs/v3/port-map.json` — ne pas les réintroduire.
- Auteur git = **Hello-Primo**. `.claude/`, `dist/`, `*.tsbuildinfo` gitignorés.

## ✅ Déjà fait (sessions 1-2, 2026-06-10)

- **Fondation** : monorepo (core/daemon/mcp/cli/web + apps/desktop), schéma gouverné, CI stricte verte.
- **Recall** : fan-out FTS + **vectoriel sqlite-vec hybride** (recallSemantic) + **expansion graphe**,
  anti-fuite inter-clients = 0, cap tokens.
- **Capture** : WAL-first, redaction secrets (gate dur, coffre Keychain/AES), extraction LLM
  (Ollama/Anthropic), review-first.
- **Cognition** (bucket B) : entités/relations/observations async + decay.
- **Gouvernance** : pairing, partage par référence (`shareFacts`/`setScopeAccess`/`suggestIdentityFacts`),
  hard-delete, audit neutre, capture_mode (pause/incognito).
- **Migration** : Koda (Mac Studio) récupérée — 3515 faits + 364 procédures + 3038 entités +
  3329 relations + 1920 observations, embeddings réindexés. Importeur legacy + adoption.
- **Connexion/déconnexion** : 1 commande (`connect`/`disconnect`), auto-enregistrement MCP par hôte.
- **UI** : Dashboard, Agents, Mémoire, Revue, Audit, Réglages, Onboarding, sélecteur pause.
- **Desktop** : Memoria.app + DMG construits.
- **Agents connectés en réel** : Claude Code (`72615d82`), Codex (`0b5322e1`), Koda (`405290ba`, mémoire complète).

## Reste à faire (ordre conseillé)

### Import des mémoires Claude Code / Codex
- [x] ~~Importeur de transcripts~~ **FAIT + INTÉGRÉ** : `Memoria.importTranscripts` (parsers Claude
      Code/Codex/Markdown, idempotent, quarantaine review-first, anti-fuite multi-instance testée).
- [x] ~~Import réel échantillon~~ FAIT : 10 transcripts récents → 208 faits en quarantaine (preuve E2E).
- [ ] ⚠️ **QUALITÉ D'EXTRACTION** : qwen2.5:3b (local) extrait trop granulaire (détails de tâche au
      lieu de faits durables). Avant le **bulk import** (931 fenêtres = 122 CC + 41 Codex), choisir :
      - **Haiku** (profil `local-plus-cloud`, clé Anthropic présente) : bien meilleur, ~$1 pour tout
        le corpus. Recommandé pour la qualité. → `memoria` setLlmProfile + relancer l'import.
      - **qwen local** : gratuit mais bruité → prévoir un gros tri en Revue.
      Commande : `Memoria.importTranscripts(instanceId, files, {maxWindowsPerFile})`. Exclure le bruit
      `**/subagents/**` et `agent-*.jsonl` (voir `/tmp/real-import-sample.mjs`).
- [ ] Après bulk import : `suggestIdentityFacts` sur Claude Code + Codex → proposer à Néto de
      **partager** les faits sur lui / sa structure / ses clients vers `user`/`org` (ils bossent pour lui).
- [ ] Améliorer le prompt d'extraction transcripts (plus sélectif) OU post-filtrer les faits trop
      spécifiques à une tâche ponctuelle.

### UI manquante
- [ ] **Écran Partage** (matrice scopes × agents) : API prête (`GET /v1/admin/scopes`, `POST /share`,
      `POST /policy`, `GET /identity_candidates`), il manque l'écran React.
- [ ] Écran Organisations & projets (créer org client, projet, scopes) — logique core prête.
- [ ] Onboarding : barres de progression de téléchargement des modèles Ollama (spec §14).

### Reconnecter OpenClaw (P6)
- [ ] Adaptateur OpenClaw : diagnostic fait (`DIAG-OPENCLAW.md`), MCP natif → `openclaw mcp set memoria`.
      Adaptateur hooks mince (~200 lignes, prependContext + capture) dans `packages/adapters/openclaw`.
      ⚠️ Avant : `openclaw plugins doctor` sur le Mac Studio pour confirmer la cause de la casse v3.34.

### Couches avancées restantes (P6)
- [ ] Clusters (fact-clusters), carte 3D UMAP (opt-in), couches D sur validation (patterns/auto-skill).
- [ ] Job cron daemon : `decayCognition` quotidien (méthode prête, manque le scheduler).

### Distribution & finitions
- [ ] **Publier npm** (`@memoria/*` ou `@primo-studio/memoria`) — tant que non publié, les commandes
      utilisent le chemin local `node ~/openclaw-memoria/packages/mcp/dist/bin.js` (déjà géré par le
      daemon et connect). Après publication : repasser aux formes `npx -y @memoria/mcp`.
- [ ] Signature/notarisation `Memoria.app` (process Igara), Node embarqué SEA (v1.5).
- [ ] Auto-démarrage daemon au login (launchd plist macOS).
- [ ] `getSecretRef`/`secret_access` de bout en bout (engine→daemon→MCP `memoria_get_secret_ref`).
- [ ] Renommer le repo `openclaw-memoria` → `memoria` (à la release, décision Néto).
- [ ] Récupérer **Sol** (Mac mini) quand Néto le voudra — procédure dans AGENTS-RESEAU.md.

## Pièges connus
- bm25 NON comparable entre DB → scoring fan-out = couverture de requête (`content.ts searchFacts`). Ne pas « simplifier ».
- FTS5 : maintenance par TRIGGERS uniquement (pas de rebuild manuel sans rowid).
- Embeddings : `model`+`dimensions` obligatoires, comparaison inter-dim interdite (cosine throw).
- Mode JSON Ollama : demander un OBJET `{"facts":[...]}`, pas un tableau nu (petits modèles).
- Le daemon pointe sur le build du repo : `memoria stop && memoria start` après un rebuild.
- Migration : toujours `.backup` (snapshot cohérent) côté source, jamais toucher l'original.
