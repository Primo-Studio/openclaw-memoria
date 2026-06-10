/**
 * Abstraction LLM (spec §14) — le core ne connaît AUCUN fournisseur en dur.
 * Implémentations : OllamaProvider (local, défaut), AnthropicProvider (cloud
 * opt-in, Haiku 4.5), NullProvider (aucun LLM : capture = WAL seul).
 * ⚠ Le défaut legacy `gpt-5.4-nano` (modèle INEXISTANT) est banni — aucun
 * nom de modèle en dur hors des profils de config.
 */
/** NullProvider : pas de LLM disponible → les couches LLM se désactivent PROPREMENT (pas de mort silencieuse : l'appelant teste isAvailable). */
export class NullLlmProvider {
    name = 'null';
    model = 'none';
    isAvailable() {
        return Promise.resolve(false);
    }
    complete() {
        return Promise.reject(new Error('aucun LLM configuré (NullLlmProvider)'));
    }
}
//# sourceMappingURL=provider.js.map