import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { AgentRuntime } from './AgentRuntime.js';
import type { Provider, ProviderResponse } from '../providers/Provider.js';
import type { RuntimeContext } from './Runtime.js';
import type { AgentConfig } from '@legion/types';

// ── Test helper ──────────────────────────────────────────────────────────────

async function makeSetup(providerResponses: ProviderResponse[]) {
  const storage = new MemoryStorage();
  const conversationStore = new FileConversationStore(storage);

  const agentConfig: AgentConfig = {
    id: 'agent-1',
    name: 'Test Agent',
    type: 'agent',
    systemPrompt: 'You are a helpful assistant.',
    model: { provider: 'test', model: 'test-model' },
    tools: { echo: 'auto' },
    status: 'active',
  };
  await storage.writeJson('collective/participants/agent-1.json', agentConfig);
  const collective = await Collective.load(storage);

  const conv = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  const thread = new ConversationThread(conv, conversationStore);
  // Simulate what MessageRouter does: append the inbound message before calling handle().
  const inbound = await thread.append({
    senderId: 'user-1',
    recipientId: 'agent-1',
    role: 'user',
    content: 'Hello, agent!',
  });

  const eventBus = new EventBus();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: 'echo',
    description: 'Echoes the input text',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(args) {
      const { text } = args as { text: string };
      return { status: 'success', data: text };
    },
  });

  let responseIndex = 0;
  const mockProvider: Provider = {
    async complete() {
      const resp = providerResponses[responseIndex++];
      return resp ?? { content: '[no more responses]', toolCalls: [], stopReason: 'stop' };
    },
  };
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register('test', mockProvider);

  const context = {
    participant: collective.getOrThrow('agent-1'),
    conversationId: conv.id,
    conversation: thread,
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: '/tmp/test',
    communicationDepth: 0,
    toolRegistry,
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
  } as unknown as RuntimeContext;

  return { context, thread, eventBus, inbound, providerRegistry };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime', () => {
  it('returns the provider text response when no tools are called', async () => {
    const { context, inbound, providerRegistry } = await makeSetup([
      { content: 'I am happy to help!', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', providerRegistry);
    const result = await runtime.handle(inbound, context);
    expect(result).toBe('I am happy to help!');
    // No extra messages persisted — only the inbound message
    expect(context.conversation.activeChain).toHaveLength(1);
  });

  it('executes a tool call turn, persists it, and returns the follow-up text', async () => {
    const { context, inbound, providerRegistry } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello world' } }],
        stopReason: 'tool_calls',
      },
      { content: 'Done echoing!', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', providerRegistry);
    const result = await runtime.handle(inbound, context);

    expect(result).toBe('Done echoing!');

    // Tool-call turn persisted as a second message in the conversation
    const chain = context.conversation.activeChain;
    expect(chain).toHaveLength(2); // inbound + tool-call turn
    const toolTurn = chain[1];
    expect(toolTurn.toolCalls).toHaveLength(1);
    expect(toolTurn.toolCalls![0].name).toBe('echo');
    expect(toolTurn.toolResults).toHaveLength(1);
    expect(toolTurn.toolResults![0].result.status).toBe('success');
    expect(toolTurn.toolResults![0].result.data).toBe('hello world');
  });

  it('emits iteration, tool:call, and tool:result events in the correct order', async () => {
    const { context, inbound, providerRegistry, eventBus } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'x' } }],
        stopReason: 'tool_calls',
      },
      { content: 'Finished.', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', providerRegistry);
    const events: string[] = [];
    eventBus.on('iteration', () => events.push('iteration'));
    eventBus.on('tool:call', () => events.push('tool:call'));
    eventBus.on('tool:result', () => events.push('tool:result'));

    await runtime.handle(inbound, context);

    // iteration 0 fires before provider call; tool:call + tool:result for the one tool;
    // iteration 1 fires before the second provider call which returns text.
    expect(events).toEqual(['iteration', 'tool:call', 'tool:result', 'iteration']);
  });

  it('stops at maxIterations and returns a limit message', async () => {
    const storage = new MemoryStorage();
    const conversationStore = new FileConversationStore(storage);
    // Agent with maxIterations: 2
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1',
      name: 'Limited',
      type: 'agent',
      systemPrompt: 'You are helpful.',
      model: { provider: 'test', model: 'm' },
      tools: { echo: 'auto' },
      runtimeConfig: { maxIterations: 2, communicationDepthLimit: 10 },
      status: 'active',
    } as AgentConfig);
    const collective = await Collective.load(storage);
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    const thread = new ConversationThread(conv, conversationStore);
    const inbound = await thread.append({
      senderId: 'u',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
      async execute(args) {
        return { status: 'success', data: (args as { text: string }).text };
      },
    });
    let tcId = 0;
    const loopingProvider: Provider = {
      async complete() {
        return {
          content: null,
          toolCalls: [{ id: `tc-${tcId++}`, name: 'echo', arguments: { text: 'hi' } }],
          stopReason: 'tool_calls',
        };
      },
    };
    const reg = new ProviderRegistry();
    reg.register('test', loopingProvider);
    const context = {
      participant: collective.getOrThrow('agent-1'),
      conversationId: conv.id,
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus: new EventBus(),
      storage,
      workspaceRoot: '/tmp',
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as RuntimeContext;

    const runtime = new AgentRuntime('agent-1', reg);
    const result = await runtime.handle(inbound, context);
    expect(result).toMatch(/maximum iteration limit/i);
    expect(result).toContain('2');
  });

  it('returns an error message when no provider is registered for the agent model', async () => {
    const emptyReg = new ProviderRegistry();
    const { context, inbound } = await makeSetup([]);
    const runtime = new AgentRuntime('agent-1', emptyReg);
    const result = await runtime.handle(inbound, context);
    expect(result).toMatch(/no provider/i);
    expect(result).toMatch(/test/); // provider name from model config
  });
});
