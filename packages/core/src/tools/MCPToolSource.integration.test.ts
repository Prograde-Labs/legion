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

  it('load() connects and returns tool namespaced under the server name', async () => {
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
