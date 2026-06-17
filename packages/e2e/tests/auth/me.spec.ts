import { test, expect } from '../../fixtures/index.js';

test.describe('GET /api/auth/me', () => {
  test('returns correct participant info with valid token', async ({ api, connInfo }) => {
    const { token } = await api.login('operator', connInfo.password);
    const me = await api.me(token);

    expect(me.id).toBe('operator');
    expect(me.name).toBe('Operator');
    expect(me.operator).toBe(true);
    expect(Array.isArray(me.tools)).toBe(true);
    expect(me.tools.length).toBeGreaterThan(0);
  });

  test('tools array contains expected management tool names', async ({ api, connInfo }) => {
    const { token } = await api.login('operator', connInfo.password);
    const me = await api.me(token);

    const expectedTools = [
      'list_participants',
      'list_tools',
      'list_conversations',
      'list_providers',
      'list_credentials',
      'configure_provider',
      'set_credential_with_meta',
      'create_agent',
      'modify_agent',
      'retire_agent',
    ];
    for (const name of expectedTools) {
      expect(me.tools, `expected tools to include "${name}"`).toContain(name);
    }
  });

  test('returns 401 with no token', async ({ request, connInfo }) => {
    const res = await request.get(`${connInfo.serverUrl}/api/auth/me`);
    expect(res.status()).toBe(401);
  });

  test('returns 401 with malformed token', async ({ request, connInfo }) => {
    const res = await request.get(`${connInfo.serverUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer not-a-valid-jwt' },
    });
    expect(res.status()).toBe(401);
  });
});
