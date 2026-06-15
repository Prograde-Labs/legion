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
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
