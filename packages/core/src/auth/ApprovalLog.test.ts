import { ApprovalLog } from './ApprovalLog.js';

describe('ApprovalLog', () => {
  it('records and lists approval decisions', () => {
    const log = new ApprovalLog();
    log.record({
      requestId: 'r1',
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: { path: 'x' },
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    const entries = log.list();
    expect(entries.length).toBe(1);
    expect(entries[0].decidedByParticipantId).toBe('operator');
  });

  it('filters by conversation', () => {
    const log = new ApprovalLog();
    log.record({
      requestId: 'r1',
      conversationId: 'c1',
      requesterId: 'a',
      tool: 't',
      args: {},
      approved: true,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    log.record({
      requestId: 'r2',
      conversationId: 'c2',
      requesterId: 'a',
      tool: 't',
      args: {},
      approved: false,
      decidedByParticipantId: 'op',
      decidedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(log.list({ conversationId: 'c2' }).map((e) => e.requestId)).toEqual(['r2']);
  });
});
