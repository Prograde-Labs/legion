import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig, JSONSchema } from '@legion/types';
import { ConfigError } from '../errors/LegionError.js';
import type { Tool, ToolContext } from './Tool.js';
import type { ToolResult } from '@legion/types';
import type { ToolSource } from './ToolSource.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Expand `${VAR}` placeholders from `process.env`. Unresolved vars become `''`. */
function expandEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  return result;
}

interface MCPTextContent {
  type: 'text';
  text: string;
}

interface MCPCallToolResult {
  content: MCPTextContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// MCPToolSource
// ---------------------------------------------------------------------------

/**
 * Connects to an MCP server (stdio or HTTP/SSE), lists its tools, and registers
 * them in the ToolRegistry under the `mcp__<serverName>__<toolName>` namespace.
 *
 * The client connection is held open for the lifetime of the process so that
 * individual tool `execute()` calls can relay requests to the server.
 *
 * Spec §9.
 */
export class MCPToolSource implements ToolSource {
  private client: Client | null = null;

  constructor(private readonly config: MCPServerConfig) {
    if (!config.command && !config.url) {
      throw new ConfigError(
        `MCPServerConfig "${config.name}": at least one of "command" or "url" must be provided`,
      );
    }
  }

  async load(): Promise<Tool[]> {
    if (this.client) return [];

    const transport = this.createTransport();
    const client = new Client(
      { name: 'legion', version: '2.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.client = client;

    const { tools: mcpTools } = await client.listTools();
    const serverName = this.config.name;

    return mcpTools.map((mcpTool) => {
      const namespacedName = `mcp__${serverName}__${mcpTool.name}`;
      const originalName = mcpTool.name;

      const tool: Tool = {
        name: namespacedName,
        description: mcpTool.description ?? namespacedName,
        parameters: mcpTool.inputSchema ?? {
          type: 'object',
        } as JSONSchema,
        async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
          try {
            const response = (await client!.callTool({
              name: originalName,
              arguments: args as Record<string, unknown>,
            })) as MCPCallToolResult;

            if (response.isError) {
              const errorText =
                response.content.find((c) => c.type === 'text')?.text ?? 'MCP tool error';
              return { status: 'error', error: errorText };
            }

            return { status: 'success', data: response.content };
          } catch (err) {
            return {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      };

      return tool;
    });
  }

  async unload(): Promise<void> {
    if (!this.client) return;
    await this.client.close();
    this.client = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private createTransport(): SSEClientTransport | StdioClientTransport {
    const { config } = this;

    // Prefer HTTP/SSE when a URL is present (even if command is also set).
    if (config.url) {
      const opts: { requestInit?: RequestInit } = {};
      if (config.headers) {
        opts.requestInit = { headers: config.headers };
      }
      return new SSEClientTransport(new URL(config.url), opts);
    }

    // Stdio transport.
    // config.command is guaranteed non-null here (constructor guard).
    const stdioEnv = config.env
      ? ({
          ...Object.fromEntries(
            Object.entries(process.env).filter(([, v]) => v !== undefined),
          ),
          ...expandEnv(config.env),
        } as Record<string, string>)
      : undefined;
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: stdioEnv,
    });
  }
}
