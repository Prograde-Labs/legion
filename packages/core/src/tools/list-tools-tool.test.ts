import type { ParticipantConfig, ToolResult } from '@legion/types';
import { listToolsTool } from './list-tools-tool.js';
import type { AnyTool, ToolContext, ToolRegistryLike } from './Tool.js';

function makeTool(name: string, description = `${name} description`): AnyTool {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
    execute: async () => ({ status: 'success' }),
  };
}

function makeContext(
  tools: Record<string, 'auto' | 'requires_approval'>,
  registryTools: AnyTool[],
): ToolContext {
  const registry: ToolRegistryLike = {
    get: (name) => registryTools.find((t) => t.name === name),
    has: (name) => registryTools.some((t) => t.name === name),
    list: () => registryTools,
    listAll: () => registryTools.map((t) => t.name),
  } as ToolRegistryLike;
  return {
    participant: { id: 'chris', name: 'Chris', type: 'user', tools } as ParticipantConfig,
    conversationId: 'c1',
    toolRegistry: registry,
  } as unknown as ToolContext;
}

it('lists only tools present in the participant policy', async () => {
  const registryTools = [
    makeTool('communicate'),
    makeTool('list_participants'),
    makeTool('read_file'),
  ];
  const context = makeContext(
    { communicate: 'auto', read_file: 'requires_approval' },
    registryTools,
  );
  const result = (await listToolsTool.execute({}, context)) as ToolResult;
  expect(result.status).toBe('success');
  const tools = (result.data as { tools: Array<{ name: string; description: string }> }).tools;
  expect(tools.map((t) => t.name).sort()).toEqual(['communicate', 'read_file']);
});

it('includes name, description, and parameters for each entry', async () => {
  const registryTools = [makeTool('communicate')];
  const context = makeContext({ communicate: 'auto' }, registryTools);
  const result = (await listToolsTool.execute({}, context)) as ToolResult;
  const entry = (result.data as { tools: Array<Record<string, unknown>> }).tools[0];
  expect(entry.name).toBe('communicate');
  expect(entry.description).toBe('communicate description');
  expect(entry.parameters).toEqual({
    type: 'object',
    properties: { pattern: { type: 'string' } },
  });
});

it('returns an empty list when the participant has no tools', async () => {
  const registryTools = [makeTool('communicate')];
  const context = makeContext({}, registryTools);
  const result = (await listToolsTool.execute({}, context)) as ToolResult;
  expect((result.data as { tools: unknown[] }).tools).toEqual([]);
});

it('list_tools itself is discoverable once registered', () => {
  expect(listToolsTool.name).toBe('list_tools');
  expect(listToolsTool.parameters).toEqual({
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
});
