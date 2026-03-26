---
name: openclaw-memoria
description: Persistent memory plugin for OpenClaw — 12 layers of brain-inspired memory (semantic/episodic facts, observations, knowledge graph, fact clusters, adaptive recall). SQLite-backed, fully local, zero cloud dependency. Works with Ollama, LM Studio, OpenAI, OpenRouter, Anthropic.
metadata:
  openclaw:
    kind: plugin
    requires:
      bins: [node, npm]
      env_optional:
        - name: OPENAI_API_KEY
          description: "Optional — only needed if using OpenAI as fallback provider"
        - name: ANTHROPIC_API_KEY
          description: "Optional — only needed if using Anthropic as provider"
    install:
      - id: memoria
        kind: script
        command: "curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash"
        label: "Install Memoria (interactive wizard)"
    security:
      filesystem:
        - path: "~/.openclaw/workspace/memory/"
          access: read-write
          reason: "Store and read persistent memory database (SQLite)"
        - path: "~/.openclaw/workspace/*.md"
          access: read-write
          reason: "Sync captured facts to workspace markdown files"
        - path: "~/.openclaw/openclaw.json"
          access: read-write
          reason: "Auto-configure plugin entry during installation"
      network:
        - host: "localhost"
          ports: [11434, 1234]
          reason: "Connect to local LLM providers (Ollama port 11434, LM Studio port 1234)"
        - host: "api.openai.com"
          optional: true
          reason: "Fallback LLM provider (only if configured)"
        - host: "api.anthropic.com"
          optional: true
          reason: "Fallback LLM provider (only if configured)"
        - host: "openrouter.ai"
          optional: true
          reason: "Fallback LLM provider (only if configured)"
---

# Memoria — Persistent Memory for OpenClaw

Brain-inspired memory that learns from every conversation. See [README.md](README.md) for full documentation.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash
```

## Security

- **100% local by default** — no data leaves your machine unless you configure a cloud provider
- **SQLite storage** — your memory stays in `~/.openclaw/workspace/memory/memoria.db`
- **No telemetry** — zero tracking, zero analytics
- **API keys are optional** — only needed if you choose a cloud fallback provider
- **Open source** — audit every line: [github.com/Primo-Studio/openclaw-memoria](https://github.com/Primo-Studio/openclaw-memoria)

## Features

- 12 memory layers (FTS5, embeddings, knowledge graph, observations, fact clusters)
- Semantic vs Episodic memory with natural decay
- Provider-agnostic: Ollama, LM Studio, OpenAI, OpenRouter, Anthropic
- Fallback chain for resilience
- Zero config needed — smart defaults
- 82% accuracy on LongMemEval-S benchmark
