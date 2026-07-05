import { test, expect } from '../../fixtures/index.js';

test.describe('Markdown rendering in message bubbles', () => {
  let agentId: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const { token } = await api.login('operator', connInfo.password);

    await api.execute(token, 'set_credential_with_meta', {
      key: 'md-test-cred',
      value: 'sk-mock',
      usedBy: [],
    });
    await api.execute(token, 'configure_provider', {
      name: 'md-test-provider',
      type: 'openai-compatible',
      baseUrl: connInfo.mockProviderUrl,
      defaultModel: 'mock-model',
      credentialKey: 'md-test-cred',
    });

    const createResult = await api.execute<{ id: string }>(token, 'create_agent', {
      id: `md-test-agent-${Date.now()}`,
      name: 'md-test-agent',
      systemPrompt: 'test agent for markdown rendering',
      model: { provider: 'md-test-provider', model: 'mock-model' },
    });
    expect(createResult.result.status).toBe('success');
    agentId = createResult.result.data!.id;
  });

  test('bold markdown in user message renders as <strong>, not raw **', async ({
    authPage,
    api,
  }) => {
    const { page, token } = authPage;

    const commResult = await api.execute<{ conversationId: string }>(token, 'communicate', {
      to: agentId,
      message: '**bold text** and `inline code`',
    });
    expect(commResult.result.status).toBe('success');
    const conversationId = commResult.result.data!.conversationId;

    await page.goto(`/#/conversations/${conversationId}`);

    // Wait for chat mode to kick in (conversations load async; chat mode shows [data-bubble])
    await page.waitForSelector('[data-bubble]', { timeout: 8000 });

    // Some bubble must contain a <strong> element
    await expect(page.locator('[data-bubble] strong').first()).toBeVisible();

    // No bubble should contain the raw markdown asterisks
    await expect(page.locator('[data-bubble]').first()).not.toContainText('**bold text**');
  });

  test('fenced code block in user message renders with copy button that writes correct text', async ({
    authPage,
    api,
  }) => {
    const { page, token } = authPage;

    // Spy on clipboard.writeText before any navigation
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__clipboardData'] = '';
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: (text: string): Promise<void> => {
            (window as unknown as Record<string, unknown>)['__clipboardData'] = text;
            return Promise.resolve();
          },
        },
        configurable: true,
        writable: true,
      });
    });

    const commResult = await api.execute<{ conversationId: string }>(token, 'communicate', {
      to: agentId,
      message: 'Here is some code:\n```typescript\nconst x: number = 42;\n```',
    });
    expect(commResult.result.status).toBe('success');
    const conversationId = commResult.result.data!.conversationId;

    await page.goto(`/#/conversations/${conversationId}`);

    // Wait for the code block copy button to appear
    await page.waitForSelector('[data-copy-code]', { timeout: 8000 });

    await page.locator('[data-copy-code]').first().click();

    const copied = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)['__clipboardData'] as string,
    );
    expect(copied.trim()).toContain('const x: number = 42;');
  });
});
