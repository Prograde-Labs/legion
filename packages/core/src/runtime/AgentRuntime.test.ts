import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileStorage } from '../storage/FileStorage.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { AgentRuntime } from './AgentRuntime.js';
import { UsageCalculator } from '../providers/UsageCalculator.js';
import type {
  Provider,
  ProviderMessage,
  ProviderStopReason,
  ProviderUsage,
} from '../providers/Provider.js';
import type { LLMChunk } from '@legion/types';
import type { ModelPricing, PricingSource } from '../providers/PricingSource.js';
import type { ModelRouter } from '../providers/ModelRouter.js';
import type { RuntimeContext, RuntimeResult } from './Runtime.js';
import type {
  AgentConfig,
  JSONSchema,
  Tool,
  MessageData,
  MiddlewareActionResult,
} from '@legion/types';
import type { PendingApproval } from '../auth/PendingApprovalRegistry.js';
import type { MessageRouterPort } from '../tools/Tool.js';

// ── Test helper ──────────────────────────────────────────────────────────────

class MockPricingSource implements PricingSource {
  constructor(private pricing: Record<string, ModelPricing>) {}
  async resolve(_providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    return this.pricing[modelId];
  }
}

class MockModelRouter {
  constructor(private mockProviders: Map<string, Provider>) {}

  async resolve(modelId: string): Promise<Provider | null> {
    return this.mockProviders.get(modelId) ?? null;
  }

  async resolveWithId(modelId: string): Promise<{ provider: Provider; providerId: string } | null> {
    const provider = this.mockProviders.get(modelId);
    return provider ? { provider, providerId: 'mock-provider' } : null;
  }
}

interface ScriptedProviderResponse {
  content: string | null;
  reasoning?: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: ProviderStopReason;
  usage?: ProviderUsage;
  cost?: number;
  errorAfterChunks?: string;
}

