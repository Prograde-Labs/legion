import type {
  AgentConfig,
  LLMChunk,
  MessageData,
  MessageUsage,
  MiddlewareActionResult,
  ToolCallData,
  ToolCallResult,
} from '@legion/types';
import type { AgentProviderResume, Runtime, RuntimeContext, RuntimeResult } from './Runtime.js';
import type { ModelRouter } from '../providers/ModelRouter.js';
import type {
  Provider,
  ProviderMessage,
  ProviderStopReason,
  ProviderStreamChunk,
  ProviderTool,
  ProviderUsage,
} from '../providers/Provider.js';
import type { UsageCalculator } from '../providers/UsageCalculator.js';
import type { PendingApproval } from '../auth/PendingApprovalRegistry.js';
import type { ConversationThread } from '../conversation/ConversationThread.js';
import { snapshotMiddlewareActions } from '../auth/PendingApprovalRegistry.js';

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Build the provider message list from the conversation chain + system prompt.
 * Tool-call turns are expanded into an assistant message followed by one
 * tool-result message per call, matching the OpenAI Chat Completions format.
 */
function buildProviderMessages(chain: MessageData[], systemPrompt: string): ProviderMessage[] {
  // Extract summary nodes and fold them into the system prompt as context.
  //
  // Summaries placed anywhere in the chain as 'assistant' role can break
  // providers that require strict user/assistant alternation (e.g. the first
  // non-system message must be 'user'). Injecting summaries into the system
  // message sidesteps all role-ordering issues regardless of where in the
  // chain the summary sits.
  const summaries = chain.filter((m) => m.type === 'summary');
  const regularChain = chain.filter((m) => m.type !== 'summary');

  let effectiveSystemPrompt = systemPrompt;
  if (summaries.length > 0) {
    const ctx = summaries.map((s) => s.content).join('\n\n---\n\n');
    effectiveSystemPrompt =
      `${systemPrompt}\n\n` +
      `<previous_conversation_summary>\n${ctx}\n</previous_conversation_summary>`;
  }

  const messages: ProviderMessage[] = [{ role: 'system', content: effectiveSystemPrompt }];

  for (const msg of regularChain) {
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

interface TurnAccumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, { id: string; name: string; argsBuffer: string }>;
  stopReason?: ProviderStopReason;
  usage?: ProviderUsage;
  cost?: number;
}

function freshAccumulator(): TurnAccumulator {
  return { content: '', reasoning: '', toolCalls: new Map() };
}

function accumulateChunk(acc: TurnAccumulator, chunk: ProviderStreamChunk): void {
  if (chunk.type === 'text_delta') {
    acc.content += chunk.delta;
  } else if (chunk.type === 'reasoning_delta') {
    acc.reasoning += chunk.delta;
  } else if (chunk.type === 'tool_call_start') {
    acc.toolCalls.set(chunk.index, { id: chunk.id, name: chunk.name, argsBuffer: '' });
  } else if (chunk.type === 'tool_call_args_delta') {
    const tc = acc.toolCalls.get(chunk.index);
    if (tc) tc.argsBuffer += chunk.delta;
  } else if (chunk.type === 'done') {
    acc.stopReason = chunk.stopReason;
    acc.usage = chunk.usage;
    acc.cost = chunk.cost;
  }
}

function accumulatorToResponse(acc: TurnAccumulator): {
  content: string | null;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: ProviderStopReason;
  usage?: ProviderUsage;
  cost?: number;
} {
  const toolCalls = [...acc.toolCalls.values()].map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: (() => {
      try {
        return JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })(),
  }));
  return {
    content: acc.content || null,
    reasoning: acc.reasoning,
    toolCalls,
    stopReason: acc.stopReason ?? 'stop',
    usage: acc.usage,
    cost: acc.cost,
  };
}

