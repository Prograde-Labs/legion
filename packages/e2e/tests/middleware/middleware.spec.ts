import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '../../fixtures/index.js';
import type { ApiClient, ExecuteResult } from '../../helpers/api.js';

type Middleware = {
  id: string;
  type: string;
  enabled?: boolean;
  failureMode?: 'open' | 'closed';
  config: Record<string, unknown>;
};
type Conversation = {
  id: string;
  title?: string;
  sharedTitle?: string;
  titles?: Record<string, string>;
  status?: 'active' | 'archived';
  tags?: string[];
  origin?: { kind: string; middlewareInstanceId?: string; parentConversationId?: string };
  messages: Array<{ id: string; type?: string; content: string }>;
};

function data<T>(response: ExecuteResult<T>): T {
  expect(response.result.status, response.result.error).toBe('success');
  return response.result.data as T;
}

async function createAgent(
  api: ApiClient,
  token: string,
  id: string,
  middleware: Middleware[],
  tools: Record<string, 'auto' | 'requires_approval'>,
) {
  return data<{ id: string }>(
    await api.executeBuffered(token, 'create_agent', {
      id,
      name: id,
      systemPrompt: 'Follow scenario markers and use supplied tools.',
      model: { provider: 'middleware-e2e-provider', model: 'mock-model' },
      middleware,
      tools,
    }),
  );
}

