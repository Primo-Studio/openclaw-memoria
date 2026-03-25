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

export interface LLMProvider {
  generate(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    format?: "json" | "text";
    timeoutMs?: number;
  }): Promise<string>;
  readonly name: string;
}

export interface ProviderConfig {
  type: "ollama" | "lmstudio" | "openai" | "openrouter";
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions?: number;  // for embed
}
