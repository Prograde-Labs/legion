import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { EventBus } from '../events/EventBus.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { communicateTool } from '../tools/communicate-tool.js';
import { getActiveChain } from '../conversation/conversation-ops.js';
import { RuntimeRegistry } from './RuntimeRegistry.js';
import { MockRuntime } from './MockRuntime.js';
import { UserDeliveryRuntime } from './UserDeliveryRuntime.js';
import { MessageRouter } from './MessageRouter.js';
import type { ToolContext } from '../tools/Tool.js';

describe('integration: end-to-end mock loop', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-loop-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes an operator message through a mock agent and persists the full thread', async () => {
    const storage = new FileStorage(dir);
    await storage.writeJson('collective/participants/operator.json', {
      id: 'operator',
      name: 'Operator',
      type: 'user',
      tools: { communicate: 'auto' },
      operator: true,
      protected: true,
      status: 'active',
    });
    await storage.writeJson('collective/participants/assistant.json', {
      id: 'assistant',
      name: 'Assistant',
      type: 'mock',
      tools: {},
      responses: ['Hello, operator!'],
      status: 'active',
    });

    const collective = await Collective.load(storage);
    const eventBus = new EventBus();
    const store = new FileConversationStore(storage, eventBus);

    const registry = new RuntimeRegistry();
    registry.registerFactory('mock', (id) => new MockRuntime(id));
    registry.registerFactory('user', (id) => new UserDeliveryRuntime(id));

    const router = new MessageRouter(store, registry, collective, eventBus);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(communicateTool);

    const events: string[] = [];
    eventBus.on('conversation:created', () => events.push('conversation:created'));
    eventBus.on('message:sent', () => events.push('message:sent'));
    eventBus.on('message:delivered', () => events.push('message:delivered'));

    const operatorContext = {
      participant: collective.getOrThrow('operator'),
      conversationId: '',
      collective,
      config: { version: '2' },
      eventBus,
      storage,
      workspaceRoot: dir,
      communicationDepth: 0,
      toolRegistry,
      authEngine: new AuthEngine(),
      pendingApprovalRegistry: new PendingApprovalRegistry(),
      messageRouter: router,
    } as unknown as ToolContext;

    // Operator uses the communicate tool to message the assistant.
    const result = await toolRegistry.execute(
      'communicate',
      { to: 'assistant', message: 'Hi assistant' },
      operatorContext,
    );

    expect(result.status).toBe('success');
    const data = result.data as { conversationId: string; response: string };
    expect(data.response).toBe('Hello, operator!');

    // The conversation persists both messages in order.
    const conversation = await store.load(data.conversationId);
    expect(conversation).not.toBeNull();
    const chain = getActiveChain(conversation!);
    expect(chain.map((m) => ({ sender: m.senderId, content: m.content }))).toEqual([
      { sender: 'operator', content: 'Hi assistant' },
      { sender: 'assistant', content: 'Hello, operator!' },
    ]);

    // Events fired: one creation + one sent (inbound) + one delivered (response).
    expect(events.filter((e) => e === 'conversation:created').length).toBe(1);
    expect(events.filter((e) => e === 'message:sent').length).toBe(1);
    expect(events.filter((e) => e === 'message:delivered').length).toBe(1);
  });
});
