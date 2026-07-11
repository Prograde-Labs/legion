import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyToken, extractBearerToken } from '../auth.js';
import type { JwtSecret } from '../auth.js';
import type { ConnectorContext, Collective, StreamChunk } from '@legion/core';
import { StreamRegistry } from '@legion/core';

export interface ExecuteRouteDeps {
  collective: Collective;
  ctx: ConnectorContext;
  jwtSecret: JwtSecret;
  streamRegistry: StreamRegistry;
  sendToStream: (connectionId: string, participantId: string, data: object) => boolean;
}

export async function registerExecuteRoute(
  app: FastifyInstance,
  deps: ExecuteRouteDeps,
): Promise<void> {
  const { collective, ctx, jwtSecret, streamRegistry, sendToStream } = deps;

  app.post<{
    Body: { tool?: string; args?: unknown; conversationId?: string };
    Querystring: { stream?: string };
  }>('/api/execute', async (req, reply) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return reply.status(401).send({ error: 'Unauthenticated' });

    let participantId: string;
    try {
      ({ participantId } = await verifyToken(token, jwtSecret));
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    if (!collective.get(participantId)) {
      return reply.status(401).send({ error: 'Participant not found' });
    }

    const { tool: toolName, args = {}, conversationId } = req.body ?? {};
    if (!toolName) return reply.status(400).send({ error: 'tool is required' });

    // ── Buffered mode (?stream=false) ────────────────────────────────────────
    if (req.query.stream === 'false') {
      const { result, conversationId: convId } = await ctx.callTool(participantId, toolName, args, {
        conversationId: conversationId ?? '',
      });
      return reply.send({ result, conversationId: convId });
    }

    // ── WS streaming mode (X-Stream-Connection header) ────────────────────────
    const connectionId = req.headers['x-stream-connection'] as string | undefined;
    if (connectionId) {
      const streamId = randomUUID();
      const signal = streamRegistry.register(streamId, connectionId);
      const cancelStream = (sid: string) => streamRegistry.cancel(sid);

      let gen: AsyncGenerator<StreamChunk>;
      let convId: string;
      try {
        ({ gen, conversationId: convId } = await ctx.streamTool(participantId, toolName, args, {
          conversationId: conversationId ?? '',
          signal,
          cancelStream,
        }));
      } catch (err) {
        streamRegistry.cancel(streamId);
        return reply.status(500).send({ error: String(err) });
      }

      // Return streamId immediately; background task routes chunks to WS socket.
      await reply.send({ streamId, conversationId: convId });

      // Background iteration — fire-and-forget, errors silently cleaned up.
      void (async () => {
        let seq = 0;
        try {
          for await (const chunk of gen) {
            const sent = sendToStream(connectionId, participantId, {
              type: 'stream:chunk',
              streamId,
              seq: seq++,
              data: chunk,
            });
            if (!sent) {
              // Socket gone — abort the generator.
              streamRegistry.cancel(streamId);
              break;
            }
            if (chunk.type === 'stream:done' || chunk.type === 'stream:error') break;
          }
        } catch (err) {
          sendToStream(connectionId, participantId, {
            type: 'stream:chunk',
            streamId,
            seq: seq++,
            data: { type: 'stream:error', error: String(err) },
          });
        } finally {
          streamRegistry.cancel(streamId); // no-op if already done
        }
      })();

      return;
    }

    // ── SSE mode (no special header, not stream=false) ────────────────────────
    let gen: AsyncGenerator<StreamChunk>;
    let convId: string;
    try {
      ({ gen, conversationId: convId } = await ctx.streamTool(participantId, toolName, args, {
        conversationId: conversationId ?? '',
      }));
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.writeHead(200);

    // First event carries conversationId
    let seq = 0;
    const write = (data: object) => {
      reply.raw.write(`data: ${JSON.stringify({ seq: seq++, data })}\n\n`);
    };

    write({ type: 'stream:start', conversationId: convId });

    try {
      for await (const chunk of gen) {
        write(chunk);
        if (chunk.type === 'stream:done' || chunk.type === 'stream:error') break;
      }
    } catch (err) {
      write({ type: 'stream:error', error: String(err) });
    }

    reply.raw.end();
    reply.hijack();
  });
}
