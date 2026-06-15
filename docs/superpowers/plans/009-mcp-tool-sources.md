# MCP Tool Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `ToolSource` abstraction and `MCPToolSource` — spawning or connecting to MCP servers, listing their tools into the global `ToolRegistry` under the `mcp__<serverName>__<toolName>` namespace, and executing tool calls via the MCP client. Also provide the `loadMCPSources()` utility that Plan 10 calls during startup (spec §8 step 7).

**Architecture:** MCP servers are _tool sources_, not participants. They extend the global `ToolRegistry` making those tools available to any participant whose tool policy allows them. Two transports are supported: **stdio** (spawn a subprocess via `command`/`args`/`env`) and **HTTP/SSE** (connect to a remote server via `url`). Transport selection is automatic: if `url` is present, SSE is used; otherwise stdio is required. The official `@modelcontextprotocol/sdk` npm package handles all protocol details. The `MCPToolSource` maintains a live client connection for the lifetime of the process; each tool's `execute()` method sends a `tools/call` request over that connection. `loadMCPSources()` creates one source per config entry, connects them all, and registers every tool into the registry. Plan 10 calls `unload()` on each source during graceful shutdown. Depends on Plans 1–4.

**Tech Stack:** TypeScript strict ESM, Vitest globals, Node 20+ (`child_process`, native `fetch`), `@modelcontextprotocol/sdk ^1.0.0`.

---

## File Structure

**New files — all under `packages/core/src/tools/`:**

| File | Responsibility |
|------|----------------|
| `ToolSource.ts` | `ToolSource` interface |
| `ToolSource.test.ts` | Type-shape tests |
| `MCPToolSource.ts` | `MCPToolSource` implementation (both transports) |
| `MCPToolSource.test.ts` | Unit tests (mock SDK) |
| `loadMCPSources.ts` | `loadMCPSources()` utility |
| `loadMCPSources.test.ts` | Unit tests |
| `MCPToolSource.integration.test.ts` | Integration test (real subprocess, `LEGION_MCP_INTEGRATION=1`) |
| `fixtures/echo-mcp-server.mjs` | Minimal MCP stdio server fixture used by the integration test |

**Amended files:**

| File | Change |
|------|--------|
| `packages/types/src/config.ts` | `MCPServerConfig`: make `command` optional, add `url?` and `headers?` |
| `packages/core/src/index.ts` | Add `ToolSource`, `MCPToolSource`, `loadMCPSources` barrel exports |

---

## Task 1: Amend `MCPServerConfig` in `@legion/types`

**Files:**
- Amend: `packages/types/src/config.ts`

> Spec §9 + §11. The original spec defines `command` as required. Adding `url?` and `headers?` for HTTP/SSE transport; making `command` optional so either transport can be used. Invariant: at least one of `command` or `url` must be provided — enforced at runtime by `MCPToolSource`, not at the type level.

- [ ] **Step 1: Amend `MCPServerConfig`**

In `packages/types/src/config.ts`, replace:

```typescript
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
```

with:

```typescript
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
```

- [ ] **Step 2: Verify build**

```bash
npm run build --workspace=packages/types
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```
git add packages/types/src/config.ts
git commit -m "types: extend MCPServerConfig with url/headers for HTTP/SSE transport"
```

---

## Task 2: `ToolSource` interface

**Files:**
- Create: `packages/core/src/tools/ToolSource.ts`
- Create: `packages/core/src/tools/ToolSource.test.ts`

> Spec §9 (`ToolSource` interface). Minimal abstraction over any tool source. Lives in `@legion/core` because it references `Tool` which is also in `@legion/core`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/tools/ToolSource.test.ts`:

```typescript
import type { Tool } from './Tool.js';
import type { ToolSource } from './ToolSource.js';

describe('ToolSource interface', () => {
  it('can be implemented with only load()', () => {
    const source: ToolSource = {
      async load(): Promise<Tool[]> {
        return [];
      },
    };
    expect(typeof source.load).toBe('function');
    expect(source.unload).toBeUndefined();
  });

  it('can be implemented with both load() and unload()', () => {
    let unloaded = false;
    const source: ToolSource = {
      async load(): Promise<Tool[]> {
        return [];
      },
      async unload(): Promise<void> {
        unloaded = true;
      },
    };
    expect(typeof source.unload).toBe('function');
    // Confirm unload() is callable.
    source.unload!();
    expect(unloaded).toBe(true);
  });

  it('load() returns a Tool array', async () => {
    const source: ToolSource = {
      async load(): Promise<Tool[]> {
        return [
          {
            name: 'fake_tool',
            description: 'test',
            parameters: { type: 'object', properties: {} },
            async execute(_args, _ctx) {
              return { status: 'success', data: null };
            },
          },
        ];
      },
    };
    const tools = await source.load();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('fake_tool');
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test --workspace=packages/core -- --reporter=verbose ToolSource.test
```

