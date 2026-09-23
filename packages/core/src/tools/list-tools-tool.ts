import type { ToolResult } from '@legion/types';
import type { Tool, ToolContext } from './Tool.js';

/**
 * Discovery tool: returns the name, description, and parameter schema of every
 * registry tool the calling participant's policy makes visible. Fine-grained
 * authorization (auto vs requires_approval) is still enforced per call by AuthEngine.
 */
export const listToolsTool: Tool = {
  name: 'list_tools',
  description:
    'List the tools this participant is authorized to call, with their parameter schemas.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args: unknown, context: ToolContext): Promise<unknown> {
    const policy = context.participant.tools ?? {};
    const tools = context.toolRegistry
      .list()
      .filter((tool) => policy[tool.name] !== undefined)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters),
      }));
    const result: ToolResult = { status: 'success', data: { tools } };
    return result;
  },
};
