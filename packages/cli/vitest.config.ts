import { defineConfig } from 'vitest/config'

/** Projet cli : même garde anti-Ollama/LM Studio réels que le daemon. */
export default defineConfig({
  test: {
    setupFiles: ['../daemon/test/setup-no-local-llm.ts'],
  },
})