Expected: `Cannot find module './ToolSource.js'`.

- [ ] **Step 3: Write `ToolSource.ts`**

`packages/core/src/tools/ToolSource.ts`:

```typescript
import type { Tool } from './Tool.js';

/**
 * A ToolSource contributes tools to the global ToolRegistry.
 * It is responsible for the full lifecycle of its connection:
 * `load()` establishes the connection and returns the available tools;
 * `unload()` (optional) tears it down cleanly.
 *
 * Spec §9.
 */
export interface ToolSource {
  /**
   * Connect to the underlying source and return all tools it exposes.
   * Called once at startup; the source must remain connected for the lifetime
   * of the process so that tool `execute()` calls can reach the server.
   */
  load(): Promise<Tool[]>;

  /**
   * Disconnect from the underlying source and release any held resources.
   * Called during graceful shutdown.
   */
  unload?(): Promise<void>;
}
```

- [ ] **Step 4: Run — expect green**

```bash
npm test --workspace=packages/core -- --reporter=verbose ToolSource.test
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/ToolSource.ts packages/core/src/tools/ToolSource.test.ts
git commit -m "core: add ToolSource interface (spec §9)"
```

---

## Task 3: `MCPToolSource` — transport, `load()`, and unit tests

**Files:**
- Create: `packages/core/src/tools/MCPToolSource.ts`
- Create: `packages/core/src/tools/MCPToolSource.test.ts`

> Core of the plan. Implements `ToolSource` using `@modelcontextprotocol/sdk`. Handles both stdio (subprocess) and HTTP/SSE transports. Maps MCP tool descriptors to our `Tool` interface and stores a live client reference so `execute()` can send `tools/call` requests.

### Design notes

**Transport selection:**
- `config.url` present → `SSEClientTransport`
- `config.command` present → `StdioClientTransport`
- Neither → throw `ConfigError`

**Tool name convention:** `mcp__<serverName>__<mcpToolName>` (double underscore separators). The server name comes from `MCPServerConfig.name`; the tool name from the MCP `tools/list` response.

**`env` interpolation:** Values matching `${VAR}` are replaced with `process.env.VAR ?? ''`. Applied only to `MCPServerConfig.env`; never to `headers` (those are already resolved values).

**`execute()` result mapping:**
- `callTool` response has `content` (array of content blocks) and optional `isError: true`.
- If `isError` is truthy → `{ status: 'error', error: first text block or 'MCP tool error' }`.
- Otherwise → `{ status: 'success', data: content }`.
- Thrown exceptions → `{ status: 'error', error: err.message }`.

**`parameters`:** MCP tool `inputSchema` maps directly to our `JSONSchema` type (both are plain objects).

**Dependency on `@modelcontextprotocol/sdk`:** Add to `packages/core/package.json` as a production dependency.

- [ ] **Step 1: Add SDK dependency**

In `packages/core/package.json`, add to `"dependencies"`:

```json
"@modelcontextprotocol/sdk": "^1.0.0"
```

Then:

```bash
npm install --workspace=packages/core
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/tools/MCPToolSource.test.ts`:

