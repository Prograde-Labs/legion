import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion/types';
import type {
  Provider,
  ProviderMessage,
  ProviderResponse,
  ProviderStopReason,
  ProviderTool,
  ProviderToolCall,
} from './Provider.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';

// ── Internal OpenAI Chat Completions wire types ──────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────

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

export class OpenAICompatibleProvider implements Provider {
  constructor(
    private defaultBaseUrl = DEFAULT_BASE_URL,
    private defaultApiKeyEnv = DEFAULT_API_KEY_ENV,
  ) {}

  async complete(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Promise<ProviderResponse> {
    // Base URL: per-model override → OPENAI_BASE_URL env var → constructor default.
    const baseUrl = (
      model.baseUrl ??
      process.env['OPENAI_BASE_URL'] ??
      this.defaultBaseUrl
    ).replace(/\/$/, '');

    // API key: read the env var named by model.apiKeyEnv (or the constructor default).
    const apiKeyEnv = model.apiKeyEnv ?? this.defaultApiKeyEnv;
    const apiKey = process.env[apiKeyEnv];

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

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
}