async function makeSetup(providerResponses: ScriptedProviderResponse[]) {
  const storage = new MemoryStorage();
  const conversationStore = new FileConversationStore(storage);

  const agentConfig: AgentConfig = {
    id: 'agent-1',
    name: 'Test Agent',
    type: 'agent',
    systemPrompt: 'You are a helpful assistant.',
    model: { model: 'test-model' },
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
  const providerRequests: ProviderMessage[][] = [];
  const mockProvider: Provider = {
    async *stream(messages) {
      providerRequests.push(
        messages.map((message) => ({
          ...message,
          ...(message.toolCalls
            ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) }
            : {}),
        })),
      );
      const resp: ScriptedProviderResponse = providerResponses[responseIndex++] ?? {
        content: '[no more responses]',
        toolCalls: [],
        stopReason: 'stop',
      };
      if (resp.reasoning) {
        yield { type: 'reasoning_delta', delta: resp.reasoning };
      }
      if (resp.content) {
        yield { type: 'text_delta', delta: resp.content };
      }
      for (let i = 0; i < (resp.toolCalls ?? []).length; i++) {
        const tc = resp.toolCalls[i];
        yield { type: 'tool_call_start', index: i, id: tc.id, name: tc.name };
        yield { type: 'tool_call_args_delta', index: i, delta: JSON.stringify(tc.arguments) };
      }
      if (resp.errorAfterChunks) {
        throw new Error(resp.errorAfterChunks);
      }
      yield { type: 'done', stopReason: resp.stopReason, usage: resp.usage };
    },
  };
  const router = new MockModelRouter(new Map([['test-model', mockProvider]])) as ModelRouter;

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

  return { context, thread, eventBus, inbound, router, providerRequests };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime', () => {
  it('returns the provider text response when no tools are called', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: 'I am happy to help!',
        reasoning: 'brief analysis',
        toolCalls: [],
        stopReason: 'stop',
      },
    ]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);
    expect(result).toEqual({
      kind: 'response',
      content: 'I am happy to help!',
      reasoning: 'brief analysis',
    });
    // No extra messages persisted — only the inbound message
    expect(context.conversation.activeChain).toHaveLength(1);
  });

  it('omits reasoning when the provider returns none', async () => {
    const { context, inbound, router } = await makeSetup([
      { content: 'plain answer', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', router);

    expect(await runtime.handle(inbound, context)).toEqual({
      kind: 'response',
      content: 'plain answer',
    });
  });

  it('does not send reasoning back to the provider on later iterations', async () => {
    const { context, inbound, router, providerRequests } = await makeSetup([
      {
        content: null,
        reasoning: 'private reasoning',
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        stopReason: 'tool_calls',
      },
      { content: 'done', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', router);

    await runtime.handle(inbound, context);

    expect(providerRequests).toHaveLength(2);
    for (const message of providerRequests[1]) {
      expect(message).not.toHaveProperty('reasoning');
      expect(message.content ?? '').not.toContain('private reasoning');
    }
  });

  it('does not return or persist partial reasoning from a failed iteration', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: null,
        reasoning: 'incomplete reasoning',
        toolCalls: [],
        stopReason: 'stop',
        errorAfterChunks: 'stream interrupted',
      },
    ]);
    const runtime = new AgentRuntime('agent-1', router);

    expect(await runtime.handle(inbound, context)).toEqual({
      kind: 'response',
      content: '[AgentRuntime error: stream interrupted]',
    });
    expect(context.conversation.activeChain).toHaveLength(1);
  });

  it('executes a tool call turn, persists it, and returns the follow-up text', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello world' } }],
        stopReason: 'tool_calls',
      },
      { content: 'Done echoing!', toolCalls: [], stopReason: 'stop' },
    ]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);

    expect(result).toEqual({ kind: 'response', content: 'Done echoing!' });

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
    const { context, inbound, router, eventBus } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'x' } }],
        stopReason: 'tool_calls',
      },
      { content: 'Finished.', toolCalls: [], stopReason: 'stop' },
    ]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
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
      model: { model: 'm' },
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
      async *stream() {
        yield { type: 'tool_call_start', index: 0, id: `tc-${tcId++}`, name: 'echo' };
        yield { type: 'tool_call_args_delta', index: 0, delta: JSON.stringify({ text: 'hi' }) };
        yield { type: 'done', stopReason: 'tool_calls', usage: undefined };
      },
    };
    const router = new MockModelRouter(new Map([['m', loopingProvider]])) as ModelRouter;
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

    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);
    expect((result as { kind: string; content: string }).content).toMatch(/maximum iteration/i);
    expect((result as { kind: string; content: string }).content).toContain('2');
  });

  it('returns an error message when no provider is registered for the agent model', async () => {
    const emptyRouter = new MockModelRouter(new Map()) as ModelRouter;
    const { context, inbound } = await makeSetup([]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', emptyRouter, calc);
    const result = await runtime.handle(inbound, context);
    expect((result as { kind: string; content: string }).content).toMatch(/no provider/i);
    expect((result as { kind: string; content: string }).content).toMatch(/test-model/);
  });

  it('returns a graceful error response when model resolution throws', async () => {
    const throwingRouter = {
      async resolveWithId() {
        throw new Error('resolve failed');
      },
    } as ModelRouter;
    const { context, inbound } = await makeSetup([]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', throwingRouter, calc);
    const result = await runtime.handle(inbound, context);

    expect(result).toEqual({ kind: 'response', content: '[AgentRuntime error: resolve failed]' });
  });

  it('returns a graceful error response when the provider throws', async () => {
    const throwingProvider: Provider = {
      async *stream() {
        throw new TypeError('fetch failed');
      },
    };
    const router = new MockModelRouter(new Map([['test-model', throwingProvider]])) as ModelRouter;
    const { context, inbound } = await makeSetup([]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);
    expect(result).toEqual({ kind: 'response', content: '[AgentRuntime error: fetch failed]' });
  });

  it('attaches usage from ProviderResponse to the returned response', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: 'I used some tokens',
        toolCalls: [],
        stopReason: 'stop',
        usage: {
          inputTokens: 2006,
          outputTokens: 300,
          reasoningTokens: 50,
          cacheReadInputTokens: 1920,
        },
        cost: 0.005615,
      },
    ]);
    const calc = new UsageCalculator(
      new MockPricingSource({
        'test-model': { input: 2.5, output: 10, cache: { read: 1.25, write: 2.5 } },
      }),
      new Map(),
    );
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);

    expect(result).toEqual({
      kind: 'response',
      content: 'I used some tokens',
      usage: {
        input: 86,
        output: 250,
        reasoning: 50,
        cache: { read: 1920, write: 0 },
        cost: 0.005615, // provider cost override used directly
        modelId: 'test-model',
        providerId: 'mock-provider',
      },
    });
    // No assistant message persisted by AgentRuntime — caller persists.
    expect(context.conversation.activeChain).toHaveLength(1);
  });

  it('computes usage via calculator when ProviderResponse has no cost override', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: 'no cost override',
        toolCalls: [],
        stopReason: 'stop',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      },
    ]);
    const calc = new UsageCalculator(
      new MockPricingSource({
        'test-model': { input: 2.5, output: 10, cache: { read: 1.25, write: 2.5 } },
      }),
      new Map(),
    );
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);

    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.usage).toBeDefined();
    expect(result.usage?.input).toBe(100);
    expect(result.usage?.output).toBe(50);
    expect(result.usage?.cost).toBeCloseTo(0.00075, 6); // 100*2.5/1e6 + 50*10/1e6
  });

  it('returns response without usage when ProviderResponse omits usage', async () => {
    const { context, inbound, router } = await makeSetup([
      { content: 'no usage', toolCalls: [], stopReason: 'stop' },
    ]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);

    expect(result).toEqual({ kind: 'response', content: 'no usage' });
  });
});