```typescript
import { type MockedClass, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '@legion/types';
import { ConfigError } from '../errors/index.js';
import { MCPToolSource } from './MCPToolSource.js';

// ---------------------------------------------------------------------------
// Mock the MCP SDK so no subprocess is spawned.
// ---------------------------------------------------------------------------
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation((url: unknown) => ({ _url: url })),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks are set up.
// ---------------------------------------------------------------------------
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

const MockClient = Client as MockedClass<typeof Client>;
const MockStdio = StdioClientTransport as MockedClass<typeof StdioClientTransport>;
const MockSSE = SSEClientTransport as MockedClass<typeof SSEClientTransport>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeToolDescriptor(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  };
}

function makeContext() {
  return {
    participant: { id: 'agent-1', type: 'agent' as const, name: 'Agent 1' },
    conversationId: 'conv-1',
    collective: {} as never,
    config: {} as never,
    eventBus: {} as never,
    storage: {} as never,
    workspaceRoot: '/workspace',
    communicationDepth: 0,
    toolRegistry: {} as never,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MCPToolSource — configuration validation', () => {
  it('throws ConfigError when neither command nor url is provided', () => {
    const config: MCPServerConfig = { name: 'bad-server' };
    expect(() => new MCPToolSource(config)).toThrow(ConfigError);
    expect(() => new MCPToolSource(config)).toThrow(/command.*url/i);
  });

  it('does not throw when command is provided', () => {
    const config: MCPServerConfig = { name: 'stdio-server', command: 'npx', args: ['server'] };
    expect(() => new MCPToolSource(config)).not.toThrow();
  });

  it('does not throw when url is provided', () => {
    const config: MCPServerConfig = { name: 'sse-server', url: 'http://localhost:3000/mcp' };
    expect(() => new MCPToolSource(config)).not.toThrow();
  });
});

describe('MCPToolSource — transport selection', () => {
  beforeEach(() => {
    MockClient.mockClear();
    MockStdio.mockClear();
    MockSSE.mockClear();
  });

  it('uses StdioClientTransport when command is present', async () => {
    const config: MCPServerConfig = {
      name: 'stdio-server',
      command: 'my-server',
      args: ['--flag'],
      env: { MY_VAR: 'hello' },
    };
    const source = new MCPToolSource(config);
    await source.load();
    expect(MockStdio).toHaveBeenCalledOnce();
    expect(MockSSE).not.toHaveBeenCalled();
  });

  it('uses SSEClientTransport when url is present', async () => {
    const config: MCPServerConfig = {
      name: 'sse-server',
      url: 'http://localhost:3000/mcp',
    };
    const source = new MCPToolSource(config);
    await source.load();
    expect(MockSSE).toHaveBeenCalledOnce();
    expect(MockSSE).toHaveBeenCalledWith(expect.any(URL));
    expect(MockStdio).not.toHaveBeenCalled();
  });

  it('prefers url over command when both are set', async () => {
    const config: MCPServerConfig = {
      name: 'dual-server',
      command: 'some-cmd',
      url: 'http://localhost:9000/mcp',
    };
    const source = new MCPToolSource(config);
    await source.load();
    expect(MockSSE).toHaveBeenCalledOnce();
    expect(MockStdio).not.toHaveBeenCalled();
  });
});

describe('MCPToolSource — env variable interpolation', () => {
  beforeEach(() => {
    MockClient.mockClear();
    MockStdio.mockClear();
    process.env.TEST_MCP_KEY = 'my-api-key';
    process.env.TEST_MCP_OTHER = 'other-value';
  });

  afterEach(() => {
    delete process.env.TEST_MCP_KEY;
    delete process.env.TEST_MCP_OTHER;
  });

  it('expands ${VAR} placeholders from process.env', async () => {
    const config: MCPServerConfig = {
      name: 'env-server',
      command: 'server',
      env: {
        API_KEY: '${TEST_MCP_KEY}',
        OTHER: '${TEST_MCP_OTHER}',
        LITERAL: 'no-substitution',
      },
    };
    const source = new MCPToolSource(config);
    await source.load();

    const stdioCall = MockStdio.mock.calls[0][0] as { env?: Record<string, string> };
    expect(stdioCall.env?.API_KEY).toBe('my-api-key');
    expect(stdioCall.env?.OTHER).toBe('other-value');
    expect(stdioCall.env?.LITERAL).toBe('no-substitution');
  });

  it('replaces unresolved ${VAR} with empty string', async () => {
    const config: MCPServerConfig = {
      name: 'missing-env-server',
      command: 'server',
      env: { API_KEY: '${DEFINITELY_NOT_SET_XYZ}' },
    };
    const source = new MCPToolSource(config);
    await source.load();

    const stdioCall = MockStdio.mock.calls[0][0] as { env?: Record<string, string> };
    expect(stdioCall.env?.API_KEY).toBe('');
  });

  it('does not interpolate headers (SSE transport)', async () => {
    const config: MCPServerConfig = {
      name: 'sse-auth',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer ${TEST_MCP_KEY}' },
    };
    const source = new MCPToolSource(config);
    await source.load();
    // Headers are passed through verbatim; interpolation is the caller's responsibility.
    expect(MockSSE).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ headers: { Authorization: 'Bearer ${TEST_MCP_KEY}' } }),
    );
  });
});

describe('MCPToolSource — load() tool mapping', () => {
  beforeEach(() => {
    MockClient.mockClear();
  });

  it('returns an empty array when the server exposes no tools', async () => {
    const source = new MCPToolSource({ name: 'empty-server', command: 'server' });
    const tools = await source.load();
    expect(tools).toEqual([]);
  });

  it('namespaces tool names as mcp__<serverName>__<toolName>', async () => {
    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [makeToolDescriptor('search'), makeToolDescriptor('fetch')],
      }),
      callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    const source = new MCPToolSource({ name: 'brave', command: 'brave-server' });
    const tools = await source.load();
    expect(tools.map((t) => t.name)).toEqual(['mcp__brave__search', 'mcp__brave__fetch']);
  });

  it('maps MCP inputSchema to Tool.parameters', async () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    };
    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ name: 'search', description: 'web search', inputSchema: schema }] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    const source = new MCPToolSource({ name: 'brave', command: 'brave-server' });
    const [tool] = await source.load();
    expect(tool.parameters).toEqual(schema);
  });

  it('maps MCP tool description to Tool.description', async () => {
    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ name: 'go', description: 'Fetch a URL', inputSchema: { type: 'object' } }] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    const source = new MCPToolSource({ name: 'http', command: 'http-server' });
    const [tool] = await source.load();
    expect(tool.description).toBe('Fetch a URL');
  });

  it('calls client.connect() exactly once during load()', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    MockClient.mockImplementationOnce(() => mockClient);
    const source = new MCPToolSource({ name: 'test', command: 'server' });
    await source.load();
    expect(mockClient.connect).toHaveBeenCalledOnce();
  });
});

describe('MCPToolSource — execute() result mapping', () => {
  let mockCallTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockClient.mockClear();
    mockCallTool = vi.fn();
    MockClient.mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi
        .fn()
        .mockResolvedValue({ tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }] }),
      callTool: mockCallTool,
      close: vi.fn().mockResolvedValue(undefined),
    }));
  });

  it('returns success with content data when isError is false', async () => {
    const content = [{ type: 'text', text: 'result text' }];
    mockCallTool.mockResolvedValue({ content, isError: false });

    const source = new MCPToolSource({ name: 'brave', command: 'server' });
    const [tool] = await source.load();
    const result = await tool.execute({ query: 'hello' }, makeContext() as never);

    expect(result.status).toBe('success');
    expect(result.data).toEqual(content);
  });

  it('returns error result when isError is true', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'tool exploded' }],
      isError: true,
    });

    const source = new MCPToolSource({ name: 'brave', command: 'server' });
    const [tool] = await source.load();
    const result = await tool.execute({ query: 'hello' }, makeContext() as never);

    expect(result.status).toBe('error');
    expect(result.error).toBe('tool exploded');
  });

  it('returns generic error message when isError is true but content is empty', async () => {
    mockCallTool.mockResolvedValue({ content: [], isError: true });

    const source = new MCPToolSource({ name: 'brave', command: 'server' });
    const [tool] = await source.load();
    const result = await tool.execute({}, makeContext() as never);

    expect(result.status).toBe('error');
    expect(result.error).toBe('MCP tool error');
  });

  it('wraps thrown exceptions in a ToolResult error', async () => {
    mockCallTool.mockRejectedValue(new Error('network timeout'));

    const source = new MCPToolSource({ name: 'brave', command: 'server' });
    const [tool] = await source.load();
    const result = await tool.execute({}, makeContext() as never);

    expect(result.status).toBe('error');
    expect(result.error).toBe('network timeout');
  });

  it('sends correct tool name (un-namespaced) and args to callTool', async () => {
    mockCallTool.mockResolvedValue({ content: [], isError: false });

    const source = new MCPToolSource({ name: 'brave', command: 'server' });
    const [tool] = await source.load();
    await tool.execute({ query: 'cats' }, makeContext() as never);

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'search',
      arguments: { query: 'cats' },
    });
  });
});

describe('MCPToolSource — unload()', () => {
  it('calls client.close() on unload', async () => {
    const mockClose = vi.fn().mockResolvedValue(undefined);
    MockClient.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: mockClose,
    }));

    const source = new MCPToolSource({ name: 'test', command: 'server' });
    await source.load();
    await source.unload();
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('does nothing on unload if load() was never called', async () => {
    const source = new MCPToolSource({ name: 'test', command: 'server' });
    // Should resolve without error — no client to close.
    await expect(source.unload()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — expect failure**

```bash
npm test --workspace=packages/core -- --reporter=verbose MCPToolSource.test
```

Expected: `Cannot find module './MCPToolSource.js'`.

- [ ] **Step 4: Write `MCPToolSource.ts`**

`packages/core/src/tools/MCPToolSource.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '@legion/types';
import { ConfigError } from '../errors/index.js';
import type { Tool } from './Tool.js';
import type { ToolContext } from './Tool.js';
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
        parameters: (mcpTool.inputSchema ?? { type: 'object' }) as import('@legion/types').JSONSchema,
        async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
          try {
            const response = (await client.callTool({
              name: originalName,
              arguments: args as Record<string, unknown>,
            })) as MCPCallToolResult;

            if (response.isError) {
              const errorText = response.content.find((c) => c.type === 'text')?.text ?? 'MCP tool error';
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
      return new SSEClientTransport(new URL(config.url), config.headers ? { headers: config.headers } : undefined);
    }

    // Stdio transport.
    // config.command is guaranteed non-null here (constructor guard).
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: config.env ? { ...process.env, ...expandEnv(config.env) } : undefined,
    });
  }
}
```

- [ ] **Step 5: Run — expect green**

```bash
npm test --workspace=packages/core -- --reporter=verbose MCPToolSource.test
```

Expected: all tests passing (~22).

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/tools/MCPToolSource.ts packages/core/src/tools/MCPToolSource.test.ts
git commit -m "core: add MCPToolSource with stdio + HTTP/SSE transport (spec §9)"
```

