export interface MessageUsage {
  /** Non-cached input tokens (promptTokens - cacheRead - cacheWrite). */
  input: number;
  /** Output tokens excluding reasoning. */
  output: number;
  /** Reasoning/thinking tokens (o1/o3, Claude extended thinking). */
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
  /** Computed cost in USD. May be 0 if pricing unavailable. */
  cost: number;
  /** Model ID as known to the provider (e.g. "claude-sonnet-4-5"). */
  modelId: string;
  /** Provider ID (e.g. "anthropic", "openai"). */
  providerId: string;
}
