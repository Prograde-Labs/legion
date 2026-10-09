import { test, expect } from '../../fixtures/index.js';

function data<T>(response: { result: { status: string; data?: T; error?: string } }): T {
  expect(response.result.status, response.result.error).toBe('success');
  return response.result.data as T;
}

test.describe('Chat UI', () => {
  let token: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const login = await api.login('operator', connInfo.password);
    token = login.token;
    data(
      await api.execute(token, 'save_provider', {
        name: 'chat-e2e-provider',
        type: 'openai-compatible',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'test-key',
        priority: 10,
      }),
    );
  });

  test('landing route is /#/chat after login', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/');
    await expect(page).toHaveURL(/#\/chat/);
  });

  test('send a message and see the mock assistant reply stream in', async ({ authPage, api }) => {
    const { page } = authPage;
    const agent = `chat-agent-${Date.now()}`;
    data(
      await api.execute(token, 'create_agent', {
        id: agent,
        name: agent,
        systemPrompt: 'You are a deterministic e2e agent.',
        model: { provider: 'chat-e2e-provider', model: 'mock-model' },
        tools: {},
      }),
    );

    await page.goto('/#/chat');
    const pickerInput = page.locator('[data-test="recipient-picker"] input');
    await pickerInput.click();
    await pickerInput.fill(agent);
    await page.locator('li[data-option]', { hasText: agent }).first().click();

    await page.locator('[data-test="composer-input"]').fill('hello collective');
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-test="msg"]').last()).toBeVisible();
    // The mock provider never echoes the prompt; its canned reply is "mock response".
    await expect(page.locator('.md-content').last()).toContainText('mock response', {
      timeout: 15_000,
    });

    // Second send in the SAME conversation (final-review C1/I1 regression): the
    // non-draft path must start the communicate stream — both the new user
    // message and the fresh reply appear without any navigation.
    await page.locator('[data-test="composer-input"]').fill('second message');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-test="msg"]').last()).toContainText('second message', {
      timeout: 15_000,
    });
    await expect(page.locator('.md-content').last()).toContainText('mock response', {
      timeout: 15_000,
    });
  });
});
