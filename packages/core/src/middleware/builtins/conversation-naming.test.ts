import type { ConversationData, MessageData } from '@legion/types';
import type { ConversationStore } from '../../conversation/ConversationStore.js';
import { createConversationNamingMiddleware } from './conversation-naming.js';

function message(id: string, role: 'user' | 'assistant'): MessageData {
  return {
    id,
    parentId: null,
    conversationId: 'c',
    senderId: role === 'user' ? 'user' : 'agent',
    recipientId: role === 'user' ? 'agent' : 'user',
    role,
    content: id,
    status: 'active',
    timestamp: id,
  };
}

const config = {
  namingParticipantId: 'namer',
  maximumLength: 60,
  guidance: 'Use a noun phrase.',
  scope: 'participant' as const,
  excludedTags: [],
};

describe('conversation naming middleware', () => {
  function definition(overrides: Partial<ConversationData> = {}) {
    const conversationStore = {
      load: vi.fn().mockResolvedValue({
        id: 'c',
        schemaVersion: '2.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        activeBranchHead: 'm2',
        messages: {},
        ...overrides,
      }),
    } as unknown as ConversationStore;
    return createConversationNamingMiddleware(conversationStore);
  }

  it('requests naming after first persisted assistant response', async () => {
    const result = await definition().hooks.afterSend!({
      participant: { id: 'agent' },
      instance: { id: 'naming-1' },
      config,
      conversationId: 'c',
      activeChain: [message('m1', 'user'), message('m2', 'assistant')],
      message: message('m2', 'assistant'),
      actions: [],
    } as never);
    expect(result).toEqual({
      kind: 'tool',
      requestId: 'title:c:agent:participant',
      tool: 'generate_conversation_title',
      arguments: {
        conversationId: 'c',
        namingParticipantId: 'namer',
        middlewareInstanceId: 'naming-1',
        parentMessageId: 'm2',
        scope: 'participant',
        attachedParticipantId: 'agent',
        maximumLength: 60,
        guidance: 'Use a noun phrase.',
      },
    });
  });

  it('supports post-response ownership and shared scope', async () => {
    const result = await definition().hooks.afterReceive!({
      participant: { id: 'user' },
      instance: { id: 'naming-user' },
      config: { ...config, scope: 'shared' },
      conversationId: 'c',
      mode: 'post_response',
      activeChain: [message('m1', 'user'), message('m2', 'assistant')],
      message: message('m2', 'assistant'),
      actions: [],
    } as never);
    expect(result).toEqual(
      expect.objectContaining({ kind: 'tool', requestId: 'title:c:user:shared' }),
    );
  });

  it('skips later responses, existing scoped titles, helper tags, and pre-runtime receive', async () => {
    const base = {
      participant: { id: 'agent' },
      instance: { id: 'naming-1' },
      config,
      conversationId: 'c',
      activeChain: [
        message('m1', 'user'),
        message('m2', 'assistant'),
        message('m3', 'user'),
        message('m4', 'assistant'),
      ],
      message: message('m4', 'assistant'),
      actions: [],
    } as never;
    await expect(definition().hooks.afterSend!(base)).resolves.toEqual({ kind: 'continue' });
    await expect(
      definition({ titles: { agent: 'Existing' } }).hooks.afterSend!({
        ...base,
        activeChain: [message('m1', 'user'), message('m2', 'assistant')],
      } as never),
    ).resolves.toEqual({ kind: 'continue' });
    await expect(
      definition({ tags: ['conversation-title'] }).hooks.afterSend!({
        ...base,
        activeChain: [message('m1', 'user'), message('m2', 'assistant')],
      } as never),
    ).resolves.toEqual({ kind: 'continue' });
    await expect(
      definition().hooks.afterReceive!({ ...base, mode: 'pre_runtime' } as never),
    ).resolves.toEqual({ kind: 'continue' });
  });
});
