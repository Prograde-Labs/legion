import { ProviderError } from '../errors/LegionError.js';
import type { ModelConfig } from '@legion-collective/types';
import {
  authHeaders,
  normalizeParameters,
  OpenAICompatibleProvider,
} from './OpenAICompatibleProvider.js';
import type {
  ProviderMessage,
  ProviderStopReason,
  ProviderStreamChunk,
  ProviderTool,
  ProviderUsage,
} from './Provider.js';

/** Input item shapes we emit; backends tolerate extra fields, so parsing stays loose. */
type ResponsesInputItem =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: ProviderTool['parameters'];
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface ResponsesObject {
  usage?: ResponsesUsage;
  error?: { code?: unknown; message?: unknown };
  incomplete_details?: { reason?: unknown };
}

interface ResponsesEvent {
  type?: unknown;
  response?: ResponsesObject;
  delta?: unknown;
  item?: { type?: unknown; call_id?: unknown; name?: unknown; id?: unknown };
  output_index?: unknown;
  item_id?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function mapUsage(usage: ResponsesUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    cacheReadInputTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens,
  };
}

/** Per-stream parser state — a provider instance may serve many streams. */
interface StreamState {
  reasoningMode: 'full' | 'summary' | undefined;
  emittedToolCall: boolean;
  /** Resolved chunk index per tool-call key (item_id when present, else output_index). */
  toolKeyToIndex: Map<string, number>;
  /** Fallback counter for args deltas whose key was never started. */
  nextSyntheticIndex: number;
}

/**
 * OpenAI Responses API wire format, mapped statelessly onto the shared
 * ProviderStreamChunk union. See docs/superpowers/specs/2026-10-06-responses-api-provider-design.md
 * (§Q2) for the full mapping and quirk-tolerance rules: only delta events emit
 * chunks; `response.output` replays inside terminal events never do; unknown
 * event types are ignored; missing sequence_number is tolerated.
 */
export class OpenAIResponsesProvider extends OpenAICompatibleProvider {
  async *stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk> {
    const body = this.buildRequestBody(messages, tools, model);

    const res = await fetch(`${this.baseUrl}/responses`, {
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
    let sawTerminal = false;
    let stopReason: ProviderStopReason = 'stop';
    let usage = undefined as ReturnType<typeof mapUsage>;
    let completed = false;
    const state: StreamState = {
      reasoningMode: undefined,
      emittedToolCall: false,
      toolKeyToIndex: new Map(),
      nextSyntheticIndex: 0,
    };

    try {
      while (!sawTerminal) {
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
          if (raw === '[DONE]') continue; // no sentinel in Responses; tolerate a trailing one

          let event: ResponsesEvent;
          try {
            event = JSON.parse(raw) as ResponsesEvent;
          } catch {
            continue; // quirk tolerance: skip non-JSON data lines
          }

          for (const chunk of this.handleEvent(event, state)) {
            if (chunk.type === 'done') {
              // Exactly one done is yielded, after the loop — never inside it.
              sawTerminal = true;
              stopReason = chunk.stopReason;
              if (chunk.usage) usage = chunk.usage;
            } else {
              yield chunk;
            }
          }
          if (sawTerminal) break;
        }
      }
      completed = true;
    } finally {
      if (!completed || options?.signal?.aborted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (!sawTerminal) {
      throw new ProviderError('Responses stream ended without a terminal event');
    }

    yield { type: 'done', stopReason, usage, cost: undefined };
  }

  private buildRequestBody(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
  ): Record<string, unknown> {
    const { instructions, input } = this.mapInput(messages);
    const body: Record<string, unknown> = {
      model: model.model,
      input,
      stream: true,
      store: false,
    };
    if (instructions !== undefined) body['instructions'] = instructions;
    if (model.temperature !== undefined) body['temperature'] = model.temperature;
    if (model.maxTokens !== undefined) body['max_output_tokens'] = model.maxTokens;
    if (tools.length > 0) {
      const mapped: ResponsesFunctionTool[] = tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: normalizeParameters(t.parameters),
      }));
      body['tools'] = mapped;
      body['tool_choice'] = 'auto';
    }
    return body;
  }

