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

export interface ProviderUsageWindow {
  /** Human label: "5-hour", "Weekly", or an additional-limit name. */
  label: string;
  /** 0-100 as reported by the provider, or null when unknown. */
  usedPercent: number | null;
  /** clamp(100 - usedPercent, 0, 100), or null when unknown. */
  remainingPercent: number | null;
  windowSeconds: number | null;
  /** Unix seconds. */
  resetAt: number | null;
}

export interface ProviderUsageSummary {
  planType?: string;
  windows: ProviderUsageWindow[];
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  /** ISO 8601 timestamp of the fetch. */
  capturedAt: string;
}
