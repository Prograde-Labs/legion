import type { JSONSchema, ModelConfig, ProviderModel } from '@legion-collective/types';

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
 * Wire format for individual chunks from the LLM SSE stream.
 * The `done` chunk is consumed internally by AgentRuntime and never
 * becomes a StreamChunk visible to tool callers.
 */
export type ProviderStreamChunk =
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'done'; stopReason: ProviderStopReason; usage?: ProviderUsage; cost?: number };

/**
 * LLM provider interface. Implementations are constructed by SystemProviderStore
 * and resolved by ModelRouter.
 */
export interface Provider {
  /**
   * Stream a chat completion. Yields one or more content/tool-call delta chunks
   * followed by exactly one `done` chunk. The caller accumulates deltas and acts
   * on the `done` chunk to determine stop reason and usage.
   *
   * Non-streaming providers implement this by calling their blocking endpoint
   * and yielding the response as a synthetic sequence of chunks.
   */
  stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk>;

  /** Optional: enumerate models available from this provider. */
  listModels?(): Promise<ProviderModel[]>;
  /** Optional: override system-wide pricing for this provider. */
  pricingSource?(): PricingSource;
}
