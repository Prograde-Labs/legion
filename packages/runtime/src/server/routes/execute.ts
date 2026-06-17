import type { FastifyInstance } from 'fastify';
import { verifyToken, extractBearerToken } from '../auth.js';
import type { JwtSecret } from '../auth.js';
import type { ConnectorContext } from '@legion/core';
import type { Collective } from '@legion/core';

export async function registerExecuteRoute(
  app: FastifyInstance,
  deps: {
    collective: Collective;
    ctx: ConnectorContext;
    jwtSecret: JwtSecret;
  },
): Promise<void> {
  const { collective, ctx, jwtSecret } = deps;

  /**
   * POST /api/execute
   * Body: { tool: string; args?: unknown; conversationId?: string }
   * Returns: { result: ToolResult; conversationId: string }
   */
  app.post<{ Body: { tool?: string; args?: unknown; conversationId?: string } }>(
    '/api/execute',
    async (req, reply) => {
      // Authenticate
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

      // Validate body
      const { tool: toolName, args = {}, conversationId } = req.body ?? {};
      if (!toolName) {
        return reply.status(400).send({ error: 'tool is required' });
      }

      // Execute via ConnectorContext (authorization + routing handled inside)
      const { result, conversationId: convId } = await ctx.callTool(participantId, toolName, args, {
        conversationId: conversationId ?? '',
      });

      return reply.send({ result, conversationId: convId });
    },
  );
}
