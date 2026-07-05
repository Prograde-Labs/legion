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
import type { Provider, ProviderResponse } from '../providers/Provider.js';
import type { ModelPricing, PricingSource } from '../providers/PricingSource.js';
import type { ModelRouter } from '../providers/ModelRouter.js';
import type { RuntimeContext, RuntimeResult } from './Runtime.js';
import type { AgentConfig, JSONSchema, Tool, MessageData } from '@legion/types';
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
}

async function makeSetup(providerResponses: ProviderResponse[]) {
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
  const mockProvider: Provider = {
    async complete() {
      const resp = providerResponses[responseIndex++];
      return resp ?? { content: '[no more responses]', toolCalls: [], stopReason: 'stop' };
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

  return { context, thread, eventBus, inbound, router };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime', () => {
  it('returns the provider text response when no tools are called', async () => {
    const { context, inbound, router } = await makeSetup([
      { content: 'I am happy to help!', toolCalls: [], stopReason: 'stop' },
    ]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    const result = await runtime.handle(inbound, context);
    expect(result).toEqual({ kind: 'response', content: 'I am happy to help!' });
    // No extra messages persisted — only the inbound message
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
      async complete() {
        return {
          content: null,
          toolCalls: [{ id: `tc-${tcId++}`, name: 'echo', arguments: { text: 'hi' } }],
          stopReason: 'tool_calls',
        };
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
      async resolve() {
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
      async complete() {
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

  it('attaches usage from ProviderResponse to the persisted assistant message', async () => {
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
    await runtime.handle(inbound, context);

    const chain = context.conversation.activeChain;
    const assistantMsg = chain.find((m) => m.role === 'assistant');
    expect(assistantMsg?.usage).toEqual({
      input: 86,
      output: 250,
      reasoning: 50,
      cache: { read: 1920, write: 0 },
      cost: 0.005615, // provider cost override used directly
      modelId: 'test-model',
      providerId: 'unknown',
    });
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
    await runtime.handle(inbound, context);

    const chain = context.conversation.activeChain;
    const assistantMsg = chain.find((m) => m.role === 'assistant');
    expect(assistantMsg?.usage).toBeDefined();
    expect(assistantMsg?.usage?.input).toBe(100);
    expect(assistantMsg?.usage?.output).toBe(50);
    expect(assistantMsg?.usage?.cost).toBeCloseTo(0.00075, 6); // 100*2.5/1e6 + 50*10/1e6
  });

  it('persists assistant message without usage when ProviderResponse omits usage', async () => {
    const { context, inbound, router } = await makeSetup([
      { content: 'no usage', toolCalls: [], stopReason: 'stop' },
    ]);
    const calc = new UsageCalculator(new MockPricingSource({}), new Map());
    const runtime = new AgentRuntime('agent-1', router, calc);
    await runtime.handle(inbound, context);

    const chain = context.conversation.activeChain;
    const assistantMsg = chain.find((m) => m.role === 'assistant');
    expect(assistantMsg?.usage).toBeUndefined();
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
      async complete(_msgs, tools) {
        toolsSeenByProvider = (tools ?? []).map((t) => t.name);
        return { content: 'No tools available', toolCalls: [], stopReason: 'stop' };
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
      async complete(_msgs, tools) {
        call++;
        toolsSeenByProvider = (tools ?? []).map((t) => t.name);
        if (call === 1) {
          return {
            content: 'calling echo',
            toolCalls: [{ id: 'tc-hidden', name: 'echo', arguments: { text: 'hi' } }],
            stopReason: 'tool_calls',
          };
        }
        return { content: 'Recovered', toolCalls: [], stopReason: 'stop' };
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
      async complete(_msgs, _tools) {
        const last = _msgs[_msgs.length - 1];
        if (last.role === 'tool') {
          const parsed = JSON.parse(last.content ?? '{}');
          if (parsed.status !== 'pending_approval') {
            return { content: 'Done', toolCalls: [], stopReason: 'stop' };
          }
        }
        return {
          content: null,
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
          stopReason: 'tool_calls',
        };
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
