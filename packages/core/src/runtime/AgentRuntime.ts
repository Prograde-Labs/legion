import type { AgentConfig, MessageData, ToolCallData, ToolCallResult } from '@legion/types';
import type { Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';
import type { ProviderStore } from '../providers/ProviderStore.js';
import type { ProviderMessage, ProviderTool } from '../providers/Provider.js';
import type { PendingApproval } from '../auth/PendingApprovalRegistry.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Build the provider message list from the conversation chain + system prompt.
 * Tool-call turns are expanded into an assistant message followed by one
 * tool-result message per call, matching the OpenAI Chat Completions format.
 */
function buildProviderMessages(chain: MessageData[], systemPrompt: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of chain) {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        toolCalls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      });
      for (const tr of msg.toolResults ?? []) {
        messages.push({
          role: 'tool',
          content: JSON.stringify(tr.result),
          toolCallId: tr.id,
          name: tr.name,
        });
      }
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  return messages;
}

export class AgentRuntime implements Runtime {
  constructor(
    private participantId: string,
    private providerStore: ProviderStore,
  ) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const participant = context.collective.getOrThrow(this.participantId);
    if (participant.type !== 'agent') return { kind: 'void' };
    const agent = participant as AgentConfig;

    const provider = await this.providerStore.get(agent.model.provider);
    if (!provider) {
      return {
        kind: 'response',
        content: `[AgentRuntime error: no provider registered for '${agent.model.provider}']`,
      };
    }

