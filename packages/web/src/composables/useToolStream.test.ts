import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, watch } from 'vue';

const mocks = vi.hoisted(() => ({
  connectionId: null as string | null,
  token: null as string | null,
  streamChunkHandler: null as ((chunk: { type: string; result?: unknown }) => void) | null,
  streamChunkHandlers: [] as Array<(chunk: { type: string; result?: unknown }) => void>,
  streamUnregister: vi.fn(),
}));

vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    getConnectionId: () => mocks.connectionId,
    onStreamChunk: vi.fn(
      (_streamId: string, handler: (chunk: { type: string; result?: unknown }) => void) => {
        mocks.streamChunkHandler = handler;
        mocks.streamChunkHandlers.push(handler);
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
  mocks.streamChunkHandlers = [];
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
        vi.fn().mockImplementation((input: RequestInfo | URL) =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve(
                String(input).includes('stream=false')
                  ? { result: { status: 'success', data: { cancelled: true } } }
                  : { streamId: 'stream-1', conversationId: 'c1' },
              ),
          }),
        ),
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
      expect(stream.cancelling.value).toBe(true);
      expect(stream.active.value).toBe(true);
      mocks.streamChunkHandler?.({ type: 'stream:done' });
      await cancellation;
      expect(stream.active.value).toBe(false);
      expect(stream.cancelling.value).toBe(false);
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

      expect(stream.active.value).toBe(true);
      expect(stream.cancelling.value).toBe(true);
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

    it('reports a failed cancellation request while keeping the original stream active', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ streamId: 'stream-1', conversationId: 'c1' }),
        } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response);
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
      await expect(stream.cancel()).rejects.toThrow('Cancel failed: 500');

      expect(mocks.streamUnregister).not.toHaveBeenCalled();
      expect(stream.active.value).toBe(true);
      expect(stream.cancelling.value).toBe(false);
      expect(stream.error.value).toBe('Cancel failed: 500');
      wrapper.unmount();
    });

    it('reports a logical cancellation error while keeping the original stream active', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ streamId: 'stream-1', conversationId: 'c1' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ result: { status: 'error', error: 'Not found' } }),
        } as Response);
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
      await expect(stream.cancel()).rejects.toThrow('Cancel failed: Not found');

      expect(stream.active.value).toBe(true);
      expect(stream.cancelling.value).toBe(false);
      expect(mocks.streamUnregister).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it('accepts an already-complete result when the terminal arrived first', async () => {
      let resolveCancellation!: (response: Response) => void;
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ streamId: 'stream-1', conversationId: 'c1' }),
        } as Response)
        .mockReturnValueOnce(
          new Promise<Response>((resolve) => {
            resolveCancellation = resolve;
          }),
        );
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
      mocks.streamChunkHandler?.({ type: 'stream:done', result: { status: 'success' } });
      resolveCancellation({
        ok: true,
        json: () =>
          Promise.resolve({
            result: { status: 'error', error: 'Stream not found or already complete' },
          }),
      } as Response);

      await expect(cancellation).resolves.toBeUndefined();
      expect(stream.done.value).toBe(true);
      expect(stream.error.value).toBeNull();
      wrapper.unmount();
    });

    it('ignores a stale terminal handler after a new stream starts', async () => {
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
      const firstHandler = mocks.streamChunkHandlers[0];
      const cancellation = stream.cancel();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      firstHandler({ type: 'stream:done', result: { status: 'success' } });
      await cancellation;
      await stream.start();

      firstHandler({ type: 'stream:error', error: 'stale' } as never);

      expect(stream.active.value).toBe(true);
      expect(stream.error.value).toBeNull();
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
