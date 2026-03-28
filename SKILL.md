---
name: Memoria for OpenClaw
version: 3.16.0
description: "Multi-layer persistent memory for OpenClaw. 7 memory layers, bring your own LLM (Ollama, LM Studio, or API), 100% local-first, zero cloud cost."
author: Primo Studio (@Nieto42)
license: Apache-2.0
homepage: https://github.com/Primo-Studio/openclaw-memoria
repository: https://github.com/Primo-Studio/openclaw-memoria
feedback: https://x.com/Nitix_
tags:
  - memory
  - persistence
  - brain-inspired
  - procedural
  - lifecycle
  - ollama
  - lm-studio
  - multi-layer
env:
  - name: OPENAI_API_KEY
    required: false
    description: Optional — used as fallback for LLM extraction and embeddings if local models unavailable
  - name: OPENROUTER_API_KEY
    required: false
    description: Optional — used as fallback for remote LLM provider
  - name: OPENCLAW_WORKSPACE
    required: false
    description: Auto-set by OpenClaw — workspace path for memory files
security: |
  Memoria runs 100% locally by default. No data is sent externally unless you explicitly configure a remote LLM provider.
  All memory is stored in a local SQLite database on your machine.
  API keys are only used if you opt into remote providers as fallback — they are never required.
---

# 🧠 Memoria — Multi-Layer Persistent Memory for OpenClaw

**The most complete memory system for OpenClaw.** 7 layers of memory that work together, powered by YOUR choice of LLM.

## Why Memoria?

### 🏗️ 7 Memory Layers (not just a fact store)
1. **Facts** — Durable knowledge extracted from every conversation
2. **Procedures** — HOW to do things, improves with repetition, learns from failures
3. **Knowledge Graph** — Entities + relations connecting your facts
4. **Topics & Expertise** — Tracks what you talk about most, specializes over time
5. **Observations** — Short-term working memory for active context
6. **Error Detection** 🔥 — Touch fire once, remember forever. Dangers captured on first occurrence
7. **Lifecycle** — Fresh → Settled → Dormant. Nothing deleted, priority shifts naturally

### 🔌 Bring Your Own LLM
Configure each layer independently. Mix and match:
- **Ollama** — Run gemma3, qwen3.5, llama, or any model locally (recommended)
- **LM Studio** — Use any GGUF model from your local server
- **Remote APIs** — OpenAI, Anthropic, OpenRouter as primary or fallback
- **Fallback chains** — Ollama → LM Studio → API. If one fails, the next takes over automatically

### 🏠 100% Local-First
- **SQLite + FTS5** — No external database needed
- **Local embeddings** — nomic-embed-text via Ollama (zero API cost)
- **Zero cloud dependency** — Works offline, your data stays on your machine
- **Fallback chain** — Degrades gracefully if a provider goes down

### 🧬 What Makes Memoria Different
| Feature | Memoria | Basic memory plugins |
|---------|---------|---------------------|
| Memory layers | 7 specialized layers | Single fact store |
| LLM choice | Any local or remote model | Usually hardcoded |
| Per-layer LLM config | ✅ Different model per layer | ❌ |
| Procedural learning | ✅ Learns HOW, not just WHAT | ❌ |
| Error detection | ✅ Auto-captures dangers | ❌ |
| Knowledge graph | ✅ Entities + relations | ❌ |
| Lifecycle management | ✅ Smart aging, never forgets | ❌ or simple TTL |
| Cost | $0 with local models | Varies |

## Installation

### As Plugin (recommended)
```bash
openclaw plugins install clawhub:memoria-plugin
```

### From source
```bash
cd ~/.openclaw/extensions
git clone https://github.com/Primo-Studio/openclaw-memoria.git memoria
cd memoria && npm install
```

Then add to your `openclaw.json`:
```json
"plugins": {
  "entries": {
    "memoria": { "enabled": true },
    "memory-convex": { "enabled": false }
  }
}
```

## Configuration

### Minimal (works out of the box with Ollama)
Just install and restart. Defaults: Ollama + gemma3:4b for extraction, nomic for embeddings.

### Custom LLM per layer
```json
"memoria": {
  "enabled": true,
  "config": {
    "llm": {
      "default": { "provider": "ollama", "model": "qwen3.5:4b" },
      "procedural": { "provider": "lmstudio", "model": "your-model" },
      "graph": { "provider": "openai", "model": "gpt-4o-mini" }
    }
  }
}
```

## Feedback & Community

**We'd love your feedback!** Tell us how Memoria works for you:
- 🐦 **Tweet us** [@Nitix_](https://x.com/Nitix_) — share your setup, results, or ideas
- ⭐ **Star the repo**: [github.com/Primo-Studio/openclaw-memoria](https://github.com/Primo-Studio/openclaw-memoria)
- 🐛 **Issues**: [GitHub Issues](https://github.com/Primo-Studio/openclaw-memoria/issues)

Built with ❤️ by [Primo Studio](https://primo-studio.fr) 🇬🇫 — AI tooling from French Guiana.
