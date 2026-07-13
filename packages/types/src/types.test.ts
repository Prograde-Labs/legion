import type {
  ParticipantConfig,
  ConversationData,
  LLMChunk,
  MessageData,
  MiddlewareCheckpoint,
  MiddlewareDiagnostic,
  MiddlewarePhase,
  ToolResult,
  WorkspaceConfig,
} from './index.js';

describe('domain type shapes', () => {
  it('accepts a representative agent participant', () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      type: 'agent',
      tools: { communicate: 'auto' },
      systemPrompt: 'You are helpful.',
      model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
    } satisfies ParticipantConfig;
    expect(agent.type).toBe('agent');
  });

  it('accepts a representative conversation with a keyed message map', () => {
    const root: MessageData = {
      id: 'm1',
      parentId: null,
      conversationId: 'conv-1',
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const conv = {
      id: 'conv-1',
      schemaVersion: '2.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      activeBranchHead: 'm1',
      messages: { m1: root },
    } satisfies ConversationData;
    expect(conv.messages.m1.parentId).toBeNull();
  });

  it('accepts a tool result and workspace config', () => {
    const ok: ToolResult = { status: 'success', data: 42 };
    const cfg = { version: '2' } satisfies WorkspaceConfig;
    expect(ok.status).toBe('success');
    expect(cfg.version).toBe('2');
  });

  it('accepts middleware diagnostics, checkpoints, and message snapshots', () => {
    const diagnostic = {
      type: 'audit',
      source: 'workspace',
      status: 'loaded',
      configurationErrors: [],
    } satisfies MiddlewareDiagnostic;
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

    expect(diagnostic.status).toBe('loaded');
    expect(checkpoint.phase).toBe('beforeSend');
    expect(checkpoint.request.tool).toBe('communicate');
    expect(checkpoint.runtimeResume.kind).toBe('agent_provider');
    expect(snapshot.type).toBe('message_snapshot');
    expectTypeOf(checkpoint.phase).toEqualTypeOf<'beforeSend'>();
    expectTypeOf(snapshot.type).toEqualTypeOf<'message_snapshot'>();
  });
});
