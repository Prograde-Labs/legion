import { test, expect } from '../../fixtures/index.js';

function data<T>(response: { result: { status: string; data?: T; error?: string } }): T {
  expect(response.result.status, response.result.error).toBe('success');
  return response.result.data as T;
}

test.describe('Approvals journey', () => {
  let token: string;

  test.beforeAll(async ({ api, connInfo }) => {
    const login = await api.login('operator', connInfo.password);
    token = login.token;
    data(
      await api.execute(token, 'save_provider', {
        name: 'approval-e2e-provider',
        type: 'openai-compatible',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'test-key',
        priority: 10,
      }),
    );
  });

  test('pending approval badges, deep-links, and approves to completion', async ({
    authPage,
    api,
  }) => {
    const { page } = authPage;
    const agent = `approval-agent-${Date.now()}`;
    const namer = `approval-namer-${Date.now()}`;
    data(
      await api.execute(token, 'create_agent', {
        id: namer,
        name: namer,
        systemPrompt: 'You are a deterministic e2e agent.',
        model: { provider: 'approval-e2e-provider', model: 'mock-model' },
        tools: {},
      }),
    );
    data(
      await api.execute(token, 'create_agent', {
        id: agent,
        name: agent,
        systemPrompt: 'You are a deterministic e2e agent.',
        model: { provider: 'approval-e2e-provider', model: 'mock-model' },
        middleware: [
          {
            id: 'approval-naming',
            type: 'builtin:conversation-naming',
            failureMode: 'closed',
            config: {
              namingParticipantId: namer,
              maximumLength: 80,
              guidance: 'E2E_SHARED_TITLE',
              scope: 'shared',
              excludedTags: [],
            },
          },
        ],
        tools: { generate_conversation_title: 'requires_approval' },
      }),
    );

    // Arrange the pending approval entirely via API BEFORE navigating: the mock
    // provider's E2E_APPROVAL_SCENARIO + conversation-title middleware emits a
    // generate_conversation_title tool call that pauses for approval. There is no
    // websocket bridge for approval events, so the badge populates on ChatView mount.
    const paused = await api.execute<{ conversationId: string }>(token, 'communicate', {
      to: agent,
      message: 'E2E_APPROVAL_SCENARIO',
    });
    expect(paused.result.status).toBe('pending_approval');
    const conversationId = paused.result.data!.conversationId;

    await page.goto('/#/chat');
    const badge = page.locator('[data-test="nav-badge"]');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.click();

    // Badge deep-links into the pending conversation.
    await expect(page).toHaveURL(new RegExp(`#\\/chat/${conversationId}`));
    const card = page.locator('[data-test="approval-card"]');
    await expect(card).toBeVisible();

    // ApprovalCard sends decisions:[{approvalId, decision:'approve'}] (wire contract
    // fixed in 75eed15). Approving resumes the paused agent turn.
    await page.locator('[data-test="approval-approve"]').click();

    await expect(badge).toBeHidden({ timeout: 15_000 });
    await expect(card).toBeHidden();
    await expect
      .poll(async () => {
        // The naming middleware writes the title onto the conversation record
        // (conversation.title), not a summary message — matches middleware.spec.ts.
        const conversation = data<{ title?: string }>(
          await api.execute(token, 'get_conversation', { conversationId }),
        );
        return conversation.title;
      })
      .toBe('Shared Middleware Title');
  });
});
