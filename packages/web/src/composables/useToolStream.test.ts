import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, watch } from 'vue';

const mocks = vi.hoisted(() => ({
  connectionId: null as string | null,
  token: null as string | null,
  streamChunkHandler: null as ((chunk: { type: string; result?: unknown }) => void) | null,
  streamUnregister: vi.fn(),
}));

vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    getConnectionId: () => mocks.connectionId,
    onStreamChunk: vi.fn(
      (_streamId: string, handler: (chunk: { type: string; result?: unknown }) => void) => {
        mocks.streamChunkHandler = handler;
        return mocks.streamUnregister;
      },
    ),
  }),
}));

vi.mock('./useAuth.js', () => ({
  useAuth: () => ({ getToken: () => mocks.token }),
}));

beforeEach(() => {
  mocks.connectionId = null;
  mocks.token = null;
  mocks.streamChunkHandler = null;
  mocks.streamUnregister.mockReset();
});

describe('useToolStream', () => {
  it.each([
    {
      name: 'disconnected',
      prepare: () => {
        mocks.connectionId = null;
        mocks.token = 'token';
      },
      message: 'Not connected — connectionId unavailable',
    },
    {
      name: 'unauthenticated',
      prepare: () => {
        mocks.connectionId = 'connection-1';
        mocks.token = null;
      },
      message: 'Not authenticated',
    },
  ])('reactively reports consecutive identical $name failures', async ({ prepare, message }) => {
    const { useToolStream } = await import('./useToolStream.js');
    prepare();
    let stream!: ReturnType<typeof useToolStream>;
    const wrapper = mount(
      defineComponent({
        setup() {
          stream = useToolStream('communicate');
          return () => null;
        },
      }),
    );
    const transitions: Array<string | null> = [];
    const stop = watch(stream.error, (value) => transitions.push(value), { flush: 'sync' });

    await stream.start();
    await stream.start();

    expect(transitions).toEqual([message, null, message]);
    stop();
    wrapper.unmount();
  });

  describe('active state', () => {
    beforeEach(() => {
      mocks.connectionId = 'connection-1';
      mocks.token = 'token';
      mocks.streamChunkHandler = null;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ streamId: 'stream-1', conversationId: 'c1' }),
        }),
      );
    });

    it('is inactive before start and after stream:done', async () => {
      const { useToolStream } = await import('./useToolStream.js');
      let stream!: ReturnType<typeof useToolStream>;
      const wrapper = mount(
        defineComponent({
          setup() {
            stream = useToolStream('communicate');
            return () => null;
          },
        }),
      );

      expect(stream.active.value).toBe(false);

      await stream.start();
      expect(stream.active.value).toBe(true);

      mocks.streamChunkHandler?.({ type: 'stream:done' });
      expect(stream.active.value).toBe(false);
      wrapper.unmount();
    });

    it('becomes inactive after cancel', async () => {
      const { useToolStream } = await import('./useToolStream.js');
      let stream!: ReturnType<typeof useToolStream>;
      const wrapper = mount(
        defineComponent({
          setup() {
            stream = useToolStream('communicate');
            return () => null;
          },
        }),
      );

      await stream.start();
      expect(stream.active.value).toBe(true);

      const cancellation = stream.cancel();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      mocks.streamChunkHandler?.({ type: 'stream:done' });
      await cancellation;
      expect(stream.active.value).toBe(false);
      wrapper.unmount();
    });

    it('keeps the stream handler until a cancelled stream reaches its terminal event', async () => {
      const { useToolStream } = await import('./useToolStream.js');
      let stream!: ReturnType<typeof useToolStream>;
      const wrapper = mount(
        defineComponent({
          setup() {
            stream = useToolStream('communicate');
            return () => null;
          },
        }),
      );

      await stream.start();
      let cancelSettled = false;
      const cancellation = stream.cancel().then(() => {
        cancelSettled = true;
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

      expect(stream.active.value).toBe(false);
      expect(mocks.streamUnregister).not.toHaveBeenCalled();
      expect(cancelSettled).toBe(false);

      mocks.streamChunkHandler?.({
        type: 'stream:done',
        result: { status: 'success', data: { conversationId: 'c1' } },
      });
      await cancellation;

      expect(stream.done.value).toBe(true);
      expect(stream.result.value).toEqual({
        status: 'success',
        data: { conversationId: 'c1' },
      });
      expect(mocks.streamUnregister).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it('keeps the stream handler when the cancellation request fails', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ streamId: 'stream-1', conversationId: 'c1' }),
        } as Response)
        .mockResolvedValueOnce({ ok: false } as Response);
      const { useToolStream } = await import('./useToolStream.js');
      let stream!: ReturnType<typeof useToolStream>;
      const wrapper = mount(
        defineComponent({
          setup() {
            stream = useToolStream('communicate');
            return () => null;
          },
        }),
      );

      await stream.start();
      const cancellation = stream.cancel();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

      expect(mocks.streamUnregister).not.toHaveBeenCalled();
      mocks.streamChunkHandler?.({ type: 'stream:done', result: { status: 'success' } });
      await cancellation;

      expect(mocks.streamUnregister).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it('stays inactive when start fails', async () => {
      const { useToolStream } = await import('./useToolStream.js');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      let stream!: ReturnType<typeof useToolStream>;
      const wrapper = mount(
        defineComponent({
          setup() {
            stream = useToolStream('communicate');
            return () => null;
          },
        }),
      );

      await stream.start();
      expect(stream.active.value).toBe(false);
      wrapper.unmount();
    });
  });
});
