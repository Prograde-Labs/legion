import { test, expect } from '../../fixtures/index.js';

function data<T>(response: { result: { status: string; data?: T; error?: string } }): T {
  expect(response.result.status, response.result.error).toBe('success');
  return response.result.data as T;
}

test.describe('Tool dock', () => {
  let token: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const login = await api.login('operator', connInfo.password);
    token = login.token;
    data(
      await api.execute(token, 'save_provider', {
        name: 'dock-e2e-provider',
        type: 'openai-compatible',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'test-key',
        priority: 10,
      }),
    );
  });

  test('clicking a tool chip opens the dock tab and closing works', async ({ authPage, api }) => {
    const { page } = authPage;
    const agent = `dock-agent-${Date.now()}`;
    data(
      await api.execute(token, 'create_agent', {
        id: agent,
        name: agent,
        systemPrompt: 'You are a deterministic e2e agent.',
        model: { provider: 'dock-e2e-provider', model: 'mock-model' },
        tools: { list_participants: 'auto' },
      }),
    );

    // Arrange the tool-call conversation entirely via API: the mock provider
    // answers E2E_REASONING_SCENARIO by emitting a list_participants tool call.
    const sent = data<{ conversationId: string }>(
      await api.execute(token, 'communicate', {
        to: agent,
        message: 'E2E_REASONING_SCENARIO',
      }),
    );

    await page.goto(`/#/chat/${sent.conversationId}`);
    const chip = page.locator('[data-test="tool-chip"]').first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-test="dock-root"]')).toBeHidden();

    await chip.click();
    const dock = page.locator('[data-test="dock-root"]');
    await expect(dock).toBeVisible();
    await expect(page.locator('[data-test="dock-tab"]').first()).toBeVisible();

    await page.locator('[data-test="dock-tab-close"]').first().click();
    await expect(dock).toBeHidden();
  });
});
