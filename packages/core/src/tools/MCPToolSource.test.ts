import { type MockedClass, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '@legion/types';
import { ConfigError } from '../errors/LegionError.js';
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
    MockSSE.mockClear();
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
    // Headers are passed through verbatim inside requestInit; interpolation is the caller's responsibility.
    expect(MockSSE).toHaveBeenCalledOnce();
    const secondArg = MockSSE.mock.calls[0][1] as { requestInit?: { headers?: Record<string, string> } };
    expect(secondArg.requestInit?.headers?.Authorization).toBe('Bearer ${TEST_MCP_KEY}');
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
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'search', description: 'web search', inputSchema: schema }],
      }),
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
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'go', description: 'Fetch a URL', inputSchema: { type: 'object' } }],
      }),
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
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }],
      }),
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
