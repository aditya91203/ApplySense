import type { z } from "zod";

export interface CompleteJsonOptions<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

/** Swap providers (Gemini, Anthropic, Ollama) by implementing this one method. */
export interface LlmProvider {
  completeJson<T>(opts: CompleteJsonOptions<T>): Promise<T>;
}
