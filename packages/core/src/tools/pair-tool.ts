import type { ConnectorIdentity, ToolResult } from '@legion-collective/types';
import type { Tool, ToolContext } from './Tool.js';

function requireCollective(context: ToolContext): NonNullable<ToolContext['collective']> {
  if (!context.collective) throw new Error('collective unavailable in context');
  return context.collective;
}

export const pairTool: Tool = {
  name: 'pair',
  description: 'Merge an external identity into a participant (connector-agnostic).',
  parameters: {
    type: 'object',
    properties: {
      participantId: { type: 'string', description: 'Target participant ID' },
      connector: { type: 'string', description: 'Connector name, e.g. teams or telegram' },
      externalId: { type: 'string', description: 'Platform identity' },
    },
    required: ['participantId', 'connector', 'externalId'],
  },
  async execute(args, context): Promise<ToolResult> {
    const { participantId, connector, externalId } = (args ?? {}) as {
      participantId?: string;
      connector?: string;
      externalId?: string;
    };
    if (!participantId || !connector || !externalId) {
      return { status: 'error', error: 'participantId, connector, and externalId are required' };
    }
    const collective = requireCollective(context);
    const target = collective.get(participantId);
    if (!target) return { status: 'error', error: `Participant not found: ${participantId}` };

    const owner = collective.findByIdentity(connector, externalId);
    if (owner && owner.id !== participantId) {
      return {
        status: 'error',
        error: `Identity ${connector}/${externalId} is already paired to ${owner.id}`,
      };
    }

    const identities = target.identities ?? [];
    if (identities.some((i) => i.connector === connector && i.externalId === externalId)) {
      return {
        status: 'success',
        data: { participantId, connector, externalId, alreadyPaired: true },
      };
    }

    const next: ConnectorIdentity[] = [...identities, { connector, externalId }];
    await collective.update(participantId, { identities: next });
    return { status: 'success', data: { participantId, connector, externalId } };
  },
};
