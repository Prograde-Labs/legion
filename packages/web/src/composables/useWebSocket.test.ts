import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the public interface only — not the internal WebSocket construction
describe('useWebSocket', () => {
  beforeEach(() => {
    // Reset module-level singleton state between tests by reimporting
    vi.resetModules();
  });

  it('exports connect, disconnect, onMessage, send', async () => {
    const ws = await import('./useWebSocket.js');
    expect(typeof ws.useWebSocket).toBe('function');
    const { connect, disconnect, onMessage, send } = ws.useWebSocket();
    expect(typeof connect).toBe('function');
    expect(typeof disconnect).toBe('function');
    expect(typeof onMessage).toBe('function');
    expect(typeof send).toBe('function');
  });

  it('onMessage returns an unsubscribe function', async () => {
    const { useWebSocket } = await import('./useWebSocket.js');
    const { onMessage } = useWebSocket();
    const unsub = onMessage(() => {});
    expect(typeof unsub).toBe('function');
    unsub(); // should not throw
  });

  it('sets connectionId when connected frame arrives', async () => {
    vi.resetModules();

    vi.doMock('./useAuth.js', () => ({
      useAuth: () => ({ getToken: () => 'tok-1', logout: () => {} }),
    }));
    vi.doMock('../router/index.js', () => ({
      router: { push: vi.fn() },
    }));

    class FakeWS {
      static instances: FakeWS[] = [];
      static OPEN = 1;
      readyState = 1;
      listeners: Record<string, EventListener[]> = {};
      sent: string[] = [];
      constructor(public url: string) {
        FakeWS.instances.push(this);
      }
      addEventListener(type: string, listener: EventListener) {
        (this.listeners[type] ??= []).push(listener);
      }
      dispatchEvent(ev: Event) {
        for (const l of this.listeners[ev.type] ?? []) l(ev);
        return true;
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
      }
    }

    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });

    const { useWebSocket } = await import('./useWebSocket.js');
    const api = useWebSocket();
    api.connect();

    const sock = FakeWS.instances[FakeWS.instances.length - 1];
    expect(sock).toBeDefined();

    // Dispatch open event
    sock.dispatchEvent({ type: 'open' } as unknown as Event);

    // Server sends connected frame with connectionId
    sock.dispatchEvent({
      type: 'message',
      data: JSON.stringify({
        type: 'connected',
        participantId: 'op-1',
        connectionId: 'conn-abc-123',
      }),
    } as unknown as Event);

    expect(api.getConnectionId()).toBe('conn-abc-123');

    vi.unstubAllGlobals();
  });

  it('delivers a stream terminal that arrives before handler registration', async () => {
    vi.doMock('./useAuth.js', () => ({
      useAuth: () => ({ getToken: () => 'tok-1', logout: () => {} }),
    }));
    vi.doMock('../router/index.js', () => ({ router: { push: vi.fn() } }));

    class FakeWS {
      static instances: FakeWS[] = [];
      static OPEN = 1;
      readyState = 1;
      listeners: Record<string, EventListener[]> = {};
      constructor() {
        FakeWS.instances.push(this);
      }
      addEventListener(type: string, listener: EventListener) {
        (this.listeners[type] ??= []).push(listener);
      }
      dispatchEvent(ev: Event) {
        for (const listener of this.listeners[ev.type] ?? []) listener(ev);
        return true;
      }
      send() {}
      close() {}
    }

    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
    const { useWebSocket } = await import('./useWebSocket.js');
    const api = useWebSocket();
    api.connect();
    const socket = FakeWS.instances[0];
    socket.dispatchEvent({
      type: 'message',
      data: JSON.stringify({
        type: 'stream:chunk',
        streamId: 'stream-early',
        data: { type: 'stream:done', result: { status: 'success' } },
      }),
    } as unknown as Event);
    const handler = vi.fn();

    api.onStreamChunk('stream-early', handler);

    expect(handler).toHaveBeenCalledWith({
      type: 'stream:done',
      result: { status: 'success' },
    });
    vi.unstubAllGlobals();
  });

  it('terminates registered streams when the socket closes', async () => {
    vi.doMock('./useAuth.js', () => ({
      useAuth: () => ({ getToken: () => 'tok-1', logout: () => {} }),
    }));
    vi.doMock('../router/index.js', () => ({ router: { push: vi.fn() } }));

    class FakeWS {
      static instances: FakeWS[] = [];
      static OPEN = 1;
      readyState = 1;
      listeners: Record<string, EventListener[]> = {};
      constructor() {
        FakeWS.instances.push(this);
      }
      addEventListener(type: string, listener: EventListener) {
        (this.listeners[type] ??= []).push(listener);
      }
      dispatchEvent(ev: Event) {
        for (const listener of this.listeners[ev.type] ?? []) listener(ev);
        return true;
      }
      send() {}
      close() {}
    }

    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
    vi.useFakeTimers();
    const { useWebSocket } = await import('./useWebSocket.js');
    const api = useWebSocket();
    api.connect();
    const handler = vi.fn();
    api.onStreamChunk('stream-active', handler);

    FakeWS.instances[0].dispatchEvent({ type: 'close', code: 1006 } as unknown as Event);

    vi.useRealTimers();
    expect(handler).toHaveBeenCalledWith({
      type: 'stream:error',
      error: 'WebSocket disconnected',
    });
    vi.unstubAllGlobals();
  });

  it('stops reconnecting and calls logout on close code 4401', async () => {
    vi.resetModules();

    const logoutMock = vi.fn();
    vi.doMock('./useAuth.js', () => ({
      useAuth: () => ({ getToken: () => 'dead-token', logout: logoutMock }),
    }));
    const pushMock = vi.fn();
    vi.doMock('../router/index.js', () => ({
      router: { push: pushMock },
    }));

    // Fake WebSocket that records instances and supports event dispatch
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      static OPEN = 1;
      static CLOSED = 3;
      static CONNECTING = 0;
      static CLOSING = 2;
      readyState = 0;
      listeners: Record<string, EventListener[]> = {};
      constructor(public url: string) {
        FakeWebSocket.instances.push(this);
      }
      addEventListener(type: string, listener: EventListener) {
        (this.listeners[type] ??= []).push(listener);
      }
      dispatchEvent(ev: Event) {
        for (const l of this.listeners[ev.type] ?? []) l(ev);
        return true;
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }

    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });
    vi.useFakeTimers();

    const { useWebSocket } = await import('./useWebSocket.js');
    useWebSocket().connect();

    // Wait a tick for sync construction
    await vi.advanceTimersByTimeAsync(10);

    const instancesBeforeClose = FakeWebSocket.instances.length;
    const wsInstance = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(wsInstance).toBeDefined();
    // happy-dom CloseEvent doesn't honor the `code` init field, so build a plain event
    const closeEv = { type: 'close', code: 4401 } as unknown as Event;
    wsInstance.dispatchEvent(closeEv);

    // Advance well past the reconnect backoff (1000ms) to allow any
    // scheduled reconnect to fire if one had been queued.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(logoutMock).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith('/login');

    // Verify reconnect was stopped: no new WebSocket instance should have
    // been created after the 4401 close.
    expect(FakeWebSocket.instances.length).toBe(instancesBeforeClose);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
