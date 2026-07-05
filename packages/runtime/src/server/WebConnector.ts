import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { WebSocket } from 'ws';
import type { Connector, ConnectorContext } from '@legion/core';
import type {
  Collective,
  CredentialStore,
  EventBus,
  ProcessManager,
  ServerConfig,
} from '@legion/core';
import { verifyToken } from './auth.js';
import type { JwtSecret } from './auth.js';
import { isRelevantToParticipant } from './event-filter.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerExecuteRoute } from './routes/execute.js';

export interface WebConnectorDeps {
  collective: Collective;
  credentials: CredentialStore;
  eventBus: EventBus;
  processManager: ProcessManager;
  serverConfig?: ServerConfig;
  /** Absolute path to built SPA files (packages/web/dist). Used in production. */
  webDistPath?: string;
  /** Absolute path to the web package root (packages/web). Used in dev mode. */
  webSrcPath?: string;
  /** When true, serve the SPA via Vite middleware with HMR instead of static files. */
  dev?: boolean;
}

/** Auth timeout for WebSocket connections: close if no auth message within this window. */
const WS_AUTH_TIMEOUT_MS = 10_000;

export class WebConnector implements Connector {
  readonly name = 'web';

  private app?: FastifyInstance;
  private viteServer?: import('vite').ViteDevServer;
  /** Fresh random secret per process — sessions invalidated on restart. */
  private readonly jwtSecret: JwtSecret = crypto.getRandomValues(new Uint8Array(32));
  /** participantId → active WS sockets (for outbound deliver()). */
  private connections = new Map<string, Set<WebSocket>>();

  constructor(private deps: WebConnectorDeps) {}

