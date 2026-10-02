import type {
  Abort,
  AfterReceiveContext,
  AfterReceiveResult,
  AgentConfig,
  Complete,
  Continue,
  ContinueMessage,
  ContinuePrompt,
  ConversationEventMetadata,
  ConversationFilter,
  ConversationMutation,
  ConversationOrigin,
  MessageDraft,
  MessageDraftContext,
  MessageDraftResult,
  MiddlewareDefinition,
  MiddlewareHookContext,
  MiddlewareInstanceConfig,
  ParticipantConfig,
  PostMessageContext,
  PostMessageResult,
  Reject,
  RequestTool,
  Respond,
  SystemPromptResult,
  WorkspaceConfig,
} from '../src/index.js';

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type IsOptional<T, TKey extends keyof T> = {} extends Pick<T, TKey> ? true : false;

type MetadataStatusIsRequired = Expect<
  Equal<IsOptional<ConversationEventMetadata, 'status'>, false>
>;
type MetadataTagsAreRequired = Expect<Equal<IsOptional<ConversationEventMetadata, 'tags'>, false>>;
type HookParticipantIsParticipantConfig = Expect<
  Equal<MiddlewareHookContext<unknown>['participant'], ParticipantConfig>
>;
type AgentMaxIterationsIsRequired = Expect<Equal<IsOptional<AgentConfig, 'maxIterations'>, false>>;
type MessageDraftResultIsExact = Expect<
  Equal<MessageDraftResult, ContinueMessage | Reject | RequestTool>
>;
type AfterReceiveResultIsExact = Expect<
  Equal<AfterReceiveResult, Continue | Complete | Respond | Abort | RequestTool>
>;
type SystemPromptResultIsExact = Expect<
  Equal<SystemPromptResult, ContinuePrompt | Abort | RequestTool>
>;
type PostMessageResultIsExact = Expect<Equal<PostMessageResult, Continue | Abort | RequestTool>>;

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

const continueMessage = { kind: 'continue' } satisfies MessageDraftResult;
const rejectMessage = { kind: 'reject', error: 'blocked' } satisfies MessageDraftResult;
const draftTool = {
  kind: 'tool',
  requestId: 'draft-tool',
  tool: 'audit',
  arguments: { level: 'strict' },
  stateOnSuccess: { audited: true },
} satisfies MessageDraftResult;
const completeReceive = { kind: 'complete' } satisfies AfterReceiveResult;
const respondReceive = { kind: 'respond', message: messageDraft } satisfies AfterReceiveResult;
const abortReceive = { kind: 'abort', error: 'cancelled' } satisfies AfterReceiveResult;
const continuePrompt = {
  kind: 'continue',
  change: { operation: 'append', content: 'Follow audit policy.' },
} satisfies SystemPromptResult;
const promptTool = {
  kind: 'tool',
  requestId: 'prompt-tool',
  tool: 'load_policy',
  arguments: {},
} satisfies SystemPromptResult;
const postTool = {
  kind: 'tool',
  requestId: 'post-tool',
  tool: 'record_audit',
  arguments: {},
} satisfies PostMessageResult;

const middlewareDefinition = {
  type: 'audit',
  displayName: 'Audit middleware',
  defaultFailureMode: 'closed',
  configSchema: { type: 'object' },
  hooks: {
    beforeSend: () => continueMessage,
    beforeReceive: () => rejectMessage,
    afterReceive: () => completeReceive,
    buildSystemPrompt: () => continuePrompt,
    afterSend: () => postTool,
  },
} satisfies MiddlewareDefinition;

const metadata = {
  id: 'conversation-1',
  status: 'active',
  tags: ['audit'],
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
  participants: ['operator', 'assistant'],
} satisfies ConversationEventMetadata;

declare const origin: ConversationOrigin;
// @ts-expect-error Conversation origins are immutable.
origin.kind = 'tool';
// @ts-expect-error Conversation origin details are immutable.
origin.participantId = 'other';

declare const draftContext: MessageDraftContext;
// @ts-expect-error Hook input messages are immutable.
draftContext.message.content = 'mutated';

declare const receiveContext: AfterReceiveContext;
// @ts-expect-error Hook input messages are immutable.
receiveContext.message.content = 'mutated';

declare const postContext: PostMessageContext;
// @ts-expect-error Hook input messages are immutable.
postContext.message.content = 'mutated';

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
  middlewareModules: [{ id: 'audit', module: '@legion-collective/middleware-audit' }],
} satisfies WorkspaceConfig;

void [
  middlewareInstance,
  messageDraft,
  middlewareDefinition,
  metadata,
  conversationFilter,
  conversationMutation,
  workspace,
  draftTool,
  respondReceive,
  abortReceive,
  promptTool,
];

void (null as unknown as MetadataStatusIsRequired);
void (null as unknown as MetadataTagsAreRequired);
void (null as unknown as HookParticipantIsParticipantConfig);
void (null as unknown as AgentMaxIterationsIsRequired);
void (null as unknown as MessageDraftResultIsExact);
void (null as unknown as AfterReceiveResultIsExact);
void (null as unknown as SystemPromptResultIsExact);
void (null as unknown as PostMessageResultIsExact);
