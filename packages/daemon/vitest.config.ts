import { defineConfig } from 'vitest/config'

/** Projet daemon : garde anti-Ollama/LM Studio réels (voir test/setup-no-local-llm.ts). */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup-no-local-llm.ts'],
  },
})
