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
});
