export interface ModelConfig {
  provider: string; // e.g. 'openai-compatible' | 'anthropic'
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string; // name of env var holding the key
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
  options?: Record<string, unknown>;
}

export interface StorageConfig {
  backend?: 'file' | 'memory';
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface LoggingConfig {
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface WorkspaceConfig {
  version: '2';
  workspaceRoot?: string;
  storage?: StorageConfig;
  server?: ServerConfig;
  connectors?: ConnectorConfig[];
  mcpServers?: MCPServerConfig[];
  defaultModel?: ModelConfig;
  providers?: Record<string, ProviderConfig>;
  logging?: LoggingConfig;
}
