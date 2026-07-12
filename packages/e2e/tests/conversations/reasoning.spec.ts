import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures/index.js';
import type { ExecuteResult } from '../../helpers/api.js';

async function executeBuffered<T = unknown>(
  request: APIRequestContext,
  serverUrl: string,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult<T>> {
  const response = await request.post(`${serverUrl}/api/execute?stream=false`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { tool, args },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ExecuteResult<T>>;
}

test('rejects malformed mock chat requests without stopping the provider', async ({
  connInfo,
  request,
}) => {
  const malformedResponse = await request.post(`${connInfo.mockProviderUrl}/v1/chat/completions`, {
    headers: { 'Content-Type': 'application/json' },
    data: Buffer.from('{'),
  });
  expect(malformedResponse.status()).toBe(400);

  const modelsResponse = await request.get(`${connInfo.mockProviderUrl}/v1/models`);
  expect(modelsResponse.status()).toBe(200);
});

test('rejects invalid mock chat request shapes without stopping the provider', async ({
  connInfo,
  request,
}) => {
  const invalidRequests = [null, [], { messages: {} }, { messages: [{ content: 42 }] }];

  for (const invalidRequest of invalidRequests) {
    const response = await request.post(`${connInfo.mockProviderUrl}/v1/chat/completions`, {
      headers: { 'Content-Type': 'application/json' },
      data: Buffer.from(JSON.stringify(invalidRequest)),
    });
    expect(response.status()).toBe(400);

    const modelsResponse = await request.get(`${connInfo.mockProviderUrl}/v1/models`);
    expect(modelsResponse.status()).toBe(200);
  }

  const responseWithExtraFields = await request.post(
    `${connInfo.mockProviderUrl}/v1/chat/completions`,
    {
      headers: { 'Content-Type': 'application/json' },
      data: Buffer.from(
        JSON.stringify({
          model: 'mock-model',
          messages: [{ role: 'user', content: 'hello', name: 'operator' }],
          stream: true,
        }),
      ),
    },
  );
  expect(responseWithExtraFields.status()).toBe(200);
  await expect(responseWithExtraFields.text()).resolves.toContain('mock response');
});

test.describe('Reasoning streams', () => {
  let agentName: string;
  let operatorToken: string;

  test.beforeAll(async ({ api, connInfo, request }) => {
    const { token } = await api.login('operator', connInfo.password);
    operatorToken = token;

    const providerResult = await executeBuffered(
      request,
      connInfo.serverUrl,
      token,
      'save_provider',
      {
        name: 'reasoning-mock-provider',
        type: 'openai-compatible',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'sk-mock',
        priority: 10,
      },
    );
    expect(providerResult.result.status).toBe('success');

    agentName = `reasoning-test-agent-${Date.now()}`;
    const createResult = await executeBuffered<{ id: string }>(
      request,
      connInfo.serverUrl,
      token,
      'create_agent',
      {
        id: agentName,
        name: agentName,
        systemPrompt: 'Use available tools when requested.',
        model: { provider: 'reasoning-mock-provider', model: 'mock-model' },
        tools: { list_participants: 'auto' },
      },
    );
    expect(createResult.result.status).toBe('success');
  });

  test.afterAll(async ({ connInfo, request }) => {
    const retireResult = await executeBuffered(
      request,
      connInfo.serverUrl,
      operatorToken,
      'retire_agent',
      { id: agentName },
    );
    expect(retireResult.result.status).toBe('success');

    const deleteResult = await executeBuffered(
      request,
      connInfo.serverUrl,
      operatorToken,
      'delete_provider',
      {
        name: 'reasoning-mock-provider',
      },
    );
    expect(deleteResult.result.status).toBe('success');
  });

  test('streams and persists reasoning across two iterations', async ({ authPage }) => {
    const { page } = authPage;
    await page.goto('/#/conversations/new');

    const agentSelect = page.getByPlaceholder('Select agent...');
    await agentSelect.fill(agentName);
    await page.locator('[data-option]').filter({ hasText: agentName }).click();

    await page.getByPlaceholder(`Message ${agentName}...`).fill('E2E_REASONING_SCENARIO');
    await page.getByRole('button', { name: 'Send' }).click();

    const streamingMessage = page.locator('[data-streaming-message]');
    const streamingReasoning = streamingMessage.locator('[data-streaming-reasoning]');
    const streamingAnswer = streamingMessage.locator('[data-streaming-answer]');
    await expect(streamingReasoning).toContainText('tool reasoning');
    await expect(streamingAnswer).toContainText('temporary preface');
    await expect(streamingReasoning).toContainText('final reasoning');
    await expect(streamingMessage).not.toContainText('temporary preface');
    await expect(streamingAnswer).toContainText('final reasoning answer');

    await expect(streamingMessage).toHaveCount(0);
    await expect(
      page.locator('[data-bubble]').filter({ hasText: 'final reasoning answer' }),
    ).toBeVisible();

    const disclosures = page.locator('details[data-reasoning]');
    await expect(disclosures).toHaveCount(2);
    await expect(disclosures.nth(0)).not.toHaveAttribute('open');
    await expect(disclosures.nth(1)).not.toHaveAttribute('open');

    await disclosures.nth(0).locator('summary').click();
    await expect(disclosures.nth(0)).toHaveAttribute('open', '');
    await expect(disclosures.nth(1)).not.toHaveAttribute('open');
    await expect(disclosures.nth(0)).toContainText('tool reasoning');

    await page.reload();
    const persistedDisclosures = page.locator('details[data-reasoning]');
    await expect(persistedDisclosures).toHaveCount(2);
    await expect(persistedDisclosures.nth(0)).not.toHaveAttribute('open');
    await expect(persistedDisclosures.nth(1)).not.toHaveAttribute('open');
    await expect(persistedDisclosures.nth(0)).toContainText('tool reasoning');
    await expect(persistedDisclosures.nth(1)).toContainText('final reasoning');
  });
});
