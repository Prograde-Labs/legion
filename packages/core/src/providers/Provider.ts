import type { JSONSchema, ModelConfig, ProviderModel } from '@legion/types';

import type { PricingSource } from './PricingSource.js';

/**
 * A message in the LLM conversation thread.
 * `role: 'tool'` carries the result of a function call; use `toolCallId` to match it.
 */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Set on role:'assistant' messages that contain function calls. */
  toolCalls?: ProviderToolCall[];
  /** Set on role:'tool' messages — matches the originating ProviderToolCall.id. */
  toolCallId?: string;
  /** Set on role:'tool' messages — the tool name (convenience for logging). */
  name?: string;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool definition sent to the LLM so it can choose to call it. */
export interface ProviderTool {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type ProviderStopReason = 'stop' | 'tool_calls' | 'max_tokens';

/** Raw usage from the provider API. inputTokens includes cached tokens on OpenAI/AI SDK v6. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ProviderResponse {
  /** Final assistant text, or null if the LLM only produced tool calls. */
  content: string | null;
  /** Non-empty when stopReason === 'tool_calls'. */
  toolCalls: ProviderToolCall[];
  stopReason: ProviderStopReason;
  usage?: ProviderUsage;
  /**
   * Provider may override cost calculation (e.g. Copilot nano-AIU).
   * If absent, UsageCalculator computes it via PricingSource.
   */
  cost?: number;
}

/**
 * LLM provider interface. Implementations are constructed by SystemProviderStore
 * and resolved by ModelRouter.
 */
export interface Provider {
  complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse>;

  /**
   * Optional: return all models this provider can serve.
   * Providers that do not implement this cannot be auto-resolved by ModelRouter —
   * they must be referenced explicitly via RoutingConfig.
   */
  listModels?(): Promise<ProviderModel[]>;

  /**
   * Optional: return a PricingSource for models this provider serves.
   * If absent, the system-wide OpenRouterPricingSource is used.
   * Providers with bespoke billing (e.g. Copilot AIU, self-hosted) implement this.
   */
  pricingSource?(): PricingSource;
}
