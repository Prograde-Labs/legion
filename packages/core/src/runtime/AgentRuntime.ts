import type { AgentConfig, MessageData, ToolCallData, ToolCallResult } from '@legion/types';
import type { Runtime, RuntimeContext } from './Runtime.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { ProviderMessage, ProviderTool } from '../providers/Provider.js';

const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Build the provider message list from the conversation chain + system prompt.
 * Tool-call turns (messages with toolCalls) are expanded into an assistant message
 * followed by one tool-result message per call, matching the OpenAI message format.
 */
function buildProviderMessages(chain: MessageData[], systemPrompt: string): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of chain) {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      // Expand the tool-call turn into assistant message + tool result messages.
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
    private providerRegistry: ProviderRegistry,
  ) {}

  async handle(_incoming: MessageData, context: RuntimeContext): Promise<string | void> {
    const participant = context.collective.getOrThrow(this.participantId);
    if (participant.type !== 'agent') return;
    const agent = participant as AgentConfig;

    const provider = this.providerRegistry.get(agent.model.provider);
    if (!provider) {
      return `[AgentRuntime error: no provider registered for '${agent.model.provider}']`;
    }

    const maxIterations = agent.runtimeConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Build initial message list from the full conversation chain (includes the inbound
    // message that MessageRouter appended before calling handle()).
    const messages: ProviderMessage[] = buildProviderMessages(
      context.conversation.activeChain,
      agent.systemPrompt,
    );

    // Build the tool list: only 'auto'-policy tools are presented to the LLM in this
    // plan. 'requires_approval' tools will be added in Plan 7 (approval bubbling).
    const providerTools: ProviderTool[] = context.toolRegistry
      .list()
      .filter((tool) => agent.tools[tool.name] === 'auto')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    for (let i = 0; i < maxIterations; i++) {
      context.eventBus.emit('iteration', {
        conversationId: context.conversationId,
        participantId: this.participantId,
        iteration: i,
      });

      const response = await provider.complete(messages, providerTools, agent.model);

      // Text response (or no tool calls): return it; MessageRouter persists it.
      if (response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
        return response.content ?? '';
      }

      // Execute tool calls and collect results.
      const toolCallData: ToolCallData[] = response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));

      const toolResults: ToolCallResult[] = [];
      for (const tc of response.toolCalls) {
        context.eventBus.emit('tool:call', {
          conversationId: context.conversationId,
          participantId: this.participantId,
          tool: tc.name,
          callId: tc.id,
        });
        const result = await context.toolRegistry.execute(tc.name, tc.arguments, context);
        context.eventBus.emit('tool:result', {
          conversationId: context.conversationId,
          participantId: this.participantId,
          tool: tc.name,
          callId: tc.id,
          status: result.status,
        });
        toolResults.push({ id: tc.id, name: tc.name, result });
      }

      // Persist the tool-call turn to the conversation for audit + context replay.
      await context.conversation.append({
        senderId: this.participantId,
        recipientId: this.participantId,
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: toolCallData,
        toolResults,
      });

      // Advance the local message history so the next iteration has full context.
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

    return `[Agent reached maximum iteration limit of ${maxIterations}]`;
  }
}
