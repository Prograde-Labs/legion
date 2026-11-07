import type { ToolPolicy, ToolResult, UserConfig } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';
import { validateToolsMap } from '../auth/validateToolPolicy.js';

/**
 * Read/subscription tools every user needs for the web UI to be live: approval
 * events, conversation-list updates, per-conversation messages, stream cancel,
 * and the authoritative pending-approval list (already scoped server-side).
 * Shared with the runtime boot grant so users created after boot start live
 * without a restart. None of these can mutate policies, credentials, or config.
 */
export const USER_SUBSCRIPTION_TOOL_NAMES = [
  'list_pending_approvals',
  'cancel_stream',
  'watch_activity',
  'watch_conversation',
  'watch_conversations',
] as const;

/** Default tool-policy map for a newly created user. */
export function defaultUserSubscriptionTools(): Record<string, ToolPolicy> {
  return Object.fromEntries(USER_SUBSCRIPTION_TOOL_NAMES.map((name) => [name, 'auto']));
}

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

function callerIsOperator(context: ToolContext): boolean {
  return context.participant.operator === true;
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
        description:
          'Map of tool name to policy. A policy is "auto", "requires_approval", or ' +
          '{ policy: "auto" | "requires_approval", scope?: { <arg>: {...} } } where scope ' +
          'is keyed by top-level argument name. Merged over the default read/subscription ' +
          'tools (approvals, conversation and activity streams, cancel_stream); explicit ' +
          'policies override the defaults.',
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
    if (operator !== undefined && !callerIsOperator(context)) {
      return { status: 'error', error: 'Only an operator can change the operator flag' };
    }
    // Tool policies are privilege-bearing: save_mcp_sources can run arbitrary
    // commands on the next boot and save_provider/set_secret/set_approval_authority
    // widen access. A non-operator must not be able to grant them, even to
    // itself, so any `tools` mutation requires an operator.
    if (tools !== undefined && !callerIsOperator(context)) {
      return { status: 'error', error: 'Only an operator can change tool policies' };
    }
    if (tools !== undefined) {
      const validated = validateToolsMap(context.toolRegistry, tools);
      if (!validated.ok) return { status: 'error', error: validated.error };
    }
    try {
      const config: UserConfig = {
        id,
        name,
        type: 'user',
        // Merge the boot-time read/subscription grant so users created after
        // boot are live immediately; explicit policies override the defaults.
        tools: { ...defaultUserSubscriptionTools(), ...(tools ?? {}) },
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
          'Full replacement tools map. Omit to keep existing. Pass {} to clear all tool access. ' +
          'Each policy is "auto", "requires_approval", or ' +
          '{ policy: "auto" | "requires_approval", scope?: { <arg>: {...} } } where scope ' +
          'is keyed by top-level argument name.',
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
    if (operator !== undefined && !callerIsOperator(context)) {
      return { status: 'error', error: 'Only an operator can change the operator flag' };
    }
    if (tools !== undefined && !callerIsOperator(context)) {
      return { status: 'error', error: 'Only an operator can change tool policies' };
    }
    if (tools !== undefined) {
      const validated = validateToolsMap(context.toolRegistry, tools);
      if (!validated.ok) return { status: 'error', error: validated.error };
    }
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
