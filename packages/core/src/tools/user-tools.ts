import type { ToolPolicy, ToolResult, UserConfig } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

function toError(err: unknown): ToolResult {
  return { status: 'error', error: err instanceof Error ? err.message : String(err) };
}

export const createUserTool: Tool = {
  name: 'create_user',
  description: 'Create a user participant (a human operator identity with credentials).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      operator: { type: 'boolean', description: 'Grant operator flag. Default false.' },
      tools: {
        type: 'object',
        description: 'Map of tool name to policy (auto or requires_approval). Default empty.',
      },
    },
    required: ['id', 'name'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id, name, operator, tools } = args as {
      id: string;
      name: string;
      operator?: boolean;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const config: UserConfig = {
        id,
        name,
        type: 'user',
        tools: tools ?? {},
        status: 'active',
        ...(operator === undefined ? {} : { operator }),
      };
      await requireCollective(context).add(config);
      return { status: 'success', data: { id } };
    } catch (err) {
      return toError(err);
    }
  },
};

export const modifyUserTool: Tool = {
  name: 'modify_user',
  description:
    'Update an existing user — name, operator flag, or full-replacement tool policies. ' +
    'Passwords are managed by set_credential.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Participant ID' },
      name: { type: 'string' },
      operator: { type: 'boolean' },
      tools: {
        type: 'object',
        description:
          'Full replacement tools map. Omit to keep existing. Pass {} to clear all tool access.',
      },
    },
    required: ['id'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { id, name, operator, tools } = args as {
      id: string;
      name?: string;
      operator?: boolean;
      tools?: Record<string, ToolPolicy>;
    };
    try {
      const collective = requireCollective(context);
      const existing = collective.get(id);
      if (!existing) return { status: 'error', error: `User not found: ${id}` };
      if (existing.type !== 'user')
        return { status: 'error', error: `Participant ${id} is not a user` };
      const patch: Partial<UserConfig> = {};
      if (name !== undefined) patch.name = name;
      if (operator !== undefined) patch.operator = operator;
      if (tools !== undefined) patch.tools = tools;
      await collective.update(id, patch);
      return { status: 'success', data: collective.getOrThrow(id) };
    } catch (err) {
      return toError(err);
    }
  },
};

export const userTools: Tool[] = [createUserTool, modifyUserTool];
