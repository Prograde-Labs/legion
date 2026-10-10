import type { ParticipantConfig, UserConfig, ToolPolicy } from '@legion-collective/types';

export const BOOTSTRAP_OPERATOR_ID = 'operator';

const MANAGEMENT_TOOLS = [
  'communicate',
  'create_agent',
  'modify_agent',
  'retire_agent',
  'list_participants',
  'get_participant',
  'list_tools',
  'list_conversations',
  'get_conversation',
  'modify_conversation',
  'edit_message',
  'prune_message',
  'compact_conversation',
  'generate',
  'switch_branch',
  'delete_conversation',
  'set_tool_policy',
  'remove_tool_policy',
  'set_credential',
  'create_user',
  'modify_user',
  'set_approval_authority',
  'set_participant_middleware',
  'approval_response',
  // runtime / config tools (registered by WebConnector layer)
  'list_providers',
  'save_provider',
  'delete_provider',
  'list_models',
  'get_routing',
  'save_routing',
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
