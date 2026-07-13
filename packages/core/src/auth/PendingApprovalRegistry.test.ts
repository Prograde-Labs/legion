import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { PendingApprovalRegistry } from './PendingApprovalRegistry.js';
import type { MiddlewareCheckpoint } from '@legion/types';

function checkpoint(): MiddlewareCheckpoint {
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
    request: { requestId: 'request-1', tool: 'file_write', arguments: { path: 'x' } },
    actions: [],
    observedHead: 'message-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
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
      args: {},
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
      args: {},
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
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
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
      args: {},
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
      args: {},
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
        args: {},
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
        args: {},
        continuation: { kind: 'middleware', checkpoint: prompt },
      }),
    ).rejects.toThrow(/runtimeResume.*participantId/i);
    expect(reg.listPending()).toEqual([]);
  });
});
