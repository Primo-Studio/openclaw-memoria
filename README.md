# 🧠 Memoria — Persistent Memory for OpenClaw

**Memory that thinks like you do.** Your AI assistant remembers what matters, forgets what doesn't, and gets better over time.

**SQLite-backed · Fully local · Zero cloud · Human-like memory architecture**

---

## ✨ What's New in v3.7.2

### 🔧 **Procedural Memory** *(NEW in 3.7.0)*
Memoria now learns **"how to do things"**, not just "what happened":
- Captures successful command sequences automatically
- Tracks success/failure rates per procedure
- Improves with repetition (success++ → degradation--)
- Searches for alternatives when a procedure degrades
- Example: "How to publish on ClawHub" → stored as 4-step procedure with 100% success rate

**Why it matters**: No more "I did this yesterday but don't remember how." Memoria now stores the steps.

---

### 🧬 **Identity-Aware Memory** *(v3.6.0)*
Memoria now understands **who you are** and **what you care about**. Facts about your core projects (Bureau, Polymarket, client work) are prioritized over plugin config details.

### 🌱 **Fact Evolution (Lifecycle)** *(v3.6.0)*
Facts evolve through 4 states like human memory:
- **Fresh** → new facts (< 7 days OR < 3 recalls)
- **Mature** → proven useful (3+ uses, no corrections)
- **Aged** → rarely used (90+ days, low usage)
- **Archived** → forgotten (180+ days, never used)

Archived facts are excluded from recall — **forgotten, not deleted**.

### 🔄 **Proactive Revision** *(v3.6.0)*
Mature facts recalled 10+ times trigger automatic LLM revision. If improved → new version created, old one superseded.

### 🧠 **Hebbian Reinforcement** *(v3.6.0)*
Knowledge graph relations now strengthen when entities co-occur (like neural connections). Weak relations fade over time and are pruned automatically.

### ⭐ **Expertise Specialization** *(v3.6.0)*
Topics gain expertise levels based on interaction frequency:
- `★` Novice → `★★` Familiar → `★★★` Experienced → `★★★★` Expert

Expert topics boost recall scores (your "specialist" knowledge rises to the top).

---

## ✨ Core Features

- **15 memory layers** — from text search to procedural memory, knowledge graphs, feedback loops, emergent topics
- **Semantic vs Episodic** — durable knowledge decays slowly, dated events fade (like human memory)
- **Observations** — living syntheses that evolve as new evidence appears
- **Fact Clusters** — entity-grouped summaries for complete recall across sessions
- **Procedural memory** — tricks, patterns, "what worked" preserved, not filtered
- **Adaptive recall** — injects 2-12 facts based on context load
- **Hot Tier** — frequently accessed facts always recalled
- **Query Expansion** — synonyms, FR↔EN, abbreviations auto-expanded
- **Feedback loop** — facts used rise; ignored/corrected facts sink
- **User signal detection** — corrections and frustration penalize bad facts
- **Self-regulating budget** — learns from compactions, auto-adjusts
- **Cross-layer cascade** — superseded facts update graph, topics, embeddings, observations
- **Provider-agnostic** — Ollama, LM Studio, OpenAI, OpenRouter, Anthropic
- **Fallback chain** — if primary LLM crashes, memory keeps working
- **Zero config** — smart defaults, 60-second setup

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
┌──────────────────────────────────────────────────────┐
│                   MEMORIA v3.5.0                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│  RECALL (before each response):                      │
│  User Signal Detection (correction/frustration)      │
│  → Observations → Hot Facts → Hybrid Search          │
│  → Knowledge Graph → Topics → Adaptive Budget        │
│                                                      │
│  CAPTURE (after each conversation):                  │
│  Extract → Classify → Filter → Store                 │
│  → Embed → Graph → Topics → Observations             │
│  → Clusters → Feedback Loop → Sync to .md            │
│                                                      │
│  LEARNING (continuous):                              │
│  Feedback (used/ignored) → Scoring adjustment        │
│  User correction → Penalize bad facts                │
│  Compaction → Budget self-regulation                 │
│  Supersede → Cascade to all layers                   │
│                                                      │
├──────────────────────────────────────────────────────┤
│  SQLite (FTS5 + vectors) · No cloud required         │
└──────────────────────────────────────────────────────┘
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
| v3.4.0 | 82% | 50% | Fact Clusters (multi-session +75%) |
| v3.5.0 | **82%+** | **50%** | Feedback loop + cross-layer cascade + user signal detection |

Detailed methodology and scripts in [benchmarks/](benchmarks/).

---

## 🗺️ Roadmap

| Version | Feature | Status |
|---------|---------|--------|
| v3.5.0 | **Feedback Loop** — usefulness tracking, user correction/frustration detection | ✅ Done |
| v3.5.0 | **Cross-Layer Cascade** — supersede propagates to all 4 layers | ✅ Done |
| v3.5.0 | **Self-Regulating Budget** — learns from compactions | ✅ Done |
| v3.6.0 | **Image Memory** — extract and remember important details from images | 🔜 Planned |
| v3.6.0 | **Interest Profile** — track user's recurring themes, boost relevant topics | 🔜 Planned |
| v3.7.0 | **LCM Bridge** — cross-reference with conversation summaries | 💡 Design |

---

## 📄 License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2026 Primo-Studio by Neto Pompeu.
