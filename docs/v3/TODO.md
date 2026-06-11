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

## ✅ Session 3 (2026-06-11) — Contrôle & config + audit OpenClaw

- **Kill-switch global** (`config.enabled`) : `memoria enable`/`disable` + engine `isEnabled/setEnabled`
  + daemon no-op ANNONCÉ (`{disabled:true}`) sur capture/recall en pause + toggle UI Réglages.
- **Suppression définitive d'agent** : `deleteInstance` (engine+registry), `memoria delete-agent --yes`,
  route `POST /v1/admin/delete_agent`, bouton « Supprimer » (confirm) écran Agents. ≠ revoke (efface la DB privée).
- **Déplacement du stockage (clé USB)** : `moveStorage` (rename même volume / cpSync+rm cross-volume) +
  `memoria move --to <dir>` (arrête le daemon, déplace, réécrit `config.toml`). UI : commande affichée.
- **Lancement auto au login** : `control/autostart.ts` (LaunchAgent launchd, KeepAlive), `memoria autostart on|off`,
  route `POST /v1/admin/autostart`, toggle UI. macOS only (échoue proprement ailleurs).
- **Route `GET /v1/admin/control`** : enabled + autostart status + storageInfo (pour l'UI).
- **Relations entre thèmes** (demande Néto) : `TopicEngine.relations()` (graphe par faits/entités partagés,
  borné 28 nœuds/70 arêtes, `via` = entités fortes d'abord, bruit filtré). `Memoria.topicRelations`,
  route `GET /v1/admin/topic_relations`, vue SVG circulaire « Relations » dans l'écran Thèmes (0 dépendance).
  Validé sur Koda : 23 nœuds, 70 arêtes réelles (JamBoard↔CoreBluetooth, RSMA↔Devis, Directus↔SEO).
- **Recherche globale** : `Memoria.globalSearch` (tous agents d'un coup, résultat étiqueté de l'agent),
  route `GET /v1/admin/search?q=`, option « 🔍 Toutes les mémoires » dans l'écran Mémoire.
- Tests : `control.test.ts` (9) + `topics.test.ts` relations (3). Suite = **374 verts**. Daemon réel redémarré,
  routes control/topic_relations/search vérifiées live.
- **Audit OpenClaw 2026.6.5** (`DIAG-OPENCLAW-2026.6.5.md`) : ⚠️ **NOUVEAU gate `allowConversationAccess`
  bloque par défaut** les hooks de conversation (`llm_output`, `agent_end`) pour tout plugin non bundlé →
  **cause #1 plausible de la casse de capture v3.34**. L'install de l'adaptateur DOIT poser
  `plugins.entries.memoria.hooks.allowConversationAccess=true`. L'auto-recall (`before_prompt_build`) survit.

## Reste à faire (ordre conseillé)

### Import des mémoires Claude Code / Codex
- [x] ~~Importeur de transcripts~~ **FAIT + INTÉGRÉ** : `Memoria.importTranscripts`.
- [x] ~~Bulk import RÉEL avec gpt-4o-mini~~ **FAIT 2026-06-10** : **2266 faits en quarantaine**
      (Claude Code 1021, Codex 1245) en ~28 min. Échantillon qwen nettoyé avant. Idempotent.
- [x] ~~Providers OpenAI/OpenRouter + choix utilisateur~~ FAIT (Réglages UI + clés par fichier).
- [ ] **Approuver/trier la quarantaine** : 2266 faits dormants à valider. Options pour Néto :
      - Écran Revue « Tout approuver » par agent (chaque agent récupère SA mémoire active). Le plus
        rapide ; un peu de bruit (gpt-4o-mini extrait parfois de l'éphémère) mais ranké au recall.
      - Tri sélectif si Néto préfère.
- [ ] **Partager les faits sur Néto** : écran Partage → par agent, `suggestIdentityFacts` (50 candidats
      réels/agent : préférences, identité, conventions) → cocher → `shareFacts` vers `user`. Reste
      la décision de Néto.
- [ ] (optionnel) prompt d'extraction encore plus sélectif / post-filtre de l'éphémère résiduel.

### UI manquante
- [ ] **Écran Partage** (matrice scopes × agents) : API prête (`GET /v1/admin/scopes`, `POST /share`,
      `POST /policy`, `GET /identity_candidates`), il manque l'écran React.
- [ ] Écran Organisations & projets (créer org client, projet, scopes) — logique core prête.
- [ ] Onboarding : barres de progression de téléchargement des modèles Ollama (spec §14).
- [x] ~~Vue relations entre thèmes~~ **FAIT** (onglet « Relations » écran Thèmes, graphe SVG).
- [x] ~~Recherche globale (tous agents)~~ **FAIT** (option « Toutes les mémoires » écran Mémoire).

### Reconnecter OpenClaw (P6) — audit 2026.6.5 FAIT
- [x] ~~Diagnostic compatibilité 2026.6.5~~ **FAIT** (`DIAG-OPENCLAW-2026.6.5.md`). MCP natif confirmé →
      `openclaw mcp set memoria '{"command":"node","args":["…/packages/mcp/dist/bin.js","serve","--instance","koda"]}'`.
- [ ] **Adaptateur hooks mince** (~180-260 lignes, zéro dépendance native) dans `packages/adapters/openclaw` :
      `before_prompt_build`→/recall (timeout dur 300 ms), `agent_end`/`llm_output`→/capture (fire-and-forget),
      `before_compaction`/`session_end`→/flush (nouveaux hooks). **L'install DOIT poser
      `hooks.allowConversationAccess=true`** sinon la capture est morte sans erreur (gate 2026.6.5).
      Corriger aussi `event.toolCallCount` (absent du type `agent_end`). Install `--link`, garder zéro natif.

### Couches avancées restantes (P6)
- [ ] Clusters (fact-clusters), carte 3D UMAP (opt-in), couches D sur validation (patterns/auto-skill).
- [ ] Job cron daemon : `decayCognition` quotidien (méthode prête, manque le scheduler).

### Distribution & finitions
- [ ] **Publier npm** (`@memoria/*` ou `@primo-studio/memoria`) — tant que non publié, les commandes
      utilisent le chemin local `node ~/openclaw-memoria/packages/mcp/dist/bin.js` (déjà géré par le
      daemon et connect). Après publication : repasser aux formes `npx -y @memoria/mcp`.
- [ ] Signature/notarisation `Memoria.app` (process Igara), Node embarqué SEA (v1.5).
- [x] ~~Auto-démarrage daemon au login (launchd plist macOS)~~ **FAIT** (`memoria autostart on` + toggle UI).
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