// ---------------------------------------------------------------------------
// Auth: hidden tool (absent from tools map) — LLM never sees it
// ---------------------------------------------------------------------------
describe('AgentRuntime: auth – hidden tool (absent from map)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-ar-hidden-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tool absent from map is not presented to LLM; LLM responds directly', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1',
      name: 'A',
      type: 'agent',
      status: 'active',
      tools: {}, // echo is absent — hidden from LLM
      systemPrompt: 'You are an assistant.',
      model: { model: 'test' },
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(new FileStorage(dir));
    const eventBus = new EventBus();
    const thread = new ConversationThread(
      await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} }),
      store,
    );

    // Provider: should never receive echo as an available tool — returns text directly
    let toolsSeenByProvider: string[] = [];
    const provider: Provider = {
      async *stream(_msgs, tools) {
        toolsSeenByProvider = (tools ?? []).map((t) => t.name);
        yield { type: 'text_delta', delta: 'No tools available' };
        yield { type: 'done', stopReason: 'stop' };
      },
    };
    const router = new MockModelRouter(new Map([['test', provider]])) as ModelRouter;

    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      } as JSONSchema,
      async execute(args) {
        return { status: 'success', data: (args as { text: string }).text };
      },
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(echoTool);

    const context: RuntimeContext = {
      participant: collective.getOrThrow('agent-1'),
      conversationId: thread.id,
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: { send: vi.fn(), resume: vi.fn() } as unknown as MessageRouterPort,
    } as unknown as RuntimeContext;

    const incoming: MessageData = {
      id: 'msg-1',
      parentId: null,
      conversationId: thread.id,
      senderId: 'op',
      recipientId: 'agent-1',
      role: 'user',
      content: 'use echo',
      status: 'active',
      timestamp: new Date().toISOString(),
    };

    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(incoming, context);

    // LLM never saw echo
    expect(toolsSeenByProvider).not.toContain('echo');
    expect(result.kind).toBe('response');
    expect((result as { kind: string; content: string }).content).toBe('No tools available');
  });

  it('hallucinated tool call to absent tool hits hidden guard with error result', async () => {
    const storage = new MemoryStorage();
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1',
      name: 'A',
      type: 'agent',
      status: 'active',
      tools: {}, // echo is absent — hidden from LLM
      systemPrompt: 'You are an assistant.',
      model: { model: 'test' },
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(new FileStorage(dir));
    const eventBus = new EventBus();
    const thread = new ConversationThread(
      await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} }),
      store,
    );

    // Provider: first call hallucinates a call to echo (which it never saw);
    // second call returns plain text after the hidden-guard error result.
    let toolsSeenByProvider: string[] = [];
    let call = 0;
    const provider: Provider = {
      async *stream(_msgs, tools) {
        call++;
        toolsSeenByProvider = (tools ?? []).map((t) => t.name);
        if (call === 1) {
          yield { type: 'text_delta', delta: 'calling echo' };
          yield { type: 'tool_call_start', index: 0, id: 'tc-hidden', name: 'echo' };
          yield { type: 'tool_call_args_delta', index: 0, delta: JSON.stringify({ text: 'hi' }) };
          yield { type: 'done', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', delta: 'Recovered' };
          yield { type: 'done', stopReason: 'stop' };
        }
      },
    };
    const router = new MockModelRouter(new Map([['test', provider]])) as ModelRouter;

    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      } as JSONSchema,
      async execute(args) {
        return { status: 'success', data: (args as { text: string }).text };
      },
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(echoTool);

    const context: RuntimeContext = {
      participant: collective.getOrThrow('agent-1'),
      conversationId: thread.id,
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: { send: vi.fn(), resume: vi.fn() } as unknown as MessageRouterPort,
    } as unknown as RuntimeContext;

    const incoming: MessageData = {
      id: 'msg-1',
      parentId: null,
      conversationId: thread.id,
      senderId: 'op',
      recipientId: 'agent-1',
      role: 'user',
      content: 'use echo',
      status: 'active',
      timestamp: new Date().toISOString(),
    };

    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(incoming, context);

    // LLM never saw echo as an available tool
    expect(toolsSeenByProvider).not.toContain('echo');
    expect(result.kind).toBe('response');
    expect((result as { kind: string; content: string }).content).toBe('Recovered');

    // The hallucinated tool call was recorded as an error result via the hidden guard
    const chain = thread.activeChain;
    const toolTurn = chain.find((m) => m.toolCalls?.some((tc) => tc.name === 'echo'));
    expect(toolTurn).toBeDefined();
    const hiddenResult = toolTurn?.toolResults?.find((tr) => tr.name === 'echo');
    expect(hiddenResult).toBeDefined();
    expect(hiddenResult?.result.status).toBe('error');
    expect(hiddenResult?.result.error).toMatch(/not available/i);
  });
});

