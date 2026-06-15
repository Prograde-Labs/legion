import { MemoryStorage } from '../storage/MemoryStorage.js';
import { Collective } from '../collective/Collective.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { FileCredentialStore } from '../credentials/FileCredentialStore.js';
import {
  createAgentTool,
  retireAgentTool,
  listParticipantsTool,
  getConversationTool,
  setToolPolicyTool,
  setCredentialTool,
} from './management-tools.js';
import type { ToolContext } from './Tool.js';

async function makeContext() {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  const conversationStore = new FileConversationStore(storage);
  const context = {
    participant: collective.getOrThrow('operator'),
    collective,
    conversationStore,
    workspaceRoot: '/tmp',
  } as unknown as ToolContext;
  return { context, collective, conversationStore };
}

describe('management tools', () => {
  it('create_agent adds a new agent participant', async () => {
    const { context, collective } = await makeContext();
    const result = await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 'be helpful',
        model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
        tools: { communicate: 'auto' },
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.type).toBe('agent');
  });

  it('list_participants returns the roster', async () => {
    const { context } = await makeContext();
    const result = await listParticipantsTool.execute({}, context);
    expect(result.status).toBe('success');
    expect((result.data as { id: string }[]).some((p) => p.id === 'operator')).toBe(true);
  });

  it('retire_agent retires an agent', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 's',
        model: { provider: 'openai-compatible', model: 'm' },
        tools: {},
      },
      context,
    );
    const result = await retireAgentTool.execute({ id: 'agent-x' }, context);
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.status).toBe('retired');
  });

  it('set_tool_policy updates a participant policy', async () => {
    const { context, collective } = await makeContext();
    await createAgentTool.execute(
      {
        id: 'agent-x',
        name: 'X',
        systemPrompt: 's',
        model: { provider: 'openai-compatible', model: 'm' },
        tools: {},
      },
      context,
    );
    const result = await setToolPolicyTool.execute(
      { participantId: 'agent-x', tool: 'file_read', policy: 'auto' },
      context,
    );
    expect(result.status).toBe('success');
    expect(collective.get('agent-x')?.tools['file_read']).toBe('auto');
  });

  it('get_conversation returns the active chain of a conversation', async () => {
    const { context, conversationStore } = await makeContext();
    const conv = await conversationStore.create({
      schemaVersion: '2.0',
      activeBranchHead: '',
      messages: {},
    });
    await conversationStore.appendMessage(conv.id, {
      id: 'm1',
      parentId: null,
      conversationId: conv.id,
      senderId: 'operator',
      recipientId: 'agent-x',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: new Date().toISOString(),
    });
    await conversationStore.updateHead(conv.id, 'm1');
    const result = await getConversationTool.execute({ conversationId: conv.id }, context);
    expect(result.status).toBe('success');
    expect((result.data as { messages: unknown[] }).messages.length).toBe(1);
  });

  it('create_agent rejects a duplicate id with a tool error', async () => {
    const { context } = await makeContext();
    const args = {
      id: 'operator',
      name: 'dup',
      systemPrompt: 's',
      model: { provider: 'p', model: 'm' },
      tools: {},
    };
    const result = await createAgentTool.execute(args, context);
    expect(result.status).toBe('error');
  });

  it('set_credential hashes and stores a participant secret', async () => {
    const { context } = await makeContext();
    const credentialStore = new FileCredentialStore(new MemoryStorage());
    const ctx = { ...context, credentialStore } as unknown as ToolContext;
    const result = await setCredentialTool.execute(
      { participantId: 'operator', secret: 'hunter2' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(await credentialStore.verify('operator', 'hunter2')).toBe(true);
  });

  it('set_credential errors when no credentialStore is in context', async () => {
    const { context } = await makeContext();
    const result = await setCredentialTool.execute(
      { participantId: 'operator', secret: 'x' },
      context,
    );
    expect(result.status).toBe('error');
  });
});
