---
name: Memoria
version: 3.14.1
description: "Persistent memory that thinks like a human brain. Facts, procedures, errors — remembered forever, prioritized smartly."
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
  - error-detection
env:
  - name: OPENROUTER_API_KEY
    required: false
    description: Optional — for remote LLM fallback if no local model available
---

# 🧠 Memoria — Persistent Memory for OpenClaw

**Memory that thinks like you do.** Your AI assistant remembers what matters, forgets what doesn't, learns from mistakes, and gets better over time.

## What it does

- **Facts** — Extracts and stores durable knowledge from every conversation
- **Procedures** — Learns HOW to do things (not just what happened), improves with repetition
- **Error Detection** 🔥 — Touch fire once, remember forever. Dangers captured automatically on first occurrence
- **Lifecycle** — Fresh → Settled → Dormant. Nothing is ever deleted, but priority shifts naturally
- **Knowledge Graph** — Entities and relations enriching every recall
- **100% Local** — SQLite + FTS5 + Ollama. Zero cloud, zero cost

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

Then restart your gateway.

## Configuration

Minimal (3 lines in `openclaw.json` under `plugins.entries`):
```json
"memoria": { "enabled": true },
"memory-convex": { "enabled": false }
```

## Feedback & Community

**We'd love your feedback!** Tell us how Memoria works for you:
- 🐦 Tweet us [@Nitix_](https://x.com/Nitix_) — share your setup, results, or ideas
- ⭐ Star the repo: [github.com/Primo-Studio/openclaw-memoria](https://github.com/Primo-Studio/openclaw-memoria)
- 🐛 Issues: [GitHub Issues](https://github.com/Primo-Studio/openclaw-memoria/issues)

Built by [Primo Studio](https://primo-studio.fr) 🇬🇫 — AI tooling from French Guiana.