// ---------------------------------------------------------------------------
// Auth: requires_approval policy – returns pending_approval
// ---------------------------------------------------------------------------
describe('AgentRuntime: auth – requires_approval policy', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-ar-appr-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setupApprovalScenario(tmpDir: string) {
    const storage = new MemoryStorage();
    await storage.writeJson('collective/participants/agent-1.json', {
      id: 'agent-1',
      name: 'A',
      type: 'agent',
      status: 'active',
      tools: { echo: 'requires_approval' },
      systemPrompt: 'You are an assistant.',
      model: { model: 'test' },
    });
    const collective = await Collective.load(storage);
    const store = new FileConversationStore(new FileStorage(tmpDir));
    const eventBus = new EventBus();
    const thread = new ConversationThread(
      await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} }),
      store,
    );

    const provider: Provider = {
      async *stream(msgs, _tools) {
        const last = msgs[msgs.length - 1];
        if (last.role === 'tool') {
          const parsed = JSON.parse(last.content ?? '{}');
          if (parsed.status !== 'pending_approval') {
            yield { type: 'text_delta', delta: 'Done' };
            yield { type: 'done', stopReason: 'stop' };
            return;
          }
        }
        yield { type: 'tool_call_start', index: 0, id: 'tc-1', name: 'echo' };
        yield { type: 'tool_call_args_delta', index: 0, delta: JSON.stringify({ text: 'hello' }) };
        yield { type: 'done', stopReason: 'tool_calls' };
      },
    };
    const router = new MockModelRouter(new Map([['test', provider]])) as ModelRouter;

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'echo',
      description: 'echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      } as JSONSchema,
      async execute(args) {
        return { status: 'success', data: (args as { text: string }).text };
      },
    });

    const pendingApprovalRegistry = new PendingApprovalRegistry();

    const context: RuntimeContext = {
      participant: collective.getOrThrow('agent-1'),
      conversationId: thread.id,
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: tmpDir,
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry,
      messageRouter: { send: vi.fn(), resume: vi.fn() } as unknown as MessageRouterPort,
    } as unknown as RuntimeContext;

    const incoming: MessageData = {
      id: 'msg-1',
      parentId: null,
      conversationId: thread.id,
      senderId: 'op',
      recipientId: 'agent-1',
      role: 'user',
      content: 'use echo',
      status: 'active',
      timestamp: new Date().toISOString(),
    };

    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    return {
      runtime: new AgentRuntime('agent-1', router, calc),
      incoming,
      context,
      thread,
      pendingApprovalRegistry,
    };
  }

  it('returns pending_approval when a tool requires approval', async () => {
    const { runtime, incoming, context } = await setupApprovalScenario(dir);
    const result = await runtime.handle(incoming, context);
    expect(result.kind).toBe('pending_approval');
    const r = result as { kind: string; approvalRequests: { tool: string }[] };
    expect(r.approvalRequests[0].tool).toBe('echo');
  });

  it('writes pending_approval tool result to the conversation', async () => {
    const { runtime, incoming, context, thread } = await setupApprovalScenario(dir);
    await runtime.handle(incoming, context);
    const chain = thread.activeChain;
    const toolTurn = chain.find((m) =>
      m.toolResults?.some((tr) => tr.result.status === 'pending_approval'),
    );
    expect(toolTurn).toBeDefined();
    expect(toolTurn?.toolResults?.[0].result.approvalId).toMatch(/^appr-/);
  });

  it('returns rejected title helper tool results without pending approval events', async () => {
    const { runtime, incoming, context, thread, pendingApprovalRegistry } =
      await setupApprovalScenario(dir);
    context.titleApprovalRejectionMessage = 'Title generation requires approval';
    const approvals = vi.fn();
    context.eventBus.on('approval:requested', approvals);

    const result = await runtime.handle(incoming, context);

    expect(result).toEqual({
      kind: 'middleware_abort',
      error: 'Title generation requires approval',
    });
    expect(approvals).not.toHaveBeenCalled();
    expect(pendingApprovalRegistry.listPending()).toEqual([]);
    expect(
      thread.activeChain.some((message) => message.toolResults?.[0]?.result.status === 'rejected'),
    ).toBe(true);
  });

  it('resumes and completes after approval is granted', async () => {
    const { runtime, incoming, context, thread, pendingApprovalRegistry } =
      await setupApprovalScenario(dir);
    const result = await runtime.handle(incoming, context);
    expect(result.kind).toBe('pending_approval');

    const r = result as { kind: string; approvalRequests: { approvalId: string }[] };
    const { approvalId } = r.approvalRequests[0];

    await pendingApprovalRegistry.resolve(approvalId, {
      approved: true,
      decidedByParticipantId: 'operator',
      decidedAt: new Date().toISOString(),
    });

    const resumeResult = await runtime.handle(incoming, context);
    expect(resumeResult.kind).toBe('response');
    expect((resumeResult as { kind: string; content: string }).content).toBe('Done');

    const chain = thread.activeChain;
    const resolved = chain.find((m) => m.toolResults?.some((tr) => tr.result.status === 'success'));
    expect(resolved).toBeDefined();
  });

  it('resumes with rejection message in context', async () => {
    const { runtime, incoming, context, thread, pendingApprovalRegistry } =
      await setupApprovalScenario(dir);
    const result = await runtime.handle(incoming, context);
    const r = result as { kind: string; approvalRequests: { approvalId: string }[] };

    await pendingApprovalRegistry.resolve(r.approvalRequests[0].approvalId, {
      approved: false,
      decidedByParticipantId: 'operator',
      message: 'Not permitted on prod',
      decidedAt: new Date().toISOString(),
    });

    const resumeResult = await runtime.handle(incoming, context);
    expect(resumeResult.kind).toBe('response');
    const chain = thread.activeChain;
    const rejectedTurn = chain.find((m) =>
      m.toolResults?.some((tr) => tr.result.status === 'rejected'),
    );
    expect(rejectedTurn?.toolResults?.[0].result.message).toBe('Not permitted on prod');
  });
});