test.describe('middleware system', () => {
  let token: string;
  let operatorId: string;
  let sequence = 0;
  const unique = (stem: string) => `${stem}-${Date.now()}-${sequence++}`;

  test.beforeAll(async ({ api, connInfo }) => {
    const login = await api.login('operator', connInfo.password);
    token = login.token;
    operatorId = login.participantId;
    data(
      await api.executeBuffered(token, 'save_provider', {
        name: 'middleware-e2e-provider',
        type: 'openai-compatible',
        baseUrl: `${connInfo.mockProviderUrl}/v1`,
        apiKey: 'sk-mock',
        priority: 10,
      }),
    );
  });

  test('loads only configured skill and returns its instructions to the loop', async ({ api }) => {
    const agent = unique('skill-agent');
    await createAgent(
      api,
      token,
      agent,
      [{ id: 'skills', type: 'builtin:skills', config: { skills: ['e2e-proof-skill'] } }],
      { load_skills: 'auto' },
    );

    const result = data<{ response: string; conversationId: string }>(
      await api.executeBuffered(token, 'communicate', {
        to: agent,
        message: 'E2E_SKILL_SCENARIO',
      }),
    );

    expect(result.response).toBe('SKILL_LOADED_OK');
    const conversation = data<Conversation>(
      await api.executeBuffered(token, 'get_conversation', {
        conversationId: result.conversationId,
      }),
    );
    expect(conversation.messages.some((message) => message.content === 'SKILL_LOADED_OK')).toBe(
      true,
    );
  });

  test('auto-compacts and hides its archived helper from default listing', async ({ api }) => {
    const summarizer = unique('summarizer');
    const agent = unique('compact-agent');
    await createAgent(api, token, summarizer, [], {});
    await createAgent(
      api,
      token,
      agent,
      [
        {
          id: 'auto-compact',
          type: 'builtin:auto-compaction',
          config: {
            triggerPercentage: 1,
            targetPercentage: 1,
            fallbackTokenThreshold: 1,
            summarizerParticipantId: summarizer,
            minimumRecentTokens: 1,
            excludedTags: [],
          },
        },
      ],
      { compact_conversation: 'auto' },
    );

    const warmup = data<{ conversationId: string }>(
      await api.executeBuffered(token, 'communicate', {
        to: agent,
        message: 'compaction warmup',
      }),
    );
    const sent = data<{ conversationId: string }>(
      await api.executeBuffered(token, 'communicate', {
        to: agent,
        message: `E2E_AUTO_COMPACT ${'context '.repeat(300)}`,
        conversationId: warmup.conversationId,
      }),
    );
    const parent = data<Conversation>(
      await api.executeBuffered(token, 'get_conversation', {
        conversationId: sent.conversationId,
      }),
    );
    expect(parent.messages.some((message) => message.type === 'summary')).toBe(true);

    const active = data<{ conversations: Array<{ id: string }> }>(
      await api.executeBuffered(token, 'list_conversations', { status: 'active' }),
    );
    const archived = data<{ conversations: Array<Conversation> }>(
      await api.executeBuffered(token, 'list_conversations', {
        status: 'archived',
        tags: ['compaction'],
      }),
    );
    const helper = archived.conversations.find(
      (conversation) => conversation.origin?.parentConversationId === sent.conversationId,
    );
    expect(helper?.status).toBe('archived');
    expect(helper?.origin).toMatchObject({
      kind: 'middleware',
      middlewareInstanceId: 'auto-compact',
    });
    expect(active.conversations.some((conversation) => conversation.id === helper?.id)).toBe(false);

    const all = data<{ conversations: Array<{ id: string }> }>(
      await api.executeBuffered(token, 'list_conversations', {
        status: 'all',
        tags: ['compaction'],
      }),
    );
    expect(all.conversations.some((conversation) => conversation.id === helper?.id)).toBe(true);
  });

  test('generates shared and participant-scoped resolved titles', async ({ api }) => {
    const namer = unique('namer');
    const sharedAgent = unique('shared-title-agent');
    const participantAgent = unique('participant-title-agent');
    await createAgent(api, token, namer, [], {});
    await createAgent(
      api,
      token,
      sharedAgent,
      [
        {
          id: 'shared-naming',
          type: 'builtin:conversation-naming',
          config: {
            namingParticipantId: namer,
            maximumLength: 80,
            guidance: 'E2E_SHARED_TITLE',
            scope: 'shared',
            excludedTags: [],
          },
        },
      ],
      { generate_conversation_title: 'auto' },
    );
    await createAgent(
      api,
      token,
      participantAgent,
      [
        {
          id: 'participant-naming',
          type: 'builtin:conversation-naming',
          config: {
            namingParticipantId: namer,
            maximumLength: 80,
            guidance: 'E2E_PARTICIPANT_TITLE',
            scope: 'participant',
            excludedTags: [],
          },
        },
      ],
      { generate_conversation_title: 'auto' },
    );

    const sharedSend = data<{ conversationId: string }>(
      await api.executeBuffered(token, 'communicate', {
        to: sharedAgent,
        message: 'E2E_NAMING_PARENT shared',
      }),
    );
    const participantSend = data<{ conversationId: string }>(
      await api.executeBuffered(token, 'communicate', {
        to: participantAgent,
        message: 'E2E_NAMING_PARENT participant',
      }),
    );
    const shared = data<Conversation>(
      await api.executeBuffered(token, 'get_conversation', {
        conversationId: sharedSend.conversationId,
      }),
    );
    const participant = data<Conversation>(
      await api.executeBuffered(token, 'get_conversation', {
        conversationId: participantSend.conversationId,
      }),
    );

    expect(shared.title).toBe('Shared Middleware Title');
    expect(shared.sharedTitle).toBe('Shared Middleware Title');
    // Operator is not title owner, so resolved title stays on shared fallback while raw map proves
    // participant-scoped write targeted attached agent.
    expect(participant.title).toBeUndefined();
    expect(participant.sharedTitle).toBeUndefined();
    expect(participant.titles?.[participantAgent]).toBe('Participant Middleware Title');
    expect(participant.titles?.[operatorId]).toBeUndefined();
  });

  test('pauses and resumes an approved middleware tool request once', async ({ api, connInfo }) => {
    const namer = unique('approval-namer');
    const agent = unique('approval-agent');
    await createAgent(api, token, namer, [], {});
    await createAgent(
      api,
      token,
      agent,
      [
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
      { generate_conversation_title: 'requires_approval' },
    );

    const paused = await api.executeBuffered<{
      conversationId: string;
      approvalRequests?: Array<{ approvalId: string; tool: string }>;
    }>(token, 'communicate', { to: agent, message: 'E2E_APPROVAL_SCENARIO' });
    expect(paused.result.status).toBe('pending_approval');
    const pending = paused.result.data!;
    // The streaming respond path returns no approvalRequests for middleware pauses, so the
    // approvalId is discovered from the durable pending-approval registry instead.
    const registryPath = join(
      connInfo.workspaceDir,
      '.legion',
      'pending-approvals',
      'registry.json',
    );
    type RegistryFile = {
      records: Record<
        string,
        { approvalId: string; conversationId: string; tool: string; lifecycle: string }
      >;
    };
    let approvalId = '';
    await expect
      .poll(async () => {
        const raw = JSON.parse(await readFile(registryPath, 'utf8')) as RegistryFile;
        const record = Object.values(raw.records).find(
          (candidate) =>
            candidate.conversationId === pending.conversationId &&
            candidate.tool === 'generate_conversation_title' &&
            candidate.lifecycle === 'pending',
        );
        approvalId = record?.approvalId ?? '';
        return approvalId;
      })
      .not.toBe('');

    data(
      await api.executeBuffered(token, 'approval_response', {
        decisions: [
          {
            approvalId,
            decision: 'approve',
            message: 'e2e approval',
          },
        ],
      }),
    );

    await expect
      .poll(async () => {
        const conversation = data<Conversation>(
          await api.executeBuffered(token, 'get_conversation', {
            conversationId: pending.conversationId,
          }),
        );
        return conversation.sharedTitle;
      })
      .toBe('Shared Middleware Title');

    const helpers = data<{ conversations: Conversation[] }>(
      await api.executeBuffered(token, 'list_conversations', {
        status: 'archived',
        tags: ['conversation-title'],
      }),
    );
    expect(
      helpers.conversations.filter(
        (conversation) => conversation.origin?.parentConversationId === pending.conversationId,
      ),
    ).toHaveLength(1);
  });

  test('browser exposes archived helper filters and resolved titles', async ({ authPage, api }) => {
    const agent = unique('browser-title-agent');
    const namer = unique('browser-title-namer');
    await createAgent(api, token, namer, [], {});
    await createAgent(
      api,
      token,
      agent,
      [
        {
          id: 'browser-naming',
          type: 'builtin:conversation-naming',
          config: {
            namingParticipantId: namer,
            maximumLength: 80,
            guidance: 'E2E_SHARED_TITLE',
            scope: 'shared',
            excludedTags: [],
          },
        },
      ],
      { generate_conversation_title: 'auto' },
    );
    await api.executeBuffered(token, 'communicate', {
      to: agent,
      message: 'E2E_NAMING_PARENT browser',
    });

    const { page } = authPage;
    await page.goto('/#/conversations');
    await expect(page.getByText('Shared Middleware Title', { exact: true }).first()).toBeVisible();
    // Helper conversations belong to agent↔namer, so the default "Mine" mode hides them.
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.locator('[data-status="archived"]').click();
    await page.locator('[data-tag-filter]').fill('conversation-title');
    await page.locator('[data-tag-filter]').press('Tab');
    await expect(page.locator('[data-conversation-title]').first()).toBeVisible();
    await page.locator('[data-tag-filter]').fill('');
    await page.locator('[data-tag-filter]').press('Tab');
    await page.locator('[data-status="active"]').click();
    await expect(page.getByText('Shared Middleware Title', { exact: true }).first()).toBeVisible();
  });
});
