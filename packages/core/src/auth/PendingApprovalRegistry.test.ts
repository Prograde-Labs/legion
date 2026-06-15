import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { PendingApprovalRegistry } from './PendingApprovalRegistry.js';

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
