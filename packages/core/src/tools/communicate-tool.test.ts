import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../storage/FileStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { Collective } from '../collective/Collective.js';
import { EventBus } from '../events/EventBus.js';
import { AuthEngine } from '../auth/AuthEngine.js';
import { PendingApprovalRegistry } from '../auth/PendingApprovalRegistry.js';
import { ToolRegistry } from './ToolRegistry.js';
import { RuntimeRegistry } from '../runtime/RuntimeRegistry.js';
import { MockRuntime } from '../runtime/MockRuntime.js';
import { MessageRouter } from '../runtime/MessageRouter.js';
import { communicateTool } from './communicate-tool.js';
import type { ToolContext } from './Tool.js';

async function setup(dir: string) {
  const storage = new FileStorage(dir);
  await storage.writeJson('collective/participants/agent-a.json', {
    id: 'agent-a',
    name: 'A',
    type: 'mock',
    tools: { communicate: 'auto' },
    responses: [],
    status: 'active',
  });
  await storage.writeJson('collective/participants/agent-b.json', {
    id: 'agent-b',
    name: 'B',
    type: 'mock',
    tools: {},
    responses: ['B replies'],
    status: 'active',
  });
  const collective = await Collective.load(storage);
  const store = new FileConversationStore(storage);
  const eventBus = new EventBus();
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', (id) => new MockRuntime(id));
  const router = new MessageRouter(store, registry, collective, eventBus);

  const context = {
    participant: collective.getOrThrow('agent-a'),
    conversationId: 'seed',
    collective,
    config: { version: '2' },
    eventBus,
    storage,
    workspaceRoot: dir,
    communicationDepth: 0,
    toolRegistry: new ToolRegistry(),
    authEngine: new AuthEngine(),
    pendingApprovalRegistry: new PendingApprovalRegistry(),
    messageRouter: router,
  } as unknown as ToolContext;

  return { context, router };
}

describe('communicate tool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-comm-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends a synchronous message and returns the recipient response', async () => {
    const { context } = await setup(dir);
    const result = await communicateTool.execute({ to: 'agent-b', message: 'hi B' }, context);
    expect(result.status).toBe('success');
    expect((result.data as { response: string }).response).toBe('B replies');
  });

  it('returns dispatched for fire-and-forget', async () => {
    const { context, router } = await setup(dir);
    const result = await communicateTool.execute(
      { to: 'agent-b', message: 'async', replyTo: 'agent-a' },
      context,
    );
    expect(result.status).toBe('success');
    expect((result.data as { status: string }).status).toBe('dispatched');
    await router.drain();
  });

  it('returns a tool error when messageRouter is missing', async () => {
    const { context } = await setup(dir);
    const broken = { ...context, messageRouter: undefined } as unknown as ToolContext;
    const result = await communicateTool.execute({ to: 'agent-b', message: 'x' }, broken);
    expect(result.status).toBe('error');
  });
});
