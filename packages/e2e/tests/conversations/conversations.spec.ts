import { test, expect } from '../../fixtures/index.js';

test.describe('ConversationsView', () => {
  test('loads with empty state when no conversations exist', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/conversations');

    // The sidebar exists
    await expect(page.locator('.w-60').getByText('Conversations')).toBeVisible();
    // No conversation selected — right panel shows placeholder
    await expect(page.getByText('Select a conversation')).toBeVisible();
  });

  test.describe('with a conversation', () => {
    let agentId: string;
    let conversationId: string;

    test.beforeAll(async ({ api, connInfo }) => {
      const { token } = await api.login('operator', connInfo.password);

      // Configure provider + credential for the agent to function
      await api.execute(token, 'set_credential_with_meta', {
        key: 'conv-test-cred',
        value: 'sk-mock',
        usedBy: [],
      });
      await api.execute(token, 'configure_provider', {
        name: 'conv-mock-provider',
        type: 'openai-compatible',
        baseUrl: connInfo.mockProviderUrl,
        defaultModel: 'mock-model',
        credentialKey: 'conv-test-cred',
      });

      const createResult = await api.execute<{ id: string }>(token, 'create_agent', {
        id: `conv-test-agent-${Date.now()}`,
        name: 'conv-test-agent',
        systemPrompt: 'test agent for conversations e2e test',
        model: { provider: 'conv-mock-provider', model: 'mock-model' },
      });
      expect(createResult.result.status).toBe('success');
      agentId = createResult.result.data!.id;

      // Send a message to the agent — this creates a conversation
      const commResult = await api.execute<{ conversationId: string }>(token, 'communicate', {
        to: agentId,
        message: 'hello from e2e test',
      });
      expect(commResult.result.status).toBe('success');
      conversationId = commResult.result.data!.conversationId;
    });

    test('new conversation appears in sidebar after communicate call', async ({ authPage }) => {
      const { page } = authPage;
      await page.goto('/#/conversations');

      // Wait for the specific conversation to appear (use full ID for uniqueness)
      await expect(page.locator('.w-60 button').filter({ hasText: conversationId })).toBeVisible({ timeout: 5000 });
    });

    test('clicking a conversation loads the thread panel', async ({ authPage }) => {
      const { page } = authPage;
      await page.goto('/#/conversations');

      const convButton = page.locator('.w-60 button').first();
      await expect(convButton).toBeVisible();
      await convButton.click();

      // Thread panel no longer shows placeholder
      await expect(page.getByText('Select a conversation')).not.toBeVisible();
    });

    test('URL updates to /conversations/:id after selecting conversation', async ({ authPage }) => {
      const { page } = authPage;
      await page.goto('/#/conversations');

      await page.locator('.w-60 button').first().click();
      await expect(page).toHaveURL(/#\/conversations\//);
    });

    test('selecting different conversation replaces thread content', async ({ authPage, api, connInfo }) => {
      const { page, token } = authPage;

      // Create a second conversation
      const commResult = await api.execute<{ conversationId: string }>(token, 'communicate', {
        to: agentId,
        message: 'second message',
      });
      const secondConvId = commResult.result.data!.conversationId;

      await page.goto('/#/conversations');

      // Click first conversation, then second
      const buttons = page.locator('.w-60 button');
      await buttons.first().click();
      const firstUrl = page.url();

      await buttons.nth(1).click();
      const secondUrl = page.url();

      expect(firstUrl).not.toBe(secondUrl);
    });

    test('navigating away and back resets selected conversation', async ({ authPage }) => {
      const { page } = authPage;
      await page.goto('/#/conversations');

      await page.locator('.w-60 button').first().click();
      await expect(page).toHaveURL(/#\/conversations\//);

      // Navigate away and back to base conversations route
      await page.goto('/#/participants');
      // Allow SPA to fully unload before navigating back (hash-based routing timing)
      await page.waitForTimeout(500);
      await page.goto('/#/conversations');

      // No conversation selected — back to placeholder
      await expect(page.getByText('Select a conversation')).toBeVisible();
    });

    test('navigating away and back does not duplicate conversations in sidebar', async ({ authPage }) => {
      const { page } = authPage;
      await page.goto('/#/conversations');
      const initialCount = await page.locator('.w-60 button').count();

      await page.goto('/#/participants');
      await page.goto('/#/conversations');

      const afterCount = await page.locator('.w-60 button').count();
      expect(afterCount).toBe(initialCount);
    });
  });
});
