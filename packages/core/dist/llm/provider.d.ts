/**
 * Abstraction LLM (spec §14) — le core ne connaît AUCUN fournisseur en dur.
 * Implémentations : OllamaProvider (local, défaut), AnthropicProvider (cloud
 * opt-in, Haiku 4.5), NullProvider (aucun LLM : capture = WAL seul).
 * ⚠ Le défaut legacy `gpt-5.4-nano` (modèle INEXISTANT) est banni — aucun
 * nom de modèle en dur hors des profils de config.
 */
export interface CompleteOptions {
    system?: string;
    prompt: string;
    maxTokens?: number;
    /** Si vrai, demande une sortie JSON (le provider fait au mieux). */
    json?: boolean;
    temperature?: number;
}
export interface LlmProvider {
    readonly name: string;
    /** Modèle effectif (ex. `qwen2.5:3b`, `claude-haiku-4-5-20251001`). */
    readonly model: string;
    isAvailable(): Promise<boolean>;
    complete(opts: CompleteOptions): Promise<string>;
}
export interface EmbeddingProvider {
    readonly name: string;
    readonly model: string;
    /** Dimensions FIXES du modèle — gravées avec chaque vecteur (anti-768/1536). */
    readonly dimensions: number;
    isAvailable(): Promise<boolean>;
    embed(texts: string[]): Promise<Float32Array[]>;
}
/** Profil de modèles par couche (spec §14) — résolu depuis config.toml. */
export interface LlmProfile {
    extraction: LlmProvider | null;
    embeddings: EmbeddingProvider | null;
}
/** NullProvider : pas de LLM disponible → les couches LLM se désactivent PROPREMENT (pas de mort silencieuse : l'appelant teste isAvailable). */
export declare class NullLlmProvider implements LlmProvider {
    readonly name = "null";
    readonly model = "none";
    isAvailable(): Promise<boolean>;
    complete(): Promise<string>;
}
//# sourceMappingURL=provider.d.ts.map