import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig, ProviderModel } from '@legion/types';
import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderStopReason,
  ProviderTool,
  ProviderToolCall,
} from './Provider.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

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

interface OAIChatResponse {
  choices: Array<{
    message: OAIMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OAIModelsResponse {
  data?: unknown;
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

  async complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: model.model,
      messages: messages.map(toOAIMessage),
    };
    if (model.temperature !== undefined) body['temperature'] = model.temperature;
    if (model.maxTokens !== undefined) body['max_tokens'] = model.maxTokens;
    if (tools.length > 0) {
      body['tools'] = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
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
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`OpenAI-compatible API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OAIChatResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new ProviderError('No choices returned from OpenAI-compatible API');
    }

    const msg = choice.message;
    const toolCalls: ProviderToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const stopReason: ProviderStopReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'stop';

    return {
      content: msg.content,
      toolCalls,
      stopReason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
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
