import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick, ref } from 'vue';
import type { StreamChunk } from '@legion/types';

let communicateOnChunk: ((chunk: StreamChunk) => void) | undefined;
let conversationOnChunk: ((chunk: StreamChunk) => void) | undefined;
const streamDone = ref(false);
const streamError = ref<string | null>(null);
const streamResult = ref<unknown>(null);

vi.mock('./useToolStream.js', () => ({
  useToolStream: vi.fn(
    (name: string, _args: unknown, options?: { onChunk?: (chunk: StreamChunk) => void }) => {
      if (name === 'communicate') communicateOnChunk = options?.onChunk;
      if (name === 'watch_conversation') conversationOnChunk = options?.onChunk;
      return {
        start: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        chunks: ref([]),
        done: streamDone,
        error: streamError,
        conversationId: ref(null),
        result: streamResult,
      };
    },
  ),
}));
vi.mock('./useWebSocket.js', () => ({
  useWebSocket: vi.fn(() => ({
    getConnectionId: vi.fn(() => 'conn-1'),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    send: vi.fn(),
    onStreamChunk: vi.fn(() => vi.fn()),
  })),
}));

const executeMock = vi.fn().mockResolvedValue({
  id: 'c1',
  messages: [],
  subThreads: {},
});

const conversationResponse = {
  id: 'c1',
  messages: [
    {
      id: 'm1',
      parentId: null,
      conversationId: 'c1',
      senderId: 'operator',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: '2026-01-01T00:00:00Z',
    },
    {
      id: 'm2',
      parentId: 'm1',
      conversationId: 'c1',
      senderId: 'agent-1',
      recipientId: 'operator',
      role: 'assistant',
      content: 'hello',
      status: 'active',
      timestamp: '2026-01-01T00:00:01Z',
    },
  ],
  subThreads: {},
};

vi.mock('./useExecute.js', () => ({
  useExecute: vi.fn(() => ({ execute: executeMock })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  communicateOnChunk = undefined;
  conversationOnChunk = undefined;
  streamDone.value = false;
  streamError.value = null;
  streamResult.value = null;
});

describe('useConversation', () => {
  it('starts with loading true and no messages', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { messages, loading } = useConversation('c1');
    expect(loading.value).toBe(true);
    expect(messages.value).toHaveLength(0);
  });

  it('loads conversation on mount and populates messages in chain order', async () => {
    const { useConversation } = await import('./useConversation.js');
    executeMock.mockResolvedValueOnce(conversationResponse);
    const { messages, loading, load } = useConversation('c1');
    await load();
    await nextTick();
    expect(loading.value).toBe(false);
    expect(messages.value).toHaveLength(2);
    expect(messages.value[0].role).toBe('user');
    expect(messages.value[1].role).toBe('assistant');
  });

  it('returns empty messages and only communicate stream for null id', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { useToolStream } = await import('./useToolStream.js');
    const { messages } = useConversation(null);
    expect(messages.value).toHaveLength(0);
    expect(useToolStream).toHaveBeenCalledTimes(1);
    expect(useToolStream).toHaveBeenCalledWith(
      'communicate',
      expect.any(Function),
      expect.objectContaining({ cancelOnUnmount: false }),
    );
  });

  it('thinking is false when last chain message is assistant', async () => {
    const { useConversation } = await import('./useConversation.js');
    executeMock.mockResolvedValueOnce(conversationResponse);
    const { load, isThinking } = useConversation('c1');
    // mock returns 'm2' (assistant) as head so thinking should be false
    await load();
    await nextTick();
    expect(isThinking.value).toBe(false);
  });

  it('editMessage executes edit_message and reloads', async () => {
    const { useConversation } = await import('./useConversation.js');
    executeMock
      .mockResolvedValueOnce({ newMessageId: 'm2' })
      .mockResolvedValueOnce({ messages: [] });
    const { editMessage } = useConversation('c1');

    await expect(editMessage('m1', 'changed')).resolves.toBe('m2');

    expect(executeMock).toHaveBeenNthCalledWith(1, 'edit_message', {
      conversationId: 'c1',
      messageId: 'm1',
      newContent: 'changed',
    });
    expect(executeMock).toHaveBeenNthCalledWith(2, 'get_conversation', { conversationId: 'c1' });
  });

  it('generate executes generate and marks local thinking without reload', async () => {
    const { useConversation } = await import('./useConversation.js');
    executeMock.mockResolvedValueOnce({ status: 'success' });
    const { generate, isThinking } = useConversation('c1');

    await generate('agent-x');

    expect(isThinking.value).toBe(true);
    expect(executeMock).toHaveBeenCalledWith('generate', {
      conversationId: 'c1',
      agentId: 'agent-x',
    });
  });

  it('tracks reasoning separately and resets both buffers at iteration boundaries', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { streamingText, streamingReasoning } = useConversation(null);

    communicateOnChunk?.({ type: 'iteration_start', iteration: 0 });
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'tool thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'tool preface' });

    expect(streamingReasoning.value).toBe('tool thought');
    expect(streamingText.value).toBe('tool preface');

    communicateOnChunk?.({ type: 'iteration_start', iteration: 1 });
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'final thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'final answer' });

    expect(streamingReasoning.value).toBe('final thought');
    expect(streamingText.value).toBe('final answer');
  });

  it('clears temporary reasoning and text when stream completes', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { streamingText, streamingReasoning } = useConversation(null);
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'answer' });

    streamDone.value = true;
    await nextTick();

    expect(streamingReasoning.value).toBe('');
    expect(streamingText.value).toBe('');
  });

  it('clears temporary reasoning and text and stops thinking when stream errors', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { send, streamingText, streamingReasoning, isThinking, error } = useConversation('c1');
    await send('agent-1', 'question', 'operator');
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'partial thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'partial answer' });

    streamError.value = 'stream failed';
    await nextTick();

    expect(streamingReasoning.value).toBe('');
    expect(streamingText.value).toBe('');
    expect(isThinking.value).toBe(false);
    expect(error.value).toBeNull();
  });

  it('clears temporary reasoning and text when beginning a new send', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { send, streamingText, streamingReasoning } = useConversation(null);
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'old thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'old answer' });

    await send('agent-1', 'next question', 'operator');

    expect(streamingReasoning.value).toBe('');
    expect(streamingText.value).toBe('');
  });

  it('clears temporary reasoning and text when a message is delivered', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { streamingText, streamingReasoning } = useConversation('c1');
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'answer' });

    conversationOnChunk?.({
      type: 'message:delivered',
      data: { conversationId: 'c1', recipientId: 'operator', messageId: 'm2' },
    });

    expect(streamingReasoning.value).toBe('');
    expect(streamingText.value).toBe('');
  });
});