describe('AgentRuntime.handleStream()', () => {
  it('emits boundaries and keeps reasoning separate per iteration', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: 'calling tool',
        reasoning: 'tool reasoning',
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        stopReason: 'tool_calls',
      },
      {
        content: 'final answer',
        reasoning: 'final reasoning',
        toolCalls: [],
        stopReason: 'stop',
      },
    ]);
    const runtime = new AgentRuntime('agent-1', router);
    const chunks: LLMChunk[] = [];
    const gen = runtime.handleStream!(inbound, context);
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }

    expect(chunks).toEqual([
      { type: 'iteration_start', iteration: 0 },
      { type: 'reasoning_delta', delta: 'tool reasoning' },
      { type: 'text_delta', delta: 'calling tool' },
      { type: 'tool_call_start', index: 0, id: 'tc-1', name: 'echo' },
      { type: 'tool_call_args_delta', index: 0, delta: '{"text":"hello"}' },
      { type: 'iteration_start', iteration: 1 },
      { type: 'reasoning_delta', delta: 'final reasoning' },
      { type: 'text_delta', delta: 'final answer' },
    ]);
    expect(next.value).toEqual({
      kind: 'response',
      content: 'final answer',
      reasoning: 'final reasoning',
    });
    expect(context.conversation.activeChain[1]).toMatchObject({
      content: 'calling tool',
      reasoning: 'tool reasoning',
    });
  });

  it('yields LLM chunks during response', async () => {
    const { context, inbound, router } = await makeSetup([
      { content: 'Hello!', toolCalls: [], stopReason: 'stop' },
    ]);
    const agent = new AgentRuntime('agent-1', router);
    expect(agent.handleStream).toBeDefined();

    const chunks: LLMChunk[] = [];
    const gen = agent.handleStream!(inbound, context);
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }
    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'Hello!')).toBe(true);
    expect(next.value.kind).toBe('response');
  });

  it('returns a non-persisting terminal when cancelled before provider streaming', async () => {
    const { context, inbound, router, providerRequests, thread } = await makeSetup([
      { content: 'must not run', toolCalls: [], stopReason: 'stop' },
    ]);
    const controller = new AbortController();
    context.signal = controller.signal;
    const agent = new AgentRuntime('agent-1', router);
    const stream = agent.handleStream!(inbound, context);

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'iteration_start', iteration: 0 },
    });
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({
      done: true,
      value: { kind: 'middleware_abort', error: expect.stringMatching(/cancelled/i) },
    });
    expect(providerRequests).toEqual([]);
    expect(thread.activeChain).toHaveLength(1);
  });
});

