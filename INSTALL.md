# Installation Memoria

## Prérequis

- **OpenClaw** installé et fonctionnel (gateway running)
- **Ollama** installé et démarré (`ollama serve` ou app Ollama)
- **Node.js** ≥ 20 avec `npm` dans le PATH

## 1. Installer les modèles Ollama

```bash
# LLM extraction (3.3 GB)
ollama pull gemma3:4b

# Embeddings (957 MB)
ollama pull nomic-embed-text-v2-moe
```

⚠️ **Vérifier que les modèles sont bien listés** : `ollama list`

## 2. Copier le plugin

```bash
# Cloner le repo
git clone https://github.com/Primo-Studio/openclaw-memoria.git \
  ~/.openclaw/extensions/memoria

# Installer les dépendances
cd ~/.openclaw/extensions/memoria
npm install
```

## 3. Configurer openclaw.json

Ajouter dans `plugins.entries` :

```json
{
  "memoria": {
    "enabled": true,
    "config": {
      "autoRecall": true,
      "autoCapture": true,
      "recallLimit": 12,
      "captureMaxFacts": 8,
      "defaultAgent": "koda",
      "contextWindow": 200000,
      "syncMd": true,
      "llm": {
        "provider": "ollama",
        "model": "gemma3:4b"
      },
      "embed": {
        "provider": "ollama",
        "model": "nomic-embed-text-v2-moe",
        "dimensions": 768
      },
      "fallback": [
        { "provider": "ollama", "model": "gemma3:4b" }
      ]
    }
  }
}
```

Ajouter `"memoria"` dans `plugins.allow` :

```json
{
  "plugins": {
    "allow": ["memoria", "...vos autres plugins"]
  }
}
```

## 4. Vérifier et démarrer

```bash
# Vérifier la config
openclaw doctor

# Restart le gateway
openclaw gateway restart

# Vérifier que Memoria charge
openclaw status
```

Vous devez voir :
```
[plugins] memoria: v2.5.0 registered (X facts, ...)
```

## 5. (Optionnel) Migrer des faits existants

Si vous avez des faits dans `memory-convex` ou un `facts.json` :

```bash
cd ~/.openclaw/extensions/memoria
npx tsx migrate.ts
```

---

## Bugs connus à l'installation

### ❌ `syncMd` doit être un boolean

**Erreur** : `plugins.entries.memoria.config.syncMd: must be boolean`
**Cause** : écrire `"syncMd": { "enabled": true }` au lieu de `"syncMd": true`
**Fix** : `"syncMd": true`

### ❌ `embed.dims` n'existe pas

**Erreur** : `must NOT have additional properties`
**Cause** : le champ s'appelle `dimensions`, pas `dims`
**Fix** : `"dimensions": 768`

### ❌ `llm.default` n'existe pas

**Erreur** : `must NOT have additional properties`
**Cause** : les champs `provider` et `model` sont directement dans `llm`, pas dans `llm.default`
**Fix** :
```json
"llm": {
  "provider": "ollama",
  "model": "gemma3:4b"
}
```

### ❌ `fallback[].type` n'existe pas

**Erreur** : propriété inconnue
**Cause** : le champ s'appelle `provider`, pas `type`
**Fix** : `{ "provider": "ollama", "model": "gemma3:4b" }`

### ❌ DB path = workspace root, pas le fichier

Le constructeur `MemoriaDB()` attend le **workspace root** (ex: `~/.openclaw/workspace`).
Il crée automatiquement `memory/memoria.db` dedans.
Ne pas passer le chemin de la DB directement.

### ⚠️ Ollama modèles = 0 malgré process running

**Symptôme** : `ollama list` retourne vide, mais le process tourne
**Cause** : Ollama app lancée mais aucun modèle pull
**Fix** : `ollama pull gemma3:4b && ollama pull nomic-embed-text-v2-moe`

### ⚠️ `npm` / `node` not found via SSH

**Cause** : SSH ne charge pas le PATH complet (brew, nvm, etc.)
**Fix** : `export PATH=/opt/homebrew/bin:$PATH` avant les commandes

### ⚠️ "loaded without install/load-path provenance"

**Cause** : plugin local, pas installé via `openclaw plugin install`
**Impact** : warning non-bloquant, le plugin fonctionne
**Fix** : ajouter dans `plugins.allow` (déjà fait si vous suivez le guide)

---

## Config minimale (copier-coller)

Pour une installation rapide avec Ollama local :

```json
{
  "plugins": {
    "allow": ["memoria"],
    "entries": {
      "memoria": {
        "enabled": true,
        "config": {
          "autoRecall": true,
          "autoCapture": true,
          "syncMd": true,
          "llm": { "provider": "ollama", "model": "gemma3:4b" },
          "embed": { "provider": "ollama", "model": "nomic-embed-text-v2-moe", "dimensions": 768 }
        }
      }
    }
  }
}
```

---

## Providers supportés

| Provider | LLM | Embeddings | Prérequis |
|----------|-----|------------|-----------|
| `ollama` | ✅ | ✅ | Ollama installé, modèles pull |
| `lmstudio` | ✅ | ✅ | LM Studio avec serveur local |
| `openai` | ✅ | ✅ | Clé API OpenAI |
| `openrouter` | ✅ | ❌ | Clé API OpenRouter |
