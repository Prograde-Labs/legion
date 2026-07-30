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
import { isStreamingTool } from './Tool.js';
import type { ToolContext } from './Tool.js';
import type { LLMChunk } from '@legion/types';

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
  await store.replaceForTesting({
    id: 'seed',
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
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

async function setupStreaming(dir: string) {
  const { context } = await setup(dir);
  const registry = new RuntimeRegistry();
  registry.registerFactory('mock', () => ({
    async handle() {
      return { kind: 'response', content: 'B replies' } as const;
    },
    async *handleStream() {
      yield { type: 'iteration_start', iteration: 0 } as const;
      yield { type: 'reasoning_delta', delta: 'why' } as const;
      yield { type: 'text_delta', delta: 'answer' } as const;
      return { kind: 'response', content: 'B replies' } as const;
    },
  }));
  const router = new MessageRouter(
    new FileConversationStore(context.storage),
    registry,
    context.collective,
    context.eventBus,
  );
  return { context: { ...context, messageRouter: router } as ToolContext, router };
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
    const registry = new ToolRegistry();
    registry.register(communicateTool);
    const result = await registry.execute(
      'communicate',
      { to: 'agent-b', message: 'hi B' },
      context,
    );
    expect(result.status).toBe('success');
    expect((result.data as { response: string }).response).toBe('B replies');
  });

  it('returns dispatched for fire-and-forget', async () => {
    const { context, router } = await setup(dir);
    const registry = new ToolRegistry();
    registry.register(communicateTool);
    const result = await registry.execute(
      'communicate',
      { to: 'agent-b', message: 'async', replyTo: 'agent-a' },
      context,
    );
    expect(result.status).toBe('success');
    expect((result.data as { conversationId: string }).conversationId).toBeDefined();
    expect((result.data as { status: string }).status).toBe('dispatched');
    expect((result.data as { response?: string }).response).toBeUndefined();
    await router.drain();
  });

  it('returns a tool error when messageRouter is missing', async () => {
    const { context } = await setup(dir);
    const broken = { ...context, messageRouter: undefined } as unknown as ToolContext;
    const registry = new ToolRegistry();
    registry.register(communicateTool);
    const result = await registry.execute('communicate', { to: 'agent-b', message: 'x' }, broken);
    expect(result.status).toBe('error');
  });

  it('creates a new conversation when no conversationId is supplied (does not join caller conversation)', async () => {
    const { context } = await setup(dir);
    // Pre-create the caller's 'seed' conversation so the implicit-join bug
    // would actually return 'seed' (and thus be detectable).
    const store = new FileConversationStore(new FileStorage(dir));
    await store.replaceForTesting({
      id: 'seed',
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const registry = new ToolRegistry();
    registry.register(communicateTool);
    const result = await registry.execute(
      'communicate',
      { to: 'agent-b', message: 'hi B' },
      context,
    );
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
    await store.replaceForTesting({
      id: 'explicit-conv',
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const registry = new ToolRegistry();
    registry.register(communicateTool);
    const result = await registry.execute(
      'communicate',
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
    await storeB.replaceForTesting({
      id: 'seed',
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(communicateTool);
    const result = await toolRegistry.execute(
      'communicate',
      { to: 'agent-b', message: 'do the thing' },
      context,
    );
    expect(result.status).toBe('pending_approval');
    const data = result.data as { approvalRequests: { tool: string }[] };
    expect(data.approvalRequests[0].tool).toBe('write_file');
  });
});

describe('communicate as StreamingTool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legion-comm-stream-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('isStreamingTool returns true for communicateTool', () => {
    expect(isStreamingTool(communicateTool)).toBe(true);
  });

  it('stream() yields LLM chunks and returns a ToolResult', async () => {
    const { context } = await setupStreaming(dir);
    const chunks: LLMChunk[] = [];
    const gen = communicateTool.stream({ to: 'agent-b', message: 'hi B' }, context);
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value as LLMChunk);
      next = await gen.next();
    }
    const result = next.value;
    expect(chunks).toEqual([
      { type: 'iteration_start', iteration: 0 },
      { type: 'reasoning_delta', delta: 'why' },
      { type: 'text_delta', delta: 'answer' },
    ]);
    expect(result.status).toBe('success');
    expect((result.data as { response: string }).response).toBe('B replies');
  });

  it('preserves the conversation id when a new conversation is cancelled before output', async () => {
    const { context } = await setup(dir);
    const cancelledContext = {
      ...context,
      messageRouter: {
        async *sendStream() {
          return {
            status: 'error',
            conversationId: 'conv-cancelled',
            error: 'Runtime cancelled',
          } as const;
        },
      },
    } as unknown as ToolContext;

    const result = await communicateTool
      .stream({ to: 'agent-b', message: 'hi B' }, cancelledContext)
      .next();

    expect(result).toEqual({
      done: true,
      value: {
        status: 'error',
        error: 'Runtime cancelled',
        data: { conversationId: 'conv-cancelled' },
      },
    });
  });
});