---

## Task 4: `loadMCPSources()` utility

**Files:**
- Create: `packages/core/src/tools/loadMCPSources.ts`
- Create: `packages/core/src/tools/loadMCPSources.test.ts`

> Called by Plan 10 during startup (spec §8 step 7). Creates one `MCPToolSource` per config entry, loads all tools, and registers them in the `ToolRegistry`. Returns the array of loaded sources so Plan 10 can call `unload()` on each during graceful shutdown.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/tools/loadMCPSources.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '@legion/types';
import { ConflictError } from '../errors/index.js';
import type { Tool } from './Tool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { loadMCPSources } from './loadMCPSources.js';

// ---------------------------------------------------------------------------
// Mock MCPToolSource so no SDK is needed.
// ---------------------------------------------------------------------------
vi.mock('./MCPToolSource.js', () => {
  const instances: Array<{
    config: MCPServerConfig;
    loadCalled: boolean;
    unloadCalled: boolean;
    tools: Tool[];
  }> = [];

  const MCPToolSource = vi.fn().mockImplementation((config: MCPServerConfig) => {
    const tools: Tool[] = (config as MCPServerConfig & { _tools?: Tool[] })._tools ?? [];
    const instance = {
      config,
      loadCalled: false,
      unloadCalled: false,
      tools,
      async load() {
        this.loadCalled = true;
        return this.tools;
      },
      async unload() {
        this.unloadCalled = true;
      },
    };
    instances.push(instance);
    return instance;
  });

  (MCPToolSource as unknown as { _instances: typeof instances })._instances = instances;
  return { MCPToolSource };
});

