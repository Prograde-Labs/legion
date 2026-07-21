import type {
  AgentConfig,
  MessageData,
  MessageDraft,
  MiddlewareActionResult,
  MiddlewareDefinition,
  MiddlewareCheckpoint,
  MessageDraftContext,
  MiddlewareInstanceConfig,
  MiddlewareLogger,
  ParticipantConfig,
} from '@legion/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import {
  PendingApprovalRegistry,
  type AutomationCompactionContinuation,
  type AutomationCompactionSeed,
} from '../auth/PendingApprovalRegistry.js';
import { Collective } from '../collective/Collective.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { EventBus } from '../events/EventBus.js';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { MiddlewareRegistry } from './MiddlewareRegistry.js';
import {
  MiddlewareRunner,
  type AfterReceivePhaseResult,
  type AfterSendPhaseResult,
  type MessagePhaseResult,
  type MiddlewarePhaseResult,
  type MiddlewareRunnerDependencies,
  type SystemPromptInput,
  type SystemPromptPhaseResult,
} from './MiddlewareRunner.js';

interface LogEntry {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

const schema = { type: 'object', additionalProperties: true } as const;

function middlewareDefinition(
  hooks: MiddlewareDefinition['hooks'],
  overrides: Partial<MiddlewareDefinition> = {},
): MiddlewareDefinition {
  return {
    type: 'test:middleware',
    displayName: 'Test middleware',
    defaultFailureMode: 'closed',
    configSchema: schema,
    hooks,
    ...overrides,
  };
}

function instance(
  id: string,
  overrides: Partial<MiddlewareInstanceConfig> = {},
): MiddlewareInstanceConfig {
  return { id, type: 'test:middleware', config: {}, ...overrides };
}

function draft(overrides: Partial<MessageDraft> = {}): MessageDraft {
  return {
    senderId: 'sender',
    recipientId: 'recipient',
    role: 'user',
    content: 'x',
    ...overrides,
  };
}

async function fixture(instances: MiddlewareInstanceConfig[] = []) {
  const storage = new MemoryStorage();
  const eventBus = new EventBus();
  const conversationStore = new FileConversationStore(storage, eventBus);
  const data = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const thread = new ConversationThread(data, conversationStore);
  const participant: ParticipantConfig = {
    id: 'participant',
    name: 'Participant',
    type: 'mock',
    tools: {},
    responses: [],
    middleware: instances,
  };
  const collective = new Collective(storage, [participant]);
  const registry = new MiddlewareRegistry();
  const authEngine = new AuthEngine();
  const toolRegistry = new ToolRegistry();
  const pendingApprovals = new PendingApprovalRegistry(storage);
  const logs: LogEntry[] = [];
  const logger: MiddlewareLogger = {
    debug: (message, fields) => logs.push({ level: 'debug', message, fields }),
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  const runnerDependencies: MiddlewareRunnerDependencies = {
    registry,
    authEngine,
    toolRegistry,
    pendingApprovals,
    eventBus,
    logger,
    conversationStore,
    collective,
    buildToolContext: (principal, activeThread, signal) => ({
      participant: principal,
      conversationId: activeThread.id,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: '/workspace',
      communicationDepth: 0,
      toolRegistry,
      conversation: activeThread,
      signal,
    }),
  };
  const runner = new MiddlewareRunner(runnerDependencies);
  const persistMessage = async (overrides: Partial<MessageData> = {}) => {
    const value = message(thread, overrides);
    await conversationStore.appendMessage(thread.id, value);
    await thread.reload();
    return structuredClone(thread.data.messages[value.id]);
  };
  return {
    runner,
    registry,
    participant,
    collective,
    thread,
    eventBus,
    logs,
    conversationStore,
    toolRegistry,
    pendingApprovals,
    storage,
    runnerDependencies,
    persistMessage,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function message(thread: ConversationThread, overrides: Partial<MessageData> = {}): MessageData {
  const value: MessageData = {
    id: 'message-1',
    parentId: null,
    conversationId: thread.id,
    senderId: 'sender',
    recipientId: 'recipient',
    role: 'user',
    content: 'incoming',
    status: 'active',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  thread.data.messages[value.id] = structuredClone(value);
  return structuredClone(value);
}

function agentParticipant(participant: ParticipantConfig): AgentConfig {
  return {
    ...participant,
    type: 'agent',
    model: { model: 'test' },
    systemPrompt: 'System prompt',
    maxIterations: 3,
  };
}

describe('MiddlewareRunner', () => {
  it('advertises only phase-valid outcomes while retaining pending approval', () => {
    expectTypeOf<ReturnType<MiddlewareRunner['runMessagePhase']>>().toEqualTypeOf<
      Promise<MessagePhaseResult>
    >();
    expectTypeOf<ReturnType<MiddlewareRunner['runAfterReceive']>>().toEqualTypeOf<
      Promise<AfterReceivePhaseResult>
    >();
    expectTypeOf<ReturnType<MiddlewareRunner['runSystemPrompt']>>().toEqualTypeOf<
      Promise<SystemPromptPhaseResult>
    >();
    expectTypeOf<ReturnType<MiddlewareRunner['runAfterSend']>>().toEqualTypeOf<
      Promise<AfterSendPhaseResult>
    >();
    expectTypeOf<Extract<MessagePhaseResult, { kind: 'complete' }>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<SystemPromptPhaseResult, { kind: 'respond' }>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<AfterSendPhaseResult, { kind: 'reject' }>>().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<AfterReceivePhaseResult, { kind: 'pending_approval' }>
    >().not.toEqualTypeOf<never>();
    expectTypeOf<
      Extract<MiddlewarePhaseResult<unknown>, { kind: 'pending_approval' }>
    >().not.toEqualTypeOf<never>();
    expectTypeOf<SystemPromptInput['persistedMessageId']>().toEqualTypeOf<string>();
  });

  it('resumes an approved checkpoint once at following hook and retains continuation', async () => {
    const f = await fixture([instance('request'), instance('following')]);
    f.participant.tools = { risky: 'requires_approval' };
    const calls: string[] = [];
    const execute = vi.fn(async () => ({ status: 'success' as const, data: { written: true } }));
    f.toolRegistry.register({ name: 'risky', description: 'risky', parameters: schema, execute });
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          calls.push(context.instance.id);
          if (context.instance.id === 'request') {
            return { kind: 'tool', requestId: 'resume-risky', tool: 'risky', arguments: {} };
          }
          expect(context.actions).toMatchObject([
            { requestId: 'resume-risky', status: 'success', result: { data: { written: true } } },
          ]);
          return { kind: 'continue', message: { ...context.message, content: 'resumed' } };
        },
      }),
      'test:runner',
    );
    const pending = await f.runner.runMessagePhase({
      operationId: 'resume-approved',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    if (pending.kind !== 'pending_approval') throw new Error('Expected pending approval');
    await f.pendingApprovals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(f.runner.resumeApproval(pending.approvalId, f.thread)).resolves.toMatchObject({
      kind: 'continue',
      value: draft({ content: 'resumed' }),
    });
    expect(calls).toEqual(['request', 'following']);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.pendingApprovals.getRecord(pending.approvalId)).toMatchObject({
      lifecycle: 'decided',
      continuation: { kind: 'middleware' },
    });
  });

  it('fails stale checkpoints before executing external tool and retains continuation', async () => {
    const f = await fixture([instance('request')]);
    f.participant.tools = { risky: 'requires_approval' };
    const execute = vi.fn(async () => ({ status: 'success' as const }));
    f.toolRegistry.register({ name: 'risky', description: 'risky', parameters: schema, execute });
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({
          kind: 'tool',
          requestId: 'stale-risky',
          tool: 'risky',
          arguments: {},
        }),
      }),
      'test:runner',
    );
    const pending = await f.runner.runMessagePhase({
      operationId: 'resume-stale',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    if (pending.kind !== 'pending_approval') throw new Error('Expected pending approval');
    await f.pendingApprovals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    await f.conversationStore.updateHead(f.thread.id, 'different-head');

    await expect(f.runner.resumeApproval(pending.approvalId, f.thread)).resolves.toMatchObject({
      kind: 'abort',
      persisted: false,
      error: expect.stringMatching(/checkpoint/i),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(f.pendingApprovals.getRecord(pending.approvalId)).toMatchObject({
      lifecycle: 'decided',
      resumeResult: { status: 'error' },
      continuation: { kind: 'middleware' },
    });
  });

  it.each([
    ['open', 'continue'],
    ['closed', 'abort'],
  ] as const)(
    'resumes rejected checkpoint using requesting %s failure mode',
    async (failureMode, kind) => {
      const f = await fixture([instance('request', { failureMode }), instance('following')]);
      f.participant.tools = { risky: 'requires_approval' };
      const execute = vi.fn();
      f.toolRegistry.register({ name: 'risky', description: 'risky', parameters: schema, execute });
      const calls: string[] = [];
      f.registry.register(
        middlewareDefinition({
          beforeSend: (context) => {
            calls.push(context.instance.id);
            return context.instance.id === 'request'
              ? { kind: 'tool', requestId: 'rejected-risky', tool: 'risky', arguments: {} }
              : { kind: 'continue' };
          },
        }),
        'test:runner',
      );
      const pending = await f.runner.runMessagePhase({
        operationId: `resume-rejected-${failureMode}`,
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      });
      if (pending.kind !== 'pending_approval') throw new Error('Expected pending approval');
      await f.pendingApprovals.resolve(pending.approvalId, {
        approved: false,
        decidedByParticipantId: 'operator',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });

      await expect(f.runner.resumeApproval(pending.approvalId, f.thread)).resolves.toMatchObject({
        kind,
      });
      expect(calls).toEqual(failureMode === 'open' ? ['request', 'following'] : ['request']);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['open', 'continue'],
    ['closed', 'abort'],
  ] as const)(
    'emits one sanitized middleware:error for rejected %s approval resumes',
    async (failureMode, kind) => {
      const secret = `private-token-${failureMode}`;
      const f = await fixture([instance('request', { failureMode, config: { secret } })]);
      f.participant.tools = { risky: 'requires_approval' };
      const errors: unknown[] = [];
      f.eventBus.on('middleware:error', (event) => errors.push(event));
      f.registry.register(
        middlewareDefinition({
          beforeSend: () => ({
            kind: 'tool',
            requestId: 'rejected-event',
            tool: 'risky',
            arguments: { secret },
          }),
        }),
        'test:runner',
      );

      const pending = await f.runner.runMessagePhase({
        operationId: `rejected-event-${failureMode}`,
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      });
      if (pending.kind !== 'pending_approval') throw new Error('Expected pending approval');
      await f.pendingApprovals.resolve(pending.approvalId, {
        approved: false,
        decidedByParticipantId: 'operator',
        decidedAt: '2026-01-01T00:00:00.000Z',
      });

      const result = await f.runner.resumeApproval(pending.approvalId, f.thread);

      expect(result.kind).toBe(kind);
      if (result.kind === 'continue') {
        expect(result.actions).toMatchObject([
          { requestId: 'rejected-event', instanceId: 'request', status: 'rejected' },
        ]);
      }
      expect(errors).toEqual([
        expect.objectContaining({
          conversationId: f.thread.id,
          participantId: 'participant',
          instanceId: 'request',
          middlewareType: 'test:middleware',
          phase: 'beforeSend',
          failureMode,
          error: {
            name: 'MiddlewareError',
            message: expect.stringMatching(/diagnostic.*diag-/i),
          },
        }),
      ]);
      expect(JSON.stringify({ result, errors, logs: f.logs })).not.toContain(secret);
    },
  );

  it('executes an auto-authorized middleware tool once then resumes following hook with action', async () => {
    const f = await fixture([instance('request'), instance('following')]);
    f.participant.tools = { write: 'auto' };
    const calls: string[] = [];
    f.toolRegistry.register({
      name: 'write',
      description: 'write',
      parameters: schema,
      execute: async (_args, context) => {
        calls.push(context.participant.id);
        return { status: 'success', data: { ok: true } };
      },
    });
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          if (context.instance.id === 'request') {
            return {
              kind: 'tool',
              requestId: 'write-1',
              tool: 'write',
              arguments: {},
              stateOnSuccess: { ok: true },
            };
          }
          expect(context.actions).toEqual([
            {
              requestId: 'write-1',
              participantId: 'participant',
              instanceId: 'request',
              tool: 'write',
              status: 'success',
              result: { status: 'success', data: { ok: true } },
            },
          ]);
          return { kind: 'continue', message: { ...context.message, content: 'continued' } };
        },
      }),
      'test:runner',
    );

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-tool-auto',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue', value: draft({ content: 'continued' }) });
    expect(calls).toEqual(['participant']);
    expect(f.thread.data.middlewareState).toEqual({ participant: { request: { ok: true } } });
  });

  it('suspends an auto-authorized middleware action when its tool returns helper approval', async () => {
    const f = await fixture([instance('request')]);
    f.participant.tools = { compact_conversation: 'auto' };
    let checkpoint: unknown;
    f.toolRegistry.register({
      name: 'compact_conversation',
      description: 'compact',
      parameters: schema,
      execute: async (_args, context) => {
        checkpoint = context.middlewareCheckpoint;
        return {
          status: 'pending_approval',
          approvalId: 'helper-approval',
          data: { checkpointId: 'helper-checkpoint', pendingParticipantId: 'summarizer' },
        };
      },
    });
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({
          kind: 'tool',
          requestId: 'compact-request',
          tool: 'compact_conversation',
          arguments: {},
        }),
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'suspend-compaction',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });

    expect(result).toMatchObject({
      kind: 'pending_approval',
      approvalId: 'helper-approval',
      checkpointId: 'helper-checkpoint',
      participantId: 'summarizer',
    });
    expect(checkpoint).toMatchObject({
      conversationId: f.thread.id,
      request: { requestId: 'compact-request', tool: 'compact_conversation' },
    });
    const reloaded = await PendingApprovalRegistry.load(f.storage);
    await expect(
      reloaded.claimMiddlewareAction({
        operationId: 'suspend-compaction',
        conversationId: f.thread.id,
        participantId: f.participant.id,
        instanceId: 'request',
        requestId: 'compact-request',
        tool: 'compact_conversation',
        args: {},
      }),
    ).resolves.toEqual({ kind: 'in_progress' });
  });

  it('hands helper approval out of an approved compact action without completing it as error', async () => {
    const f = await fixture([instance('request')]);
    f.participant.tools = { compact_conversation: 'requires_approval' };
    let checkpoint: unknown;
    f.toolRegistry.register({
      name: 'compact_conversation',
      description: 'compact',
      parameters: schema,
      execute: async (_args, context) => {
        checkpoint = context.middlewareCheckpoint;
        return {
          status: 'pending_approval',
          approvalId: 'nested-helper-approval',
          data: { checkpointId: 'nested-helper-checkpoint', pendingParticipantId: 'summarizer' },
        };
      },
    });
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({
          kind: 'tool',
          requestId: 'approved-compact-request',
          tool: 'compact_conversation',
          arguments: {},
        }),
      }),
      'test:runner',
    );
    const pending = await f.runner.runMessagePhase({
      operationId: 'approved-compaction',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    if (pending.kind !== 'pending_approval') throw new Error('Expected parent approval');
    await f.pendingApprovals.resolve(pending.approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(f.runner.resumeApproval(pending.approvalId, f.thread)).resolves.toMatchObject({
      kind: 'pending_approval',
      approvalId: 'nested-helper-approval',
      checkpointId: 'nested-helper-checkpoint',
      participantId: 'summarizer',
    });
    expect(checkpoint).toMatchObject({ checkpointId: pending.checkpointId });
  });

  it('does not pass helper automation seed into resumed parent pipeline', async () => {
    const f = await fixture([instance('auto-compaction'), instance('parent-tail')]);
    f.participant.tools = { gate: 'requires_approval' };
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) =>
          context.instance.id === 'parent-tail'
            ? {
                kind: 'tool',
                requestId: 'parent-gate',
                tool: 'gate',
                arguments: {},
              }
            : { kind: 'continue' },
      }),
      'test:runner',
    );
    const parentCheckpoint: MiddlewareCheckpoint = {
      checkpointId: 'parent-checkpoint',
      operationId: 'parent-operation',
      conversationId: f.thread.id,
      phase: 'beforeSend',
      participantId: f.participant.id,
      instanceId: 'auto-compaction',
      middlewareType: 'test:middleware',
      middlewareRevision: 0,
      middlewareConfig: {},
      nextHookIndex: 1,
      actionCursor: 0,
      request: {
        requestId: 'compact-request',
        tool: 'compact_conversation',
        arguments: {},
      },
      actions: [],
      observedHead: '',
      draft: draft(),
      final: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const continuation: AutomationCompactionContinuation = {
      kind: 'automation_compaction',
      parentConversationId: f.thread.id,
      helperConversationId: 'helper-conversation',
      participantId: f.participant.id,
      middlewareInstanceId: 'auto-compaction',
      middlewareRevision: 0,
      middlewareType: 'test:middleware',
      middlewareConfig: {},
      observedParentHead: '',
      selectedMessages: [],
      parentMessageId: 'parent-message',
      helperContinuation: { kind: 'middleware', checkpoint: parentCheckpoint },
      parentCheckpoint,
    };
    const observedKinds: Array<string | undefined> = [];
    f.eventBus.on('approval:requested', ({ approvalId }) => {
      observedKinds.push(f.pendingApprovals.getRecord(approvalId)?.continuation?.kind);
    });

    const result = await f.runner.resumeAutomationParent(
      continuation,
      f.thread,
      {
        requestId: 'compact-request',
        participantId: f.participant.id,
        instanceId: 'auto-compaction',
        tool: 'compact_conversation',
        status: 'success',
        result: { status: 'success' },
      },
      '',
    );

    expect(result).toMatchObject({ kind: 'pending_approval' });
    expect(observedKinds).toEqual(['middleware']);
  });

  it('uses persisted auto tool result on repeated middleware operation and redacts tool failure detail', async () => {
    const f = await fixture([instance('request')]);
    f.participant.tools = { write: 'auto' };
    const secret = 'https://private.example/token=super-secret';
    const execute = vi.fn(async () => ({
      status: 'error' as const,
      error: secret,
      data: { secret },
    }));
    f.toolRegistry.register({ name: 'write', description: 'write', parameters: schema, execute });
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({ kind: 'tool', requestId: 'write-1', tool: 'write', arguments: {} }),
      }),
      'test:runner',
    );
    const input = {
      operationId: 'operation-ledger',
      phase: 'beforeSend' as const,
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    };
    const first = await f.runner.runMessagePhase(input);
    const second = await f.runner.runMessagePhase(input);
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify({ first, second, logs: f.logs })).not.toContain(secret);
  });

  it('rebuilds frozen active-chain snapshots after an auto tool reload before continuing hooks', async () => {
    const f = await fixture([instance('request'), instance('following')]);
    f.participant.tools = { append: 'auto' };
    f.toolRegistry.register({
      name: 'append',
      description: 'append',
      parameters: schema,
      execute: async (_args, context) => {
        await context.conversation!.append({
          senderId: context.participant.id,
          recipientId: 'operator',
          role: 'assistant',
          content: 'tool mutation',
        });
        return { status: 'success' };
      },
    });
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          if (context.instance.id === 'request') {
            return { kind: 'tool', requestId: 'append-1', tool: 'append', arguments: {} };
          }
          expect(context.activeChain.map((message) => message.content)).toEqual(['tool mutation']);
          expect(context.actions).toMatchObject([{ requestId: 'append-1', status: 'success' }]);
          expect(Object.isFrozen(context.activeChain)).toBe(true);
          expect(Object.isFrozen(context.actions)).toBe(true);
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-tool-refresh',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
  });

  it('durably checkpoints approval-required middleware tools before emitting request events', async () => {
    const f = await fixture([instance('request')]);
    f.participant.tools = { risky: 'requires_approval' };
    const events: string[] = [];
    f.eventBus.on('tool:call', () => events.push('tool:call'));
    f.eventBus.on('tool:result', () => events.push('tool:result'));
    f.eventBus.on('approval:requested', () => events.push('approval:requested'));
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({
          kind: 'tool',
          requestId: 'risky-1',
          tool: 'risky',
          arguments: { path: 'x' },
        }),
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-tool-approval',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    expect(result).toMatchObject({ kind: 'pending_approval', participantId: 'participant' });
    if (result.kind !== 'pending_approval') throw new Error('Expected pending approval');
    expect(f.pendingApprovals.getRecord(result.approvalId)).toMatchObject({
      lifecycle: 'pending',
      continuation: {
        kind: 'middleware',
        checkpoint: {
          checkpointId: result.checkpointId,
          nextHookIndex: 1,
          actionCursor: 0,
          participantId: 'participant',
          instanceId: 'request',
          middlewareType: 'test:middleware',
          middlewareRevision: 0,
          observedHead: '',
          request: { requestId: 'risky-1', tool: 'risky', arguments: { path: 'x' } },
        },
      },
    });
    expect(events).toEqual(['tool:call', 'tool:result', 'approval:requested']);
  });

  it('rejects title helper middleware approvals without pending events', async () => {
    const f = await fixture([instance('request')]);
    f.participant.tools = { risky: 'requires_approval' };
    const approvals = vi.fn();
    f.eventBus.on('approval:requested', approvals);
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({
          kind: 'tool',
          requestId: 'risky-1',
          tool: 'risky',
          arguments: { path: 'x' },
        }),
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'title-helper-approval',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
      titleApprovalRejectionMessage: 'Title generation requires approval',
    });

    expect(result).not.toMatchObject({ kind: 'pending_approval' });
    expect(approvals).not.toHaveBeenCalled();
    expect(f.pendingApprovals.listPending()).toEqual([]);
  });

  it('records rejected tool actions and applies open versus closed failure modes without replaying request hook', async () => {
    const f = await fixture([
      instance('open', { failureMode: 'open' }),
      instance('closed', { failureMode: 'closed' }),
      instance('later', { failureMode: 'open' }),
    ]);
    const calls: string[] = [];
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          calls.push(context.instance.id);
          if (context.instance.id === 'later') return { kind: 'continue' };
          return {
            kind: 'tool',
            requestId: `${context.instance.id}-1`,
            tool: 'hidden',
            arguments: {},
          };
        },
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-rejected-tools',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    expect(calls).toEqual(['open', 'closed']);
    expect(result).toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: false,
    });
  });

  it('rejects provisional and duplicate tool requests without executing tools', async () => {
    const f = await fixture([instance('request')]);
    f.participant.tools = { write: 'auto' };
    const execute = vi.spyOn(f.toolRegistry, 'execute');
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({ kind: 'tool', requestId: 'repeat', tool: 'write', arguments: {} }),
      }),
      'test:runner',
    );
    const prior: MiddlewareActionResult[] = [
      {
        requestId: 'repeat',
        participantId: 'participant',
        instanceId: 'previous',
        tool: 'write',
        status: 'success',
      },
    ];
    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-duplicate-tool',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: prior,
        final: false,
      }),
    ).resolves.toMatchObject({ kind: 'abort' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs enabled instances in participant order with isolated participant-instance state', async () => {
    const f = await fixture([
      instance('first', { config: { prefix: 'A' } }),
      instance('second', { config: { prefix: 'B' } }),
    ]);
    const observed: number[] = [];
    f.registry.register(
      middlewareDefinition({
        beforeSend: async (context) => {
          const count = ((context.getState() as { count?: number } | undefined)?.count ?? 0) + 1;
          observed.push(count);
          await context.setState({ count });
          return {
            kind: 'continue',
            message: {
              ...context.message,
              content: context.message.content.replace(
                'x',
                `${(context.config as { prefix: string }).prefix}x`,
              ),
            },
          };
        },
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-1',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });

    expect(result).toEqual({ kind: 'continue', value: draft({ content: 'ABx' }), actions: [] });
    expect(observed).toEqual([1, 1]);
    expect(f.thread.data.middlewareState).toEqual({
      participant: { first: { count: 1 }, second: { count: 1 } },
    });
  });

  it('skips disabled instances without resolving or validating them and runs later hooks', async () => {
    const f = await fixture([
      instance('disabled', { type: 'missing:type', enabled: false, config: { invalid: true } }),
      instance('later'),
    ]);
    const get = vi.spyOn(f.registry, 'get');
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => ({
          kind: 'continue',
          message: { ...context.message, content: `later:${context.message.content}` },
        }),
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-2',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });

    expect(result.kind === 'continue' && result.value.content).toBe('later:x');
    expect(get).not.toHaveBeenCalledWith('missing:type');
    expect(f.logs).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        fields: expect.objectContaining({ instanceId: 'disabled' }),
      }),
    );
  });

  it('fail-open preserves phase value, emits safe error, redacts logs, and runs later hook', async () => {
    const secret = 'secret config and stack';
    const f = await fixture([
      instance('broken', { failureMode: 'open', config: { secret } }),
      instance('later'),
    ]);
    const errors: unknown[] = [];
    f.eventBus.on('middleware:error', (event) => errors.push(event));
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          if (context.instance.id === 'broken') throw new Error(secret);
          return {
            kind: 'continue',
            message: { ...context.message, content: `ok:${context.message.content}` },
          };
        },
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-3',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });

    expect(result.kind === 'continue' && result.value.content).toBe('ok:x');
    expect(errors).toEqual([
      expect.objectContaining({
        conversationId: f.thread.id,
        participantId: 'participant',
        instanceId: 'broken',
        middlewareType: 'test:middleware',
        phase: 'beforeSend',
        failureMode: 'open',
        error: {
          name: 'MiddlewareError',
          message: expect.stringMatching(/diagnostic.*diag-/i),
        },
      }),
    ]);
    const serializedLogs = JSON.stringify(f.logs);
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain('stack');
    expect(f.logs.find((entry) => entry.level === 'warn')?.fields).toEqual({
      operationId: 'operation-3',
      conversationId: f.thread.id,
      participantId: 'participant',
      instanceId: 'broken',
      middlewareType: 'test:middleware',
      phase: 'beforeSend',
      duration: expect.any(Number),
      failureMode: 'open',
      diagnosticId: expect.stringMatching(/^diag-/),
      errorCategory: 'Error',
    });
  });

  it('reports fail-closed persistence based on persistedMessageId', async () => {
    const f = await fixture([instance('broken')]);
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => {
          throw new Error('before persistence');
        },
        afterSend: () => {
          throw new Error('after persistence');
        },
      }),
      'test:runner',
    );

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-4a',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: false,
    });
    await expect(
      f.runner.runAfterSend({
        operationId: 'operation-4b',
        participant: f.participant,
        thread: f.thread,
        message: await f.persistMessage({ id: 'stored-1' }),
        actions: [],
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: true,
      storedMessageId: 'stored-1',
    });
  });

  it.each(['senderId', 'recipientId', 'role', 'replyTo'] as const)(
    'treats %s mutation as failure in open and closed modes',
    async (field) => {
      const f = await fixture([
        instance('open', { failureMode: 'open' }),
        instance('closed', { failureMode: 'closed' }),
      ]);
      f.registry.register(
        middlewareDefinition({
          beforeReceive: (context) => ({
            kind: 'continue',
            message: { ...context.message, [field]: field === 'role' ? 'assistant' : 'rerouted' },
          }),
        }),
        'test:runner',
      );

      const result = await f.runner.runMessagePhase({
        operationId: `operation-mutation-${field}`,
        phase: 'beforeReceive',
        participant: f.participant,
        thread: f.thread,
        draft: draft({ replyTo: 'original' }),
        actions: [],
        final: true,
      });

      expect(result).toEqual({
        kind: 'abort',
        error: expect.stringMatching(/diagnostic.*diag-/i),
        persisted: false,
      });
    },
  );

  it('maps message reject outcomes for beforeSend and beforeReceive', async () => {
    const f = await fixture([instance('rejector')]);
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => ({ kind: 'reject', error: 'send rejected' }),
        beforeReceive: () => ({ kind: 'reject', error: 'receive rejected' }),
      }),
      'test:runner',
    );

    for (const [phase, error] of [
      ['beforeSend', 'send rejected'],
      ['beforeReceive', 'receive rejected'],
    ] as const) {
      await expect(
        f.runner.runMessagePhase({
          operationId: `operation-${phase}`,
          phase,
          participant: f.participant,
          thread: f.thread,
          draft: draft(),
          actions: [],
          final: true,
        }),
      ).resolves.toEqual({ kind: 'reject', error });
    }
  });

  it('maps afterReceive outcomes by pre-runtime and post-response mode', async () => {
    const f = await fixture([instance('terminal')]);
    f.registry.register(
      middlewareDefinition({
        afterReceive: (context) =>
          context.mode === 'pre_runtime'
            ? {
                kind: 'respond',
                message: draft({
                  senderId: context.participant.id,
                  recipientId: context.message.replyTo ?? context.message.senderId,
                  role: 'assistant',
                  content: 'short circuit',
                }),
              }
            : { kind: 'complete' },
      }),
      'test:runner',
    );

    await expect(
      f.runner.runAfterReceive({
        operationId: 'operation-pre',
        participant: f.participant,
        thread: f.thread,
        message: await f.persistMessage({ id: 'incoming-1' }),
        mode: 'pre_runtime',
        actions: [],
        persistedMessageId: 'incoming-1',
      }),
    ).resolves.toEqual({
      kind: 'respond',
      draft: draft({
        senderId: 'participant',
        recipientId: 'sender',
        role: 'assistant',
        content: 'short circuit',
      }),
      actions: [],
    });
    await expect(
      f.runner.runAfterReceive({
        operationId: 'operation-post',
        participant: f.participant,
        thread: f.thread,
        message: await f.persistMessage({ id: 'response-1' }),
        mode: 'post_response',
        actions: [],
        persistedMessageId: 'response-1',
      }),
    ).resolves.toEqual({ kind: 'complete', actions: [] });

    const complete = await fixture([instance('complete')]);
    complete.registry.register(
      middlewareDefinition({ afterReceive: () => ({ kind: 'complete' }) }),
      'test:runner',
    );
    await expect(
      complete.runner.runAfterReceive({
        operationId: 'operation-pre-complete',
        participant: complete.participant,
        thread: complete.thread,
        message: await complete.persistMessage({ id: 'incoming-complete' }),
        mode: 'pre_runtime',
        actions: [],
        persistedMessageId: 'incoming-complete',
      }),
    ).resolves.toEqual({ kind: 'complete', actions: [] });
  });

  it('routes fire-and-forget pre-runtime responses to replyTo without carrying replyTo forward', async () => {
    const f = await fixture([instance('respond')]);
    const incoming = await f.persistMessage({
      id: 'incoming-fire-and-forget',
      recipientId: f.participant.id,
      replyTo: 'operator',
    });
    f.registry.register(
      middlewareDefinition({
        afterReceive: (context) => ({
          kind: 'respond',
          message: {
            senderId: context.participant.id,
            recipientId: context.message.replyTo ?? context.message.senderId,
            role: 'assistant',
            content: 'dispatched response',
          },
        }),
      }),
      'test:runner',
    );

    await expect(
      f.runner.runAfterReceive({
        operationId: 'operation-fire-and-forget-response',
        participant: f.participant,
        thread: f.thread,
        message: incoming,
        mode: 'pre_runtime',
        actions: [],
      }),
    ).resolves.toEqual({
      kind: 'respond',
      draft: {
        senderId: f.participant.id,
        recipientId: 'operator',
        role: 'assistant',
        content: 'dispatched response',
      },
      actions: [],
    });
  });

  it.each(['senderId', 'recipientId', 'role', 'replyTo'] as const)(
    'rejects forged pre-runtime response %s according to effective failure mode',
    async (field) => {
      const f = await fixture([
        instance('open', { failureMode: 'open' }),
        instance('closed', { failureMode: 'closed' }),
      ]);
      const incoming = await f.persistMessage({
        id: 'incoming-forged',
        recipientId: f.participant.id,
        replyTo: 'operator',
      });
      let calls = 0;
      f.registry.register(
        middlewareDefinition({
          afterReceive: (context) => {
            calls += 1;
            const baseline = {
              senderId: context.participant.id,
              recipientId: context.message.replyTo ?? context.message.senderId,
              role: 'assistant' as const,
              content: 'response',
            };
            return {
              kind: 'respond',
              message: {
                ...baseline,
                [field]: field === 'role' ? 'user' : 'forged',
              },
            };
          },
        }),
        'test:runner',
      );

      const result = await f.runner.runAfterReceive({
        operationId: `operation-forged-response-${field}`,
        participant: f.participant,
        thread: f.thread,
        message: incoming,
        mode: 'pre_runtime',
        actions: [],
      });

      expect(calls).toBe(2);
      expect(result).toEqual({
        kind: 'abort',
        error: expect.stringMatching(/diagnostic.*diag-/i),
        persisted: true,
        storedMessageId: incoming.id,
      });
    },
  );

  it('treats post-response respond and pre-E5 tool outcomes as controlled failures', async () => {
    const f = await fixture([
      instance('open', { failureMode: 'open' }),
      instance('closed', { failureMode: 'closed' }),
    ]);
    f.registry.register(
      middlewareDefinition({
        afterReceive: (context) =>
          context.instance.id === 'open'
            ? { kind: 'respond', message: draft() }
            : { kind: 'tool', requestId: 'request-1', tool: 'x', arguments: {} },
      }),
      'test:runner',
    );
    const execute = vi.spyOn(f.toolRegistry, 'execute');

    await expect(
      f.runner.runAfterReceive({
        operationId: 'operation-controlled',
        participant: f.participant,
        thread: f.thread,
        message: await f.persistMessage({ id: 'stored-2' }),
        mode: 'post_response',
        actions: [],
        persistedMessageId: 'stored-2',
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: true,
      storedMessageId: 'stored-2',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('applies prompt changes sequentially and supports prompt and afterSend aborts', async () => {
    const f = await fixture([
      instance('append', { config: { operation: 'append', content: 'B' } }),
      instance('prepend', { config: { operation: 'prepend', content: 'A' } }),
      instance('replace', { config: { operation: 'replace', content: 'R' } }),
    ]);
    f.registry.register(
      middlewareDefinition({
        buildSystemPrompt: (context) => ({ kind: 'continue', change: context.config as never }),
        afterSend: (context) =>
          context.instance.id === 'prepend'
            ? { kind: 'abort', error: 'stop after send' }
            : { kind: 'continue' },
      }),
      'test:runner',
    );
    const promptMessage = await f.persistMessage({ id: 'prompt-message' });

    await expect(
      f.runner.runSystemPrompt({
        operationId: 'operation-prompt',
        participant: agentParticipant(f.participant),
        thread: f.thread,
        prompt: 'x',
        actions: [],
        persistedMessageId: promptMessage.id,
      }),
    ).resolves.toEqual({ kind: 'continue', value: 'R', actions: [] });
    await expect(
      f.runner.runAfterSend({
        operationId: 'operation-after-send',
        participant: f.participant,
        thread: f.thread,
        message: await f.persistMessage({ id: 'stored-3' }),
        actions: [],
        persistedMessageId: 'stored-3',
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: 'stop after send',
      persisted: true,
      storedMessageId: 'stored-3',
    });
  });

  it('maps explicit system-prompt and afterReceive aborts with persistence', async () => {
    const f = await fixture([instance('abort')]);
    f.registry.register(
      middlewareDefinition({
        buildSystemPrompt: () => ({ kind: 'abort', error: 'prompt stopped' }),
        afterReceive: () => ({ kind: 'abort', error: 'receive stopped' }),
      }),
      'test:runner',
    );
    await f.persistMessage({ id: 'incoming-2' });

    await expect(
      f.runner.runSystemPrompt({
        operationId: 'operation-prompt-abort',
        participant: agentParticipant(f.participant),
        thread: f.thread,
        prompt: 'prompt',
        actions: [],
        persistedMessageId: 'incoming-2',
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: 'prompt stopped',
      persisted: true,
      storedMessageId: 'incoming-2',
    });
    await expect(
      f.runner.runAfterReceive({
        operationId: 'operation-receive-abort',
        participant: f.participant,
        thread: f.thread,
        message: await f.persistMessage({ id: 'incoming-3' }),
        mode: 'pre_runtime',
        actions: [],
        persistedMessageId: 'incoming-3',
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: 'receive stopped',
      persisted: true,
      storedMessageId: 'incoming-3',
    });
  });

  it('preserves omitted optional fields on freshly appended messages', async () => {
    const f = await fixture([instance('observer')]);
    let sawReplyTo = true;
    f.registry.register(
      middlewareDefinition({
        afterSend: (context) => {
          sawReplyTo = Object.hasOwn(context.message, 'replyTo');
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );
    const appended = await f.thread.append(draft());

    const result = await f.runner.runAfterSend({
      operationId: 'operation-optional-fields',
      participant: f.participant,
      thread: f.thread,
      message: appended,
      actions: [],
      persistedMessageId: appended.id,
    });

    expect(result.kind).toBe('continue');
    expect(sawReplyTo).toBe(false);
    expect(appended).toHaveProperty('replyTo', undefined);
  });

  it.each(['afterReceive', 'afterSend'] as const)(
    'rejects mismatched %s persistedMessageId before hooks',
    async (api) => {
      const f = await fixture([instance('must-not-run')]);
      const hook = vi.fn(() => ({ kind: 'continue' as const }));
      f.registry.register(
        middlewareDefinition({ afterReceive: hook, afterSend: hook }),
        'test:runner',
      );
      const persisted = await f.persistMessage({ id: 'actual-message-id' });
      const call =
        api === 'afterReceive'
          ? f.runner.runAfterReceive({
              operationId: 'operation-id-mismatch',
              participant: f.participant,
              thread: f.thread,
              message: persisted,
              mode: 'pre_runtime',
              actions: [],
              persistedMessageId: 'forged-message-id',
            })
          : f.runner.runAfterSend({
              operationId: 'operation-id-mismatch',
              participant: f.participant,
              thread: f.thread,
              message: persisted,
              actions: [],
              persistedMessageId: 'forged-message-id',
            });

      await expect(call).rejects.toThrow(/persistedMessageId.*message\.id/i);
      expect(hook).not.toHaveBeenCalled();
    },
  );

  it.each(['afterReceive', 'afterSend'] as const)(
    'rejects unstored, cross-conversation, and changed messages in %s before hooks',
    async (api) => {
      const f = await fixture([instance('must-not-run')]);
      const other = await fixture();
      const hook = vi.fn(() => ({ kind: 'continue' as const }));
      f.registry.register(
        middlewareDefinition({ afterReceive: hook, afterSend: hook }),
        'test:runner',
      );
      const unstored = message(f.thread, { id: 'unstored' });
      delete f.thread.data.messages[unstored.id];
      const crossConversation = await other.persistMessage({ id: 'cross-conversation' });
      const stored = await f.persistMessage({ id: 'changed' });
      const changed = { ...stored, content: 'forged content' };

      for (const invalid of [unstored, crossConversation, changed]) {
        const call =
          api === 'afterReceive'
            ? f.runner.runAfterReceive({
                operationId: 'operation-invalid-persistence',
                participant: f.participant,
                thread: f.thread,
                message: invalid,
                mode: 'pre_runtime',
                actions: [],
              })
            : f.runner.runAfterSend({
                operationId: 'operation-invalid-persistence',
                participant: f.participant,
                thread: f.thread,
                message: invalid,
                actions: [],
              });
        await expect(call).rejects.toThrow(/message.*(stored|match|conversation)/i);
      }
      expect(hook).not.toHaveBeenCalled();
    },
  );

  it('rejects empty system-prompt persistedMessageId before hooks', async () => {
    const f = await fixture([instance('must-not-run')]);
    const hook = vi.fn(() => ({ kind: 'continue' as const }));
    f.registry.register(middlewareDefinition({ buildSystemPrompt: hook }), 'test:runner');

    await expect(
      f.runner.runSystemPrompt({
        operationId: 'operation-empty-persisted-id',
        participant: agentParticipant(f.participant),
        thread: f.thread,
        prompt: 'prompt',
        actions: [],
        persistedMessageId: '   ',
      }),
    ).rejects.toThrow(/persistedMessageId.*non-empty/i);
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects missing and unknown system-prompt persistedMessageId before hooks', async () => {
    const f = await fixture([instance('must-not-run')]);
    const hook = vi.fn(() => ({ kind: 'continue' as const }));
    f.registry.register(middlewareDefinition({ buildSystemPrompt: hook }), 'test:runner');
    const base = {
      operationId: 'operation-prompt-persistence',
      participant: agentParticipant(f.participant),
      thread: f.thread,
      prompt: 'prompt',
      actions: [],
    };

    await expect(f.runner.runSystemPrompt(base as unknown as SystemPromptInput)).rejects.toThrow(
      /persistedMessageId.*required/i,
    );
    await expect(
      f.runner.runSystemPrompt({ ...base, persistedMessageId: 'unknown-message' }),
    ).rejects.toThrow(/persistedMessageId.*stored/i);
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects non-agent system-prompt participants before hooks', async () => {
    const f = await fixture([instance('must-not-run')]);
    const hook = vi.fn(() => ({ kind: 'continue' as const }));
    f.registry.register(middlewareDefinition({ buildSystemPrompt: hook }), 'test:runner');

    await expect(
      f.runner.runSystemPrompt({
        operationId: 'operation-non-agent',
        participant: f.participant as unknown as AgentConfig,
        thread: f.thread,
        prompt: 'prompt',
        actions: [],
        persistedMessageId: (await f.persistMessage({ id: 'non-agent-message' })).id,
      }),
    ).rejects.toThrow(/agent participant/i);
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(['message', 'afterReceive', 'systemPrompt', 'afterSend'] as const)(
    'validates %s startIndex before hooks and accepts instances.length',
    async (api) => {
      const f = await fixture([instance('must-not-bypass')]);
      const hook = vi.fn(() => ({ kind: 'continue' as const }));
      f.registry.register(
        middlewareDefinition({
          beforeSend: hook,
          afterReceive: hook,
          buildSystemPrompt: hook,
          afterSend: hook,
        }),
        'test:runner',
      );
      const invoke = async (startIndex: number) => {
        if (api === 'message') {
          return f.runner.runMessagePhase({
            operationId: 'operation-index',
            phase: 'beforeSend',
            participant: f.participant,
            thread: f.thread,
            draft: draft(),
            actions: [],
            final: true,
            startIndex,
          });
        }
        if (api === 'afterReceive') {
          const persisted = await f.persistMessage({ id: 'receive-index-message' });
          return f.runner.runAfterReceive({
            operationId: 'operation-index',
            participant: f.participant,
            thread: f.thread,
            message: persisted,
            mode: 'pre_runtime',
            actions: [],
            startIndex,
          });
        }
        if (api === 'systemPrompt') {
          const persisted = await f.persistMessage({ id: 'system-index-message' });
          return f.runner.runSystemPrompt({
            operationId: 'operation-index',
            participant: agentParticipant(f.participant),
            thread: f.thread,
            prompt: 'prompt',
            actions: [],
            persistedMessageId: persisted.id,
            startIndex,
          });
        }
        const persisted = await f.persistMessage({ id: 'send-index-message' });
        return f.runner.runAfterSend({
          operationId: 'operation-index',
          participant: f.participant,
          thread: f.thread,
          message: persisted,
          actions: [],
          startIndex,
        });
      };

      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, 2]) {
        await expect(invoke(invalid)).rejects.toThrow(/startIndex.*integer.*0.*1/i);
      }
      await expect(invoke(1)).resolves.toMatchObject({ kind: 'continue' });
      expect(hook).not.toHaveBeenCalled();
    },
  );

  it('fails missing definitions and configuration mismatches according to resolved mode', async () => {
    const f = await fixture([
      instance('missing-open', { type: 'missing:type', failureMode: 'open' }),
      instance('invalid-closed', { config: { allowed: false } }),
    ]);
    f.registry.register(
      middlewareDefinition(
        { beforeSend: () => ({ kind: 'continue' }) },
        {
          configSchema: {
            type: 'object',
            properties: { allowed: { const: true } },
            required: ['allowed'],
          },
        },
      ),
      'test:runner',
    );

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-resolution',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: false,
    });
  });

  it('detaches hook inputs, results, state, signal, and caller-owned references', async () => {
    const config = { nested: { value: 'config' } };
    const actions: MiddlewareActionResult[] = [
      {
        requestId: 'request',
        participantId: 'participant',
        instanceId: 'earlier',
        tool: 'tool',
        status: 'success',
        result: { status: 'success', data: { value: 'action' } },
      },
    ];
    const f = await fixture([instance('isolated', { config })]);
    await f.conversationStore.appendMessage(f.thread.id, message(f.thread, { content: 'history' }));
    await f.conversationStore.updateHead(f.thread.id, 'message-1');
    await f.thread.reload();
    const sourceDraft = draft();
    const sourceParticipant = structuredClone(f.participant);
    const controller = new AbortController();
    let returnedMessage: MessageDraft | undefined;
    f.registry.register(
      middlewareDefinition({
        beforeSend: async (context) => {
          expect(context.signal).toBe(controller.signal);
          expect(Reflect.set(context.participant, 'name', 'mutated')).toBe(false);
          expect(
            Reflect.set(context.instance.config.nested as object, 'value', 'instance-mutated'),
          ).toBe(false);
          expect((context.config as typeof config).nested.value).toBe('config');
          expect(
            Reflect.set((context.config as typeof config).nested, 'value', 'config-mutated'),
          ).toBe(false);
          expect(
            Reflect.set(context.actions[0].result!.data as object, 'value', 'action-mutated'),
          ).toBe(false);
          expect(Reflect.set(context.activeChain[0], 'content', 'history-mutated')).toBe(false);
          (context.message as MessageDraft).content = 'context-mutated';
          const state = context.getState() as { nested: { value: string } } | undefined;
          if (!state) {
            const value = { nested: { value: 'stored' } };
            await context.setState(value);
            value.nested.value = 'post-set-mutated';
            const detachedState = context.getState() as { nested: { value: string } };
            detachedState.nested.value = 'get-state-mutated';
          }
          returnedMessage = { ...context.message, content: 'returned' };
          return { kind: 'continue', message: returnedMessage };
        },
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-isolation',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: sourceDraft,
      actions,
      final: true,
      signal: controller.signal,
    });
    returnedMessage!.content = 'post-result-mutated';

    expect(sourceDraft).toEqual(draft());
    expect(f.participant).toEqual(sourceParticipant);
    expect(config).toEqual({ nested: { value: 'config' } });
    expect(actions[0].result?.data).toEqual({ value: 'action' });
    expect(f.thread.activeChain[0].content).toBe('history');
    expect(f.thread.data.middlewareState?.participant.isolated).toEqual({
      nested: { value: 'stored' },
    });
    expect(result.kind === 'continue' && result.value.content).toBe('returned');
  });

  it.each([
    ['result', () => ({ kind: 'continue', message: { ...draft(), content: Infinity } })],
    [
      'state',
      async (context: Parameters<NonNullable<MiddlewareDefinition['hooks']['beforeSend']>>[0]) => {
        await context.setState({ value: Infinity });
        return { kind: 'continue' as const };
      },
    ],
  ])('applies failure mode to JSON-unsafe %s', async (_name, hook) => {
    const f = await fixture([instance('open', { failureMode: 'open' }), instance('closed')]);
    f.registry.register(middlewareDefinition({ beforeSend: hook as never }), 'test:runner');

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-json',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: false,
    });
  });

  it('does not invoke result getters or toJSON', async () => {
    const f = await fixture([instance('unsafe')]);
    let invoked = false;
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => {
          const result = { kind: 'continue' } as Record<string, unknown>;
          Object.defineProperty(result, 'message', {
            enumerable: true,
            get() {
              invoked = true;
              throw new Error('getter ran');
            },
          });
          result.toJSON = () => {
            invoked = true;
            return {};
          };
          return result as never;
        },
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-accessor',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });

    expect(invoked).toBe(false);
    expect(result).toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: false,
    });
  });

  it('starts at startIndex and preserves propagated actions', async () => {
    const f = await fixture([instance('completed'), instance('resumed')]);
    const calls: string[] = [];
    const actions: MiddlewareActionResult[] = [
      {
        requestId: 'prior-request',
        participantId: 'participant',
        instanceId: 'completed',
        tool: 'prior-tool',
        status: 'success',
      },
    ];
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          calls.push(context.instance.id);
          expect(context.actions).toEqual(actions);
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-resume',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions,
      final: true,
      startIndex: 1,
    });

    expect(calls).toEqual(['resumed']);
    expect(result).toEqual({ kind: 'continue', value: draft(), actions });
    expect(result.kind === 'continue' && result.actions).not.toBe(actions);
  });

  it('returns terminal cancellation before a pre-aborted hook runs', async () => {
    const f = await fixture([instance('cancelled', { failureMode: 'open' })]);
    const hook = vi.fn(() => ({ kind: 'continue' as const }));
    f.registry.register(middlewareDefinition({ beforeSend: hook }), 'test:runner');
    const controller = new AbortController();
    controller.abort();

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-pre-aborted',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: 'Middleware operation cancelled',
      persisted: false,
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it('cancels a hung hook terminally, skips later hooks, and handles its late rejection', async () => {
    const f = await fixture([
      instance('hung', { failureMode: 'open' }),
      instance('later', { failureMode: 'open' }),
    ]);
    const started = deferred();
    const hung = deferred<never>();
    const later = vi.fn(() => ({ kind: 'continue' as const }));
    f.registry.register(
      middlewareDefinition({
        afterReceive: (context) => {
          if (context.instance.id === 'later') return later();
          started.resolve();
          return hung.promise;
        },
      }),
      'test:runner',
    );
    const incoming = await f.thread.append(draft({ recipientId: f.participant.id }));
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    try {
      const operation = f.runner.runAfterReceive({
        operationId: 'operation-hung-abort',
        participant: f.participant,
        thread: f.thread,
        message: incoming,
        mode: 'pre_runtime',
        actions: [],
        signal: controller.signal,
      });
      await started.promise;
      controller.abort();
      await expect(operation).resolves.toEqual({
        kind: 'abort',
        error: 'Middleware operation cancelled',
        persisted: true,
        storedMessageId: incoming.id,
      });
      expect(later).not.toHaveBeenCalled();
      hung.reject(new Error('late secret rejection'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('revokes retained context and waits for fire-and-forget state writes', async () => {
    const f = await fixture([instance('stateful')]);
    const entered = deferred();
    const release = deferred();
    const mutate = f.conversationStore.mutate.bind(f.conversationStore);
    vi.spyOn(f.conversationStore, 'mutate').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return mutate(...args);
    });
    let retained: MessageDraftContext | undefined;
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          retained = context;
          void context.setState({ count: 1 });
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );

    let settled = false;
    const operation = f.runner
      .runMessagePhase({
        operationId: 'operation-unawaited-state',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      })
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await expect(operation).resolves.toMatchObject({ kind: 'continue' });
    expect(f.thread.data.middlewareState?.participant.stateful).toEqual({ count: 1 });
    await expect(retained!.setState({ count: 2 })).rejects.toThrow(/inactive|settled/i);
  });

  it('drains state writes when a hook rejects and cancels blocked writes on abort', async () => {
    const rejecting = await fixture([instance('rejecting-state')]);
    const rejectEntered = deferred();
    const rejectRelease = deferred();
    const rejectMutate = rejecting.conversationStore.mutate.bind(rejecting.conversationStore);
    vi.spyOn(rejecting.conversationStore, 'mutate').mockImplementation(async (...args) => {
      rejectEntered.resolve();
      await rejectRelease.promise;
      return rejectMutate(...args);
    });
    rejecting.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          void context.setState({ value: 'written-before-failure' });
          throw new Error('hook failed');
        },
      }),
      'test:runner',
    );
    let rejectSettled = false;
    const rejectedOperation = rejecting.runner
      .runMessagePhase({
        operationId: 'operation-rejected-state',
        phase: 'beforeSend',
        participant: rejecting.participant,
        thread: rejecting.thread,
        draft: draft(),
        actions: [],
        final: true,
      })
      .finally(() => {
        rejectSettled = true;
      });
    await rejectEntered.promise;
    await Promise.resolve();
    expect(rejectSettled).toBe(false);
    rejectRelease.resolve();
    await expect(rejectedOperation).resolves.toMatchObject({ kind: 'abort' });
    expect(rejecting.thread.data.middlewareState?.participant['rejecting-state']).toEqual({
      value: 'written-before-failure',
    });

    const cancelled = await fixture([instance('cancelled-state')]);
    const cancelEntered = deferred();
    const cancelRelease = deferred();
    const cancelMutate = cancelled.conversationStore.mutate.bind(cancelled.conversationStore);
    vi.spyOn(cancelled.conversationStore, 'mutate').mockImplementation(async (...args) => {
      cancelEntered.resolve();
      await cancelRelease.promise;
      return cancelMutate(...args);
    });
    cancelled.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          void context.setState({ value: 'must-not-write' });
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );
    const controller = new AbortController();
    let cancelSettled = false;
    const cancelledOperation = cancelled.runner
      .runMessagePhase({
        operationId: 'operation-cancelled-state',
        phase: 'beforeSend',
        participant: cancelled.participant,
        thread: cancelled.thread,
        draft: draft(),
        actions: [],
        final: true,
        signal: controller.signal,
      })
      .finally(() => {
        cancelSettled = true;
      });
    await cancelEntered.promise;
    controller.abort();
    await Promise.resolve();
    expect(cancelSettled).toBe(false);
    cancelRelease.resolve();
    await expect(cancelledOperation).resolves.toEqual({
      kind: 'abort',
      error: 'Middleware operation cancelled',
      persisted: false,
    });
    expect(
      (await cancelled.conversationStore.load(cancelled.thread.id))?.middlewareState,
    ).toBeUndefined();
  });

  it('settles canceled state writes at the storage commit boundary before returning', async () => {
    const beforeCommit = await fixture([instance('before-commit')]);
    const callbackDone = deferred();
    const releaseCallback = deferred();
    const originalMutate = beforeCommit.conversationStore.mutate.bind(
      beforeCommit.conversationStore,
    );
    vi.spyOn(beforeCommit.conversationStore, 'mutate').mockImplementation(
      (conversationId, callback, guard) =>
        originalMutate(
          conversationId,
          async (conversation) => {
            const candidate = await callback(conversation);
            callbackDone.resolve();
            await releaseCallback.promise;
            return candidate;
          },
          guard,
        ),
    );
    beforeCommit.registry.register(
      middlewareDefinition({
        beforeSend: async (context) => {
          await context.setState({ value: 'must-not-commit' });
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );
    const beforeController = new AbortController();
    let beforeSettled = false;
    const beforeOperation = beforeCommit.runner
      .runMessagePhase({
        operationId: 'operation-abort-before-commit',
        phase: 'beforeSend',
        participant: beforeCommit.participant,
        thread: beforeCommit.thread,
        draft: draft(),
        actions: [],
        final: true,
        signal: beforeController.signal,
      })
      .finally(() => {
        beforeSettled = true;
      });
    await callbackDone.promise;
    beforeController.abort();
    await Promise.resolve();
    expect(beforeSettled).toBe(false);
    releaseCallback.resolve();
    await expect(beforeOperation).resolves.toEqual({
      kind: 'abort',
      error: 'Middleware operation cancelled',
      persisted: false,
    });
    expect(
      (await beforeCommit.conversationStore.load(beforeCommit.thread.id))?.middlewareState,
    ).toBeUndefined();

    const afterCommit = await fixture([instance('after-commit')]);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const originalWrite = afterCommit.storage.writeJson.bind(afterCommit.storage);
    vi.spyOn(afterCommit.storage, 'writeJson').mockImplementation(async (key, value) => {
      if (
        key.includes(`conversations/${afterCommit.thread.id}`) &&
        (value as { middlewareState?: unknown }).middlewareState !== undefined
      ) {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      await originalWrite(key, value);
    });
    afterCommit.registry.register(
      middlewareDefinition({
        beforeSend: async (context) => {
          await context.setState({ value: 'committed' });
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );
    const afterController = new AbortController();
    const afterOperation = afterCommit.runner.runMessagePhase({
      operationId: 'operation-abort-after-commit-point',
      phase: 'beforeSend',
      participant: afterCommit.participant,
      thread: afterCommit.thread,
      draft: draft(),
      actions: [],
      final: true,
      signal: afterController.signal,
    });
    await writeStarted.promise;
    afterController.abort();
    releaseWrite.resolve();
    await expect(afterOperation).resolves.toEqual({
      kind: 'abort',
      error: 'Middleware operation cancelled',
      persisted: false,
    });
    expect(
      (await afterCommit.conversationStore.load(afterCommit.thread.id))?.middlewareState,
    ).toEqual({ participant: { 'after-commit': { value: 'committed' } } });
    expect(afterCommit.thread.data.middlewareState).toEqual({
      participant: { 'after-commit': { value: 'committed' } },
    });
  });

  it('serializes state read-modify-write phases across runner instances', async () => {
    const f = await fixture([instance('counter')]);
    f.registry.register(
      middlewareDefinition({
        beforeSend: async (context) => {
          const count = ((context.getState() as { count?: number } | undefined)?.count ?? 0) + 1;
          await Promise.resolve();
          await context.setState({ count });
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );
    const secondData = await f.conversationStore.load(f.thread.id);
    const secondThread = new ConversationThread(secondData!, f.conversationStore);
    const secondRunner = new MiddlewareRunner(f.runnerDependencies);

    await Promise.all([
      f.runner.runMessagePhase({
        operationId: 'operation-concurrent-1',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
      secondRunner.runMessagePhase({
        operationId: 'operation-concurrent-2',
        phase: 'beforeSend',
        participant: f.participant,
        thread: secondThread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ]);

    expect((await f.conversationStore.load(f.thread.id))?.middlewareState).toEqual({
      participant: { counter: { count: 2 } },
    });
  });

  it('releases the shared conversation coordinator after an operation error', async () => {
    const f = await fixture([instance('recovery')]);
    const hook = vi.fn(() => ({ kind: 'continue' as const }));
    f.registry.register(middlewareDefinition({ beforeSend: hook }), 'test:runner');
    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-coordinator-error',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
        startIndex: 2,
      }),
    ).rejects.toThrow(/startIndex/i);

    await expect(
      new MiddlewareRunner(f.runnerDependencies).runMessagePhase({
        operationId: 'operation-coordinator-recovery',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('cancels a queued waiter promptly without letting later work bypass its predecessor', async () => {
    const f = await fixture([instance('queue')]);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];
    f.registry.register(
      middlewareDefinition({
        beforeSend: async (context) => {
          calls.push(context.operationId);
          if (context.operationId === 'operation-queue-first') {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );
    const first = f.runner.runMessagePhase({
      operationId: 'operation-queue-first',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    await firstStarted.promise;
    const controller = new AbortController();
    const second = f.runner.runMessagePhase({
      operationId: 'operation-queue-cancelled',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
      signal: controller.signal,
    });
    const third = f.runner.runMessagePhase({
      operationId: 'operation-queue-third',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    controller.abort();

    await expect(second).resolves.toEqual({
      kind: 'abort',
      error: 'Middleware operation cancelled',
      persisted: false,
    });
    expect(calls).toEqual(['operation-queue-first']);
    releaseFirst.resolve();
    await Promise.all([first, third]);
    expect(calls).toEqual(['operation-queue-first', 'operation-queue-third']);
  });

  it('maps queued post-persistence cancellation using authoritative message state', async () => {
    const f = await fixture([instance('queue-post')]);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    f.registry.register(
      middlewareDefinition({
        beforeSend: async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
          return { kind: 'continue' };
        },
        afterReceive: () => ({ kind: 'continue' }),
      }),
      'test:runner',
    );
    const incoming = await f.persistMessage({ id: 'queued-incoming' });
    const first = f.runner.runMessagePhase({
      operationId: 'operation-queue-post-first',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    await firstStarted.promise;
    const controller = new AbortController();
    const queued = f.runner.runAfterReceive({
      operationId: 'operation-queue-post-cancelled',
      participant: f.participant,
      thread: f.thread,
      message: incoming,
      mode: 'pre_runtime',
      actions: [],
      signal: controller.signal,
    });
    controller.abort();

    await expect(queued).resolves.toEqual({
      kind: 'abort',
      error: 'Middleware operation cancelled',
      persisted: true,
      storedMessageId: incoming.id,
    });
    releaseFirst.resolve();
    await first;
  });

  it('fails same-conversation nested execution fast while allowing another conversation', async () => {
    const f = await fixture([
      instance('nested', { failureMode: 'open' }),
      instance('later', { failureMode: 'open' }),
    ]);
    const otherData = await f.conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const otherThread = new ConversationThread(otherData, f.conversationStore);
    const calls: string[] = [];
    let distinctCompleted = false;
    f.registry.register(
      middlewareDefinition({
        beforeSend: async (context) => {
          calls.push(`${context.conversationId}:${context.instance.id}`);
          if (context.instance.id !== 'nested') return { kind: 'continue' };
          if (context.operationId === 'operation-nested-same') {
            await f.runner.runMessagePhase({
              operationId: 'operation-nested-inner',
              phase: 'beforeSend',
              participant: f.participant,
              thread: f.thread,
              draft: draft(),
              actions: [],
              final: true,
            });
          } else if (context.operationId === 'operation-nested-distinct') {
            await f.runner.runMessagePhase({
              operationId: 'operation-other-conversation',
              phase: 'beforeSend',
              participant: { ...f.participant, middleware: [] },
              thread: otherThread,
              draft: draft(),
              actions: [],
              final: true,
            });
            distinctCompleted = true;
          }
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-nested-same',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
    expect(calls).toEqual([`${f.thread.id}:nested`, `${f.thread.id}:later`]);

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-nested-distinct',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
    expect(distinctCompleted).toBe(true);
  });

  it('allows inherited async work to run after its owning operation completes', async () => {
    const f = await fixture([instance('background-owner')]);
    const releaseBackground = deferred();
    let background: Promise<unknown> | undefined;
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => {
          background = (async () => {
            await releaseBackground.promise;
            return f.runner.runMessagePhase({
              operationId: 'operation-background-after-owner',
              phase: 'beforeSend',
              participant: { ...f.participant, middleware: [] },
              thread: f.thread,
              draft: draft(),
              actions: [],
              final: true,
            });
          })();
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-background-owner',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
    releaseBackground.resolve();
    await expect(background).resolves.toMatchObject({ kind: 'continue' });
  });

  it('uses authoritative storage instead of locally injected persistence', async () => {
    const f = await fixture([instance('must-not-run')]);
    const hook = vi.fn(() => ({ kind: 'continue' as const }));
    f.registry.register(
      middlewareDefinition({ afterReceive: hook, afterSend: hook, buildSystemPrompt: hook }),
      'test:runner',
    );
    const fake = message(f.thread, { id: 'local-fake' });

    await expect(
      f.runner.runAfterReceive({
        operationId: 'operation-local-fake-receive',
        participant: f.participant,
        thread: f.thread,
        message: fake,
        mode: 'pre_runtime',
        actions: [],
      }),
    ).rejects.toThrow(/stored/i);
    await expect(
      f.runner.runAfterSend({
        operationId: 'operation-local-fake-send',
        participant: f.participant,
        thread: f.thread,
        message: fake,
        actions: [],
      }),
    ).rejects.toThrow(/stored/i);
    await expect(
      f.runner.runSystemPrompt({
        operationId: 'operation-local-fake-prompt',
        participant: agentParticipant(f.participant),
        thread: f.thread,
        prompt: 'prompt',
        actions: [],
        persistedMessageId: fake.id,
      }),
    ).rejects.toThrow(/stored/i);
    expect(hook).not.toHaveBeenCalled();
  });

  it('sanitizes thrown hook diagnostics across result, event, and logs', async () => {
    const secret = 'https://private.example/token=super-secret';
    const f = await fixture([instance('secret', { config: { token: secret } })]);
    const events: unknown[] = [];
    f.eventBus.on('middleware:error', (event) => events.push(event));
    f.registry.register(
      middlewareDefinition({
        beforeSend: () => {
          const error = new TypeError(secret);
          error.name = 'PrivateTokenError';
          throw error;
        },
      }),
      'test:runner',
    );

    const result = await f.runner.runMessagePhase({
      operationId: 'operation-secret-error',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });
    const publicJson = JSON.stringify({ result, events, logs: f.logs });

    expect(result).toEqual({
      kind: 'abort',
      error: expect.stringMatching(/diagnostic.*diag-/i),
      persisted: false,
    });
    expect(events).toEqual([
      expect.objectContaining({
        error: {
          name: 'MiddlewareError',
          message: expect.stringMatching(/diagnostic.*diag-/i),
        },
      }),
    ]);
    const eventMessage = (events[0] as { error: { message: string } }).error.message;
    const diagnosticId = eventMessage.match(/diag-[a-f0-9-]+/)?.[0];
    expect(diagnosticId).toBeDefined();
    expect(result.kind === 'abort' && result.error).toBe(eventMessage);
    expect(f.logs.find((entry) => entry.level === 'warn')?.fields).toEqual(
      expect.objectContaining({ diagnosticId, errorCategory: 'TypeError' }),
    );
    expect(publicJson).not.toContain(secret);
    expect(publicJson).not.toContain('PrivateTokenError');
    expect(publicJson).not.toContain('private.example');
  });

  it('parses exact phase outcomes and accepts legal explicit undefined optionals', async () => {
    const legal = await fixture([instance('legal')]);
    const incoming = await legal.thread.append(draft());
    legal.registry.register(
      middlewareDefinition({
        beforeSend: () => ({ kind: 'continue', message: undefined }),
        buildSystemPrompt: () => ({ kind: 'continue', change: undefined }),
      }),
      'test:runner',
    );
    await expect(
      legal.runner.runMessagePhase({
        operationId: 'operation-optional-message',
        phase: 'beforeSend',
        participant: legal.participant,
        thread: legal.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
    await expect(
      legal.runner.runSystemPrompt({
        operationId: 'operation-optional-change',
        participant: agentParticipant(legal.participant),
        thread: legal.thread,
        prompt: 'prompt',
        actions: [],
        persistedMessageId: incoming.id,
      }),
    ).resolves.toEqual({ kind: 'continue', value: 'prompt', actions: [] });

    const invalidCases = [
      ['beforeSend', { kind: 'continue', extra: 'secret-extra' }],
      ['afterReceive', { kind: 'complete', message: draft() }],
      ['buildSystemPrompt', { kind: 'abort', error: 'public', extra: true }],
      ['afterSend', { kind: 'continue', change: { operation: 'append', content: 'x' } }],
    ] as const;
    for (const [phase, outcome] of invalidCases) {
      const f = await fixture([instance(`invalid-${phase}`)]);
      const persisted = await f.thread.append(draft());
      f.registry.register(
        middlewareDefinition({ [phase]: () => outcome } as MiddlewareDefinition['hooks']),
        'test:runner',
      );
      const result =
        phase === 'beforeSend'
          ? await f.runner.runMessagePhase({
              operationId: `operation-exact-${phase}`,
              phase,
              participant: f.participant,
              thread: f.thread,
              draft: draft(),
              actions: [],
              final: true,
            })
          : phase === 'afterReceive'
            ? await f.runner.runAfterReceive({
                operationId: `operation-exact-${phase}`,
                participant: f.participant,
                thread: f.thread,
                message: persisted,
                mode: 'pre_runtime',
                actions: [],
              })
            : phase === 'buildSystemPrompt'
              ? await f.runner.runSystemPrompt({
                  operationId: `operation-exact-${phase}`,
                  participant: agentParticipant(f.participant),
                  thread: f.thread,
                  prompt: 'prompt',
                  actions: [],
                  persistedMessageId: persisted.id,
                })
              : await f.runner.runAfterSend({
                  operationId: `operation-exact-${phase}`,
                  participant: f.participant,
                  thread: f.thread,
                  message: persisted,
                  actions: [],
                });
      expect(result).toEqual({
        kind: 'abort',
        error: expect.stringMatching(/diagnostic.*diag-/i),
        persisted: phase === 'beforeSend' ? false : true,
        ...(phase === 'beforeSend' ? {} : { storedMessageId: persisted.id }),
      });
    }
  });

  it('isolates frozen context telemetry and runner telemetry failures', async () => {
    const f = await fixture([instance('telemetry')]);
    const throwingLogger: MiddlewareLogger = {
      debug: () => {
        throw new Error('logger debug failed');
      },
      info: () => {
        throw new Error('logger info failed');
      },
      warn: () => {
        throw new Error('logger warn failed');
      },
      error: () => {
        throw new Error('logger error failed');
      },
    };
    vi.spyOn(f.eventBus, 'emit').mockImplementation(() => {
      throw new Error('event backend failed');
    });
    const runner = new MiddlewareRunner({ ...f.runnerDependencies, logger: throwingLogger });
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          expect(context.eventBus).not.toBe(f.eventBus);
          expect(context.logger).not.toBe(throwingLogger);
          expect(Object.isFrozen(context.eventBus)).toBe(true);
          expect(Object.isFrozen(context.logger)).toBe(true);
          context.eventBus.emit('iteration', {
            conversationId: context.conversationId,
            participantId: context.participant.id,
            iteration: 1,
          });
          context.logger.info('hook telemetry');
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );

    await expect(
      runner.runMessagePhase({
        operationId: 'operation-telemetry',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions: [],
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
  });

  it('handles rejecting thenables returned by logger and event telemetry', async () => {
    const f = await fixture([instance('async-telemetry')]);
    const secret = 'async telemetry secret';
    const rejectAsync = () => Promise.reject(new Error(secret));
    const asyncLogger: MiddlewareLogger = {
      debug: rejectAsync as unknown as MiddlewareLogger['debug'],
      info: rejectAsync as unknown as MiddlewareLogger['info'],
      warn: rejectAsync as unknown as MiddlewareLogger['warn'],
      error: rejectAsync as unknown as MiddlewareLogger['error'],
    };
    vi.spyOn(f.eventBus, 'emit').mockImplementation(
      rejectAsync as unknown as typeof f.eventBus.emit,
    );
    const runner = new MiddlewareRunner({ ...f.runnerDependencies, logger: asyncLogger });
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          context.logger.info('async hook log');
          context.eventBus.emit('iteration', {
            conversationId: context.conversationId,
            participantId: context.participant.id,
            iteration: 1,
          });
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        runner.runMessagePhase({
          operationId: 'operation-async-telemetry',
          phase: 'beforeSend',
          participant: f.participant,
          thread: f.thread,
          draft: draft(),
          actions: [],
          final: true,
        }),
      ).resolves.toMatchObject({ kind: 'continue' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reads active chain once for multiple hooks in one phase', async () => {
    const f = await fixture([instance('first'), instance('second')]);
    const activeChain = vi.spyOn(ConversationThread.prototype, 'activeChain', 'get');
    f.registry.register(
      middlewareDefinition({ beforeSend: () => ({ kind: 'continue' }) }),
      'test:runner',
    );

    await f.runner.runMessagePhase({
      operationId: 'operation-snapshot-once',
      phase: 'beforeSend',
      participant: f.participant,
      thread: f.thread,
      draft: draft(),
      actions: [],
      final: true,
    });

    expect(activeChain).toHaveBeenCalledTimes(1);
  });

  it('reuses deeply frozen phase snapshots across hooks', async () => {
    const actions: MiddlewareActionResult[] = [
      {
        requestId: 'snapshot-action',
        participantId: 'participant',
        instanceId: 'earlier',
        tool: 'snapshot-tool',
        status: 'success',
        result: { status: 'success', data: { nested: 'stable' } },
      },
    ];
    const f = await fixture([
      instance('first', { config: { nested: { value: 'first' } } }),
      instance('second', { config: { nested: { value: 'second' } } }),
    ]);
    await f.thread.append(draft({ content: 'history' }));
    let firstParticipant: ParticipantConfig | undefined;
    let firstChain: readonly MessageData[] | undefined;
    let firstActions: readonly MiddlewareActionResult[] | undefined;
    let firstInstance: MiddlewareInstanceConfig | undefined;
    let firstConfig: unknown;
    f.registry.register(
      middlewareDefinition({
        beforeSend: (context) => {
          expect(Object.isFrozen(context.participant)).toBe(true);
          expect(Object.isFrozen(context.activeChain)).toBe(true);
          expect(Object.isFrozen(context.activeChain[0])).toBe(true);
          expect(Object.isFrozen(context.actions)).toBe(true);
          expect(Object.isFrozen(context.actions[0].result?.data)).toBe(true);
          expect(Object.isFrozen(context.instance)).toBe(true);
          expect(Object.isFrozen(context.config)).toBe(true);
          expect(Object.isFrozen((context.config as { nested: object }).nested)).toBe(true);
          expect(Reflect.set(context.participant, 'name', 'mutated')).toBe(false);
          expect(Reflect.set(context.activeChain[0], 'content', 'mutated')).toBe(false);
          expect(Reflect.set(context.actions[0], 'tool', 'mutated')).toBe(false);
          expect(Reflect.set(context.config as object, 'extra', true)).toBe(false);
          if (context.instance.id === 'first') {
            firstParticipant = context.participant;
            firstChain = context.activeChain;
            firstActions = context.actions;
            firstInstance = context.instance;
            firstConfig = context.config;
          } else {
            expect(context.participant).toBe(firstParticipant);
            expect(context.activeChain).toBe(firstChain);
            expect(context.actions).toBe(firstActions);
            expect(context.instance).not.toBe(firstInstance);
            expect(context.config).not.toBe(firstConfig);
            expect((context.config as { nested: { value: string } }).nested.value).toBe('second');
            expect(context.participant.name).toBe('Participant');
            expect(context.activeChain[0].content).toBe('history');
            expect(context.actions[0].tool).toBe('snapshot-tool');
          }
          return { kind: 'continue' };
        },
      }),
      'test:runner',
    );

    await expect(
      f.runner.runMessagePhase({
        operationId: 'operation-frozen-snapshots',
        phase: 'beforeSend',
        participant: f.participant,
        thread: f.thread,
        draft: draft(),
        actions,
        final: true,
      }),
    ).resolves.toMatchObject({ kind: 'continue' });
    expect(f.participant.name).toBe('Participant');
    expect(actions[0].tool).toBe('snapshot-tool');
  });
});
