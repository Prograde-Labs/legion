import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '@legion-collective/types';
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

function makeServerConfig(name: string, tools: Tool[] = []): MCPServerConfig & { _tools: Tool[] } {
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
    const configs = [
      makeServerConfig('server-a', [duplicateTool]),
      makeServerConfig('server-b', [duplicateTool]),
    ];
    await expect(loadMCPSources(configs, registry)).rejects.toThrow(ConflictError);
  });
});
