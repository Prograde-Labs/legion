import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig, ProviderModel } from '@legion/types';
import type {
  Provider,
  ProviderMessage,
  ProviderStopReason,
  ProviderStreamChunk,
  ProviderTool,
} from './Provider.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Strict providers (e.g. LM Studio) reject object schemas without a properties object. */
function normalizeParameters(parameters: ProviderTool['parameters']): ProviderTool['parameters'] {
  if (parameters.type === 'object' && parameters.properties === undefined) {
    return { ...parameters, properties: {} };
  }
  return parameters;
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** Anthropic-via-proxy fields (LiteLLM and similar). NOT OpenAI-native. */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface OAIModelsResponse {
  data?: unknown;
}

interface OAIStreamChunk {
  choices?: Array<{
    delta?: {
      reasoning_content?: unknown;
      reasoning?: unknown;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }>;
  usage?: OAIUsage;
}

const KNOWN_MODEL_METADATA: Record<string, Omit<ProviderModel, 'id'>> = {
  'gpt-4o': {
    name: 'GPT-4o',
    contextWindow: 128000,
    capabilities: ['vision', 'tools', 'json_mode'],
  },
  'gpt-4o-mini': {
    name: 'GPT-4o mini',
    contextWindow: 128000,
    capabilities: ['vision', 'tools', 'json_mode'],
  },
  'gpt-4-turbo': {
    name: 'GPT-4 Turbo',
    contextWindow: 128000,
    capabilities: ['vision', 'tools', 'json_mode'],
  },
  'gpt-3.5-turbo': {
    name: 'GPT-3.5 Turbo',
    contextWindow: 16385,
    capabilities: ['tools', 'json_mode'],
  },
  o1: {
    name: 'o1',
    contextWindow: 200000,
    capabilities: ['vision', 'tools', 'json_mode'],
  },
  'o1-mini': {
    name: 'o1 mini',
    contextWindow: 128000,
    capabilities: ['tools', 'json_mode'],
  },
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5',
    contextWindow: 200000,
    capabilities: ['vision', 'tools'],
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5',
    contextWindow: 200000,
    capabilities: ['vision', 'tools'],
  },
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5',
    contextWindow: 200000,
    capabilities: ['vision', 'tools'],
  },
};

function toOAIMessage(msg: ProviderMessage): OAIMessage {
  const out: OAIMessage = { role: msg.role, content: msg.content };
  if (msg.toolCalls?.length) {
    out.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  if (msg.toolCallId) out.tool_call_id = msg.toolCallId;
  if (msg.name) out.name = msg.name;
  return out;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export class OpenAICompatibleProvider implements Provider {
  constructor(
    private baseUrl = DEFAULT_BASE_URL,
    private apiKey?: string,
  ) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  async *stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk> {
    const body: Record<string, unknown> = {
      model: model.model,
      messages: messages.map(toOAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (model.temperature !== undefined) body['temperature'] = model.temperature;
    if (model.maxTokens !== undefined) body['max_tokens'] = model.maxTokens;
    if (tools.length > 0) {
      body['tools'] = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: normalizeParameters(t.parameters),
        },
      }));
      body['tool_choice'] = 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(this.apiKey),
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.body) {
      throw new ProviderError('OpenAI-compatible API returned no response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let usage: OAIUsage | undefined;
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null = null;
    let streamDone = false;
    let completed = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ':') continue;
          if (!trimmed.startsWith('data:')) continue;

          const raw = trimmed.slice(5).trim();
          if (raw === '[DONE]') {
            streamDone = true;
            break;
          }

          let parsed: OAIStreamChunk;
          try {
            parsed = JSON.parse(raw) as OAIStreamChunk;
          } catch {
            continue;
          }

          if (parsed.usage) {
            usage = parsed.usage;
          }

          for (const choice of parsed.choices ?? []) {
            const delta = choice.delta;
            if (!delta) continue;

            const reasoning =
              typeof delta.reasoning_content === 'string'
                ? delta.reasoning_content
                : typeof delta.reasoning === 'string'
                  ? delta.reasoning
                  : undefined;
            if (reasoning) {
              yield { type: 'reasoning_delta', delta: reasoning };
            }

            if (delta.content) {
              yield { type: 'text_delta', delta: delta.content };
            }

            for (const tc of delta.tool_calls ?? []) {
              const idx = tc.index;
              if (tc.id && tc.function?.name) {
                yield { type: 'tool_call_start', index: idx, id: tc.id, name: tc.function.name };
              }
              if (tc.function?.arguments) {
                yield { type: 'tool_call_args_delta', index: idx, delta: tc.function.arguments };
              }
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          }
        }
        if (streamDone) break;
      }
      completed = true;
    } finally {
      if (!completed || options?.signal?.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    const stopReason: ProviderStopReason =
      finishReason === 'tool_calls'
        ? 'tool_calls'
        : finishReason === 'length'
          ? 'max_tokens'
          : 'stop';

    yield {
      type: 'done',
      stopReason,
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
            cacheReadInputTokens:
              usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens,
            cacheWriteInputTokens: usage.cache_creation_input_tokens,
          }
        : undefined,
      cost: undefined,
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: authHeaders(this.apiKey),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as OAIModelsResponse;
      if (!Array.isArray(data.data)) return [];

      return data.data.flatMap((item): ProviderModel[] => {
        if (!item || typeof item !== 'object') return [];
        const id = (item as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) return [];
        return [{ id, ...KNOWN_MODEL_METADATA[id] }];
      });
    } catch {
      return [];
    }
  }
}
