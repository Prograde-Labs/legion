import type { MiddlewareModuleConfig } from './middleware.js';

export interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RuntimeConfig {
  maxIterations: number;
  communicationDepthLimit: number;
}

export interface MCPServerConfig {
  /** Unique name for this MCP server; used in tool namespace: `mcp__<name>__<tool>`. */
  name: string;
  /** Stdio transport: path or name of the executable to spawn. Mutually exclusive with `url`. */
  command?: string;
  /** Stdio transport: arguments passed to the spawned process. */
  args?: string[];
  /**
   * Stdio transport: additional environment variables for the child process.
   * Values may contain `${VAR}` placeholders that are expanded from `process.env` at load time.
   */
  env?: Record<string, string>;
  /** HTTP/SSE transport: base URL of the MCP server (e.g. `http://localhost:3000/mcp`). */
  url?: string;
  /** HTTP/SSE transport: additional HTTP headers (e.g. for auth). */
  headers?: Record<string, string>;
}

export interface ServerConfig {
  port?: number;
  host?: string;
}

export interface ConnectorConfig {
  name: string;
  enabled?: boolean;
  defaultParticipantId?: string;
  /** Module spec (absolute path, workspace-relative path, or npm name) for external connectors. */
  module?: string;
  options?: Record<string, unknown>;
}

export interface StorageConfig {
  backend?: 'file' | 'memory';
}

export interface ProviderRetryConfig {
  /** Extra attempts after a transient failure, before content is emitted. Defaults to 3. */
  maxRetries?: number;
  /** Initial exponential backoff window, in milliseconds. Defaults to 500. */
  baseDelayMs?: number;
  /** Maximum wait per retry, including server-requested delays. Defaults to 30000 ms. */
  maxDelayMs?: number;
}

export interface ProviderConfig {
  name: string;
  type: 'openai-compatible' | 'openai-responses' | 'anthropic' | 'copilot' | 'codex';
  baseUrl?: string;
  apiKey?: string;
  priority: number;
  retry?: ProviderRetryConfig;
}

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  capabilities?: ('vision' | 'tools' | 'json_mode')[];
}

export interface RoutingConfig {
  models?: Record<string, string[]>;
  // key: model id, value: ordered provider names (highest priority first)
  // e.g. { "claude-sonnet-4-5": ["Copilot", "My Anthropic"] }
}

export interface LoggingConfig {
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface CommunicationConfig {
  /**
   * Milliseconds a synchronous communicate to a human participant waits for
   * their next message in the conversation. `null` waits indefinitely.
   * Defaults to 30 minutes when unset.
   */
  replyTimeoutMs?: number | null;

  /**
   * How responses routed to `replyTo` are delivered.
   * - `'users'` (default): invoke the runtime of `type: 'user'` targets only.
   * - `'all'`: invoke the runtime of every target type and recurse on each
   *   returned response until a void result or the depth limit. Two agents
   *   replying to each other can consume up to the depth limit (10) turns
   *   with no human in the loop.
   */
  replyToDelivery?: 'users' | 'all';
}

export interface WorkspaceConfig {
  version: '2';
  /**
   * Default base directory for participant file/process tools. Does not
   * relocate `.legion/` storage, which stays at the launch root. May be
   * absolute or relative to the launch root.
   */
  workspaceRoot?: string;
  storage?: StorageConfig;
  server?: ServerConfig;
  connectors?: ConnectorConfig[];
  mcpServers?: MCPServerConfig[];
  logging?: LoggingConfig;
  middlewareModules?: MiddlewareModuleConfig[];
  communication?: CommunicationConfig;
}

/** Shape of .legion/config.local.json — gitignored, overrides WorkspaceConfig + adds routing. */
export interface LocalConfig extends Partial<WorkspaceConfig> {
  routing?: RoutingConfig;
}

/** Shape of ~/.config/legion/config.json — system-level defaults. */
export interface SystemConfig {
  routing?: RoutingConfig;
}
