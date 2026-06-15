import type { ParticipantConfig, UserConfig, ToolPolicy } from '@legion/types';

export const BOOTSTRAP_OPERATOR_ID = 'operator';

const MANAGEMENT_TOOLS = [
  'communicate',
  'create_agent',
  'retire_agent',
  'list_participants',
  'get_conversation',
  'set_tool_policy',
  'set_credential',
] as const;

export function createDefaultParticipants(): ParticipantConfig[] {
  const tools: Record<string, ToolPolicy> = {};
  for (const tool of MANAGEMENT_TOOLS) tools[tool] = 'auto';

  const operator: UserConfig = {
    id: BOOTSTRAP_OPERATOR_ID,
    name: 'Operator',
    type: 'user',
    tools,
    operator: true,
    protected: true,
    status: 'active',
    approvalAuthority: { tools: '*', participants: '*' },
    identities: [{ connector: 'web', externalId: BOOTSTRAP_OPERATOR_ID }],
  };

  return [operator];
}
