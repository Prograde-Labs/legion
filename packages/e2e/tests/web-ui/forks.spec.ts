import { test, expect } from '../../fixtures/index.js';

function data<T>(response: { result: { status: string; data?: T; error?: string } }): T {
  expect(response.result.status, response.result.error).toBe('success');
  return response.result.data as T;
}

test.describe('Message forks', () => {
  let token: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const login = await api.login('operator', connInfo.password);
    token = login.token;
    data(
      await api.execute(token, 'save_provider', {
        name: 'fork-e2e-provider',
        type: 'openai-compatible',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'test-key',
        priority: 10,
      }),
    );
  });

  test('editing a user message creates a sibling branch and the pager navigates it', async ({
    authPage,
    api,
  }) => {
    const { page } = authPage;
    const agent = `fork-agent-${Date.now()}`;
    data(
      await api.execute(token, 'create_agent', {
        id: agent,
        name: agent,
        systemPrompt: 'You are a deterministic e2e agent.',
        model: { provider: 'fork-e2e-provider', model: 'mock-model' },
        tools: {},
      }),
    );

    const sent = data<{ conversationId: string }>(
      await api.execute(token, 'communicate', {
        to: agent,
        message: 'FORK_ORIGINAL hello original',
      }),
    );

    await page.goto(`/#/chat/${sent.conversationId}`);
    const userMsg = page.locator('[data-test="msg"]', { hasText: 'FORK_ORIGINAL' }).first();
    await expect(userMsg).toBeVisible({ timeout: 15_000 });

    // Hover-revealed actions → Edit → change text → save (edit_message).
    await userMsg.locator('[data-test="actions-toggle"]').click();
    await userMsg.locator('[data-test="action-edit"]').click();
    await page.locator('[data-test="edit-textarea"]').fill('FORK_EDITED hello edited');
    await page.locator('[data-test="edit-save"]').click();

    // Edited branch becomes active; pager proves two siblings exist.
    const pager = page.locator('[data-test="fork-pager"]').first();
    await expect(pager).toContainText('1/2', { timeout: 15_000 });
    await expect(
      page.locator('[data-test="msg"]', { hasText: 'FORK_EDITED' }).first(),
    ).toBeVisible();

    // Next arrow switches back to the original sibling (switch_conversation_branch).
    await page.locator('[data-test="fork-next"]').first().click();
    await expect(
      page.locator('[data-test="msg"]', { hasText: 'FORK_ORIGINAL' }).first(),
    ).toBeVisible();
    // The edited node remains in the tree (fork pager still shows 2 siblings).
    await expect(pager).toContainText('1/2');
  });
});