    // -------------------------------------------------------------------------
    // Resumption check: if the active chain's last assistant message has
    // pending_approval tool results, this is a re-trigger from approval_response.
    // Process resolved decisions; return pending_approval if any remain outstanding.
    // -------------------------------------------------------------------------
    const chain = context.conversation.activeChain;
    const lastAssistantMsg = [...chain]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' &&
          m.toolResults?.some((tr) => tr.result.status === 'pending_approval'),
      );

    if (lastAssistantMsg) {
      const stillPending = await this.processResumedApprovals(lastAssistantMsg, context);
      if (stillPending !== null) {
        return { kind: 'pending_approval', approvalRequests: stillPending };
      }
      // All resolved — fall through; buildProviderMessages will read the updated chain.
    }

    // -------------------------------------------------------------------------
    // LLM agentic loop
    // -------------------------------------------------------------------------
    const maxIterations = (agent.runtimeConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS) as number;

    const messages: ProviderMessage[] = buildProviderMessages(
      context.conversation.activeChain,
      agent.systemPrompt,
    );

    // Present all non-deny tools to the LLM. Auth check runs at execution time.
    const providerTools: ProviderTool[] = context.toolRegistry
      .list()
      .filter((tool) => (agent.tools[tool.name] ?? 'requires_approval') !== 'deny')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    try {
      for (let i = 0; i < maxIterations; i++) {
        context.eventBus.emit('iteration', {
          conversationId: context.conversationId,
          participantId: this.participantId,
          iteration: i,
        });

        const response = await provider.complete(messages, providerTools, agent.model);

        if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
          return { kind: 'response', content: response.content ?? '' };
        }

        const toolCallData: ToolCallData[] = response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        }));

        const toolResults: ToolCallResult[] = [];
        const pendingApprovals: PendingApproval[] = [];

        for (const tc of response.toolCalls) {
          const authResult = context.authEngine.authorize(
            this.participantId,
            tc.name,
            tc.arguments,
            agent.tools,
          );

          if (authResult.reason === 'deny') {
            // Denied tools bypass ToolRegistry — emit events here
            context.eventBus.emit('tool:call', {
              conversationId: context.conversationId,
              participantId: this.participantId,
              tool: tc.name,
              callId: tc.id,
            });
            toolResults.push({
              id: tc.id,
              name: tc.name,
              result: { status: 'error', error: `Tool '${tc.name}' is denied for this agent` },
            });
            context.eventBus.emit('tool:result', {
              conversationId: context.conversationId,
              participantId: this.participantId,
              tool: tc.name,
              callId: tc.id,
              status: 'error',
            });
            continue;
          }

          if (authResult.reason === 'requires_approval') {
            const { approvalId } = await context.pendingApprovalRegistry.create({
              conversationId: context.conversationId,
              requesterId: this.participantId,
              tool: tc.name,
              args: tc.arguments,
            });
            const pending = context.pendingApprovalRegistry.get(approvalId)!;
            pendingApprovals.push(pending);
            toolResults.push({
              id: tc.id,
              name: tc.name,
              result: { status: 'pending_approval', approvalId },
            });
            // Approval-required tools bypass ToolRegistry — emit events here
            context.eventBus.emit('tool:call', {
              conversationId: context.conversationId,
              participantId: this.participantId,
              tool: tc.name,
              callId: tc.id,
            });
            context.eventBus.emit('tool:result', {
              conversationId: context.conversationId,
              participantId: this.participantId,
              tool: tc.name,
              callId: tc.id,
              status: 'pending_approval',
            });
            context.eventBus.emit('approval:requested', {
              conversationId: context.conversationId,
              participantId: this.participantId,
              tool: tc.name,
              approvalId,
            });
            continue;
          }

          // 'auto': execute immediately — ToolRegistry emits tool:call/tool:result
          const result = await context.toolRegistry.execute(tc.name, tc.arguments, {
            ...context,
            toolCallId: tc.id,
          });
          toolResults.push({ id: tc.id, name: tc.name, result });
        }

        // Persist the tool-call turn to the conversation.
        await context.conversation.append({
          senderId: this.participantId,
          recipientId: this.participantId,
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: toolCallData,
          toolResults,
        });

        // If any approvals are pending, return early.
        if (pendingApprovals.length > 0) {
          return { kind: 'pending_approval', approvalRequests: pendingApprovals };
        }

        // All tools executed — advance the local message history.
        messages.push({
          role: 'assistant',
          content: response.content ?? null,
          toolCalls: response.toolCalls,
        });
        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            content: JSON.stringify(tr.result),
            toolCallId: tr.id,
            name: tr.name,
          });
        }
      }

      return {
        kind: 'response',
        content: `[Agent reached maximum iteration limit of ${maxIterations}]`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'response',
        content: `[AgentRuntime error: ${msg}]`,
      };
    }
  }

  /**
   * Process resolved approval decisions for a message that previously had
   * pending_approval tool results.
   *
   * Returns `null` when all pending approvals are resolved (caller should continue
   * the loop). Returns the array of still-pending approvals if any remain outstanding.
   */
  private async processResumedApprovals(
    lastMsg: MessageData,
    context: RuntimeContext,
  ): Promise<PendingApproval[] | null> {
    const updatedResults: ToolCallResult[] = [...(lastMsg.toolResults ?? [])];
    const stillPending: PendingApproval[] = [];

    for (let i = 0; i < updatedResults.length; i++) {
      const tr = updatedResults[i];
      if (tr.result.status !== 'pending_approval') continue;

      const { approvalId } = tr.result;
      if (!approvalId) continue;

      const decision = context.pendingApprovalRegistry.getDecision(approvalId);

      if (!decision) {
        const pending = context.pendingApprovalRegistry.get(approvalId);
        if (pending) stillPending.push(pending);
        continue;
      }

      if (!decision.approved) {
        updatedResults[i] = {
          ...tr,
          result: {
            status: 'rejected',
            message: decision.message ?? 'Request rejected',
          },
        };
        context.eventBus.emit('approval:resolved', {
          conversationId: context.conversationId,
          approvalId,
          approved: false,
          decidedByParticipantId: decision.decidedByParticipantId,
        });
        continue;
      }

      // Approved: execute the tool now.
      const toolCall = lastMsg.toolCalls?.find((tc) => tc.id === tr.id);
      if (!toolCall) {
        updatedResults[i] = {
          ...tr,
          result: { status: 'error', error: 'Tool call data missing from conversation' },
        };
        continue;
      }

      context.eventBus.emit('tool:call', {
        conversationId: context.conversationId,
        participantId: this.participantId,
        tool: tr.name,
        callId: tr.id,
      });
      const result = await context.toolRegistry.execute(tr.name, toolCall.arguments, {
        ...context,
        toolCallId: tr.id,
      });
      updatedResults[i] = { ...tr, result };
      context.eventBus.emit('approval:resolved', {
        conversationId: context.conversationId,
        approvalId,
        approved: true,
        decidedByParticipantId: decision.decidedByParticipantId,
      });
    }

    if (stillPending.length > 0) {
      return stillPending;
    }

    // All resolved — update the conversation message in place.
    await (context.conversation as ConversationThread).updateToolResults(
      lastMsg.id,
      updatedResults,
    );
    return null;
  }
}
