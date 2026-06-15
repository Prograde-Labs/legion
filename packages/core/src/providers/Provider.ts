import type { JSONSchema, ModelConfig } from '@legion/types';

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

export interface ProviderResponse {
  /** Final assistant text, or null if the LLM only produced tool calls. */
  content: string | null;
  /** Non-empty when stopReason === 'tool_calls'. */
  toolCalls: ProviderToolCall[];
  stopReason: ProviderStopReason;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Custom LLM provider interface. Implementations are constructor-injected
 * into AgentRuntime via ProviderRegistry. `model` carries per-model config
 * (base URL, api key env var name, temperature, etc.) from WorkspaceConfig.
 */
export interface Provider {
  complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse>;
}
