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
import { httpProviderError, isRetryableProviderFailure } from './provider-retry.js';
import type { ProviderMessage, ProviderStreamChunk, ProviderTool } from './Provider.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'codex_cli_rs/0.0.1';

function redact(text: string, tokens: string[]): string {
  return tokens
    .filter((token) => token.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((body, token) => body.replaceAll(token, '[redacted]'), text);
}

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

  private authFailure(error: unknown): ProviderError {
    const safe = error instanceof ProviderError ? error : undefined;
    return new ProviderError(
      safe?.message ?? 'Codex authentication request failed; sign in again',
      safe?.status,
      { providerCode: safe?.providerCode, retryable: false },
    );
  }

  private requestFailure(error: unknown, tokens: string[]): ProviderError {
    const safe = error instanceof ProviderError ? error : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(redact(message, tokens), safe?.status, {
      providerCode: safe?.providerCode ? redact(safe.providerCode, tokens) : undefined,
      retryable: isRetryableProviderFailure(error),
      retryAfterMs: safe?.retryAfterMs,
    });
  }

  private async authenticatedRequest(
    request: (auth: CodexAuth) => Promise<Response>,
  ): Promise<{ res: Response; tokens: string[] }> {
    let auth: CodexAuth;
    try {
      auth = await this.authStore.ensureFresh(this.providerName);
    } catch (error) {
      throw this.authFailure(error);
    }
    const tokens = [auth.accessToken];
    let res: Response;
    try {
      res = await request(auth);
    } catch (error) {
      throw this.requestFailure(error, tokens);
    }
    if (res.status === 401) {
      try {
        auth = await this.authStore.ensureFresh(this.providerName, true);
      } catch (error) {
        throw this.authFailure(error);
      }
      tokens.push(auth.accessToken);
      try {
        res = await request(auth);
      } catch (error) {
        throw this.requestFailure(error, tokens);
      }
    }
    return { res, tokens };
  }

  private async responseError(
    res: Response,
    tokens: string[],
    context: string,
  ): Promise<ProviderError> {
    return httpProviderError(res, context, (text) => redact(text, tokens));
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
    const body = this.sanitizeBody(this.buildRequestBody(messages, tools, model));
    const { res, tokens } = await this.authenticatedRequest((currentAuth) =>
      this.post(body, currentAuth, options?.signal),
    );

    if (!res.ok) {
      throw await this.responseError(res, tokens, 'Codex API error');
    }

    try {
      for await (const chunk of this.parseStream(res, options)) {
        if (chunk.type === 'done') yield { ...chunk, cost: 0 };
        else yield chunk;
      }
    } catch (err) {
      throw this.requestFailure(err, tokens);
    }
  }

  override async listModels(): Promise<ProviderModel[]> {
    try {
      const { res, tokens } = await this.authenticatedRequest((auth) =>
        fetch(`${this.baseUrl}/models`, { headers: this.headers(auth, 'application/json') }),
      );
      if (!res.ok) throw await this.responseError(res, tokens, 'Codex models error');

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
    const { res, tokens } = await this.authenticatedRequest((currentAuth) => {
      if (!currentAuth.accountId)
        throw new ProviderError('Codex account id missing; sign in again');
      return fetch(this.usageUrl, { headers: this.headers(currentAuth, 'application/json') });
    });
    if (!res.ok) {
      throw await this.responseError(res, tokens, 'Codex usage error');
    }
    return normalizeCodexUsage(await res.json());
  }
}