  private mapInput(messages: ProviderMessage[]): {
    instructions?: string;
    input: ResponsesInputItem[];
  } {
    const input: ResponsesInputItem[] = [];
    let instructions: string | undefined;
    for (const msg of messages) {
      if (msg.role === 'system') {
        if (instructions === undefined && msg.content !== null) {
          instructions = msg.content;
          continue;
        }
        input.push({ role: 'system', content: msg.content ?? '' });
        continue;
      }
      if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content ?? '' });
        continue;
      }
      if (msg.role === 'assistant') {
        if (msg.content !== null) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: msg.content }] });
        }
        for (const tc of msg.toolCalls ?? []) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
        continue;
      }
      // role === 'tool'
      input.push({
        type: 'function_call_output',
        call_id: msg.toolCallId ?? '',
        output: msg.content ?? '',
      });
    }
    return { instructions, input };
  }

  private handleEvent(event: ResponsesEvent, state: StreamState): ProviderStreamChunk[] {
    const type = asString(event.type);
    if (!type) return []; // quirk tolerance: event without a type is ignored

    if (type === 'response.output_text.delta') {
      const delta = asString(event.delta);
      if (delta) return [{ type: 'text_delta', delta }];
      return [];
    }

    if (type === 'response.reasoning_text.delta') {
      if (state.reasoningMode === 'summary') return []; // first shape seen wins for this stream
      state.reasoningMode = 'full';
      const delta = asString(event.delta);
      if (delta) return [{ type: 'reasoning_delta', delta }];
      return [];
    }

    if (type === 'response.reasoning_summary_text.delta') {
      if (state.reasoningMode === 'full') return [];
      state.reasoningMode = 'summary';
      const delta = asString(event.delta);
      if (delta) return [{ type: 'reasoning_delta', delta }];
      return [];
    }

    if (type === 'response.refusal.delta') {
      const delta = asString(event.delta);
      if (delta) return [{ type: 'text_delta', delta }];
      return [];
    }

    if (type === 'response.output_item.added') {
      const item = event.item ?? {};
      if (asString(item.type) !== 'function_call') return [];
      state.emittedToolCall = true;
      const callId = asString(item.call_id) ?? '';
      const name = asString(item.name) ?? '';
      const rawIndex = typeof event.output_index === 'number' ? event.output_index : undefined;
      const itemId = asString(item.id) ?? asString(event.item_id) ?? `idx:${rawIndex ?? '?'}`;
      const index = this.indexFor(itemId, state, rawIndex);
      state.toolKeyToIndex.set(`start:${itemId}`, index);
      return [{ type: 'tool_call_start', index, id: callId, name }];
    }

    if (type === 'response.function_call_arguments.delta') {
      const delta = asString(event.delta);
      if (!delta) return [];
      const rawIndex = typeof event.output_index === 'number' ? event.output_index : undefined;
      const key = asString(event.item_id) ?? `idx:${rawIndex ?? '?'}`;
      // Reuse the index assigned at tool_call_start for the same item when known.
      const started = state.toolKeyToIndex.get(`start:${key}`);
      const index = started ?? this.indexFor(key, state, rawIndex);
      return [{ type: 'tool_call_args_delta', index, delta }];
    }

    if (type === 'response.incomplete') {
      const response = event.response ?? {};
      const reason = asString(response.incomplete_details?.reason);
      const stopReason: ProviderStopReason = reason === 'max_output_tokens' ? 'max_tokens' : 'stop';
      return [{ type: 'done', stopReason, usage: mapUsage(response.usage), cost: undefined }];
    }

    if (type === 'response.failed') {
      const error = event.response?.error ?? {};
      const code = asString(error.code) ?? 'unknown_error';
      const message = asString(error.message) ?? 'Responses stream failed';
      throw new ProviderError(`Responses API error ${code}: ${message}`);
    }

    if (type === 'response.completed') {
      const response = event.response ?? {};
      const stopReason: ProviderStopReason = state.emittedToolCall ? 'tool_calls' : 'stop';
      return [{ type: 'done', stopReason, usage: mapUsage(response.usage), cost: undefined }];
    }

    // Everything else — response.created, *_done replays, unknown types — is ignored.
    return [];
  }

  /**
   * Resolve a delta event's tool-call key to the stable chunk index AgentRuntime
   * accumulates by. Keys on item_id when present, falling back to output_index
   * (ollama shares output_index across a text item and a following function call).
   */
  private indexFor(key: string, state: StreamState, startIndex: number | undefined): number {
    const existing = state.toolKeyToIndex.get(key);
    if (existing !== undefined) return existing;
    const index = startIndex ?? state.nextSyntheticIndex++;
    state.toolKeyToIndex.set(key, index);
    return index;
  }
}