export class AgentRuntime implements Runtime {
  constructor(
    private participantId: string,
    private router: ModelRouter,
    private usageCalculator?: UsageCalculator,
  ) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<RuntimeResult> {
    const gen = this.runLoop(_incoming, context);
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  async resumeFromMiddleware(
    resume: AgentProviderResume,
    context: RuntimeContext,
  ): Promise<RuntimeResult> {
    try {
      await context.conversation.reload();
      if (
        resume.kind !== 'agent_provider' ||
        resume.participantId !== this.participantId ||
        context.participant.id !== this.participantId ||
        !Number.isInteger(resume.iteration) ||
        resume.iteration < 0 ||
        typeof resume.preparedPrompt !== 'string' ||
        !Number.isInteger(resume.actionCursor) ||
        resume.actionCursor < 0 ||
        !Array.isArray(resume.actions) ||
        resume.actionCursor > resume.actions.length
      ) {
        return { kind: 'middleware_abort', error: 'Invalid middleware provider resume' };
      }
      const incoming = context.conversation.data.messages[resume.incomingMessageId];
      if (!incoming || incoming.recipientId !== this.participantId) {
        return { kind: 'middleware_abort', error: 'Invalid middleware provider resume' };
      }
      const actions = snapshotMiddlewareActions(resume.actions, '$.runtimeResume.actions').slice(
        0,
        resume.actionCursor,
      );
      const gen = this.runLoop(incoming, context, {
        iteration: resume.iteration,
        preparedPrompt: resume.preparedPrompt,
        actions,
      });
      let next = await gen.next();
      while (!next.done) next = await gen.next();
      return next.value;
    } catch {
      return { kind: 'middleware_abort', error: 'Invalid middleware provider resume' };
    }
  }

  async *handleStream(
    _incoming: MessageData,
    context: RuntimeContext,
  ): AsyncGenerator<LLMChunk, RuntimeResult> {
    return yield* this.runLoop(_incoming, context);
  }

  private async *runLoop(
    _incoming: MessageData,
    context: RuntimeContext,
    start: {
      iteration?: number;
      preparedPrompt?: string;
      actions?: MiddlewareActionResult[];
    } = {},
  ): AsyncGenerator<LLMChunk, RuntimeResult> {
    let actions: MiddlewareActionResult[];
    try {
      actions = snapshotMiddlewareActions(
        start.actions === undefined ? (context.middlewareActions ?? []) : start.actions,
      );
    } catch {
      return { kind: 'middleware_abort', error: 'Invalid middleware action ledger' };
    }
    const participant = context.collective.getOrThrow(this.participantId);
    if (participant.type !== 'agent') return { kind: 'void' };
    const agent = participant as AgentConfig;

    let provider: Provider | null;
    let providerId: string | undefined;
    try {
      const resolved = await this.router.resolveWithId(agent.model.model);
      provider = resolved?.provider ?? null;
      providerId = resolved?.providerId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.withActions(
        {
          kind: 'response',
          content: `[AgentRuntime error: ${msg}]`,
        },
        actions,
      );
    }
    if (!provider) {
      return this.withActions(
        {
          kind: 'response',
          content: `[AgentRuntime error: no provider available for model '${agent.model.model}']`,
        },
        actions,
      );
    }

    // -------------------------------------------------------------------------
    // Resumption check: if the active chain's last assistant message has
    // pending_approval tool results, this is a re-trigger from approval_response.
    // Process resolved decisions; return pending_approval if any remain outstanding.
    // -------------------------------------------------------------------------
    await context.conversation.reload();
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
        return this.withActions(
          { kind: 'pending_approval', approvalRequests: stillPending },
          actions,
        );
      }
      // All resolved — fall through; buildProviderMessages will read the updated chain.
    }

    // -------------------------------------------------------------------------
    // LLM agentic loop
    // -------------------------------------------------------------------------
    const maxIterations = (agent.runtimeConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS) as number;

    // Present only tools in the participant's tools map to the LLM. Auth check runs at execution time.
    const providerTools: ProviderTool[] = context.toolRegistry
      .list()
      .filter((tool) => agent.tools[tool.name] !== undefined)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    const unpersistedApprovalIds = new Set<string>();
    const cancellationResult = async (): Promise<RuntimeResult> => {
      try {
        if (unpersistedApprovalIds.size > 0) {
          await context.pendingApprovalRegistry.discardUnpersisted([...unpersistedApprovalIds]);
        }
        unpersistedApprovalIds.clear();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.withActions(
          { kind: 'middleware_abort', error: `Runtime cancellation cleanup failed: ${message}` },
          actions,
        );
      }
      return this.withActions({ kind: 'middleware_abort', error: 'Runtime cancelled' }, actions);
    };

