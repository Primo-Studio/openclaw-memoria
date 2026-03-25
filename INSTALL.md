# Installation Memoria

## Option A : Installation automatique (recommandé)

```bash
curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash
```

Le script vérifie les prérequis, installe les modèles Ollama, clone le repo et installe les dépendances.

## Option B : Installation manuelle

### Prérequis

- **OpenClaw** installé et fonctionnel
- **Node.js** ≥ 20 avec `npm` dans le PATH
- **Ollama** installé ([ollama.ai](https://ollama.ai))

### 1. Installer les modèles Ollama

```bash
ollama pull gemma3:4b              # LLM extraction (3.3 GB)
ollama pull nomic-embed-text-v2-moe  # Embeddings (957 MB)
```

Vérifier : `ollama list` doit afficher les deux modèles.

### 2. Installer le plugin

```bash
git clone https://github.com/Primo-Studio/openclaw-memoria.git \
  ~/.openclaw/extensions/memoria

cd ~/.openclaw/extensions/memoria
npm install
```

### 3. Configurer openclaw.json

**Config minimale** — tout le reste a des defaults intelligents :

```json
{
  "plugins": {
    "allow": ["memoria"],
    "entries": {
      "memoria": { "enabled": true }
    }
  }
}
```

**Config complète** (si vous voulez personnaliser) :

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
      }
    }
  }
}
```

### 4. Vérifier et démarrer

```bash
openclaw doctor          # Vérifier la config
openclaw gateway restart # Redémarrer
openclaw status          # Vérifier le chargement
```

Vous devez voir :
```
[plugins] memoria: v2.6.0 registered (X facts, ...)
```

### 5. (Optionnel) Migrer depuis cortex.db

Si vous avez un ancien `cortex.db`, Memoria le détecte automatiquement et le copie en `memoria.db` au premier démarrage. Aucune action nécessaire.

Pour migrer depuis `memory-convex` ou un `facts.json` :

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
