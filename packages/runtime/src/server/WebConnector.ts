import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { WebSocket } from 'ws';
import type { Connector, ConnectorContext } from '@legion-collective/core';
import type {
  Collective,
  CredentialStore,
  EventBus,
  ProcessManager,
  ServerConfig,
} from '@legion-collective/core';
import { StreamRegistry } from '@legion-collective/core';
import { verifyToken } from './auth.js';
import type { JwtSecret } from './auth.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerExecuteRoute } from './routes/execute.js';
import { applySecurityHeaders } from './securityHeaders.js';

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

/**
 * Applied to every HTTP response via the onSend hook below, and to SSE streams in
 * the execute route (which hijack the response and bypass onSend).
 * Dev-mode Vite responses are hijacked in the onRequest hook and bypass onSend,
 * so HMR is unaffected.
 */
export { SECURITY_HEADERS } from './securityHeaders.js';

export class WebConnector implements Connector {
  readonly name = 'web';

  private app?: FastifyInstance;
  private viteServer?: import('vite').ViteDevServer;
  /** Fresh random secret per process — sessions invalidated on restart. */
  private readonly jwtSecret: JwtSecret = crypto.getRandomValues(new Uint8Array(32));
  /** participantId → active WS sockets (for outbound deliver()). */
  private connections = new Map<string, Set<WebSocket>>();
  /** connectionId (UUID per socket) → WebSocket */
  private connectionSockets = new Map<string, WebSocket>();
  /** connectionId → participantId (for security validation) */
  private connectionParticipants = new Map<string, string>();
  /** Transport-internal stream registry */
  private readonly streamRegistry = new StreamRegistry();

  constructor(private deps: WebConnectorDeps) {}

  async start(ctx: ConnectorContext): Promise<void> {
    const app = Fastify({ logger: false });
    this.app = app;

    // ── Response headers ─────────────────────────────────────────────────────
    // onSend covers every response, including error and not-found handlers.
    // Task 13's cache headers branch slots in here alongside the security headers.
    app.addHook('onSend', async (req, reply, payload) => {
      applySecurityHeaders((name, value) => reply.header(name, value));
      // Hashed build assets are content-addressed; cache them forever. Only a
      // real 200 asset response qualifies — the SPA shell and API responses stay
      // uncached so deploys take effect immediately.
      if (req.url.startsWith('/assets/') && reply.statusCode === 200) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return payload;
    });

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
        // SPA client-side routing fallback; unknown API routes must stay JSON 404s.
        // Absolute-form targets arrive verbatim; parse the pathname so proxy
        // traffic still routes correctly. `new URL` throws on scheme-relative
        // targets like `//`, so fall back to a manual split.
        app.setNotFoundHandler((req, reply) => {
          let pathname: string;
          try {
            pathname = new URL(req.url, 'http://localhost').pathname;
          } catch {
            pathname = req.url.split('?')[0];
          }
          if (pathname === '/api' || pathname.startsWith('/api/')) {
            reply.status(404).send({ error: 'Not found' });
            return;
          }
          // A missing hashed asset is a 404, not the SPA shell — otherwise a
          // stale asset URL would silently return index.html with asset caching.
          if (pathname.startsWith('/assets/')) {
            reply.status(404).send({ error: 'Not found' });
            return;
          }
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
      streamRegistry: this.streamRegistry,
      sendToStream: this.sendToStream.bind(this),
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
    this.connectionSockets.clear();
    this.connectionParticipants.clear();
    this.connections.clear();
    await this.viteServer?.close();
    this.viteServer = undefined;
    await this.app?.close();
    this.app = undefined;
  }

  // ── WebSocket handler ────────────────────────────────────────────────────────

  /**
   * Send a stream chunk frame to a specific connection.
   * Returns false if the socket is gone or the connectionId doesn't belong
   * to the claimed participant.
   */
  sendToStream(connectionId: string, participantId: string, data: object): boolean {
    if (this.connectionParticipants.get(connectionId) !== participantId) return false;
    const socket = this.connectionSockets.get(connectionId);
    if (!socket || (socket as any).readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  private handleWebSocket(socket: WebSocket, ctx: ConnectorContext): void {
    let participantId: string | null = null;
    let connectionId: string | null = null;
    let authStarted = false;

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
        // Ignore overlapping auth frames; only one verification may be in flight.
        if (authStarted) return;
        authStarted = true;
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
            connectionId = randomUUID();

            // Track connection
            ctx.registry.setActive(pid, this.name);
            const set = this.connections.get(pid) ?? new Set<WebSocket>();
            set.add(socket);
            this.connections.set(pid, set);
            this.connectionSockets.set(connectionId, socket);
            this.connectionParticipants.set(connectionId, pid);

            socket.send(JSON.stringify({ type: 'connected', participantId: pid, connectionId }));
          })
          .catch(() => {
            socket.close(4401, 'Invalid token');
          });
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
      if (connectionId) {
        this.connectionSockets.delete(connectionId);
        this.connectionParticipants.delete(connectionId);
        this.streamRegistry.cancelAll(connectionId);
      }
    });

    socket.on('error', () => {
      // Errors handled by the 'close' event.
    });
  }
}
