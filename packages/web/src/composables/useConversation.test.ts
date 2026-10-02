import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick, ref } from 'vue';
import type { StreamChunk } from '@legion-collective/types';

let communicateOnChunk: ((chunk: StreamChunk) => void) | undefined;
let conversationOnChunk: ((chunk: StreamChunk) => void) | undefined;
let communicateCancel: ReturnType<typeof vi.fn> | undefined;
const streamDone = ref(false);
const streamError = ref<string | null>(null);
const streamResult = ref<unknown>(null);
const streamActive = ref(false);
const streamCancelling = ref(false);
const connectionId = ref<string | null>('conn-1');

vi.mock('./useToolStream.js', () => ({
  useToolStream: vi.fn(
    (name: string, _args: unknown, options?: { onChunk?: (chunk: StreamChunk) => void }) => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      if (name === 'communicate') {
        communicateOnChunk = options?.onChunk;
        communicateCancel = cancel;
      }
      if (name === 'watch_conversation') conversationOnChunk = options?.onChunk;
      return {
        start: vi.fn().mockResolvedValue(undefined),
        cancel,
        chunks: ref([]),
        done: streamDone,
        error: streamError,
        active: streamActive,
        cancelling: streamCancelling,
        conversationId: ref(null),
        result: streamResult,
      };
    },
  ),
}));
vi.mock('./useWebSocket.js', () => ({
  useWebSocket: vi.fn(() => ({
    getConnectionId: vi.fn(() => connectionId.value),
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
  communicateCancel = undefined;
  streamDone.value = false;
  streamError.value = null;
  streamResult.value = null;
  streamActive.value = false;
  streamCancelling.value = false;
  connectionId.value = 'conn-1';
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
    const { send, streamingText, streamingReasoning, isThinking, error } = useConversation(null);
    await send('agent-1', 'question', 'operator');
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'partial thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'partial answer' });

    streamError.value = 'stream failed';
    await nextTick();

    expect(streamingReasoning.value).toBe('');
    expect(streamingText.value).toBe('');
    expect.soft(isThinking.value).toBe(false);
    expect.soft(error.value).toBe('stream failed');

    await send('agent-1', 'retry', 'operator');

    expect(error.value).toBeNull();
    expect(isThinking.value).toBe(true);
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

  it('replaces provisional text and reasoning with an authoritative snapshot', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { streamingText, streamingReasoning } = useConversation(null);

    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'old reasoning' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'old answer' });
    communicateOnChunk?.({
      type: 'message_snapshot',
      content: 'rewritten answer',
      reasoning: 'rewritten reasoning',
    });

    expect(streamingText.value).toBe('rewritten answer');
    expect(streamingReasoning.value).toBe('rewritten reasoning');
  });

  it('uses an omitted snapshot reasoning field to retract provisional reasoning', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { streamingText, streamingReasoning } = useConversation(null);

    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'remove me' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'remove me too' });
    communicateOnChunk?.({ type: 'message_snapshot', content: '' });

    expect(streamingText.value).toBe('');
    expect(streamingReasoning.value).toBe('');
  });

  it('appends deltas to the latest authoritative snapshot', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { streamingText, streamingReasoning } = useConversation(null);

    communicateOnChunk?.({ type: 'message_snapshot', content: 'base', reasoning: 'why' });
    communicateOnChunk?.({ type: 'text_delta', delta: ' plus' });
    communicateOnChunk?.({ type: 'reasoning_delta', delta: ' now' });

    expect(streamingText.value).toBe('base plus');
    expect(streamingReasoning.value).toBe('why now');
  });

  it('exposes the communicate stream active state as isStreaming', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { isStreaming } = useConversation(null);

    expect(isStreaming.value).toBe(false);
    streamActive.value = true;
    expect(isStreaming.value).toBe(true);
  });

  it('exposes the communicate stream cancellation state', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { isCancelling } = useConversation(null);

    expect(isCancelling.value).toBe(false);
    streamCancelling.value = true;
    expect(isCancelling.value).toBe(true);
  });

  it('reloads an existing conversation before restarting watchers after reconnect', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { useToolStream } = await import('./useToolStream.js');
    useConversation('c1');
    const watcherStarts = vi
      .mocked(useToolStream)
      .mock.results.slice(-2)
      .map((result) => result.value.start);
    executeMock.mockClear();
    watcherStarts.forEach((start) => start.mockClear());

    connectionId.value = null;
    await nextTick();
    connectionId.value = 'conn-2';
    await nextTick();
    await vi.waitFor(() =>
      expect(watcherStarts.every((start) => start.mock.calls.length > 0)).toBe(true),
    );

    expect(executeMock).toHaveBeenCalledWith('get_conversation', { conversationId: 'c1' });
    expect(
      watcherStarts.every(
        (start) => start.mock.invocationCallOrder[0] > executeMock.mock.invocationCallOrder[0],
      ),
    ).toBe(true);
  });

  it('stop cancels the stream and clears thinking and streaming state', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { send, stop, streamingText, streamingReasoning, isThinking } = useConversation(null);

    await send('agent-1', 'question', 'operator');
    streamActive.value = true;
    communicateOnChunk?.({ type: 'reasoning_delta', delta: 'partial thought' });
    communicateOnChunk?.({ type: 'text_delta', delta: 'partial answer' });
    expect(isThinking.value).toBe(true);

    await stop();

    expect(communicateCancel).toHaveBeenCalledTimes(1);
    expect(streamingText.value).toBe('');
    expect(streamingReasoning.value).toBe('');
    expect(isThinking.value).toBe(false);
  });

  it('reloads an existing conversation after stopping its stream', async () => {
    const { useConversation } = await import('./useConversation.js');
    executeMock.mockResolvedValueOnce(conversationResponse);
    const { stop } = useConversation('c1');

    await stop();

    expect(executeMock).toHaveBeenCalledWith('get_conversation', { conversationId: 'c1' });
  });

  it('exposes the conversation id when a new conversation is cancelled before output', async () => {
    const { useConversation } = await import('./useConversation.js');
    const { sentConversationId } = useConversation(null);

    streamResult.value = {
      status: 'error',
      error: 'Runtime cancelled',
      data: { conversationId: 'conv-cancelled' },
    };
    streamDone.value = true;
    await nextTick();

    expect(sentConversationId.value).toBe('conv-cancelled');
  });
});
