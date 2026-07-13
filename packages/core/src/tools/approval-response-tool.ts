import type { JSONSchema, ToolResult } from '@legion/types';
import type { Tool, ToolContext } from './Tool.js';
import type { PendingApprovalRegistry, ApprovalDecision } from '../auth/PendingApprovalRegistry.js';
import type { AuthEngine } from '../auth/AuthEngine.js';
import type { ApprovalLog } from '../auth/ApprovalLog.js';

interface ApprovalDecisionInput {
  approvalId: string;
  decision: 'approve' | 'reject';
  message?: string;
}

export const approvalResponseTool: Tool = {
  name: 'approval_response',
  description:
    'Respond to one or more pending tool-approval requests. ' +
    'Provide a decision (approve or reject) for each, with an optional explanatory message. ' +
    'Requires authority to approve on behalf of the requesting participant.',
  parameters: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        description: 'List of approval decisions to record.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            approvalId: { type: 'string', description: 'ID from the pending_approval tool result' },
            decision: { type: 'string', enum: ['approve', 'reject'] },
            message: {
              type: 'string',
              description: 'Optional explanation, especially useful for rejections',
            },
          },
          required: ['approvalId', 'decision'],
        },
      },
    },
    required: ['decisions'],
  } as JSONSchema,

  async execute(args, context: ToolContext): Promise<ToolResult> {
    const { decisions } = args as { decisions: ApprovalDecisionInput[] };

    const authEngine = context.authEngine as AuthEngine | undefined;
    const pendingRegistry = context.pendingApprovalRegistry as PendingApprovalRegistry | undefined;
    const approvalLog = context.approvalLog as ApprovalLog | undefined;

    if (!authEngine || !pendingRegistry) {
      return {
        status: 'error',
        error: 'approval_response requires authEngine and pendingApprovalRegistry in context',
      };
    }

    const results: Array<{ approvalId: string; outcome: string }> = [];
    const toResume = new Map<string, string>(); // conversationId → requesterId
    const seen = new Set<string>();

    for (const { approvalId, decision, message } of decisions) {
      if (seen.has(approvalId)) {
        results.push({ approvalId, outcome: 'duplicate' });
        continue;
      }
      seen.add(approvalId);
      let record = pendingRegistry.getRecord(approvalId);
      if (!record) {
        results.push({ approvalId, outcome: 'not_found' });
        continue;
      }
      if (record.lifecycle === 'acknowledged') {
        results.push({ approvalId, outcome: 'already_acknowledged' });
        continue;
      }

      const canApprove = authEngine.hasAuthority(
        context.participant.approvalAuthority,
        record.requesterId,
        record.tool,
        record.args,
      );
      if (!canApprove) {
        results.push({ approvalId, outcome: 'unauthorized' });
        continue;
      }

      const approvalDecision: ApprovalDecision = {
        approved: decision === 'approve',
        decidedByParticipantId: context.participant.id,
        message,
        decidedAt: new Date().toISOString(),
      };

      if (record.decision === undefined) {
        await pendingRegistry.resolve(approvalId, approvalDecision);
        approvalLog?.record({
          requestId: approvalId,
          conversationId: record.conversationId,
          requesterId: record.requesterId,
          tool: record.tool,
          args: record.args,
          approved: approvalDecision.approved,
          decidedByParticipantId: context.participant.id,
          decidedAt: approvalDecision.decidedAt,
        });
        context.eventBus.emit('approval:resolved', {
          conversationId: record.conversationId,
          approvalId,
          approved: approvalDecision.approved,
          decidedByParticipantId: context.participant.id,
        });
        record = pendingRegistry.getRecord(approvalId)!;
      }

      if (record.continuation?.kind === 'middleware') {
        if (!context.messageRouter) {
          results.push({ approvalId, outcome: 'resume_pending' });
          continue;
        }
        try {
          await context.messageRouter.resumeApproval(approvalId, context);
        } catch {
          // Durable continuation stays retryable; approval response stays idempotent.
        }
        results.push({
          approvalId,
          outcome:
            pendingRegistry.getRecord(approvalId)?.lifecycle === 'acknowledged'
              ? 'acknowledged'
              : 'resume_pending',
        });
        continue;
      }

      results.push({ approvalId, outcome: decision });
      toResume.set(record.conversationId, record.requesterId);
    }

    if (context.messageRouter) {
      for (const [conversationId, requesterId] of toResume) {
        await context.messageRouter.resume(conversationId, requesterId, context);
      }
    }

    return { status: 'success', data: { results } };
  },
};
