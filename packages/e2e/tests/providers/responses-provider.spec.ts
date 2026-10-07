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

test.describe('Responses API provider end-to-end', () => {
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
        name: 'responses-mock-provider',
        type: 'openai-responses',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'sk-e2e-responses',
        priority: 10,
      },
    );
    expect(providerResult.result.status).toBe('success');

    agentName = `responses-test-agent-${Date.now()}`;
    const createResult = await executeBuffered<{ id: string }>(
      request,
      connInfo.serverUrl,
      token,
      'create_agent',
      {
        id: agentName,
        name: agentName,
        systemPrompt: 'You are a terse mock-backed assistant.',
        model: { provider: 'responses-mock-provider', model: 'mock-model' },
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
        name: 'responses-mock-provider',
      },
    );
    expect(deleteResult.result.status).toBe('success');
  });

  test('one agent turn streams text over the Responses wire', async ({
    api,
    connInfo,
    request,
  }) => {
    const { token } = await api.login('operator', connInfo.password);

    const commResult = await executeBuffered<{ conversationId: string }>(
      request,
      connInfo.serverUrl,
      token,
      'communicate',
      { to: agentName, message: 'hello over responses' },
    );
    expect(commResult.result.status).toBe('success');
    const conversationId = commResult.result.data!.conversationId;

    const convResult = await executeBuffered<{
      messages: Array<{ role: string; content: string | null }>;
    }>(request, connInfo.serverUrl, token, 'get_conversation', { conversationId });
    expect(convResult.result.status).toBe('success');

    const contents = convResult.result.data!.messages.map((m) => m.content ?? '');
    expect(contents.join('\n')).toContain('mock response');
  });
});
