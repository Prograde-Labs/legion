import type { ApprovalAuthority, ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

function validateAuthority(value: unknown): ApprovalAuthority | null {
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('authority must be an object or null');
  }
  if (value === null) return null;
  const authority = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(authority)) {
    if (key !== 'tools' && key !== 'participants') {
      throw new Error(`authority contains an unknown property: ${String(key)}`);
    }
  }
  const validated: ApprovalAuthority = {};
  if (authority['tools'] !== undefined) {
    const tools = authority['tools'];
    if (tools !== '*' && (typeof tools !== 'object' || tools === null)) {
      throw new Error('authority.tools must be "*" or an object of booleans');
    }
    validated.tools = tools as ApprovalAuthority['tools'];
  }
  if (authority['participants'] !== undefined) {
    const participants = authority['participants'];
    if (
      participants !== '*' &&
      (!Array.isArray(participants) || participants.some((p) => typeof p !== 'string'))
    ) {
      throw new Error('authority.participants must be "*" or an array of participant ids');
    }
    validated.participants = participants as ApprovalAuthority['participants'];
  }
  return validated;
}

export const setApprovalAuthorityTool: Tool = {
  name: 'set_approval_authority',
  description:
    'Set or clear the approval authority of any participant — which tools they may approve ' +
    'on behalf of which requesters. Pass authority=null to clear.',
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string', description: 'Participant ID' },
      authority: {
        description:
          'ApprovalAuthority: { tools?: Record<string, boolean> | "*", participants?: string[] | "*" }. ' +
          'Pass null to clear.',
      },
    },
    required: ['participantId', 'authority'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { participantId, authority } = args as {
      participantId: string;
      authority: unknown;
    };
    try {
      const collective = requireCollective(context);
      if (!collective.get(participantId)) {
        return { status: 'error', error: `Participant not found: ${participantId}` };
      }
      const validated = validateAuthority(authority);
      if (validated === null) {
        // Collective.update shallow-merges patches, so clearing requires an explicit
        // undefined assignment; storage JSON-serialization drops the key on persist.
        await collective.update(participantId, { approvalAuthority: undefined });
      } else {
        await collective.update(participantId, { approvalAuthority: validated });
      }
      return { status: 'success', data: { participantId, authority: validated } };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  },
};
