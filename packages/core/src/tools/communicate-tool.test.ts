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

  it('creates a new conversation when no conversationId is supplied (does not join caller conversation)', async () => {
    const { context } = await setup(dir);
    // Pre-create the caller's 'seed' conversation so the implicit-join bug
    // would actually return 'seed' (and thus be detectable).
    const store = new FileConversationStore(new FileStorage(dir));
    await store.save({
      id: 'seed',
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await communicateTool.execute({ to: 'agent-b', message: 'hi B' }, context);
    expect(result.status).toBe('success');
    const convId = (result.data as { conversationId: string }).conversationId;
    expect(convId).not.toBe('seed');
    // A new conversation should have been created
    expect(convId).toMatch(/^conv-/);
  });

  it('joins explicit conversationId when supplied', async () => {
    const { context } = await setup(dir);
    // Pre-create 'explicit-conv' so the router joins it instead of creating a new one.
    const store = new FileConversationStore(new FileStorage(dir));
    await store.save({
      id: 'explicit-conv',
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await communicateTool.execute(
      { to: 'agent-b', message: 'hi', conversationId: 'explicit-conv' },
      context,
    );
    expect(result.status).toBe('success');
    const convId = (result.data as { conversationId: string }).conversationId;
    expect(convId).toBe('explicit-conv');
  });

  it('surfaces pending_approval result when the recipient runtime returns one', async () => {
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
      responses: [],
      status: 'active',
    });
    const collective = await Collective.load(storage);
    const storeB = new FileConversationStore(storage);
    const eventBus = new EventBus();
    const registry = new RuntimeRegistry();

    // B's runtime returns pending_approval
    const pendingRuntime = {
      async handle(): Promise<import('../runtime/Runtime.js').RuntimeResult> {
        return {
          kind: 'pending_approval',
          approvalRequests: [
            {
              approvalId: 'appr-1',
              conversationId: 'c1',
              requesterId: 'agent-b',
              tool: 'write_file',
              args: {},
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    };
    registry.registerFactory('mock', () => pendingRuntime);

    const router = new MessageRouter(storeB, registry, collective, eventBus);
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
    } as unknown as import('./Tool.js').ToolContext;

    const result = await communicateTool.execute(
      { to: 'agent-b', message: 'do the thing' },
      context,
    );
    expect(result.status).toBe('pending_approval');
    const data = result.data as { approvalRequests: { tool: string }[] };
    expect(data.approvalRequests[0].tool).toBe('write_file');
  });
});
