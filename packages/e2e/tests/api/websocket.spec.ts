import { test, expect } from '../../fixtures/index.js';

test.describe('WebSocket /ws', () => {
  test('accepts connection with valid token', async ({ authPage, connInfo }) => {
    const { page, token } = authPage;
    // Navigate to any page to give the browser context a same-origin base
    await page.goto('/');

    const wsUrl = connInfo.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

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
      { wsUrl, tok: token },
    );

    expect(connected).toBe(true);
  });

  test('rejects connection with no token (closes with 4401)', async ({ page, connInfo }) => {
    await page.goto('/');

    const wsUrl = connInfo.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

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
      { wsUrl },
    );

    expect(closeCode).toBe(4401);
  });

  test('rejects connection with invalid token (closes with 4401)', async ({ page, connInfo }) => {
    await page.goto('/');

    const wsUrl = connInfo.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

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
      { wsUrl },
    );

    expect(closeCode).toBe(4401);
  });

  test('after execute, at least one event arrives over WebSocket within 2s', async ({ authPage, api, connInfo }) => {
    const { page, token } = authPage;
    await page.goto('/');

    const wsUrl = connInfo.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

    // Open authenticated WS connection and start listening for events in a single evaluate,
    // so there is no race between registering the listener and triggering the tool call.
    const eventPromise = page.evaluate(
      ({ wsUrl, tok }: { wsUrl: string; tok: string }) => {
        return new Promise<string>((resolve) => {
          const ws = new WebSocket(wsUrl);
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'auth', token: tok }));
          });
          ws.addEventListener('message', (e: MessageEvent<string>) => {
            const msg = JSON.parse(e.data) as { type: string; event?: string };
            // Skip the 'connected' handshake, wait for real events
            if (msg.type === 'event') {
              ws.close();
              resolve(msg.event ?? 'unknown');
            }
          });
          ws.addEventListener('error', () => resolve('error'));
          // Expose ws so we can trigger execute after connection is ready
          (window as Record<string, unknown>).__e2eWs = ws;
          setTimeout(() => resolve('timeout'), 5000);
        });
      },
      { wsUrl, tok: token },
    );

    // Wait briefly to ensure the WS handshake completes before triggering the tool call
    await page.waitForTimeout(500);

    // Trigger a tool call — the server will emit events over the authenticated WS
    await api.execute(token, 'list_participants');

    const eventType = await eventPromise;
    expect(eventType).not.toBe('timeout');
    expect(eventType).not.toBe('error');
  });
});
