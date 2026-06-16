import type { FastifyInstance } from 'fastify';

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    return reply.send({ status: 'ok' });
  });
}
