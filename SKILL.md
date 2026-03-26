---
name: openclaw-memoria
description: Persistent memory plugin for OpenClaw — 12 layers of brain-inspired memory (semantic/episodic facts, observations, knowledge graph, fact clusters, adaptive recall). SQLite-backed, fully local, zero cloud dependency. Works with Ollama, LM Studio, OpenAI, OpenRouter, Anthropic.
metadata:
  openclaw:
    kind: plugin
    requires:
      bins: [node, npm]
    install:
      - id: memoria
        kind: script
        command: "curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash"
        label: "Install Memoria (interactive wizard)"
---

# Memoria — Persistent Memory for OpenClaw

Brain-inspired memory that learns from every conversation. See [README.md](README.md) for full documentation.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash
```

## Features

- 12 memory layers (FTS5, embeddings, knowledge graph, observations, fact clusters)
- Semantic vs Episodic memory with natural decay
- Provider-agnostic: Ollama, LM Studio, OpenAI, OpenRouter, Anthropic
- Fallback chain for resilience
- Zero config needed — smart defaults
- 82% accuracy on LongMemEval-S benchmark
