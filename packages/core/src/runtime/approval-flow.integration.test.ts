import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { ConversationThread } from '../conversation/ConversationThread.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { MessageRouter } from './MessageRouter.js';
import { AgentRuntime } from './AgentRuntime.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ApprovalLog } from '../auth/ApprovalLog.js';
import { communicateTool } from '../tools/communicate-tool.js';
import { approvalResponseTool } from '../tools/approval-response-tool.js';
import type { Provider, ProviderResponse } from '../providers/Provider.js';
import type { ModelRouter } from '../providers/ModelRouter.js';
import type { RuntimeContext } from './Runtime.js';
import type { JSONSchema } from '@legion/types';

class MockModelRouter {
  constructor(private mockProviders: Map<string, Provider>) {}

  register(modelId: string, provider: Provider): void {
    this.mockProviders.set(modelId, provider);
  }

  async resolve(modelId: string): Promise<Provider | null> {
    return this.mockProviders.get(modelId) ?? null;
  }
}

/** A provider that cycles through a scripted sequence of responses. */
function scriptedProvider(turns: ProviderResponse[]): Provider {
  let i = 0;
  return {
    async complete() {
      const response = turns[i % turns.length];
      i += 1;
      return response;
    },
  };
}

async function setup(dir: string) {
  const storage = new FileStorage(dir);

  // Agent B: has 'echo' as requires_approval, 'communicate' as auto
  await storage.writeJson('collective/participants/agent-b.json', {
    id: 'agent-b',
    name: 'B',
    type: 'agent',
    status: 'active',
    tools: { communicate: 'auto', echo: 'requires_approval' },
    systemPrompt: 'You are a helpful assistant.',
    model: { model: 'test' },
  });

  // Operator: user type, broad approval authority
  await storage.writeJson('collective/participants/operator.json', {
    id: 'operator',
    name: 'Operator',
    type: 'user',
    status: 'active',
    tools: { communicate: 'auto', approval_response: 'auto' },
    approvalAuthority: { tools: '*', participants: '*' },
  });

  const collective = await Collective.load(storage);
  const store = new FileConversationStore(storage);
  const eventBus = new EventBus();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(communicateTool);
  toolRegistry.register(approvalResponseTool);
  toolRegistry.register({
    name: 'echo',
    description: 'Echo a message',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    } as JSONSchema,
    async execute(args) {
      return { status: 'success', data: (args as { text: string }).text };
    },
  });

  const pendingApprovalRegistry = new PendingApprovalRegistry(storage);
  const approvalLog = new ApprovalLog();
  const authEngine = new AuthEngine();
  const mockProviders = new Map<string, Provider>();
  const modelRouter = new MockModelRouter(mockProviders);
  const runtimeRegistry = new RuntimeRegistry();

  const router = new MessageRouter(store, runtimeRegistry, collective, eventBus);

  runtimeRegistry.registerFactory(
    'agent',
    (id) => new AgentRuntime(id, modelRouter as ModelRouter),
  );
  runtimeRegistry.registerFactory('user', (_id) => ({
    async handle() {
      return { kind: 'void' as const };
    },
  }));

  function makeContext(participantId: string, thread?: ConversationThread): RuntimeContext {
    return {
      participant: collective.getOrThrow(participantId),
      conversationId: thread?.id ?? '',
      conversation: thread,
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry,
      authEngine,
      pendingApprovalRegistry,
      approvalLog,
      messageRouter: router,
    } as unknown as RuntimeContext;
  }

  return {
    collective,
    store,
    eventBus,
    toolRegistry,
    pendingApprovalRegistry,
    approvalLog,
    authEngine,
    modelRouter,
    router,
    makeContext,
  };
}

