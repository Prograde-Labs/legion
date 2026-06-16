import type { FastifyInstance } from 'fastify';
import type { Collective } from '@legion/core';
import type { CredentialStore } from '@legion/core';
import { signToken, verifyToken, extractBearerToken } from '../auth.js';
import type { JwtSecret } from '../auth.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    collective: Collective;
    credentials: CredentialStore;
    jwtSecret: JwtSecret;
  },
): Promise<void> {
  const { collective, credentials, jwtSecret } = deps;

  /**
   * POST /api/auth/login
   * Body: { name: string; password: string }
   * Returns: { token: string; participantId: string }
   */
  app.post<{ Body: { name?: string; password?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const { name, password } = req.body ?? {};
      if (!name || !password) {
        return reply.status(400).send({ error: 'name and password are required' });
      }

      const participant = collective
        .listActive()
        .find((p) => p.name.toLowerCase() === name.toLowerCase());

      if (!participant) {
        return reply.status(401).send({ error: 'Invalid name or password' });
      }

      const ok = await credentials.verify(participant.id, password);
      if (!ok) {
        return reply.status(401).send({ error: 'Invalid name or password' });
      }

      const token = await signToken(participant.id, jwtSecret);
      return reply.send({ token, participantId: participant.id });
    },
  );

  /**
   * POST /api/auth/logout
   * JWT is stateless — this is a client-side operation, but we acknowledge it.
   */
  app.post('/api/auth/logout', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  /**
   * GET /api/auth/me
   * Returns the authenticated participant's info.
   */
  app.get('/api/auth/me', async (req, reply) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return reply.status(401).send({ error: 'Unauthenticated' });

    let participantId: string;
    try {
      ({ participantId } = await verifyToken(token, jwtSecret));
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    const participant = collective.get(participantId);
    if (!participant) return reply.status(401).send({ error: 'Participant not found' });

    return reply.send({
      id: participant.id,
      name: participant.name,
      type: participant.type,
      operator: participant.operator ?? false,
      tools: Object.keys(participant.tools),
      approvalAuthority: participant.approvalAuthority ?? null,
    });
  });
}