  async start(ctx: ConnectorContext): Promise<void> {
    const app = Fastify({ logger: false });
    this.app = app;

    // ── Plugins ──────────────────────────────────────────────────────────────
    await app.register(websocketPlugin);

    if (this.deps.dev) {
      // ── Dev mode: Vite middleware with HMR ───────────────────────────────
      const { webSrcPath } = this.deps;
      if (!webSrcPath) {
        throw new Error('[WebConnector] dev mode requires webSrcPath');
      }
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        root: webSrcPath,
        server: { middlewareMode: true },
        appType: 'spa',
      });
      this.viteServer = vite;
      app.addHook('onRequest', async (req, reply) => {
        // onRequest fires before route handlers; URL guard lets API routes fall through to Fastify
        if (req.url.startsWith('/api/') || req.url === '/ws') {
          return;
        }
        await new Promise<void>((resolve, reject) => {
          // Vite calls res.end() (no next()) when it handles the request.
          // Vite calls next() when it does NOT handle the request.
          vite.middlewares(req.raw, reply.raw, (err?: unknown) => {
            if (err) reject(err as Error);
            else resolve();
          });
        });
        // Only hijack if Vite actually sent the response (wrote headers).
        // If Vite called next() without handling, headersSent is false — let Fastify route it.
        if (reply.raw.headersSent) {
          reply.hijack();
        }
      });
      console.log('  [dev] Vite HMR middleware active');
    } else {
      // ── Production: serve pre-built static files ─────────────────────────
      const { webDistPath } = this.deps;
      if (webDistPath && existsSync(webDistPath)) {
        await app.register(staticPlugin, {
          root: webDistPath,
          wildcard: false,
        });
        // SPA client-side routing fallback
        app.setNotFoundHandler((_req, reply) => {
          void reply.sendFile('index.html');
        });
      }
    }

    // ── HTTP routes ───────────────────────────────────────────────────────────
    await registerHealthRoute(app);
    await registerAuthRoutes(app, {
      collective: this.deps.collective,
      credentials: this.deps.credentials,
      jwtSecret: this.jwtSecret,
    });
    await registerExecuteRoute(app, {
      collective: this.deps.collective,
      ctx,
      jwtSecret: this.jwtSecret,
    });

    // ── WebSocket route ───────────────────────────────────────────────────────
    app.get('/ws', { websocket: true }, (socket, _request) => {
      this.handleWebSocket(socket as unknown as WebSocket, ctx);
    });

    // ── Startup ───────────────────────────────────────────────────────────────
    const { port = 3000, host = '127.0.0.1' } = this.deps.serverConfig ?? {};

    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn(
        `[WebConnector] WARNING: binding to ${host} exposes the server to non-loopback traffic.`,
      );
    }

    await app.listen({ port, host });
    console.log(`  Web UI: http://${host}:${port}`);
  }

  async deliver(message: {
    id: string;
    conversationId: string;
    senderId: string;
    recipientId: string;
    replyTo?: string;
    content: string;
    timestamp: string;
  }): Promise<void> {
    const sockets = this.connections.get(message.recipientId);
    if (!sockets?.size) return;
    const payload = JSON.stringify({ type: 'message', data: message });
    for (const socket of sockets) {
      try {
        if ((socket as any).readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      } catch {
        // socket may have been closed between check and send
      }
    }
  }

  async stop(): Promise<void> {
    this.connections.clear();
    await this.viteServer?.close();
    this.viteServer = undefined;
    await this.app?.close();
    this.app = undefined;
  }

  // ── WebSocket handler ────────────────────────────────────────────────────────

  private handleWebSocket(socket: WebSocket, ctx: ConnectorContext): void {
    let participantId: string | null = null;
    let anyOff: (() => void) | null = null;

    const processSubs = new Map<string, Array<() => void>>();

    function detachProcessSub(processId: string): void {
      const unsubs = processSubs.get(processId);
      if (unsubs) {
        for (const u of unsubs) u();
        processSubs.delete(processId);
      }
    }

    // Auth timeout: close if no auth message arrives promptly.
    const authTimer = setTimeout(() => {
      if (!participantId) socket.close(4401, 'Authentication timeout');
    }, WS_AUTH_TIMEOUT_MS);

    socket.on('message', (raw) => {
      let msg: { type?: string; token?: string };
      try {
        msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'auth' && !participantId) {
        const token = msg.token;
        if (!token) {
          socket.close(4401, 'No token provided');
          return;
        }
        verifyToken(token, this.jwtSecret)
          .then(({ participantId: pid }) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            clearTimeout(authTimer);
            participantId = pid;
            const isOperator = this.deps.collective.get(pid)?.operator === true;

            // Track connection
            ctx.registry.setActive(pid, this.name);
            const set = this.connections.get(pid) ?? new Set<WebSocket>();
            set.add(socket);
            this.connections.set(pid, set);

            // Acknowledge
            socket.send(JSON.stringify({ type: 'connected', participantId: pid }));

            // Bridge EventBus events
            if (!participantId) return;
            const handler = (event: string, payload: unknown) => {
              if (
                socket.readyState === WebSocket.OPEN &&
                isRelevantToParticipant(event, payload, participantId!, isOperator)
              ) {
                socket.send(JSON.stringify({ type: 'event', event, data: payload }));
              }
            };
            anyOff = this.deps.eventBus.onAny(handler);
          })
          .catch(() => {
            socket.close(4401, 'Invalid token');
          });
      }

      if (msg.type === 'subscribe_process' && participantId) {
        const processId = (msg as any).processId as string;
        if (!processId) return;

        const handle = this.deps.processManager.get(processId);
        if (!handle) {
          socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'not_found' }));
          return;
        }
        if (handle.status !== 'running') {
          socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'dead' }));
          return;
        }

        // Authorization: only the process owner or operators can subscribe
        const isOperator = this.deps.collective.get(participantId)?.operator === true;
        if (handle.startedByParticipantId !== participantId && !isOperator) {
          socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'forbidden' }));
          return;
        }

        // Detach previous subscription for same processId (idempotent re-subscribe)
        detachProcessSub(processId);

        const send = (type: string, payload: Record<string, unknown>): void => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type, processId, ...payload }));
          }
        };

        const offOutput = this.deps.processManager.subscribe(processId, 'output', (evt: any) => {
          send('process:output', {
            stream: evt.stream,
            data: (evt.data as Buffer).toString('base64'),
          });
        });

        const offExited = this.deps.processManager.subscribe(processId, 'exited', (evt: any) => {
          send('process:exited', { exitCode: evt.exitCode, signal: evt.signal ?? null });
          detachProcessSub(processId);
        });

        const offError = this.deps.processManager.subscribe(processId, 'error', (evt: any) => {
          send('process:error', { error: evt.error });
          detachProcessSub(processId);
        });

        processSubs.set(processId, [offOutput, offExited, offError]);

        // Re-check status after subscribing — if the process exited between
        // the initial get() and subscribe(), the 'exited' event already fired
        // and our listener missed it. Detach and notify.
        const latestHandle = this.deps.processManager.get(processId);
        if (!latestHandle || latestHandle.status !== 'running') {
          detachProcessSub(processId);
          send('process:exited', {
            exitCode: latestHandle?.exitCode ?? null,
            signal: null,
          });
          socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'dead' }));
          return;
        }

        socket.send(JSON.stringify({ type: 'subscribe_ack', processId, status: 'subscribed' }));
        return;
      }

      if (msg.type === 'unsubscribe_process' && participantId) {
        const processId = (msg as any).processId as string;
        if (processId) detachProcessSub(processId);
        socket.send(JSON.stringify({ type: 'unsubscribe_ack', processId }));
        return;
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (participantId) {
        ctx.registry.clearActive(participantId, this.name);
        this.connections.get(participantId)?.delete(socket);
        if (this.connections.get(participantId)?.size === 0) {
          this.connections.delete(participantId);
        }
      }
      anyOff?.();

      // Detach all process subscriptions for this socket
      for (const processId of processSubs.keys()) {
        detachProcessSub(processId);
      }
    });

    socket.on('error', () => {
      // Errors handled by the 'close' event.
    });
  }
}
