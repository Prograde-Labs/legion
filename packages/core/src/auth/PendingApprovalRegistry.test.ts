import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { PendingApprovalRegistry } from './PendingApprovalRegistry.js';
import type { MessageData, MiddlewareCheckpoint } from '@legion/types';

function checkpoint(argumentsValue: Record<string, unknown> = { path: 'x' }): MiddlewareCheckpoint {
  return {
    checkpointId: 'mwcp-1',
    operationId: 'operation-1',
    conversationId: 'c1',
    phase: 'beforeSend',
    participantId: 'agent-b',
    instanceId: 'audit',
    middlewareType: 'test:audit',
    middlewareRevision: 2,
    nextHookIndex: 1,
    actionCursor: 0,
    draft: { senderId: 'agent-b', recipientId: 'operator', role: 'assistant', content: 'hello' },
    final: true,
    request: { requestId: 'request-1', tool: 'file_write', arguments: argumentsValue },
    actions: [],
    observedHead: 'message-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function fullMessage(): MessageData {
  return {
    id: 'message-1',
    parentId: null,
    conversationId: 'c1',
    senderId: 'agent-b',
    recipientId: 'operator',
    replyTo: 'operator',
    role: 'assistant',
    content: 'hello',
    reasoning: 'because',
    type: 'message',
    status: 'active',
    toolCalls: [{ id: 'call-1', name: 'file_write', arguments: { path: 'x' } }],
    toolResults: [
      { id: 'call-1', name: 'file_write', result: { status: 'success', data: { ok: true } } },
    ],
    usage: {
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
      cost: 0.01,
      modelId: 'test-model',
      providerId: 'test-provider',
    },
    timestamp: '2026-01-01T00:00:00.000Z',
    editOf: 'message-0',
    supersededBy: 'message-2',
    compacts: ['message-0'],
    prunedAt: '2026-01-01T00:01:00.000Z',
    prunedBy: 'operator',
  };
}

function afterSendCheckpoint(message = fullMessage()): MiddlewareCheckpoint {
  const value = checkpoint();
  value.phase = 'afterSend';
  delete (value as Partial<MiddlewareCheckpoint>).draft;
  delete (value as Partial<MiddlewareCheckpoint>).final;
  value.message = message;
  value.persistedMessageId = message.id;
  return value;
}

describe('PendingApprovalRegistry (in-memory)', () => {
  it('creates a pending approval and returns approvalId', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
    });
    expect(approvalId).toMatch(/^appr-/);
    expect(reg.get(approvalId)).toBeDefined();
    expect(reg.getDecision(approvalId)).toBeUndefined();
  });

  it('resolves a decision and removes from pending', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
    });
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(reg.get(approvalId)).toBeUndefined();
    expect(reg.getDecision(approvalId)).toEqual({
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('rejects resolving an unknown approvalId', async () => {
    const reg = new PendingApprovalRegistry();
    await expect(
      reg.resolve('appr-ghost', { approved: false, decidedByParticipantId: 'x', decidedAt: '' }),
    ).rejects.toThrow(/appr-ghost/);
  });

  it('lists pending approvals, optionally filtered by conversationId', async () => {
    const reg = new PendingApprovalRegistry();
    await reg.create({ conversationId: 'c1', requesterId: 'a', tool: 't', args: {} });
    await reg.create({ conversationId: 'c2', requesterId: 'b', tool: 't', args: {} });
    expect(reg.listPending().length).toBe(2);
    expect(reg.listPending('c1').length).toBe(1);
    expect(reg.listPending('c2')[0].requesterId).toBe('b');
  });
});

