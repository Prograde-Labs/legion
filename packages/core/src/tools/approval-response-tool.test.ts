import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ApprovalLog } from '../auth/ApprovalLog.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { ToolRegistry } from './ToolRegistry.js';
import { approvalResponseTool } from './approval-response-tool.js';
import type { ToolContext } from './Tool.js';
import type { MiddlewareCheckpoint } from '@legion/types';

function checkpoint(): MiddlewareCheckpoint {
  return {
    checkpointId: 'mwcp-1',
    operationId: 'route-1',
    conversationId: 'c1',
    phase: 'beforeSend',
    participantId: 'agent-b',
    instanceId: 'middleware-1',
    middlewareType: 'test:middleware',
    middlewareRevision: 0,
    nextHookIndex: 1,
    actionCursor: 0,
    draft: { senderId: 'agent-b', recipientId: 'op', role: 'assistant', content: 'pending' },
    final: true,
    request: { requestId: 'request-1', tool: 'file_write', arguments: {} },
    actions: [],
    observedHead: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

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

async function createAutomationApproval(reg = new PendingApprovalRegistry()) {
  const helperCheckpoint = checkpoint();
  helperCheckpoint.conversationId = 'helper';
  const parentCheckpoint = checkpoint();
  parentCheckpoint.conversationId = 'parent';
  parentCheckpoint.instanceId = 'audit';
  parentCheckpoint.middlewareType = 'builtin:auto-compaction';
  parentCheckpoint.middlewareConfig = {};
  parentCheckpoint.request = {
    requestId: 'compact',
    tool: 'compact_conversation',
    arguments: {},
  };
  const { approvalId } = await reg.create(
    {
      conversationId: 'helper',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
      continuation: { kind: 'middleware', checkpoint: helperCheckpoint },
    },
    {
      parentConversationId: 'parent',
      helperConversationId: 'helper',
      participantId: 'agent-b',
      middlewareInstanceId: 'audit',
      middlewareRevision: 0,
      middlewareType: 'builtin:auto-compaction',
      middlewareConfig: {},
      observedParentHead: 'message-1',
      selectedMessages: [
        {
          id: 'message-1',
          parentId: null,
          conversationId: 'parent',
          senderId: 'op',
          recipientId: 'agent-b',
          role: 'user',
          content: 'old context',
          status: 'active',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
      parentMessageId: 'message-1',
      parentCheckpoint,
    },
  );
  return { reg, approvalId };
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

  it('releases the resume claim when the conversation still has pending approvals', async () => {
    const reg = new PendingApprovalRegistry();
    const first = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_read',
      args: {},
    });
    const second = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_read',
      args: {},
    });
    // Router reports pending_approval — one of the two approvals is still outstanding.
    const resumeSpy = vi
      .fn()
      .mockResolvedValue({ conversationId: 'c1', status: 'pending_approval' });
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: {
        send: vi.fn(),
        resume: resumeSpy,
      } as unknown as ToolContext['messageRouter'],
    });

    await approvalResponseTool.execute(
      { decisions: [{ approvalId: first.approvalId, decision: 'approve' }] },
      context,
    );

    // The claim must be releasable: a later decision can claim and resume again.
    expect(await reg.claimGenericResume('c1', 'agent-b')).toBe('claimed');
    expect(second).toBeDefined();
  });

  it('resumes again for a new approval round after a completed resume in the same conversation', async () => {
    const reg = new PendingApprovalRegistry();
    const first = await reg.create({
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

    // Round 1: decide + resume completes the generic claim.
    await approvalResponseTool.execute(
      { decisions: [{ approvalId: first.approvalId, decision: 'approve' }] },
      context,
    );
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    // Round 2: a brand-new approval in the same conversation must be able to
    // claim and resume again — the completed claim from round 1 must not latch.
    const second = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    await approvalResponseTool.execute(
      { decisions: [{ approvalId: second.approvalId, decision: 'approve' }] },
      context,
    );
    expect(resumeSpy).toHaveBeenCalledTimes(2);
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

  it('resumes middleware continuations through resumeApproval and skips acknowledged records', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c1',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
      continuation: { kind: 'middleware', checkpoint: checkpoint() },
    });
    const resumeApproval = vi.fn(async () => ({
      conversationId: 'c1',
      status: 'success' as const,
    }));
    const resume = vi.fn(async () => ({ conversationId: 'c1', status: 'success' as const }));
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: {
        send: vi.fn(),
        resume,
        resumeApproval,
      } as unknown as ToolContext['messageRouter'],
    });

    const first = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );
    expect(resumeApproval).toHaveBeenCalledWith(approvalId, context);
    expect(resume).not.toHaveBeenCalled();
    expect((first.data as { results: { outcome: string }[] }).results[0].outcome).toBe(
      'resume_pending',
    );

    const second = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );
    expect(resumeApproval).toHaveBeenCalledTimes(2);
    expect((second.data as { results: { outcome: string }[] }).results[0].outcome).toBe(
      'resume_pending',
    );
  });

  it('dispatches automation compaction through durable resumeApproval instead of generic replay', async () => {
    const { reg, approvalId } = await createAutomationApproval();
    const resumeApproval = vi.fn(async () => ({
      conversationId: 'parent',
      status: 'success' as const,
    }));
    const resume = vi.fn(async () => ({ conversationId: 'helper', status: 'success' as const }));
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: {
        send: vi.fn(),
        resume,
        resumeApproval,
      } as unknown as ToolContext['messageRouter'],
    });

    await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    expect(resumeApproval).toHaveBeenCalledWith(approvalId, context);
    expect(resume).not.toHaveBeenCalled();
  });

  it('routes rejected automation compaction through durable resumeApproval', async () => {
    const { reg, approvalId } = await createAutomationApproval();
    const resumeApproval = vi.fn(async () => ({
      conversationId: 'parent',
      status: 'error' as const,
      error: 'rejected by operator',
    }));
    const resume = vi.fn();
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: {
        send: vi.fn(),
        resume,
        resumeApproval,
      } as unknown as ToolContext['messageRouter'],
    });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'reject', message: 'Too risky' }] },
      context,
    );

    expect(reg.getDecision(approvalId)).toMatchObject({ approved: false, message: 'Too risky' });
    expect(resumeApproval).toHaveBeenCalledWith(approvalId, context);
    expect(resume).not.toHaveBeenCalled();
    expect((result.data as { results: { outcome: string }[] }).results[0].outcome).toBe(
      'resume_pending',
    );
  });

  it('keeps automation compaction durable when router resume throws', async () => {
    const { reg, approvalId } = await createAutomationApproval();
    const resumeApproval = vi.fn(async () => {
      throw new Error('router unavailable');
    });
    const resume = vi.fn();
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: {
        send: vi.fn(),
        resume,
        resumeApproval,
      } as unknown as ToolContext['messageRouter'],
    });

    const result = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    expect(reg.getDecision(approvalId)).toMatchObject({ approved: true });
    expect(reg.getRecord(approvalId)?.continuation?.kind).toBe('automation_compaction');
    expect(resumeApproval).toHaveBeenCalledWith(approvalId, context);
    expect(resume).not.toHaveBeenCalled();
    expect((result.data as { results: { outcome: string }[] }).results[0].outcome).toBe(
      'resume_pending',
    );
  });

  it('coalesces concurrent identical decisions into one generic resume', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c-concurrent',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resume = vi.fn(async () => ({
      conversationId: 'c-concurrent',
      status: 'success' as const,
    }));
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });

    const [first, second] = await Promise.all([
      approvalResponseTool.execute({ decisions: [{ approvalId, decision: 'approve' }] }, context),
      approvalResponseTool.execute({ decisions: [{ approvalId, decision: 'approve' }] }, context),
    ]);

    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    expect(reg.getDecision(approvalId)).toMatchObject({ approved: true });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('does not resume again when concurrent decisions conflict', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c-conflict',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resume = vi.fn(async () => ({
      conversationId: 'c-conflict',
      status: 'success' as const,
    }));
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });

    const results = await Promise.allSettled([
      approvalResponseTool.execute({ decisions: [{ approvalId, decision: 'approve' }] }, context),
      approvalResponseTool.execute({ decisions: [{ approvalId, decision: 'reject' }] }, context),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(reg.getDecision(approvalId)).toBeDefined();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('keeps duplicate approval IDs in one batch idempotent without double resume', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c-batch',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resume = vi.fn(async () => ({ conversationId: 'c-batch', status: 'success' as const }));
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });

    const result = await approvalResponseTool.execute(
      {
        decisions: [
          { approvalId, decision: 'approve' },
          { approvalId, decision: 'approve' },
        ],
      },
      context,
    );

    expect((result.data as { results: { outcome: string }[] }).results).toEqual([
      { approvalId, outcome: 'approve' },
      { approvalId, outcome: 'duplicate' },
    ]);
    expect(reg.getDecision(approvalId)).toMatchObject({ approved: true });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('treats an empty message as equivalent to no message across repeated approvals', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c-empty-msg',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resume = vi
      .fn()
      .mockResolvedValue({ conversationId: 'c-empty-msg', status: 'success' as const });
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });

    // First approval sends message: '' (as the web UI does with a blank reason).
    const first = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve', message: '' }] },
      context,
    );
    // A repeated approval that omits the message must be idempotent, not a conflict.
    const second = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    expect((first.data as { results: { outcome: string }[] }).results).toEqual([
      { approvalId, outcome: 'approve' },
    ]);
    expect((second.data as { results: { outcome: string }[] }).results).toEqual([
      { approvalId, outcome: 'approve' },
    ]);
    expect(reg.getDecision(approvalId)).toMatchObject({ approved: true });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('releases a failed generic resume claim so a later identical decision can retry', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c-retry',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resume = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient resume failure'))
      .mockResolvedValueOnce({ conversationId: 'c-retry', status: 'success' as const });
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });

    await expect(
      approvalResponseTool.execute({ decisions: [{ approvalId, decision: 'approve' }] }, context),
    ).rejects.toThrow('transient resume failure');
    await expect(
      approvalResponseTool.execute({ decisions: [{ approvalId, decision: 'approve' }] }, context),
    ).resolves.toMatchObject({ status: 'success' });

    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('resumes different requesters in one conversation independently while coalescing same-requester approvals', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId: first } = await reg.create({
      conversationId: 'c-shared',
      requesterId: 'agent-a',
      tool: 'file_write',
      args: {},
    });
    const { approvalId: second } = await reg.create({
      conversationId: 'c-shared',
      requesterId: 'agent-a',
      tool: 'file_delete',
      args: {},
    });
    const { approvalId: third } = await reg.create({
      conversationId: 'c-shared',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resume = vi.fn(async (conversationId: string, requesterId: string) => ({
      conversationId,
      status: 'success' as const,
      response: requesterId,
    }));
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });

    await approvalResponseTool.execute(
      {
        decisions: [
          { approvalId: first, decision: 'approve' },
          { approvalId: second, decision: 'approve' },
          { approvalId: third, decision: 'approve' },
        ],
      },
      context,
    );

    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledWith('c-shared', 'agent-a', context);
    expect(resume).toHaveBeenCalledWith('c-shared', 'agent-b', context);
  });

  it('releases a generic resume lease when router returns an error result', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c-error-result',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const resume = vi
      .fn()
      .mockResolvedValueOnce({ conversationId: 'c-error-result', status: 'error' as const })
      .mockResolvedValueOnce({ conversationId: 'c-error-result', status: 'success' as const });
    const context = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });

    await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );
    await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      context,
    );

    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('defers generic approval without a router and resumes when one later becomes available', async () => {
    const reg = new PendingApprovalRegistry();
    const { approvalId } = await reg.create({
      conversationId: 'c-deferred',
      requesterId: 'agent-b',
      tool: 'file_write',
      args: {},
    });
    const withoutRouter = makeContext({ pendingApprovalRegistry: reg, messageRouter: undefined });

    const deferred = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      withoutRouter,
    );

    expect((deferred.data as { results: { outcome: string }[] }).results).toEqual([
      { approvalId, outcome: 'resume_deferred' },
    ]);
    const resume = vi.fn(async () => ({
      conversationId: 'c-deferred',
      status: 'success' as const,
    }));
    const withRouter = makeContext({
      pendingApprovalRegistry: reg,
      messageRouter: { send: vi.fn(), resume } as unknown as ToolContext['messageRouter'],
    });
    await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      withRouter,
    );

    expect(reg.getDecision(approvalId)).toMatchObject({ approved: true });
    expect(resume).toHaveBeenCalledOnce();
  });
});
