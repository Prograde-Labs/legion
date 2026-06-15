import { PendingApprovalRegistry } from './PendingApprovalRegistry.js';

describe('PendingApprovalRegistry', () => {
  it('creates a pending request and resolves it', async () => {
    const reg = new PendingApprovalRegistry();
    const { requestId, decision } = reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
    });
    expect(requestId).toMatch(/^appr-/);
    expect(reg.get(requestId)).toBeDefined();

    reg.resolve(requestId, { approved: true, decidedByParticipantId: 'operator' });
    await expect(decision).resolves.toEqual({ approved: true, decidedByParticipantId: 'operator' });
    expect(reg.get(requestId)).toBeUndefined();
  });

  it('rejects resolving an unknown request', () => {
    const reg = new PendingApprovalRegistry();
    expect(() =>
      reg.resolve('appr-ghost', { approved: false, decidedByParticipantId: 'x' }),
    ).toThrow();
  });

  it('lists pending requests', () => {
    const reg = new PendingApprovalRegistry();
    reg.create({ conversationId: 'c1', requesterId: 'a', tool: 't', args: {} });
    reg.create({ conversationId: 'c2', requesterId: 'b', tool: 't', args: {} });
    expect(reg.list().length).toBe(2);
  });
});
