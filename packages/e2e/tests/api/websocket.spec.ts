import { test, expect } from '../../fixtures/index.js';

const WS_URL = 'ws://127.0.0.1:4000/ws';

test.describe('WebSocket /ws', () => {
  test('accepts connection with valid token', async ({ authPage }) => {
    const { page, token } = authPage;
    // Navigate to any page to give the browser context a same-origin base
    await page.goto('/');

    const connected = await page.evaluate(
      async ({ wsUrl, tok }: { wsUrl: string; tok: string }) => {
        return new Promise<boolean>((resolve) => {
          const ws = new WebSocket(wsUrl);
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'auth', token: tok }));
          });
          ws.addEventListener('message', (e: MessageEvent<string>) => {
            const msg = JSON.parse(e.data) as { type: string };
            if (msg.type === 'connected') {
              ws.close();
              resolve(true);
            }
          });
          ws.addEventListener('error', () => resolve(false));
          setTimeout(() => resolve(false), 5000);
        });
      },
      { wsUrl: WS_URL, tok: token },
    );

    expect(connected).toBe(true);
  });

  test('rejects connection with no token (closes with 4401)', async ({ page }) => {
    await page.goto('/');

    const closeCode = await page.evaluate(
      async ({ wsUrl }: { wsUrl: string }) => {
        return new Promise<number>((resolve) => {
          const ws = new WebSocket(wsUrl);
          ws.addEventListener('open', () => {
            // Send auth message without a token field
            ws.send(JSON.stringify({ type: 'auth' }));
          });
          ws.addEventListener('close', (e: CloseEvent) => resolve(e.code));
          ws.addEventListener('error', () => {});
          setTimeout(() => resolve(0), 5000);
        });
      },
      { wsUrl: WS_URL },
    );

    expect(closeCode).toBe(4401);
  });

  test('rejects connection with invalid token (closes with 4401)', async ({ page }) => {
    await page.goto('/');

    const closeCode = await page.evaluate(
      async ({ wsUrl }: { wsUrl: string }) => {
        return new Promise<number>((resolve) => {
          const ws = new WebSocket(wsUrl);
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'auth', token: 'invalid.jwt.token' }));
          });
          ws.addEventListener('close', (e: CloseEvent) => resolve(e.code));
          ws.addEventListener('error', () => {});
          setTimeout(() => resolve(0), 5000);
        });
      },
      { wsUrl: WS_URL },
    );

    expect(closeCode).toBe(4401);
  });

  test('after execute, at least one event arrives over WebSocket within 2s', async ({ authPage, api }) => {
    const { page, token } = authPage;
    await page.goto('/');

    // Phase 1: Authenticate the WS connection and keep it open
    await page.evaluate(
      async ({ wsUrl, tok }: { wsUrl: string; tok: string }) => {
        return new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          (window as Record<string, unknown>).__e2eWs = ws;
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'auth', token: tok }));
          });
          ws.addEventListener('message', (e: MessageEvent<string>) => {
            const msg = JSON.parse(e.data) as { type: string };
            if (msg.type === 'connected') {
              resolve();
            }
          });
          setTimeout(() => reject(new Error('WS auth timeout')), 5000);
        });
      },
      { wsUrl: WS_URL, tok: token },
    );

    // Phase 2: Trigger a tool call that emits events — WS listener is already active
    await api.execute(token, 'communicate', { to: 'operator', message: 'ping' });

    // Phase 3: Wait for an event on the same WS connection
    const eventType = await page.evaluate(
      async (): Promise<string> => {
        return new Promise<string>((resolve) => {
          const ws = (window as Record<string, unknown>).__e2eWs as WebSocket;
          if (!ws) { resolve('timeout'); return; }
          const handler = (e: MessageEvent<string>) => {
            const msg = JSON.parse(e.data) as { type: string; event?: string };
            if (msg.type === 'event') {
              ws.removeEventListener('message', handler);
              ws.close();
              resolve(msg.event ?? 'unknown');
            }
          };
          ws.addEventListener('message', handler);
          setTimeout(() => {
            ws.removeEventListener('message', handler);
            resolve('timeout');
          }, 2000);
        });
      },
    );

    expect(eventType).not.toBe('timeout');
  });
});
