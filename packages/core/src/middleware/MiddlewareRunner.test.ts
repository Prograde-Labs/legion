import type {
  AgentConfig,
  MessageData,
  MessageDraft,
  MiddlewareActionResult,
  MiddlewareDefinition,
  MiddlewareInstanceConfig,
  MiddlewareLogger,
  ParticipantConfig,
} from '@legion/types';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
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
  const runner = new MiddlewareRunner({
    registry,
    authEngine,
    toolRegistry,
    pendingApprovals,
    eventBus,
    logger,
    conversationStore,
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
  });
  return {
    runner,
    registry,
    participant,
    thread,
    eventBus,
    logs,
    conversationStore,
    toolRegistry,
  };
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
      {
        conversationId: f.thread.id,
        participantId: 'participant',
        instanceId: 'broken',
        middlewareType: 'test:middleware',
        phase: 'beforeSend',
        failureMode: 'open',
        error: { name: 'Error', message: secret },
      },
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
      error: 'before persistence',
      persisted: false,
    });
    await expect(
      f.runner.runAfterSend({
        operationId: 'operation-4b',
        participant: f.participant,
        thread: f.thread,
        message: message(f.thread, { id: 'stored-1' }),
        actions: [],
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: 'after persistence',
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
        error: expect.stringContaining(field),
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
        message: message(f.thread, { id: 'incoming-1' }),
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
        message: message(f.thread, { id: 'response-1' }),
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
        message: message(complete.thread, { id: 'incoming-complete' }),
        mode: 'pre_runtime',
        actions: [],
        persistedMessageId: 'incoming-complete',
      }),
    ).resolves.toEqual({ kind: 'complete', actions: [] });
  });

  it('routes fire-and-forget pre-runtime responses to replyTo without carrying replyTo forward', async () => {
    const f = await fixture([instance('respond')]);
    const incoming = message(f.thread, {
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
      const incoming = message(f.thread, {
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
        error: expect.stringContaining(field),
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
        message: message(f.thread, { id: 'stored-2' }),
        mode: 'post_response',
        actions: [],
        persistedMessageId: 'stored-2',
      }),
    ).resolves.toEqual({
      kind: 'abort',
      error: expect.stringMatching(/tool.*unsupported/i),
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
    const promptMessage = message(f.thread, { id: 'prompt-message' });

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
        message: message(f.thread, { id: 'stored-3' }),
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
    message(f.thread, { id: 'incoming-2' });

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
        message: message(f.thread, { id: 'incoming-3' }),
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
      const persisted = message(f.thread, { id: 'actual-message-id' });
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
      const crossConversation = message(other.thread, { id: 'cross-conversation' });
      const stored = message(f.thread, { id: 'changed' });
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
        persistedMessageId: message(f.thread, { id: 'non-agent-message' }).id,
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
      const invoke = (startIndex: number) => {
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
          return f.runner.runAfterReceive({
            operationId: 'operation-index',
            participant: f.participant,
            thread: f.thread,
            message: message(f.thread),
            mode: 'pre_runtime',
            actions: [],
            startIndex,
          });
        }
        if (api === 'systemPrompt') {
          const persisted = message(f.thread, { id: 'system-index-message' });
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
        return f.runner.runAfterSend({
          operationId: 'operation-index',
          participant: f.participant,
          thread: f.thread,
          message: message(f.thread),
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
      error: expect.stringMatching(/configuration invalid/i),
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
          context.participant.name = 'mutated';
          (context.instance.config.nested as { value: string }).value = 'instance-mutated';
          expect((context.config as typeof config).nested.value).toBe('config');
          (context.config as typeof config).nested.value = 'config-mutated';
          (context.actions[0].result!.data as { value: string }).value = 'action-mutated';
          (context.activeChain as MessageData[])[0].content = 'history-mutated';
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
      error: expect.stringMatching(/JSON-safe/),
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
      error: expect.stringMatching(/JSON-safe/),
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
});
