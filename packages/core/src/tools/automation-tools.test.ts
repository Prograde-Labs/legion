import { Collective } from '../collective/Collective.js';
import { appendMessage, compactRange } from '../conversation/conversation-ops.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import type { ToolContext } from './Tool.js';
import { createCompactConversationTool } from './automation-tools.js';

async function setup() {
  const storage = new MemoryStorage();
  const collective = await Collective.load(storage);
  await collective.seedDefaultsIfEmpty();
  await collective.add({
    id: 'agent',
    name: 'Agent',
    type: 'agent',
    tools: {},
    systemPrompt: 'test',
    model: { model: 'test' },
    maxIterations: 20,
    middleware: [
      {
        id: 'auto-compaction',
        type: 'builtin:auto-compaction',
        config: { summarizerParticipantId: 'summarizer' },
      },
    ],
  });
  const conversationStore = new FileConversationStore(storage);
  let parent = await conversationStore.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  for (const [id, role, content] of [
    ['m1', 'user', 'first'],
    ['m2', 'assistant', 'second'],
    ['m3', 'user', 'recent'],
  ] as const) {
    parent = appendMessage(parent, {
      id,
      senderId: role === 'user' ? 'operator' : 'agent',
      recipientId: role === 'user' ? 'agent' : 'operator',
      role,
      content,
    });
  }
  await conversationStore.replaceForTesting(parent);
  const context = {
    participant: collective.getOrThrow('agent'),
    collective,
    conversationId: parent.id,
    conversationStore,
  } as ToolContext;
  return { context, conversationStore, parent };
}

const args = (conversationId: string, messageIds = ['m1', 'm2']) => ({
  conversationId,
  messageIds,
  middlewareInstanceId: 'auto-compaction',
  parentMessageId: messageIds[messageIds.length - 1],
});

describe('compact_conversation automation tool', () => {
  it('archives helper and compacts parent with its summary watermark', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'success',
      response: 'compressed context',
    });
    const tool = createCompactConversationTool();

    const result = await tool.execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result.status).toBe('success');
    const helperId = send.mock.calls[0][0].conversationId;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: 'agent',
        recipientId: 'summarizer',
        conversationId: helperId,
        message: expect.stringContaining('user: first'),
      }),
    );
    const helper = await conversationStore.load(helperId);
    expect(helper).toEqual(
      expect.objectContaining({
        status: 'archived',
        tags: ['compaction'],
        origin: {
          kind: 'middleware',
          participantId: 'agent',
          middlewareInstanceId: 'auto-compaction',
          parentConversationId: parent.id,
          parentMessageId: 'm2',
        },
      }),
    );
    const saved = await conversationStore.load(parent.id);
    const summary = Object.values(saved!.messages).find(
      (message) => message.type === 'summary' && message.content === 'compressed context',
    );
    expect(summary?.compacts).toEqual(['m1', 'm2']);
    expect(saved?.middlewareState?.agent?.['auto-compaction']).toEqual({
      summaryMessageId: summary?.id,
    });
    expect(result.data).toEqual({ summaryMessageId: summary?.id });
  });

  it('archives helper without mutating parent when summarizer fails', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'error',
      error: 'summarizer failed',
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result).toEqual({ status: 'error', error: 'summarizer failed' });
    expect((await conversationStore.load(parent.id))?.messages['m1'].status).toBe('active');
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('rejects noncontiguous active prefix before creating helper or sending', async () => {
    const { context, parent } = await setup();
    const send = vi.fn();

    const result = await createCompactConversationTool().execute(args(parent.id, ['m1', 'm3']), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result.status).toBe('error');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not compact again when concurrent compaction keeps active head unchanged', async () => {
    const { context, conversationStore, parent } = await setup();
    const send = vi.fn().mockImplementation(async () => {
      await conversationStore.mutate(parent.id, (current) =>
        compactRange(current, ['m1', 'm2'], 'concurrent summary'),
      );
      return { conversationId: 'ignored', status: 'success', response: 'stale summary' };
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    expect(result.status).toBe('error');
    const saved = await conversationStore.load(parent.id);
    expect(
      Object.values(saved!.messages).filter((message) => message.type === 'summary'),
    ).toHaveLength(1);
    expect(saved?.middlewareState).toBeUndefined();
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('archives helper without compacting parent when signal aborts during summary', async () => {
    const { context, conversationStore, parent } = await setup();
    const controller = new AbortController();
    const send = vi.fn().mockImplementation(() => {
      controller.abort();
      return { conversationId: 'ignored', status: 'success', response: 'stale summary' };
    });

    const result = await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
      signal: controller.signal,
    } as ToolContext);

    expect(result.status).toBe('error');
    expect((await conversationStore.load(parent.id))?.messages['m1'].status).toBe('active');
    expect((await conversationStore.load(send.mock.calls[0][0].conversationId))?.status).toBe(
      'archived',
    );
  });

  it('includes provider-visible tool calls and results but not reasoning in transcript', async () => {
    const { context, conversationStore, parent } = await setup();
    const withToolTurn = {
      ...parent,
      messages: {
        ...parent.messages,
        m2: {
          ...parent.messages['m2'],
          reasoning: 'private chain of thought',
          toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { query: 'weather' } }],
          toolResults: [
            { id: 'call-1', name: 'lookup', result: { status: 'success', data: { temp: 72 } } },
          ],
        },
      },
    };
    await conversationStore.replaceForTesting(withToolTurn);
    const send = vi.fn().mockResolvedValue({
      conversationId: 'ignored',
      status: 'success',
      response: 'compressed context',
    });

    await createCompactConversationTool().execute(args(parent.id), {
      ...context,
      messageRouter: { send },
    } as ToolContext);

    const prompt = send.mock.calls[0][0].message;
    expect(prompt).toContain('assistant: second');
    expect(prompt).toContain('tool_call lookup: {"query":"weather"}');
    expect(prompt).toContain('tool_result lookup: {"status":"success","data":{"temp":72}}');
    expect(prompt).not.toContain('private chain of thought');
  });
});