describe('AgentRuntime: middleware prompts', () => {
  function action(requestId: string): MiddlewareActionResult {
    return {
      requestId,
      participantId: 'agent-1',
      instanceId: 'middleware-1',
      tool: 'echo',
      status: 'success',
      result: { status: 'success', data: requestId },
    };
  }

  it('reloads and transforms the prompt before every provider iteration', async () => {
    const { context, inbound, router, providerRequests } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        stopReason: 'tool_calls',
      },
      { content: 'done', toolCalls: [], stopReason: 'stop' },
    ]);
    const promptAction = action('prompt-action');
    const buildSystemPrompt = vi.fn(async (input) => ({
      kind: 'continue' as const,
      prompt: `prepared ${input.iteration}`,
      actions: input.iteration === 0 ? [promptAction] : input.actions,
    }));
    context.buildSystemPrompt = buildSystemPrompt;

    await new AgentRuntime('agent-1', router).handle(inbound, context);

    expect(buildSystemPrompt).toHaveBeenCalledTimes(2);
    expect(buildSystemPrompt.mock.calls.map(([input]) => input.actions)).toEqual([
      [],
      [promptAction],
    ]);
    expect(providerRequests.map(([message]) => message.content)).toEqual([
      'prepared 0',
      'prepared 1',
    ]);
  });

  it('carries inbound and prompt action ledgers through provider iterations and response', async () => {
    const { context, inbound, router } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        stopReason: 'tool_calls',
      },
      { content: 'done', toolCalls: [], stopReason: 'stop' },
    ]);
    const inboundAction = action('inbound');
    const firstPromptAction = action('prompt-1');
    const secondPromptAction = action('prompt-2');
    context.middlewareActions = [inboundAction];
    context.buildSystemPrompt = vi.fn(async (input) => ({
      kind: 'continue' as const,
      prompt: `prepared ${input.iteration}`,
      actions:
        input.iteration === 0
          ? [...input.actions, firstPromptAction]
          : [...input.actions, secondPromptAction],
    }));

    const result = await new AgentRuntime('agent-1', router).handle(inbound, context);
    expect(result).toEqual({
      kind: 'response',
      content: 'done',
      actions: [inboundAction, firstPromptAction, secondPromptAction],
    });
    if (result.kind !== 'response') throw new Error('expected response');
    expect(result.actions).not.toBe(context.middlewareActions);
    expect(result.actions?.[0]).not.toBe(inboundAction);
    expect(result.actions?.[0].result).not.toBe(inboundAction.result);
  });

  it.each([
    [
      'abort',
      { kind: 'abort' as const, error: 'internal middleware detail' },
      { kind: 'middleware_abort', error: 'internal middleware detail' },
    ],
    [
      'abort without error falls back to generic message',
      { kind: 'abort' as const, error: undefined as unknown as string },
      { kind: 'middleware_abort', error: 'Middleware prompt aborted' },
    ],
    [
      'pending approval',
      {
        kind: 'pending' as const,
        approvalId: 'appr-prompt',
        checkpointId: 'mwcp-prompt',
        preparedPrompt: 'prepared',
        actionCursor: 0,
      },
      { kind: 'middleware_pending', approvalId: 'appr-prompt', checkpointId: 'mwcp-prompt' },
    ],
  ])('does not call provider when prompt hook returns %s', async (_name, hookResult, expected) => {
    const { context, inbound, router, providerRequests } = await makeSetup([
      { content: 'must not run', toolCalls: [], stopReason: 'stop' },
    ]);
    context.buildSystemPrompt = vi.fn(async () => hookResult);

    await expect(new AgentRuntime('agent-1', router).handle(inbound, context)).resolves.toEqual(
      expected,
    );
    expect(providerRequests).toHaveLength(0);
  });

  it('resumes at saved provider boundary without replaying prompt hook', async () => {
    const { context, inbound, router, providerRequests } = await makeSetup([
      {
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        stopReason: 'tool_calls',
      },
      { content: 'done', toolCalls: [], stopReason: 'stop' },
    ]);
    const buildSystemPrompt = vi.fn(async (input) => ({
      kind: 'continue' as const,
      prompt: `prepared ${input.iteration}`,
      actions: input.actions,
    }));
    context.buildSystemPrompt = buildSystemPrompt;
    const runtime = new AgentRuntime('agent-1', router);

    await expect(
      runtime.resumeFromMiddleware!(
        {
          kind: 'agent_provider',
          participantId: 'agent-1',
          incomingMessageId: inbound.id,
          iteration: 4,
          preparedPrompt: 'saved prompt',
          actionCursor: 0,
          actions: [],
        },
        context,
      ),
    ).resolves.toEqual({ kind: 'response', content: 'done' });

    expect(buildSystemPrompt.mock.calls.map(([input]) => input.iteration)).toEqual([5]);
    expect(providerRequests.map(([message]) => message.content)).toEqual([
      'saved prompt',
      'prepared 5',
    ]);
  });

  it('rejects invalid provider-boundary resume data before calling provider', async () => {
    const { context, inbound, router, providerRequests } = await makeSetup([
      { content: 'must not run', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', router);

    await expect(
      runtime.resumeFromMiddleware!(
        {
          kind: 'agent_provider',
          participantId: 'agent-1',
          incomingMessageId: inbound.id,
          iteration: 0,
          preparedPrompt: 'saved prompt',
          actionCursor: 1,
          actions: [],
        },
        context,
      ),
    ).resolves.toEqual({ kind: 'middleware_abort', error: 'Invalid middleware provider resume' });
    expect(providerRequests).toHaveLength(0);
  });

  it.each([
    ['string', 'not actions'],
    ['array-like', { length: 0 }],
    [
      'accessor array',
      Object.defineProperty([], '0', {
        enumerable: true,
        get: () => action('accessor'),
      }),
    ],
    ['corrupt action', [{ requestId: 'missing-required-fields' }]],
  ])('rejects %s resume actions before calling provider', async (_name, actions) => {
    const { context, inbound, router, providerRequests } = await makeSetup([
      { content: 'must not run', toolCalls: [], stopReason: 'stop' },
    ]);
    const runtime = new AgentRuntime('agent-1', router);

    await expect(
      runtime.resumeFromMiddleware!(
        {
          kind: 'agent_provider',
          participantId: 'agent-1',
          incomingMessageId: inbound.id,
          iteration: 0,
          preparedPrompt: 'saved prompt',
          actionCursor: 0,
          actions: actions as MiddlewareActionResult[],
        },
        context,
      ),
    ).resolves.toEqual({ kind: 'middleware_abort', error: 'Invalid middleware provider resume' });
    expect(providerRequests).toHaveLength(0);
  });
});
