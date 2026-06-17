import { test, expect } from '../../fixtures/index.js';

test.describe('GET /api/health', () => {
  test('returns { status: "ok" } with no auth required', async ({ api }) => {
    const result = await api.health();
    expect(result.status).toBe('ok');
  });
});