const { MCPToolSource } = await import('./MCPToolSource.js');
const MockMCPToolSource = MCPToolSource as ReturnType<typeof vi.fn>;

function makeFakeTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object' },
    async execute() {
      return { status: 'success', data: null };
    },
  };
}

function makeServerConfig(
  name: string,
  tools: Tool[] = [],
): MCPServerConfig & { _tools: Tool[] } {
  return { name, command: `${name}-server`, _tools: tools } as MCPServerConfig & { _tools: Tool[] };
}

describe('loadMCPSources', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    MockMCPToolSource.mockClear();
  });

  it('returns an empty array when no configs are provided', async () => {
    const sources = await loadMCPSources([], registry);
    expect(sources).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('creates one MCPToolSource per config entry', async () => {
    const configs = [makeServerConfig('brave'), makeServerConfig('github')];
    await loadMCPSources(configs, registry);
    expect(MockMCPToolSource).toHaveBeenCalledTimes(2);
  });

  it('calls load() on each source', async () => {
    const configs = [makeServerConfig('brave'), makeServerConfig('github')];
    await loadMCPSources(configs, registry);

    const calls = MockMCPToolSource.mock.results.map((r) => r.value as { loadCalled: boolean });
    expect(calls[0].loadCalled).toBe(true);
    expect(calls[1].loadCalled).toBe(true);
  });

  it('registers all tools from each source in the registry', async () => {
    const braveTools = [makeFakeTool('mcp__brave__search'), makeFakeTool('mcp__brave__news')];
    const ghTools = [makeFakeTool('mcp__github__create_issue')];
    const configs = [makeServerConfig('brave', braveTools), makeServerConfig('github', ghTools)];

    await loadMCPSources(configs, registry);

    expect(registry.has('mcp__brave__search')).toBe(true);
    expect(registry.has('mcp__brave__news')).toBe(true);
    expect(registry.has('mcp__github__create_issue')).toBe(true);
  });

  it('returns the array of loaded MCPToolSource instances', async () => {
    const configs = [makeServerConfig('brave'), makeServerConfig('github')];
    const sources = await loadMCPSources(configs, registry);
    expect(sources).toHaveLength(2);
    // Each returned item is an MCPToolSource instance (duck-typed: has load + unload).
    expect(typeof sources[0].load).toBe('function');
    expect(typeof sources[0].unload).toBe('function');
  });

  it('propagates errors if a source fails to load', async () => {
    const error = new Error('server not found');
    MockMCPToolSource.mockImplementationOnce(() => ({
      async load() {
        throw error;
      },
      async unload() {},
    }));

    const configs = [makeServerConfig('bad-server')];
    await expect(loadMCPSources(configs, registry)).rejects.toThrow('server not found');
  });

  it('throws ConflictError if two MCP servers expose a tool with the same namespaced name', async () => {
    const duplicateTool = makeFakeTool('mcp__clash__tool');
    const configs = [makeServerConfig('server-a', [duplicateTool]), makeServerConfig('server-b', [duplicateTool])];
    await expect(loadMCPSources(configs, registry)).rejects.toThrow(ConflictError);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test --workspace=packages/core -- --reporter=verbose loadMCPSources.test
```

Expected: `Cannot find module './loadMCPSources.js'`.

- [ ] **Step 3: Write `loadMCPSources.ts`**

`packages/core/src/tools/loadMCPSources.ts`:

```typescript
import type { MCPServerConfig } from '@legion/types';
import { MCPToolSource } from './MCPToolSource.js';
import type { ToolRegistry } from './ToolRegistry.js';
import type { ToolSource } from './ToolSource.js';

/**
 * Load all MCP tool sources declared in the workspace config and register their
 * tools into the global ToolRegistry.
 *
 * Called by LegionProcess during startup (spec §8 step 7). Returns the array of
 * loaded ToolSource instances so the caller can invoke `unload()` on each during
 * graceful shutdown.
 *
 * Throws if any source fails to connect, or if two sources expose a tool under
 * the same namespaced name (a ConflictError from ToolRegistry.register()).
 */
export async function loadMCPSources(
  configs: MCPServerConfig[],
  registry: ToolRegistry,
): Promise<ToolSource[]> {
  const sources: ToolSource[] = [];

  for (const config of configs) {
    const source = new MCPToolSource(config);
    const tools = await source.load();
    for (const tool of tools) {
      registry.register(tool); // throws ConflictError on duplicate name
    }
    sources.push(source);
  }

  return sources;
}
```

- [ ] **Step 4: Run — expect green**

```bash
npm test --workspace=packages/core -- --reporter=verbose loadMCPSources.test
```

Expected: all tests passing (~8).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/loadMCPSources.ts packages/core/src/tools/loadMCPSources.test.ts
git commit -m "core: add loadMCPSources() utility (spec §9)"
```

---

## Task 5: Integration test with fixture MCP server

**Files:**
- Create: `packages/core/src/tools/fixtures/echo-mcp-server.mjs`
- Create: `packages/core/src/tools/MCPToolSource.integration.test.ts`

> Tests `MCPToolSource.load()` and `execute()` against a real MCP server subprocess. The fixture server is a minimal MCP stdio server (using the SDK's server side) that exposes two tools: `echo` and `add`. Env-gated with `LEGION_MCP_INTEGRATION=1`.

### Fixture server design

`echo-mcp-server.mjs` exposes two tools:

| Tool | Input schema | Behaviour |
|------|--------------|-----------|
| `echo` | `{ message: string }` | Returns `{ type: 'text', text: <message> }` |
| `add` | `{ a: number, b: number }` | Returns `{ type: 'text', text: String(a + b) }` |

- [ ] **Step 1: Write the fixture MCP server**

`packages/core/src/tools/fixtures/echo-mcp-server.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Minimal MCP stdio server fixture for integration tests.
 * Exposes two tools: `echo` and `add`.
 *
 * Usage: node echo-mcp-server.mjs
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(
  { method: 'tools/list' },
  async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echoes the input message back.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string', description: 'Message to echo' } },
          required: ['message'],
        },
      },
      {
        name: 'add',
        description: 'Adds two numbers.',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First operand' },
            b: { type: 'number', description: 'Second operand' },
          },
          required: ['a', 'b'],
        },
      },
    ],
  }),
);

server.setRequestHandler(
  { method: 'tools/call' },
  async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'echo') {
      return { content: [{ type: 'text', text: String(args?.message ?? '') }], isError: false };
    }

    if (name === 'add') {
      const result = Number(args?.a ?? 0) + Number(args?.b ?? 0);
      return { content: [{ type: 'text', text: String(result) }], isError: false };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Write the integration test**

`packages/core/src/tools/MCPToolSource.integration.test.ts`:

```typescript
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { MCPToolSource } from './MCPToolSource.js';

const LIVE = !!process.env.LEGION_MCP_INTEGRATION;
const fixtureServerPath = resolve(
  fileURLToPath(import.meta.url),
  '../fixtures/echo-mcp-server.mjs',
);

describe.skipIf(!LIVE)('MCPToolSource integration — stdio fixture server', () => {
  let source: MCPToolSource | null = null;

  afterEach(async () => {
    if (source) {
      await source.unload();
      source = null;
    }
  });

  it('load() connects and returns tools namespaced under the server name', async () => {
    source = new MCPToolSource({
      name: 'echo',
      command: 'node',
      args: [fixtureServerPath],
    });

    const tools = await source.load();
    const names = tools.map((t) => t.name);
    expect(names).toContain('mcp__echo__echo');
    expect(names).toContain('mcp__echo__add');
  });

  it('execute() — echo tool returns the input message', async () => {
    source = new MCPToolSource({
      name: 'echo',
      command: 'node',
      args: [fixtureServerPath],
    });

    const tools = await source.load();
    const echoTool = tools.find((t) => t.name === 'mcp__echo__echo');
    expect(echoTool).toBeDefined();

    const ctx = {
      participant: { id: 'agent-1', type: 'agent' as const, name: 'Agent 1' },
      conversationId: 'conv-1',
      collective: {} as never,
      config: {} as never,
      eventBus: {} as never,
      storage: {} as never,
      workspaceRoot: '/workspace',
      communicationDepth: 0,
      toolRegistry: {} as never,
    };

    const result = await echoTool!.execute({ message: 'hello legion' }, ctx as never);
    expect(result.status).toBe('success');
    const content = result.data as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('hello legion');
  });

  it('execute() — add tool returns the numeric sum as text', async () => {
    source = new MCPToolSource({
      name: 'echo',
      command: 'node',
      args: [fixtureServerPath],
    });

    const tools = await source.load();
    const addTool = tools.find((t) => t.name === 'mcp__echo__add');
    expect(addTool).toBeDefined();

    const ctx = {
      participant: { id: 'agent-1', type: 'agent' as const, name: 'Agent 1' },
      conversationId: 'conv-1',
      collective: {} as never,
      config: {} as never,
      eventBus: {} as never,
      storage: {} as never,
      workspaceRoot: '/workspace',
      communicationDepth: 0,
      toolRegistry: {} as never,
    };

    const result = await addTool!.execute({ a: 7, b: 35 }, ctx as never);
    expect(result.status).toBe('success');
    const content = result.data as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('42');
  });

  it('unload() closes the connection cleanly (no hanging process)', async () => {
    source = new MCPToolSource({
      name: 'echo',
      command: 'node',
      args: [fixtureServerPath],
    });

    await source.load();
    // Should resolve promptly; if the subprocess hangs the test will time out.
    await expect(source.unload()).resolves.toBeUndefined();
    source = null; // already unloaded; skip afterEach
  });
});
```

- [ ] **Step 3: Run unit tests — still green**

```bash
npm test --workspace=packages/core -- --reporter=verbose MCPToolSource.test
```

Expected: no regression.

- [ ] **Step 4: Run integration test (skipped without env var)**

```bash
npm test --workspace=packages/core -- --reporter=verbose MCPToolSource.integration.test
```

Expected: `0 tests run` (all skipped because `LEGION_MCP_INTEGRATION` is unset).

- [ ] **Step 5: Run integration test live (optional, requires node)**

```bash
LEGION_MCP_INTEGRATION=1 npm test --workspace=packages/core -- --reporter=verbose MCPToolSource.integration.test
```

Expected: 4 passing (connect, echo, add, unload).

- [ ] **Step 6: Commit**

```bash
git add \
  packages/core/src/tools/fixtures/echo-mcp-server.mjs \
  packages/core/src/tools/MCPToolSource.integration.test.ts
git commit -m "core: add MCPToolSource integration test with fixture stdio server (LEGION_MCP_INTEGRATION)"
```

---

## Task 6: Barrel exports + final checks

**Files:**
- Amend: `packages/core/src/index.ts`

> Surface `ToolSource`, `MCPToolSource`, and `loadMCPSources` from the core package barrel so Plan 10 can import them without deep path references.

- [ ] **Step 1: Add exports to `packages/core/src/index.ts`**

```typescript
// MCP tool sources (spec §9)
export type { ToolSource } from './tools/ToolSource.js';
export { MCPToolSource } from './tools/MCPToolSource.js';
export { loadMCPSources } from './tools/loadMCPSources.js';
```

- [ ] **Step 2: Run all core unit tests**

```bash
npm test --workspace=packages/core -- --reporter=verbose
```

Expected: all tests passing; integration tests skipped. No regressions from prior plans.

- [ ] **Step 3: Type-check**

```bash
npm run build --workspace=packages/types && npm run build --workspace=packages/core
```

Expected: zero `tsc` errors.

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: all tests passing; only `*.integration.test.ts` tests are skipped (not failed).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "core: export ToolSource, MCPToolSource, loadMCPSources from barrel"
```

---

## Self-review checklist

- [ ] `MCPServerConfig` amended in `@legion/types`: `command?`, `url?`, `headers?` — `build` passes.
- [ ] `ToolSource` interface exists in `@legion/core`; exports from barrel.
- [ ] `MCPToolSource` constructor throws `ConfigError` when neither `command` nor `url` provided.
- [ ] Transport selection: `url` → `SSEClientTransport`; `command` → `StdioClientTransport`; `url` preferred when both present.
- [ ] Tool names follow `mcp__<serverName>__<toolName>` convention.
- [ ] `process.env` interpolation applied to `env` values (`${VAR}` → value or `''`); headers are passed verbatim.
- [ ] `execute()`: `isError: true` → `{ status: 'error' }`; normal → `{ status: 'success', data: content }`; thrown → `{ status: 'error' }`.
- [ ] `unload()` calls `client.close()`; safe to call before `load()`.
- [ ] `loadMCPSources()` registers all tools from each source; propagates `ConflictError` on duplicate name; returns array of sources for shutdown.
- [ ] Integration test fixture (`echo-mcp-server.mjs`) exposes `echo` + `add` tools over stdio.
- [ ] Integration test is `describe.skipIf(!LIVE)` — skipped (not failed) when `LEGION_MCP_INTEGRATION` is unset.
- [ ] All unit tests pass; zero TypeScript errors; zero regressions.

---

## Plan 10 wiring note

In Plan 10 (`LegionProcess`), startup step 7 from spec §8 is implemented as:

```typescript
// After global tools are registered (step 6):
const mcpSources = await loadMCPSources(
  workspaceConfig.mcpServers ?? [],
  toolRegistry,
);
// Store mcpSources for graceful shutdown:
// process.on('SIGTERM', async () => { for (const s of mcpSources) await s.unload?.(); })
```

`loadMCPSources` and `MCPToolSource` do not need changes in Plan 10 — this note is purely for continuity.
