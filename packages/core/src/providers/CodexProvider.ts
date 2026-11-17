import type {
  ModelConfig,
  ProviderConfig,
  ProviderModel,
  ProviderUsageSummary,
} from '@legion-collective/types';
import { ProviderError } from '../errors/LegionError.js';
import type { CodexAuth, CodexAuthStore } from './CodexAuthStore.js';
import { normalizeCodexUsage } from './codex-usage.js';
import { OpenAIResponsesProvider } from './OpenAIResponsesProvider.js';
import type { ProviderMessage, ProviderStreamChunk, ProviderTool } from './Provider.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'codex_cli_rs/0.0.1';

export class CodexProvider extends OpenAIResponsesProvider {
  private readonly providerName: string;
  private readonly authStore: CodexAuthStore;
  private readonly usageUrl: string;

  constructor(config: ProviderConfig, authStore: CodexAuthStore) {
    super(config.baseUrl ?? process.env['LEGION_CODEX_BASE_URL'] ?? DEFAULT_BASE_URL, undefined);
    this.providerName = config.name;
    this.authStore = authStore;
    this.usageUrl = process.env['LEGION_CODEX_USAGE_URL'] ?? DEFAULT_USAGE_URL;
  }

  private headers(auth: CodexAuth, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      originator: 'codex_cli_rs',
      'User-Agent': USER_AGENT,
      'OpenAI-Beta': 'responses=experimental',
      Accept: accept,
    };
    if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
    return headers;
  }

  private sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
    const out = { ...body };
    delete out['temperature'];
    delete out['max_output_tokens'];

    const input = Array.isArray(out['input']) ? (out['input'] as Record<string, unknown>[]) : [];
    const systemTexts = input
      .filter((item) => item['role'] === 'system')
      .map((item) => (typeof item['content'] === 'string' ? item['content'] : ''))
      .filter((text) => text.length > 0);

    const instructions = [out['instructions'], ...systemTexts]
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n\n');

    out['input'] = input.filter((item) => item['role'] !== 'system');
    out['instructions'] = instructions || 'Follow the user request.';
    out['parallel_tool_calls'] = false;
    out['include'] = ['reasoning.encrypted_content'];
    return out;
  }

  private async post(
    body: Record<string, unknown>,
    auth: CodexAuth,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(this.responsesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers(auth, 'text/event-stream') },
      body: JSON.stringify(body),
      signal,
    });
  }

  override async *stream(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    model: ModelConfig,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderStreamChunk> {
    let auth = await this.authStore.ensureFresh(this.providerName);
    const body = this.sanitizeBody(this.buildRequestBody(messages, tools, model));

    let res = await this.post(body, auth, options?.signal);
    if (res.status === 401) {
      auth = await this.authStore.ensureFresh(this.providerName, true);
      res = await this.post(body, auth, options?.signal);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`Codex API error ${res.status}: ${text.slice(0, 200)}`, res.status);
    }

    for await (const chunk of this.parseStream(res, options)) {
      if (chunk.type === 'done') yield { ...chunk, cost: 0 };
      else yield chunk;
    }
  }

  override async listModels(): Promise<ProviderModel[]> {
    try {
      const auth = await this.authStore.ensureFresh(this.providerName);
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(auth, 'application/json'),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as Record<string, unknown>;
      const raw = Array.isArray(data['models'])
        ? data['models']
        : Array.isArray(data['data'])
          ? data['data']
          : [];

      return raw.flatMap((entry): ProviderModel[] => {
        const item = entry as Record<string, unknown>;
        const id =
          typeof item['slug'] === 'string'
            ? item['slug']
            : typeof item['id'] === 'string'
              ? item['id']
              : undefined;
        if (!id) return [];

        const name =
          typeof item['display_name'] === 'string'
            ? item['display_name']
            : typeof item['name'] === 'string'
              ? item['name']
              : id;
        const contextWindow =
          typeof item['context_window'] === 'number' ? item['context_window'] : undefined;
        const modalities = Array.isArray(item['input_modalities']) ? item['input_modalities'] : [];
        const capabilities: ProviderModel['capabilities'] = modalities.includes('image')
          ? ['vision']
          : undefined;

        return [{ id, name, contextWindow, capabilities }];
      });
    } catch {
      return [];
    }
  }

  async usage(): Promise<ProviderUsageSummary> {
    const auth = await this.authStore.ensureFresh(this.providerName);
    if (!auth.accountId) throw new ProviderError('Codex account id missing; sign in again');

    const res = await fetch(this.usageUrl, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId,
        originator: 'codex_cli_rs',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`Codex usage error ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return normalizeCodexUsage(await res.json());
  }
}