describe('PendingApprovalRegistry (durable)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-par-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads pending approvals across instances', async () => {
    const storage = new FileStorage(dir);
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
    });

    // Simulate restart: load a fresh instance from the same storage
    const reg2 = await PendingApprovalRegistry.load(storage);
    expect(reg2.get(approvalId)?.requesterId).toBe('agent-b');
    expect(reg2.getDecision(approvalId)).toBeUndefined();
  });

  it('persists and reloads resolved decisions', async () => {
    const storage = new FileStorage(dir);
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    await reg.resolve(approvalId, {
      approved: false,
      decidedByParticipantId: 'op',
      message: 'too risky',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });

    const reg2 = await PendingApprovalRegistry.load(storage);
    expect(reg2.get(approvalId)).toBeUndefined(); // no longer pending
    expect(reg2.getDecision(approvalId)?.message).toBe('too risky');
  });
});

describe('PendingApprovalRegistry continuations', () => {
  it.each([
    ['conversation', (value: MiddlewareCheckpoint) => (value.conversationId = 'wrong')],
    ['participant', (value: MiddlewareCheckpoint) => (value.participantId = 'wrong')],
    ['tool', (value: MiddlewareCheckpoint) => (value.request.tool = 'wrong')],
    ['arguments', (value: MiddlewareCheckpoint) => (value.request.arguments = { path: 'wrong' })],
    ['action cursor', (value: MiddlewareCheckpoint) => (value.actionCursor = 1)],
    [
      'request collision',
      (value: MiddlewareCheckpoint) =>
        value.actions.push({
          requestId: value.request.requestId,
          participantId: 'agent-b',
          instanceId: 'audit',
          tool: 'file_write',
          status: 'success',
        }),
    ],
  ])(
    'rejects continuation checkpoint %s binding mismatch before creating approval',
    async (_name, mutate) => {
      const reg = new PendingApprovalRegistry();
      const value = checkpoint();
      mutate(value);
      await expect(
        reg.create({
          conversationId: 'c1',
          requesterId: 'agent-b',
          tool: 'file_write',
          args: { path: 'x' },
          continuation: { kind: 'middleware', checkpoint: value },
        }),
      ).rejects.toThrow(/match|cursor|requestId/i);
      expect(reg.listPending()).toEqual([]);
    },
  );

  it.each([
    ['missing result', { status: 'success', result: undefined }],
    [
      'success with error result',
      { status: 'success', result: { status: 'error', error: 'failed' } },
    ],
    ['error with success result', { status: 'error', result: { status: 'success' } }],
    ['rejected with success result', { status: 'rejected', result: { status: 'success' } }],
  ])('rejects terminal middleware action %s without completing claim', async (_name, patch) => {
    const reg = new PendingApprovalRegistry();
    const claim = {
      operationId: 'operation-1',
      conversationId: 'c1',
      participantId: 'agent-b',
      instanceId: 'audit',
      requestId: 'request-1',
      tool: 'file_write',
      args: { path: 'x' },
    };
    await reg.claimMiddlewareAction(claim);
    const result = {
      requestId: claim.requestId,
      participantId: claim.participantId,
      instanceId: claim.instanceId,
      tool: claim.tool,
      status: 'success',
      result: { status: 'success', data: { written: true } },
      ...patch,
    };
    await expect(reg.recordMiddlewareActionResult(claim, result as never)).rejects.toThrow();
    await expect(reg.claimMiddlewareAction(claim)).resolves.toEqual({ kind: 'in_progress' });
  });

  it('fails closed loading completed action whose terminal result does not bind claim', async () => {
    const storage = new MemoryStorage();
    const reg = new PendingApprovalRegistry(storage);
    const claim = {
      operationId: 'operation-1',
      conversationId: 'c1',
      participantId: 'agent-b',
      instanceId: 'audit',
      requestId: 'request-1',
      tool: 'file_write',
      args: { path: 'x' },
    };
    await reg.claimMiddlewareAction(claim);
    await reg.recordMiddlewareActionResult(claim, {
      requestId: claim.requestId,
      participantId: claim.participantId,
      instanceId: claim.instanceId,
      tool: claim.tool,
      status: 'error',
      result: { status: 'error', error: 'safe' },
    });
    const data = (await storage.readJson<Record<string, unknown>>(
      'pending-approvals/registry.json',
    ))!;
    const action = Object.values(
      data.middlewareActions as Record<string, Record<string, unknown>>,
    )[0];
    (action.result as Record<string, unknown>).tool = 'wrong';
    await storage.writeJson('pending-approvals/registry.json', data);
    await expect(PendingApprovalRegistry.load(storage)).rejects.toThrow(/match|tool/i);
  });

  it('keeps live middleware action claim in progress until first executor records terminal result', async () => {
    const storage = new MemoryStorage();
    const reg = new PendingApprovalRegistry(storage);
    const action = {
      operationId: 'operation-1',
      conversationId: 'c1',
      participantId: 'agent-b',
      instanceId: 'audit',
      requestId: 'request-1',
      tool: 'file_write',
      args: { path: 'x' },
    };
    await expect(reg.claimMiddlewareAction(action)).resolves.toMatchObject({ kind: 'claimed' });
    await expect(reg.claimMiddlewareAction(action)).resolves.toMatchObject({ kind: 'in_progress' });
    await reg.recordMiddlewareActionResult(action, {
      requestId: 'request-1',
      participantId: 'agent-b',
      instanceId: 'audit',
      tool: 'file_write',
      status: 'success',
      result: { status: 'success', data: { written: true } },
    });
    await expect(reg.claimMiddlewareAction(action)).resolves.toMatchObject({
      kind: 'completed',
      result: { status: 'success', result: { status: 'success', data: { written: true } } },
    });

    const recovering = new PendingApprovalRegistry(storage);
    const recoveryAction = { ...action, requestId: 'request-recovery' };
    await recovering.claimMiddlewareAction(recoveryAction);
    const loaded = await PendingApprovalRegistry.load(storage);
    await expect(loaded.claimMiddlewareAction(recoveryAction)).resolves.toMatchObject({
      kind: 'completed',
      result: {
        status: 'error',
        result: { status: 'error', error: expect.stringMatching(/outcome unknown.*not retried/i) },
      },
    });
    await expect(
      loaded.recordMiddlewareActionResult(recoveryAction, {
        requestId: 'request-recovery',
        participantId: 'agent-b',
        instanceId: 'audit',
        tool: 'file_write',
        status: 'success',
        result: { status: 'success', data: { unsafe: true } },
      }),
    ).rejects.toThrow(/conflict|completed/i);
  });

  it('migrates strict predecessor records-only registry and persists empty action ledger', async () => {
    const storage = new MemoryStorage();
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    const prior = (await storage.readJson<Record<string, unknown>>(
      'pending-approvals/registry.json',
    ))!;
    delete prior.middlewareActions;
    await storage.writeJson('pending-approvals/registry.json', prior);

    const loaded = await PendingApprovalRegistry.load(storage);
    expect(loaded.getRecord(approvalId)?.approvalId).toBe(approvalId);
    expect(await storage.readJson('pending-approvals/registry.json')).toMatchObject({
      records: expect.any(Object),
      middlewareActions: {},
    });
  });

  it.each([
    ['requestId', (action: Record<string, unknown>) => (action.requestId = 'wrong')],
    ['participantId', (action: Record<string, unknown>) => (action.participantId = 'wrong')],
    ['instanceId', (action: Record<string, unknown>) => (action.instanceId = 'wrong')],
    ['tool', (action: Record<string, unknown>) => (action.tool = 'wrong')],
  ])(
    'rejects terminal middleware action %s mismatch without completing claim',
    async (_name, mutate) => {
      const reg = new PendingApprovalRegistry();
      const claim = {
        operationId: 'operation-1',
        conversationId: 'c1',
        participantId: 'agent-b',
        instanceId: 'audit',
        requestId: 'request-1',
        tool: 'file_write',
        args: { path: 'x' },
      };
      await reg.claimMiddlewareAction(claim);
      const result: Record<string, unknown> = {
        requestId: claim.requestId,
        participantId: claim.participantId,
        instanceId: claim.instanceId,
        tool: claim.tool,
        status: 'success',
        result: { status: 'success', data: { written: true } },
      };
      mutate(result);
      await expect(reg.recordMiddlewareActionResult(claim, result as never)).rejects.toThrow(
        /match|conflict/i,
      );
      await expect(reg.claimMiddlewareAction(claim)).resolves.toEqual({ kind: 'in_progress' });
    },
  );

  it('rejects non-canonical registry roots and contradictory canonical lifecycles', async () => {
    for (const value of [[], {}, 1, 'bad']) {
      const storage = new MemoryStorage();
      await storage.write('pending-approvals/registry.json', JSON.stringify(value));
      await expect(PendingApprovalRegistry.load(storage)).rejects.toThrow();
    }

    const storage = new MemoryStorage();
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    const data = (await storage.readJson<Record<string, unknown>>(
      'pending-approvals/registry.json',
    ))!;
    const records = data.records as Record<string, Record<string, unknown>>;
    records[approvalId].decision = {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    };
    await storage.writeJson('pending-approvals/registry.json', data);
    await expect(PendingApprovalRegistry.load(storage)).rejects.toThrow(
      /pending.*decision|lifecycle/i,
    );

    const actionStorage = new MemoryStorage();
    const actionRegistry = new PendingApprovalRegistry(actionStorage);
    const action = {
      operationId: 'operation-1',
      conversationId: 'c1',
      participantId: 'agent-b',
      instanceId: 'audit',
      requestId: 'request-1',
      tool: 'file_write',
      args: { path: 'x' },
    };
    await actionRegistry.claimMiddlewareAction(action);
    const actionData = (await actionStorage.readJson<Record<string, unknown>>(
      'pending-approvals/registry.json',
    ))!;
    const actions = actionData.middlewareActions as Record<string, Record<string, unknown>>;
    Object.values(actions)[0].lifecycle = 'completed';
    await actionStorage.writeJson('pending-approvals/registry.json', actionData);
    await expect(PendingApprovalRegistry.load(actionStorage)).rejects.toThrow(/completed.*result/i);
  });

  it('atomically stores detached middleware continuation and idempotent decision', async () => {
    const reg = new PendingApprovalRegistry();
    const continuation = checkpoint();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: continuation },
    });
    continuation.request.arguments.path = 'mutated';

    const stored = reg.getRecord(approvalId)!;
    expect(stored.lifecycle).toBe('pending');
    expect(stored.continuation).toEqual({ kind: 'middleware', checkpoint: checkpoint() });
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:01:00.000Z',
    });
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:01:00.000Z',
    });
    await expect(
      reg.resolve(approvalId, {
        approved: false,
        decidedByParticipantId: 'operator',
        decidedAt: '2026-01-01T00:01:00.000Z',
      }),
    ).rejects.toThrow(/conflict/i);
  });

  it('claims resume once, retains durable result, and acknowledges only continuation', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:01:00.000Z',
    });

    expect((await reg.beginResume(approvalId)).status).toBe('ready');
    expect((await reg.beginResume(approvalId)).status).toBe('in_progress');
    await reg.recordResumeResult(approvalId, { status: 'success', data: { written: true } });
    expect((await reg.beginResume(approvalId)).status).toBe('ready');
    await reg.acknowledge(approvalId);
    expect((await reg.beginResume(approvalId)).status).toBe('acknowledged');
    expect(reg.getRecord(approvalId)?.continuation).toBeUndefined();
    expect(reg.getRecord(approvalId)?.resumeResult).toEqual({
      status: 'success',
      data: { written: true },
    });
  });

  it('detaches public records and recovers an interrupted middleware execution without retry', async () => {
    const storage = new MemoryStorage();
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { nested: { value: 'safe' } },
      continuation: { kind: 'middleware', checkpoint: checkpoint({ nested: { value: 'safe' } }) },
    });
    const record = reg.getRecord(approvalId)!;
    (record.args as { nested: { value: string } }).nested.value = 'mutated';
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:01:00.000Z',
    });
    await reg.beginResume(approvalId);

    const recovered = await PendingApprovalRegistry.load(storage);
    expect(recovered.getRecord(approvalId)?.args).toEqual({ nested: { value: 'safe' } });
    expect(recovered.getRecord(approvalId)?.resumeResult).toEqual({
      status: 'error',
      error: 'Interrupted middleware tool execution; outcome unknown and tool was not retried',
    });
    expect((await recovered.beginResume(approvalId)).status).toBe('ready');
  });

  it('does not publish mutation when persistence fails and later mutations recover', async () => {
    const storage = new MemoryStorage();
    const write = vi.spyOn(storage, 'writeJson').mockRejectedValueOnce(new Error('disk full'));
    const reg = new PendingApprovalRegistry(storage);
    await expect(
      reg.create({ conversationId: 'c1', requesterId: 'agent-b', tool: 'file_write', args: {} }),
    ).rejects.toThrow('disk full');
    expect(reg.listPending()).toEqual([]);
    write.mockRestore();
    await expect(
      reg.create({ conversationId: 'c1', requesterId: 'agent-b', tool: 'file_write', args: {} }),
    ).resolves.toEqual({ approvalId: expect.stringMatching(/^appr-/) });
  });

  it('rejects acknowledgement before a terminal resume result without deleting continuation', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    await expect(reg.acknowledge(approvalId)).rejects.toThrow(/terminal|result/i);
    expect(reg.getRecord(approvalId)?.continuation).toBeDefined();
    await reg.resolve(approvalId, {
      approved: false,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:01:00.000Z',
    });
    await expect(reg.acknowledge(approvalId)).rejects.toThrow(/terminal|result/i);
    await reg.beginResume(approvalId);
    await expect(reg.acknowledge(approvalId)).rejects.toThrow(/terminal|result/i);
    expect(reg.getRecord(approvalId)?.continuation).toBeDefined();
    await reg.recordResumeResult(approvalId, { status: 'rejected', message: 'denied' });
    await reg.acknowledge(approvalId);
    await expect(reg.acknowledge(approvalId)).resolves.toBeUndefined();
  });

  it('fails closed when loading corrupt, unreadable, or unrecoverably persisted storage', async () => {
    const corrupt = new MemoryStorage();
    await corrupt.write('pending-approvals/registry.json', '{not json');
    await expect(PendingApprovalRegistry.load(corrupt)).rejects.toThrow();

    const unreadable = new MemoryStorage();
    vi.spyOn(unreadable, 'readJson').mockRejectedValueOnce(new Error('read failed'));
    await expect(PendingApprovalRegistry.load(unreadable)).rejects.toThrow('read failed');

    const storage = new MemoryStorage();
    const reg = new PendingApprovalRegistry(storage);
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:01:00.000Z',
    });
    await reg.beginResume(approvalId);
    vi.spyOn(storage, 'writeJson').mockRejectedValueOnce(new Error('recovery write failed'));
    await expect(PendingApprovalRegistry.load(storage)).rejects.toThrow('recovery write failed');
  });

  it('rejects incomplete or non-canonical middleware checkpoints before creating a record', async () => {
    const reg = new PendingApprovalRegistry();
    const incomplete = checkpoint();
    delete (incomplete as Partial<MiddlewareCheckpoint>).observedHead;
    await expect(
      reg.create({
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'file_write',
        args: { path: 'x' },
        continuation: { kind: 'middleware', checkpoint: incomplete },
      }),
    ).rejects.toThrow(/observedHead/i);

    const unknown = checkpoint() as MiddlewareCheckpoint & { unexpected: true };
    unknown.unexpected = true;
    await expect(
      reg.create({
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'file_write',
        args: {},
        continuation: { kind: 'middleware', checkpoint: unknown },
      }),
    ).rejects.toThrow(/unsupported|unknown/i);

    const wrongPhase = checkpoint();
    wrongPhase.phase = 'afterSend';
    delete (wrongPhase as Partial<MiddlewareCheckpoint>).draft;
    delete (wrongPhase as Partial<MiddlewareCheckpoint>).final;
    await expect(
      reg.create({
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'file_write',
        args: {},
        continuation: { kind: 'middleware', checkpoint: wrongPhase },
      }),
    ).rejects.toThrow(/message|persistedMessageId/i);

    const prompt = checkpoint();
    prompt.phase = 'buildSystemPrompt';
    delete (prompt as Partial<MiddlewareCheckpoint>).draft;
    delete (prompt as Partial<MiddlewareCheckpoint>).final;
    prompt.prompt = 'continue';
    prompt.persistedMessageId = 'message-1';
    prompt.runtimeResume = {
      kind: 'agent_provider',
      participantId: 'wrong-participant',
      incomingMessageId: 'message-1',
      iteration: 0,
      preparedPrompt: 'continue',
      actionCursor: 0,
      actions: [],
    };
    await expect(
      reg.create({
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'file_write',
        args: { path: 'x' },
        continuation: { kind: 'middleware', checkpoint: prompt },
      }),
    ).rejects.toThrow(/runtimeResume.*participantId/i);
    prompt.runtimeResume.participantId = 'agent-b';
    prompt.runtimeResume.incomingMessageId = 'different-message';
    await expect(
      reg.create({
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'file_write',
        args: { path: 'x' },
        continuation: { kind: 'middleware', checkpoint: prompt },
      }),
    ).rejects.toThrow(/incomingMessageId.*persistedMessageId/i);
    expect(reg.listPending()).toEqual([]);
  });

  it.each([
    ['tool role', (message: MessageData) => ({ ...message, role: 'tool' })],
    ['invalid status', (message: MessageData) => ({ ...message, status: 'deleted' })],
    [
      'malformed tool result',
      (message: MessageData) => ({
        ...message,
        toolResults: [
          { id: 'call-1', name: 'file_write', result: { status: 'success', error: 1 } },
        ],
      }),
    ],
  ])('rejects checkpoint messages with %s', async (_name, mutate) => {
    const reg = new PendingApprovalRegistry();
    await expect(
      reg.create({
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'file_write',
        args: { path: 'x' },
        continuation: {
          kind: 'middleware',
          checkpoint: afterSendCheckpoint(mutate(fullMessage())),
        },
      }),
    ).rejects.toThrow(/role|status|error/i);
  });

  it('accepts a complete typed persisted message checkpoint', async () => {
    const reg = new PendingApprovalRegistry();
    await expect(
      reg.create({
        conversationId: 'c1',
        requesterId: 'agent-b',
        tool: 'file_write',
        args: { path: 'x' },
        continuation: { kind: 'middleware', checkpoint: afterSendCheckpoint() },
      }),
    ).resolves.toEqual({ approvalId: expect.stringMatching(/^appr-/) });
  });

  it('treats concurrent semantic duplicate decisions as idempotent', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    await expect(
      Promise.all([
        reg.resolve(approvalId, {
          approved: true,
          decidedByParticipantId: 'operator',
          message: 'approved',
          decidedAt: '2026-01-01T00:00:00.000Z',
        }),
        reg.resolve(approvalId, {
          approved: true,
          decidedByParticipantId: 'operator',
          message: 'approved',
          decidedAt: '2026-01-01T00:01:00.000Z',
        }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(
      reg.resolve(approvalId, {
        approved: false,
        decidedByParticipantId: 'operator',
        message: 'approved',
        decidedAt: '2026-01-01T00:02:00.000Z',
      }),
    ).rejects.toThrow(/conflict/i);
  });

  it('accepts empty successful router responses and preserves completed provider execution', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    await reg.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    await reg.beginResume(approvalId);
    await reg.recordResumeResult(approvalId, { status: 'success' });
    expect(await reg.claimProviderExecution(approvalId)).toBe('claimed');
    await reg.recordRouterResult(approvalId, {
      conversationId: 'c1',
      status: 'success',
      response: '',
    });
    expect(await reg.claimProviderExecution(approvalId)).toBe('completed');
    expect(reg.getRecord(approvalId)?.routerResult).toEqual({
      conversationId: 'c1',
      status: 'success',
      response: '',
    });
  });
});
