import type {
  LLMChunk,
  MiddlewareCheckpoint,
  MiddlewareDefinitionSummary,
  MiddlewareDiagnostic,
  MiddlewarePhase,
} from '../src/index.js';

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

const exactPhase: 'beforeSend' = checkpoint.phase;
const exactResumeKind: 'agent_provider' = checkpoint.runtimeResume.kind;
const exactSnapshotType: 'message_snapshot' = snapshot.type;

// @ts-expect-error checkpoints require execution identity and state fields
const missingCheckpoint: MiddlewareCheckpoint = {};

void [diagnostic, definition, exactPhase, exactResumeKind, exactSnapshotType, missingCheckpoint];
