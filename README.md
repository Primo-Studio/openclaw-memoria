# 🧠 Memoria — Persistent Memory for OpenClaw

Brain-inspired memory that learns from every conversation. Your AI assistant remembers what matters — forever.

**SQLite-backed · Fully local · Zero cloud dependency · Provider-agnostic**

---

## ✨ Features

- **12 memory layers** working together — from simple text search to knowledge graphs and emergent topics
- **Semantic vs Episodic memory** — durable knowledge decays slowly, dated events fade naturally (like human memory)
- **Observations** — living syntheses that evolve as new evidence appears (inspired by [Hindsight](https://github.com/joshka/hindsight))
- **Fact Clusters** — entity-grouped "dossier" summaries for complete recall across sessions
- **Procedural memory** — tricks, patterns, and "what worked" are preserved, not filtered
- **Knowledge Graph** — entities and relations with Hebbian-style reinforcement
- **Adaptive recall** — injects 2-12 facts based on current context load
- **Hot Tier** — frequently accessed facts are always recalled, like a phone number you know by heart
- **Query Expansion** — searches synonyms, FR↔EN translations, and abbreviations automatically
- **Provider-agnostic** — works with Ollama, LM Studio, OpenAI, OpenRouter, Anthropic
- **Fallback chain** — if your primary LLM crashes, memory keeps working
- **Zero config needed** — smart defaults get you started in 60 seconds

---

## 🚀 Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash
```

The interactive wizard guides you through provider selection and model setup.

> 💡 Everything is changeable after install via `bash ~/.openclaw/extensions/memoria/configure.sh`

### Update

```bash
curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash -s -- --update
```

### Minimal manual config

Add to `openclaw.json`:
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

Smart defaults: Ollama + gemma3:4b + nomic-embed-text-v2-moe (local, 0€).

See [INSTALL.md](INSTALL.md) for advanced options.

---

## 🏗️ How It Works

```
┌────────────────────────────────────────────────┐
│               MEMORIA v3.4.1                   │
├────────────────────────────────────────────────┤
│                                                │
│  RECALL (before each response):                │
│  Observations → Hot Facts → Hybrid Search      │
│  → Knowledge Graph → Topics → Adaptive Budget  │
│                                                │
│  CAPTURE (after each conversation):            │
│  Extract → Classify → Filter → Store           │
│  → Embed → Graph → Topics → Observations       │
│  → Clusters → Sync to .md                      │
│                                                │
├────────────────────────────────────────────────┤
│  SQLite (FTS5 + vectors) · No cloud required   │
└────────────────────────────────────────────────┘
```

For detailed architecture, layer descriptions, and scoring formulas, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## ⚙️ Configuration

```json
{
  "autoRecall": true,
  "autoCapture": true,
  "recallLimit": 12,
  "captureMaxFacts": 8,
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
    { "provider": "ollama", "model": "gemma3:4b" },
    { "provider": "lmstudio", "model": "auto" }
  ]
}
```

### Supported Providers

| Provider | LLM | Embeddings | Cost |
|----------|-----|------------|------|
| **Ollama** | ✅ | ✅ | Free (local) |
| **LM Studio** | ✅ | ✅ | Free (local) |
| **OpenAI** | ✅ | ✅ | ~$0.50/month |
| **OpenRouter** | ✅ | ✅ | Varies |
| **Anthropic** | ✅ | — | Varies |

---

## 📊 Benchmarks

Tested on LongMemEval-S (30 questions, 5 categories):

| Version | Accuracy | Retrieval | Key improvement |
|---------|----------|-----------|-----------------|
| v3.2.0 | 73% | 50% | Contradiction supersession + procedural |
| v3.3.0 | 75% | 43% | Query expansion + topic recall |
| v3.4.0 | **82%** | **50%** | Fact Clusters (multi-session +75%) |

Detailed methodology and scripts in [benchmarks/](benchmarks/).

---

## 🗺️ Roadmap

| Version | Feature | Status |
|---------|---------|--------|
| v3.5.0 | **Image Memory** — extract and remember important details from images | 🔜 Planned |
| v3.5.0 | **Smart Scorer** — cross-encoder reranker for precision recall | 🔜 Planned |
| v3.6.0 | **Topic Dossiers** — auto-generated topic summaries | 💡 Design |

---

## 📄 License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2026 Primo-Studio by Neto Pompeu.
