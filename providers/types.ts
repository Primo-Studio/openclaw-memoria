/**
 * Memoria — Provider Interfaces
 * 
 * Abstract embed + LLM so we can swap Ollama/LMStudio/OpenAI/OpenRouter.
 */

export interface EmbedProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly name: string;
}

export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  format?: "json" | "text";
  timeoutMs?: number;
}

export interface GenerateResult {
  response: string;
  provider: string;
  attemptMs: number;
  fallbacksUsed: number;
}

export interface LLMProvider {
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  /** Extended generate with metadata. Default implementation wraps generate(). */
  generateWithMeta?(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;
  readonly name: string;
}

export interface ProviderConfig {
  type: "ollama" | "lmstudio" | "openai" | "openrouter" | "anthropic";
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions?: number;  // for embed
}