    try {
      const firstIteration = start.iteration ?? 0;
      for (let i = firstIteration; i < maxIterations; i++) {
        if (context.signal?.aborted) {
          return await cancellationResult();
        }
        await context.conversation.reload();
        let prompt = agent.systemPrompt;
        if (i === firstIteration && start.preparedPrompt !== undefined) {
          prompt = start.preparedPrompt;
        } else if (context.buildSystemPrompt) {
          const promptResult = await context.buildSystemPrompt({
            basePrompt: agent.systemPrompt,
            iteration: i,
            incomingMessageId: _incoming.id,
            actions,
          });
          if (promptResult.kind === 'pending') {
            return this.withActions(
              {
                kind: 'middleware_pending',
                approvalId: promptResult.approvalId,
                checkpointId: promptResult.checkpointId,
              },
              actions,
            );
          }
          if (promptResult.kind === 'abort') {
            return this.withActions(
              { kind: 'middleware_abort', error: 'Middleware prompt aborted' },
              actions,
            );
          }
          prompt = promptResult.prompt;
          actions = snapshotMiddlewareActions(promptResult.actions, '$.buildSystemPrompt.actions');
        }

        const messages = buildProviderMessages(context.conversation.activeChain, prompt);
        context.eventBus.emit('iteration', {
          conversationId: context.conversationId,
          participantId: this.participantId,
          iteration: i,
        });

        yield { type: 'iteration_start', iteration: i };
        if (context.signal?.aborted) {
          return await cancellationResult();
        }
        const acc = freshAccumulator();
        for await (const chunk of provider.stream(messages, providerTools, agent.model, {
          signal: context.signal,
        })) {
          if (context.signal?.aborted) {
            return await cancellationResult();
          }
          accumulateChunk(acc, chunk);
          if (chunk.type !== 'done') {
            yield chunk;
          }
        }
        if (context.signal?.aborted) {
          return await cancellationResult();
        }
        const response = accumulatorToResponse(acc);

        if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
          const usage = await this.computeUsage(providerId, agent, response);
          return this.withActions(
            {
              kind: 'response',
              content: response.content ?? '',
              ...(response.reasoning ? { reasoning: response.reasoning } : {}),
              ...(usage ? { usage } : {}),
            },
            actions,
          );
        }

        const toolCallData: ToolCallData[] = response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        }));

        const toolResults: ToolCallResult[] = [];
        const pendingApprovals: PendingApproval[] = [];
        const approvalEvents: Array<{ approvalId: string; callId: string; tool: string }> = [];

        for (const tc of response.toolCalls) {
          if (context.signal?.aborted) {
            return await cancellationResult();
          }
          const authResult = context.authEngine.authorize(
            this.participantId,
            tc.name,
            tc.arguments,
            agent.tools,
          );

          if (authResult.reason === 'hidden') {
            // Unreachable in normal operation — filter above excludes absent tools.
            // Defensive guard for direct authorize() calls that bypass the filter.
            toolResults.push({
              id: tc.id,
              name: tc.name,
              result: { status: 'error', error: `Tool '${tc.name}' not available` },
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
            unpersistedApprovalIds.add(approvalId);
            if (context.signal?.aborted) return await cancellationResult();
            const pending = context.pendingApprovalRegistry.get(approvalId)!;
            pendingApprovals.push(pending);
            approvalEvents.push({ approvalId, callId: tc.id, tool: tc.name });
            toolResults.push({
              id: tc.id,
              name: tc.name,
              result: { status: 'pending_approval', approvalId },
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

        const usage = await this.computeUsage(providerId, agent, response);
        if (context.signal?.aborted) {
          return await cancellationResult();
        }
        // Persist the tool-call turn to the conversation.
        await context.conversation.append({
          senderId: this.participantId,
          recipientId: this.participantId,
          role: 'assistant',
          content: response.content ?? '',
          reasoning: response.reasoning || undefined,
          toolCalls: toolCallData,
          toolResults,
          usage,
        });
        unpersistedApprovalIds.clear();
        for (const event of approvalEvents) {
          // Approval-required tools bypass ToolRegistry, so publish after their turn is durable.
          context.eventBus.emit('tool:call', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: event.tool,
            callId: event.callId,
          });
          context.eventBus.emit('tool:result', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: event.tool,
            callId: event.callId,
            status: 'pending_approval',
          });
          context.eventBus.emit('approval:requested', {
            conversationId: context.conversationId,
            participantId: this.participantId,
            tool: event.tool,
            approvalId: event.approvalId,
          });
        }

        // If any approvals are pending, return early.
        if (pendingApprovals.length > 0) {
          return this.withActions(
            { kind: 'pending_approval', approvalRequests: pendingApprovals },
            actions,
          );
        }
      }

      return this.withActions(
        {
          kind: 'response',
          content: `[Agent reached maximum iteration limit of ${maxIterations}]`,
        },
        actions,
      );
    } catch (err) {
      if (context.signal?.aborted) {
        return await cancellationResult();
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.withActions(
        {
          kind: 'response',
          content: `[AgentRuntime error: ${msg}]`,
        },
        actions,
      );
    }
  }

  private withActions(result: RuntimeResult, actions: MiddlewareActionResult[]): RuntimeResult {
    return actions.length === 0
      ? result
      : { ...result, actions: snapshotMiddlewareActions(actions, '$.runtimeActions') };
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
      if (context.signal?.aborted) return stillPending;
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

    if (context.signal?.aborted) return stillPending;

    // All resolved — update the conversation message in place.
    await (context.conversation as ConversationThread).updateToolResults(
      lastMsg.id,
      updatedResults,
    );
    return null;
  }

  private async computeUsage(
    providerId: string | undefined,
    agent: AgentConfig,
    response: {
      content: string | null;
      stopReason: ProviderStopReason;
      usage?: ProviderUsage;
      cost?: number;
    },
  ): Promise<MessageUsage | undefined> {
    if (!response.usage || !this.usageCalculator) return undefined;
    return this.usageCalculator.compute(
      providerId ?? 'unknown',
      agent.model.model,
      response.usage,
      response.cost,
    );
  }
}
