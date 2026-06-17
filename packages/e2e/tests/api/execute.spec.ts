import { test, expect } from '../../fixtures/index.js';

test.describe('POST /api/execute — management tools', () => {
  let token: string;

  test.beforeAll(async ({ api, connInfo }) => {
    ({ token } = await api.login('operator', connInfo.password));
  });

  test('list_participants returns array with at least the operator', async ({ api }) => {
    const { result } = await api.execute<{ id: string; name: string; type: string; status: string }>(
      token, 'list_participants',
    );
    expect(result.status).toBe('success');
    expect(Array.isArray(result.data)).toBe(true);
    const operator = result.data!.find((p) => p.id === 'operator');
    expect(operator).toBeDefined();
    expect(operator!.name).toBe('Operator');
    expect(operator!.status).toBe('active');
  });

  test('list_tools returns array of tool names, count > 0', async ({ api }) => {
    const { result } = await api.execute<string[]>(
      token, 'list_tools',
    );
    expect(result.status).toBe('success');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!.length).toBeGreaterThan(0);
    const first = result.data![0]!;
    expect(typeof first).toBe('string');
  });

  test('list_conversations returns empty array on fresh workspace', async ({ api }) => {
    const { result } = await api.execute(token, 'list_conversations');
    expect(result.status).toBe('success');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!).toHaveLength(0);
  });

  test('list_providers returns empty array on fresh workspace', async ({ api }) => {
    const { result } = await api.execute(token, 'list_providers');
    expect(result.status).toBe('success');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!).toHaveLength(0);
  });

  test('list_credentials returns empty array on fresh workspace', async ({ api }) => {
    const { result } = await api.execute(token, 'list_credentials');
    expect(result.status).toBe('success');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data!).toHaveLength(0);
  });

  test('set_credential_with_meta stores credential, appears in list_credentials', async ({ api }) => {
    const setResult = await api.execute(token, 'set_credential_with_meta', {
      key: 'test-cred',
      value: 'sk-test-value',
      usedBy: [],
    });
    expect(setResult.result.status).toBe('success');

    const listResult = await api.execute<{ key: string }[]>(token, 'list_credentials');
    const cred = listResult.result.data!.find((c) => c.key === 'test-cred');
    expect(cred).toBeDefined();
  });

  test('configure_provider stores provider, appears in list_providers', async ({ api, connInfo }) => {
    const configResult = await api.execute(token, 'configure_provider', {
      name: 'mock-llm',
      type: 'openai-compatible',
      baseUrl: connInfo.mockProviderUrl,
      defaultModel: 'mock-model',
      credentialKey: 'test-cred',
    });
    expect(configResult.result.status).toBe('success');

    const listResult = await api.execute<{ name: string }[]>(token, 'list_providers');
    const provider = listResult.result.data!.find((p) => p.name === 'mock-llm');
    expect(provider).toBeDefined();
  });

  test('create_agent returns new participant with id, name, type: "agent"', async ({ api }) => {
    const { result } = await api.execute<{ id: string }>(
      token, 'create_agent', {
        id: 'e2e-agent',
        name: 'e2e-agent',
        systemPrompt: 'you are helpful',
        model: { provider: 'mock-llm', model: 'mock-model' },
      },
    );
    expect(result.status).toBe('success');
    expect(typeof result.data!.id).toBe('string');

    const listResult = await api.execute<{ id: string; name: string; type: string }[]>(
      token, 'list_participants',
    );
    const agent = listResult.result.data!.find((p) => p.id === 'e2e-agent');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('e2e-agent');
    expect(agent!.type).toBe('agent');
  });

  test('modify_agent returns updated participant', async ({ api }) => {
    // Find the e2e-agent created in previous test
    const listResult = await api.execute<{ id: string; name: string }[]>(
      token, 'list_participants',
    );
    const agent = listResult.result.data!.find((p) => p.name === 'e2e-agent');
    expect(agent).toBeDefined();

    const { result } = await api.execute<{ id: string; name: string }>(
      token, 'modify_agent', {
        id: agent!.id,
        name: 'e2e-agent',
        model: 'mock-model-v2',
        systemPrompt: 'you are helpful',
        maxIterations: 5,
        toolPolicies: {},
      },
    );
    expect(result.status).toBe('success');
    expect(result.data!.id).toBe(agent!.id);
  });

  test('retire_agent causes participant status to become "retired"', async ({ api }) => {
    const listResult = await api.execute<{ id: string; name: string; status: string }[]>(
      token, 'list_participants',
    );
    const agent = listResult.result.data!.find((p) => p.name === 'e2e-agent');
    expect(agent).toBeDefined();

    await api.execute(token, 'retire_agent', { id: agent!.id });

    const afterList = await api.execute<{ id: string; status: string }[]>(
      token, 'list_participants',
    );
    const retired = afterList.result.data!.find((p) => p.id === agent!.id);
    expect(retired!.status).toBe('retired');
  });

  test('no token returns 401', async ({ api }) => {
    const { status } = await api.executeRaw('list_participants');
    expect(status).toBe(401);
  });

  test('unknown tool name returns error result', async ({ api }) => {
    const { result } = await api.execute(token, 'nonexistent_tool_xyz');
    expect(result.status).toBe('error');
  });
});
