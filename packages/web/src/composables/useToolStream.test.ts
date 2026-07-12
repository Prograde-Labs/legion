import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, watch } from 'vue';

const mocks = vi.hoisted(() => ({
  connectionId: null as string | null,
  token: null as string | null,
}));

vi.mock('./useWebSocket.js', () => ({
  useWebSocket: () => ({
    getConnectionId: () => mocks.connectionId,
    onStreamChunk: vi.fn(() => vi.fn()),
  }),
}));

vi.mock('./useAuth.js', () => ({
  useAuth: () => ({ getToken: () => mocks.token }),
}));

beforeEach(() => {
  mocks.connectionId = null;
  mocks.token = null;
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
});
