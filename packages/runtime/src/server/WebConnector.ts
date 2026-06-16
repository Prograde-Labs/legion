import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import type { WebSocket } from 'ws';
import type { Connector, ConnectorContext } from '@legion/core';
import type {
  Collective,
  CredentialStore,
  EventBus,
  ServerConfig,
} from '@legion/core';
import { signToken, verifyToken, extractBearerToken } from './auth.js';
import type { JwtSecret } from './auth.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerExecuteRoute } from './routes/execute.js';

export interface WebConnectorDeps {
  collective: Collective;
  credentials: CredentialStore;
  eventBus: EventBus;
  serverConfig?: ServerConfig;
  /** Absolute path to built SPA files (packages/web/dist). Optional; skipped if absent. */
  webDistPath?: string;
}

/** Auth timeout for WebSocket connections: close if no auth message within this window. */
const WS_AUTH_TIMEOUT_MS = 10_000;

export class WebConnector implements Connector {
  readonly name = 'web';

  private app?: FastifyInstance;
  private ctx?: ConnectorContext;
  /** Fresh random secret per process — sessions invalidated on restart. */
  private readonly jwtSecret: JwtSecret = crypto.getRandomValues(new Uint8Array(32));
  /** participantId → active WS sockets (for outbound deliver()). */
  private connections = new Map<string, Set<WebSocket>>();

  constructor(private deps: WebConnectorDeps) {}

  async start(ctx: ConnectorContext): Promise<void> {
    this.ctx = ctx;
    const app = Fastify({ logger: false });
    this.app = app;

    // ── Plugins ──────────────────────────────────────────────────────────────
    await app.register(websocketPlugin);

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
      if ((socket as any).readyState === 1 /* OPEN */) {
        socket.send(payload);
      }
    }
  }

  async stop(): Promise<void> {
    await this.app?.close();
    this.app = undefined;
    this.connections.clear();
  }

  // ── WebSocket handler ────────────────────────────────────────────────────────

  private handleWebSocket(socket: WebSocket, ctx: ConnectorContext): void {
    let participantId: string | null = null;
    let anyOff: (() => void) | null = null;

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
            clearTimeout(authTimer);
            participantId = pid;

            // Track connection
            ctx.registry.setActive(pid, this.name);
            const set = this.connections.get(pid) ?? new Set<WebSocket>();
            set.add(socket);
            this.connections.set(pid, set);

            // Acknowledge
            socket.send(JSON.stringify({ type: 'connected', participantId: pid }));

            // Bridge EventBus events
            const handler = (event: string, payload: unknown) => {
              if ((socket as any).readyState === 1) {
                socket.send(JSON.stringify({ type: 'event', event, data: payload }));
              }
            };
            anyOff = this.deps.eventBus.onAny(handler);
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
      anyOff?.();
    });

    socket.on('error', () => {
      // Errors handled by the 'close' event.
    });
  }
}
