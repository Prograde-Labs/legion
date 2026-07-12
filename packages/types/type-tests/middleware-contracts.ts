import type {
  ConversationFilter,
  ConversationMutation,
  MessageDraft,
  MiddlewareDefinition,
  MiddlewareInstanceConfig,
  WorkspaceConfig,
} from '../src/index.js';

const middlewareInstance = {
  id: 'audit-main',
  type: 'audit',
  enabled: true,
  failureMode: 'closed',
  config: { destination: 'audit.log', retries: 3 },
} satisfies MiddlewareInstanceConfig;

const messageDraft = {
  senderId: 'operator',
  recipientId: 'assistant',
  role: 'user',
  content: 'Inspect this request',
} satisfies MessageDraft;
messageDraft.content = 'Inspect this updated request';

const middlewareDefinition = {
  type: 'audit',
  displayName: 'Audit middleware',
  defaultFailureMode: 'closed',
  configSchema: { type: 'object' },
  hooks: {
    afterSend: () => ({ action: 'continue' }),
  },
} satisfies MiddlewareDefinition;

const conversationFilter = {
  status: 'archived',
  tags: ['audit', 'important'],
  viewerParticipantId: 'operator',
} satisfies ConversationFilter;

const conversationMutation = {
  title: { scope: 'participant', participantId: 'operator', value: 'Audit thread' },
  titleMode: 'first_write_wins',
} satisfies ConversationMutation;

const workspace = {
  version: '2',
  middlewareModules: [{ id: 'audit', module: '@legion/middleware-audit' }],
} satisfies WorkspaceConfig;

void [
  middlewareInstance,
  messageDraft,
  middlewareDefinition,
  conversationFilter,
  conversationMutation,
  workspace,
];
