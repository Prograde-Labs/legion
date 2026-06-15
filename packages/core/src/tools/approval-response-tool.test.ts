import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ApprovalLog } from '../auth/ApprovalLog.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { ToolRegistry } from './ToolRegistry.js';
import { approvalResponseTool } from './approval-response-tool.js';
import type { ToolContext } from './Tool.js';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    participant: {
      id: 'op',
      name: 'Operator',
      type: 'user',
      tools: {},
      approvalAuthority: { tools: '*', participants: '*' },
    },
    conversationId: 'c1',
    collective: {
      get: () => undefined,
      getOrThrow: () => {
        throw new Error();
      },
    },
    config: { version: '2' },
    eventBus: { emit: () => {} },
    storage: {} as unknown,
    workspaceRoot: '/tmp',
    communicationDepth: 0,
    toolRegistry: new ToolRegistry(),
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
    approvalLog: new ApprovalLog(),
    messageRouter: {
      send: async () => ({ conversationId: 'c1', status: 'success' }),
      resume: async () => ({ conversationId: 'c1', status: 'success' }),
    },
    ...overrides,
  } as unknown as ToolContext;
}

describe('approval_response tool', () => {
  it('approves a pending request and triggers resume', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resumeSpy = vi.fn().mockResolvedValue({ conversationId: 'c1', status: 'success' });
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: {
        send: vi.fn(),
        resume: resumeSpy,
      } as unknown as ToolContext['messageRouter'],
    });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    expect(result.status).toBe('success');
    const data = result.data as { results: { approvalId: string; outcome: string }[] };
    expect(data.results[0].outcome).toBe('approve');
    expect(reg.getDecision(approvalId)?.approved).toBe(true);
    expect(resumeSpy).toHaveBeenCalledWith('c1', 'agent-b', context);
  });

  it('rejects a request with a message', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c2',
      requesterId: 'agent-b',
      tool: 'delete_file',
      args: {},
    });
    const context = makeContext({ pendingApprovalRegistry: reg });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'reject', message: 'Too risky' }] },
      context,
    );

    expect(result.status).toBe('success');
    const decision = reg.getDecision(approvalId);
    expect(decision?.approved).toBe(false);
    expect(decision?.message).toBe('Too risky');
  });

  it('batches multiple decisions in one call', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId: id1 } = await reg.create({
      conversationId: 'c3',
      requesterId: 'b',
      tool: 'a',
      args: {},
    });
    const { approvalId: id2 } = await reg.create({
      conversationId: 'c3',
      requesterId: 'b',
      tool: 'x',
      args: {},
    });
    const context = makeContext({ pendingApprovalRegistry: reg });

    const result = await approvalResponseTool.execute(
      {
        decisions: [
          { approvalId: id1, decision: 'approve' },
          { approvalId: id2, decision: 'reject', message: 'no' },
        ],
      },
      context,
    );

    const data = result.data as { results: { outcome: string }[] };
    expect(data.results[0].outcome).toBe('approve');
    expect(data.results[1].outcome).toBe('reject');
  });

  it('returns not_found for an unknown approvalId', async () => {
    const context = makeContext();
    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId: 'appr-ghost', decision: 'approve' }] },
      context,
    );
    expect(result.status).toBe('success');
    const data = result.data as { results: { outcome: string }[] };
    expect(data.results[0].outcome).toBe('not_found');
  });

  it('returns unauthorized when the caller lacks authority', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c4',
      requesterId: 'agent-b',
      tool: 'danger',
      args: {},
    });
    const context = makeContext({
      pendingApprovalRegistry: reg,
      participant: {
        id: 'agent-c',
        name: 'C',
        type: 'agent',
        tools: {},
      } as ToolContext['participant'],
    });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    const data = result.data as { results: { outcome: string }[] };
    expect(data.results[0].outcome).toBe('unauthorized');
    expect(reg.getDecision(approvalId)).toBeUndefined(); // not recorded
  });

  it('records the decision in ApprovalLog', async () => {
    const reg = new PendingApprovalRegistry();
    const log = new ApprovalLog();
    const { approvalId } = await reg.create({
      conversationId: 'c5',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const context = makeContext({ pendingApprovalRegistry: reg, approvalLog: log });

    await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    const entries = log.list({ conversationId: 'c5' });
    expect(entries.length).toBe(1);
    expect(entries[0].decidedByParticipantId).toBe('op');
  });
});