describe('Approval flow integration', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-approval-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('approve path: operator approves → B resumes and completes', async () => {
    const { modelRouter, router, makeContext, store, pendingApprovalRegistry } = await setup(dir);

    modelRouter.register(
      'test',
      scriptedProvider([
        {
          content: null,
          toolCalls: [{ id: 'tc-echo', name: 'echo', arguments: { text: 'hello world' } }],
          stopReason: 'tool_calls',
        },
        {
          content: 'I echoed "hello world" successfully.',
          toolCalls: [],
          stopReason: 'stop',
        },
      ]),
    );

    const operatorContext = makeContext('operator');

    const communicateResult = await communicateTool.execute(
      { to: 'agent-b', message: 'Please echo "hello world"' },
      operatorContext,
    );

    expect(communicateResult.status).toBe('pending_approval');
    const pendingData = communicateResult.data as {
      conversationId: string;
      approvalRequests: { approvalId: string; tool: string }[];
    };
    expect(pendingData.approvalRequests[0].tool).toBe('echo');

    const { approvalId, conversationId } = {
      approvalId: pendingData.approvalRequests[0].approvalId,
      conversationId: pendingData.conversationId,
    };

    expect(pendingApprovalRegistry.get(approvalId)).toBeDefined();

    // Step 2: Operator approves
    const approveContext = { ...operatorContext, conversationId };
    const approveResult = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'approve' }] },
      approveContext,
    );
    expect(approveResult.status).toBe('success');
    const approveData = approveResult.data as { results: { outcome: string }[] };
    expect(approveData.results[0].outcome).toBe('approve');

    // Step 3: Verify B's final response is in the conversation
    const conv = await store.load(conversationId);
    const messages = Object.values(conv!.messages);
    const finalResponse = messages.find(
      (m) => m.role === 'assistant' && m.content === 'I echoed "hello world" successfully.',
    );
    expect(finalResponse).toBeDefined();

    const toolTurn = messages.find((m) =>
      m.toolResults?.some((tr) => tr.result.status === 'success' && tr.name === 'echo'),
    );
    expect(toolTurn).toBeDefined();
  });

  it('reject path: operator rejects → B resumes with rejection message in context', async () => {
    const { modelRouter, router, makeContext, store } = await setup(dir);

    let secondCallSeen = false;

    modelRouter.register('test', {
      async complete(msgs) {
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        if (!hasToolResult) {
          return {
            content: null,
            toolCalls: [{ id: 'tc-echo', name: 'echo', arguments: { text: 'hi' } }],
            stopReason: 'tool_calls' as const,
          };
        }
        secondCallSeen = true;
        return {
          content: 'Understood, I will not echo.',
          toolCalls: [],
          stopReason: 'stop' as const,
        };
      },
    });

    const operatorContext = makeContext('operator');

    const communicateResult = await communicateTool.execute(
      { to: 'agent-b', message: 'Echo "hi"' },
      operatorContext,
    );

    expect(communicateResult.status).toBe('pending_approval');
    const pendingData = communicateResult.data as {
      conversationId: string;
      approvalRequests: { approvalId: string }[];
    };
    const { approvalId, conversationId } = {
      approvalId: pendingData.approvalRequests[0].approvalId,
      conversationId: pendingData.conversationId,
    };

    const rejectResult = await approvalResponseTool.execute(
      { decisions: [{ approvalId, decision: 'reject', message: 'Echo is not permitted here' }] },
      { ...operatorContext, conversationId },
    );
    expect(rejectResult.status).toBe('success');

    expect(secondCallSeen).toBe(true);

    const conv = await store.load(conversationId);
    const messages = Object.values(conv!.messages);
    const rejectedTurn = messages.find((m) =>
      m.toolResults?.some((tr) => tr.result.status === 'rejected'),
    );
    expect(rejectedTurn?.toolResults?.[0].result.message).toBe('Echo is not permitted here');

    const finalResponse = messages.find(
      (m) => m.role === 'assistant' && m.content === 'Understood, I will not echo.',
    );
    expect(finalResponse).toBeDefined();
  });
});
