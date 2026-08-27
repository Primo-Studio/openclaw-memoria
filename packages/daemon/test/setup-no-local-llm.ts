/**
 * Garde-fou global des tests (setupFiles) : AUCUN appel au vrai Ollama
 * (127.0.0.1:11434) ni à LM Studio (127.0.0.1:1234).
 *
 * Constat : les tests qui initialisaient Memoria/daemon sans `llm` parlaient
 * au VRAI Ollama de ce Mac (qwen2.5:3b + nomic-embed-text : /api/tags puis
 * /api/embed pendant un recall), et au chemin « aucun provider » en CI où
 * Ollama n'existe pas. Le vert local ne prouvait pas ce que le vert CI
 * prouvait, et un Ollama occupé ralentissait ou cassait la suite. Ici une
 * telle requête est REJETÉE avec un message qui dit quoi faire ; les faux
 * serveurs Ollama des tests (port éphémère) ne sont pas concernés.
 */
const realFetch = globalThis.fetch
const LOCAL_LLM = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(11434|1234)(\/|$)/

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (LOCAL_LLM.test(url)) {
    return Promise.reject(
      new TypeError(
        `fetch failed : réseau LLM local interdit dans les tests (${url}) — passe llm: { extraction: null } à Memoria.init/startDaemon, ou un faux serveur sur port éphémère`,
      ),
    )
  }
  return realFetch(input, init)
}) as typeof fetch
