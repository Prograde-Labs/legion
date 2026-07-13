import type {
  JSONSchema,
  JSONValue,
  LLMChunk,
  MessageData,
  MessageDraft,
  MiddlewareActionResult,
  MiddlewareCheckpoint,
  MiddlewareDefinitionSummary,
  MiddlewareDiagnostic,
  MiddlewarePhase,
  RequestTool,
} from '../src/index.js';

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
      ? true
      : false
    : false;
type Expect<T extends true> = T;
type Expand<T> = { [TKey in keyof T]: T[TKey] };
type RequiredKeys<T> = {
  [TKey in keyof T]-?: object extends Pick<T, TKey> ? never : TKey;
}[keyof T];
type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>;

type ExpectedDiagnostic = {
  type: string;
  source: string;
  status: 'loaded' | 'error';
  error?: string;
  configurationErrors: Array<{
    participantId: string;
    instanceId: string;
    errors: string[];
  }>;
};

type ExpectedRuntimeResume = {
  kind: 'agent_provider';
  participantId: string;
  incomingMessageId: string;
  iteration: number;
  preparedPrompt: string;
  actionCursor: number;
  actions: MiddlewareActionResult[];
};

type ExpectedCheckpoint = {
  checkpointId: string;
  operationId: string;
  conversationId: string;
  phase: MiddlewarePhase;
  participantId: string;
  instanceId: string;
  middlewareType: string;
  middlewareRevision: number;
  middlewareConfig?: JSONValue;
  nextHookIndex: number;
  actionCursor: number;
  draft?: MessageDraft;
  prompt?: string;
  message?: MessageData;
  mode?: 'pre_runtime' | 'post_response';
  final?: boolean;
  iteration?: number;
  request: Omit<RequestTool, 'kind'>;
  actions: MiddlewareActionResult[];
  observedHead: string;
  persistedMessageId?: string;
  runtimeResume?: ExpectedRuntimeResume;
  createdAt: string;
};

type ExpectedDefinitionSummary = {
  type: string;
  displayName: string;
  description?: string;
  defaultFailureMode: 'open' | 'closed';
  configSchema: JSONSchema;
  source: string;
};

export type MiddlewareContractAssertions = [
  Expect<
    Equal<
      MiddlewarePhase,
      'beforeSend' | 'beforeReceive' | 'afterReceive' | 'buildSystemPrompt' | 'afterSend'
    >
  >,
  Expect<Equal<Expand<MiddlewareDiagnostic>, ExpectedDiagnostic>>,
  Expect<
    Equal<RequiredKeys<MiddlewareDiagnostic>, 'type' | 'source' | 'status' | 'configurationErrors'>
  >,
  Expect<Equal<OptionalKeys<MiddlewareDiagnostic>, 'error'>>,
  Expect<
    Equal<MiddlewareDiagnostic['configurationErrors'], ExpectedDiagnostic['configurationErrors']>
  >,
  Expect<Equal<Expand<MiddlewareCheckpoint>, ExpectedCheckpoint>>,
  Expect<
    Equal<
      RequiredKeys<MiddlewareCheckpoint>,
      | 'checkpointId'
      | 'operationId'
      | 'conversationId'
      | 'phase'
      | 'participantId'
      | 'instanceId'
      | 'middlewareType'
      | 'middlewareRevision'
      | 'nextHookIndex'
      | 'actionCursor'
      | 'request'
      | 'actions'
      | 'observedHead'
      | 'createdAt'
    >
  >,
  Expect<
    Equal<
      OptionalKeys<MiddlewareCheckpoint>,
      | 'draft'
      | 'prompt'
      | 'message'
      | 'mode'
      | 'final'
      | 'iteration'
      | 'persistedMessageId'
      | 'runtimeResume'
      | 'middlewareConfig'
    >
  >,
  Expect<Equal<MiddlewareCheckpoint['request'], Omit<RequestTool, 'kind'>>>,
  Expect<Equal<MiddlewareCheckpoint['actions'], MiddlewareActionResult[]>>,
  Expect<Equal<NonNullable<MiddlewareCheckpoint['runtimeResume']>, ExpectedRuntimeResume>>,
  Expect<
    Equal<NonNullable<MiddlewareCheckpoint['runtimeResume']>['actions'], MiddlewareActionResult[]>
  >,
  Expect<Equal<Expand<MiddlewareDefinitionSummary>, ExpectedDefinitionSummary>>,
  Expect<
    Equal<
      RequiredKeys<MiddlewareDefinitionSummary>,
      'type' | 'displayName' | 'defaultFailureMode' | 'configSchema' | 'source'
    >
  >,
  Expect<Equal<OptionalKeys<MiddlewareDefinitionSummary>, 'description'>>,
  Expect<
    Equal<
      Extract<LLMChunk, { type: 'message_snapshot' }>,
      { type: 'message_snapshot'; content: string; reasoning?: string }
    >
  >,
];

const diagnostic = {
  type: 'audit',
  source: 'workspace',
  status: 'loaded',
  configurationErrors: [],
} satisfies MiddlewareDiagnostic;

const definition = {
  type: 'audit',
  displayName: 'Audit',
  description: 'Records middleware activity.',
  defaultFailureMode: 'closed',
  configSchema: { type: 'object' },
  source: 'workspace',
} satisfies MiddlewareDefinitionSummary;

const phase = 'beforeSend' satisfies MiddlewarePhase;
const checkpoint = {
  checkpointId: 'checkpoint-1',
  operationId: 'operation-1',
  conversationId: 'conv-1',
  phase,
  participantId: 'agent-1',
  instanceId: 'audit-1',
  middlewareType: 'audit',
  middlewareRevision: 1,
  nextHookIndex: 1,
  actionCursor: 0,
  request: {
    requestId: 'request-1',
    tool: 'communicate',
    arguments: { recipient: 'agent-2' },
  },
  actions: [],
  observedHead: 'm1',
  runtimeResume: {
    kind: 'agent_provider',
    participantId: 'agent-1',
    incomingMessageId: 'm1',
    iteration: 1,
    preparedPrompt: 'Continue.',
    actionCursor: 0,
    actions: [],
  },
  createdAt: '2026-01-01T00:00:00.000Z',
} satisfies MiddlewareCheckpoint;

const snapshot = {
  type: 'message_snapshot',
  content: 'Complete response',
  reasoning: 'Finished',
} satisfies LLMChunk;

void [diagnostic, definition, checkpoint, snapshot];
