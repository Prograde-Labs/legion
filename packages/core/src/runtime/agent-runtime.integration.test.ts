import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { EventBus } from '../events/EventBus.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ProviderStore } from '../providers/ProviderStore.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { AgentRuntime } from './AgentRuntime.js';
import { UserDeliveryRuntime } from './UserDeliveryRuntime.js';
import { MessageRouter } from './MessageRouter.js';
import type { ToolContext } from '../tools/Tool.js';

const LIVE = !!process.env['LEGION_OPENAI_INTEGRATION'];

describe.skipIf(!LIVE)('AgentRuntime: live end-to-end via MessageRouter', () => {
  it('connects to the OpenAI-compatible endpoint and returns a text response', async () => {
    const model = process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
    const storage = new MemoryStorage();

    // Participants: a user (operator) and an agent.
    await storage.writeJson('collective/participants/operator.json', {
      id: 'operator',
      name: 'Operator',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/assistant.json', {
      id: 'assistant',
      name: 'Assistant',
      type: 'agent',
      systemPrompt: 'You are a helpful assistant. Always respond in exactly one short sentence.',
      model: { provider: 'openai-compatible', model },
      tools: {},
      status: 'active',
    });

    const collective = await Collective.load(storage);
    const conversationStore = new FileConversationStore(storage);
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();

    const providerStorage = new MemoryStorage();
    await providerStorage.writeJson('providers/openai-compatible.json', {
      name: 'openai-compatible',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    const providerStore = new ProviderStore(providerStorage);

    const runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id));
    runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, providerStore));

    const router = new MessageRouter(conversationStore, runtimeRegistry, collective, eventBus);

    const baseContext = {
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: '/tmp/legion-live-test',
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    const result = await router.send({
      senderId: 'operator',
      recipientId: 'assistant',
      message: 'What is the capital of France?',
      context: baseContext,
    });

    expect(result.status).toBe('success');
    expect(typeof result.response).toBe('string');
    expect(result.response!.length).toBeGreaterThan(0);
    // Should contain "Paris" somewhere in the response.
    expect(result.response!.toLowerCase()).toContain('paris');
  }, 30_000); // 30-second timeout for live API call

  it('executes a tool call when the agent is configured with an echo tool', async () => {
    const model = process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
    const storage = new MemoryStorage();

    await storage.writeJson('collective/participants/operator.json', {
      id: 'operator',
      name: 'Op',
      type: 'user',
      tools: {},
      status: 'active',
    });
    await storage.writeJson('collective/participants/agent.json', {
      id: 'agent',
      name: 'Echo Agent',
      type: 'agent',
      systemPrompt:
        'You are a test agent. When asked to echo something, call the echo tool with ' +
        'that text, then report the result.',
      model: { provider: 'openai-compatible', model },
      tools: { echo: 'auto' },
      status: 'active',
    });

    const collective = await Collective.load(storage);
    const conversationStore = new FileConversationStore(storage);
    const eventBus = new EventBus();

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'echo',
      description: 'Echoes the provided text back',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo' } },
        required: ['text'],
      },
      async execute(args) {
        const { text } = args as { text: string };
        return { status: 'success', data: text };
      },
    });

    const providerStorage = new MemoryStorage();
    await providerStorage.writeJson('providers/openai-compatible.json', {
      name: 'openai-compatible',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    const providerStore = new ProviderStore(providerStorage);

    const runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.registerFactory('user', (id) => new UserDeliveryRuntime(id));
    runtimeRegistry.registerFactory('agent', (id) => new AgentRuntime(id, providerStore));

    const router = new MessageRouter(conversationStore, runtimeRegistry, collective, eventBus);

    const baseContext = {
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: '/tmp/legion-live-test',
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
    } as unknown as ToolContext;

    const toolEvents: string[] = [];
    eventBus.on('tool:call', (p) => toolEvents.push(p.tool));

    const result = await router.send({
      senderId: 'operator',
      recipientId: 'agent',
      message: 'Please echo the text "hello legion".',
      context: baseContext,
    });

    expect(result.status).toBe('success');
    expect(result.response).toBeTruthy();
    // The agent should have called the echo tool at least once.
    expect(toolEvents).toContain('echo');
  }, 45_000); // longer timeout — two round trips to the LLM
});
