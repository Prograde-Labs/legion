import { Buffer } from 'node:buffer';
import type { ConversationData, MessageData } from '@legion/types';
import type { ConversationStore } from '../../conversation/ConversationStore.js';
import {
  createAutoCompactionMiddleware,
  estimateProviderContextTokens,
  selectCompactionPrefix,
} from './auto-compaction.js';

function message(id: string, content: string, role: 'user' | 'assistant' = 'user'): MessageData {
  return {
    id,
    parentId: null,
    conversationId: 'c',
    senderId: 'u',
    recipientId: 'a',
    role,
    content,
    status: 'active',
    timestamp: id,
  };
}

describe('auto compaction selection', () => {
  function conversation(overrides: Partial<ConversationData> = {}): ConversationData {
    return {
      id: 'c',
      schemaVersion: '2.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      activeBranchHead: 'm2',
      messages: {},
      ...overrides,
    };
  }

  function definition(data: ConversationData, contextWindow?: number) {
    const conversationStore = {
      load: vi.fn().mockResolvedValue(data),
    } as unknown as ConversationStore;
    return createAutoCompactionMiddleware({
      conversationStore,
      getModelMetadata: async () => (contextWindow === undefined ? undefined : { contextWindow }),
    });
  }

  it('estimates summaries and tool calls/results exactly as AgentRuntime exposes them', () => {
    const summary = {
      ...message('summary', 'earlier facts', 'assistant'),
      type: 'summary' as const,
    };
    const toolTurn = {
      ...message('m1', 'working', 'assistant'),
      reasoning: 'hidden reasoning is not provider-visible',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'abc' } }],
      toolResults: [
        { id: 'call-1', name: 'read', result: { status: 'success' as const, data: 'done' } },
      ],
    };
    const visible =
      'system\n\n<previous_conversation_summary>\nearlier facts\n</previous_conversation_summary>' +
      'workingcall-1read{"path":"abc"}call-1read{"status":"success","data":"done"}';
    expect(estimateProviderContextTokens('system', [summary, toolTurn])).toBe(
      Math.ceil(Buffer.byteLength(visible) / 4),
    );
    expect(estimateProviderContextTokens('system', [toolTurn])).toBe(
      estimateProviderContextTokens('system', [{ ...toolTurn, reasoning: undefined }]),
    );
  });

  it('selects oldest contiguous prefix while retaining recent tokens', () => {
    const chain = [
      message('m1', 'a'.repeat(40)),
      message('m2', 'b'.repeat(40), 'assistant'),
      message('m3', 'c'.repeat(40)),
    ];
    expect(selectCompactionPrefix(chain, 15, 20).map((entry) => entry.id)).toEqual(['m1']);
  });

  it('uses model percentage and falls back to absolute threshold', async () => {
    const middleware = definition(conversation(), 100);
    const base = {
      participant: {
        id: 'agent',
        type: 'agent',
        model: { model: 'm' },
        systemPrompt: 'x'.repeat(40),
      },
      instance: { id: 'compact-1' },
      config: {
        triggerPercentage: 30,
        targetPercentage: 20,
        fallbackTokenThreshold: 1000,
        summarizerParticipantId: 'summary',
        minimumRecentTokens: 5,
        excludedTags: [],
      },
      conversationId: 'c',
      activeChain: [message('m1', 'x'.repeat(80)), message('m2', 'y'.repeat(40))],
      actions: [],
      getState: () => undefined,
    } as never;
    await expect(middleware.hooks.afterReceive!(base)).resolves.toEqual(
      expect.objectContaining({ kind: 'tool', tool: 'compact_conversation' }),
    );

    const fallback = definition(conversation());
    await expect(
      fallback.hooks.afterReceive!({
        ...base,
        config: { ...(base as never as { config: object }).config, fallbackTokenThreshold: 100 },
      } as never),
    ).resolves.toEqual({ kind: 'continue' });
  });

  it('skips helper tags and valid watermarks but retries a watermark absent from active branch', async () => {
    const helper = definition(conversation({ tags: ['compaction'] }), 20);
    const base = {
      participant: { id: 'agent', type: 'agent', model: { model: 'm' }, systemPrompt: '' },
      instance: { id: 'compact-1' },
      config: {
        triggerPercentage: 10,
        targetPercentage: 5,
        fallbackTokenThreshold: 10,
        summarizerParticipantId: 'summary',
        minimumRecentTokens: 1,
        excludedTags: [],
      },
      conversationId: 'c',
      activeChain: [message('m1', 'x'.repeat(40)), message('m2', 'y'.repeat(40))],
      actions: [],
      getState: () => undefined,
    } as never;
    await expect(helper.hooks.afterReceive!(base)).resolves.toEqual({ kind: 'continue' });
    const validWatermark = definition(conversation(), 20);
    await expect(
      validWatermark.hooks.afterReceive!({
        ...base,
        activeChain: [
          { ...message('summary-1', 'summary', 'assistant'), type: 'summary' },
          message('m2', 'y'.repeat(40)),
        ],
        getState: () => ({ summaryMessageId: 'summary-1' }),
      } as never),
    ).resolves.toEqual({ kind: 'continue' });
    const staleWatermark = definition(conversation(), 20);
    await expect(
      staleWatermark.hooks.afterReceive!({
        ...base,
        getState: () => ({ summaryMessageId: 'old-branch' }),
      } as never),
    ).resolves.toEqual(expect.objectContaining({ kind: 'tool' }));
  });

  it('skips non-agent participants before model metadata lookup', async () => {
    const getModelMetadata = vi.fn(async () => undefined);
    const conversationStore = { load: vi.fn() } as unknown as ConversationStore;
    const middleware = createAutoCompactionMiddleware({ conversationStore, getModelMetadata });
    await expect(
      middleware.hooks.afterReceive!({ participant: { id: 'user', type: 'user' } } as never),
    ).resolves.toEqual({ kind: 'continue' });
    expect(conversationStore.load).not.toHaveBeenCalled();
    expect(getModelMetadata).not.toHaveBeenCalled();
  });
});
