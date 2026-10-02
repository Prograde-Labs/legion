import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage.js';
import { FileConversationStore } from '../conversation/FileConversationStore.js';
import { appendMessage, type NewMessageInput } from '../conversation/conversation-ops.js';
import { UsageQuery } from './UsageQuery.js';
import type { MessageData, MessageUsage } from '@legion-collective/types';

const USAGE_GPT4O: MessageUsage = {
  input: 100,
  output: 50,
  reasoning: 0,
  cache: { read: 200, write: 10 },
  cost: 0.001,
  modelId: 'gpt-4o',
  providerId: 'openai',
};

const USAGE_CLAUDE: MessageUsage = {
  input: 200,
  output: 100,
  reasoning: 30,
  cache: { read: 50, write: 0 },
  cost: 0.005,
  modelId: 'claude-sonnet-4-5',
  providerId: 'anthropic',
};

async function makeConversation(
  store: FileConversationStore,
  participants: [string, string],
  usages: MessageUsage[],
  timestamps?: string[],
): Promise<string> {
  const conv = await store.create({
    schemaVersion: '2.0',
    activeBranchHead: '',
    messages: {},
  });
  await appendMsg(store, conv.id, {
    senderId: participants[0],
    recipientId: participants[1],
    role: 'user',
    content: 'hello',
  });
  for (let i = 0; i < usages.length; i++) {
    const ts = timestamps?.[i];
    const msg = await appendMsg(store, conv.id, {
      senderId: participants[1],
      recipientId: participants[0],
      role: 'assistant',
      content: `response ${i}`,
      usage: usages[i],
    });
    if (ts) {
      await store.updateMessage(conv.id, msg.id, { timestamp: ts });
    }
  }
  return conv.id;
}

async function appendMsg(
  store: FileConversationStore,
  convId: string,
  input: NewMessageInput,
): Promise<MessageData> {
  const { after: updated } = await store.mutate(convId, (conv) => appendMessage(conv, input));
  return updated.messages[updated.activeBranchHead];
}

describe('UsageQuery', () => {
  it('returns zero totals for an empty conversation store', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const query = new UsageQuery(store);

    const report = await query.query({});
    expect(report.totals.messageCount).toBe(0);
    expect(report.totals.cost).toBe(0);
  });

  it('sums usage across all messages in all conversations', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(2);
    expect(report.totals.input).toBe(300);
    expect(report.totals.output).toBe(150);
    expect(report.totals.reasoning).toBe(30);
    expect(report.totals.cache.read).toBe(250);
    expect(report.totals.cost).toBeCloseTo(0.006, 6);
  });

  it('filters by conversationId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const id1 = await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ conversationId: id1 });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('filters by participantId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ participantId: 'agent-1' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('filters by modelId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O, USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ modelId: 'claude-sonnet-4-5' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(200);
  });

  it('filters by providerId', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O, USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ providerId: 'openai' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100);
  });

  it('filters by since timestamp', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(
      store,
      ['user-1', 'agent-1'],
      [USAGE_GPT4O, USAGE_CLAUDE],
      ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
    );

    const query = new UsageQuery(store);
    const report = await query.query({ since: '2026-03-01T00:00:00.000Z' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(200); // CLAUDE
  });

  it('filters by until timestamp', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(
      store,
      ['user-1', 'agent-1'],
      [USAGE_GPT4O, USAGE_CLAUDE],
      ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
    );

    const query = new UsageQuery(store);
    const report = await query.query({ until: '2026-03-01T00:00:00.000Z' });

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100); // GPT4O
  });

  it('groups by model', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O, USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'model' });

    expect(report.groups).toHaveLength(2);
    const gptGroup = report.groups!.find((g) => g.key === 'gpt-4o');
    expect(gptGroup?.totals.input).toBe(100);
    const claudeGroup = report.groups!.find((g) => g.key === 'claude-sonnet-4-5');
    expect(claudeGroup?.totals.input).toBe(200);
  });

  it('groups by participant', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'participant' });

    expect(report.groups).toHaveLength(2);
    const agent1Group = report.groups!.find((g) => g.key === 'agent-1');
    expect(agent1Group?.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('groups by conversation', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const id1 = await makeConversation(store, ['user-1', 'agent-1'], [USAGE_GPT4O]);
    await makeConversation(store, ['user-2', 'agent-2'], [USAGE_CLAUDE]);

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'conversation' });

    expect(report.groups).toHaveLength(2);
    const conv1Group = report.groups!.find((g) => g.key === id1);
    expect(conv1Group?.totals.cost).toBeCloseTo(0.001, 6);
  });

  it('groups by day (UTC, YYYY-MM-DD)', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    await makeConversation(
      store,
      ['user-1', 'agent-1'],
      [USAGE_GPT4O, USAGE_CLAUDE],
      ['2026-01-15T10:00:00.000Z', '2026-01-16T22:00:00.000Z'],
    );

    const query = new UsageQuery(store);
    const report = await query.query({ groupBy: 'day' });

    expect(report.groups).toHaveLength(2);
    const day1 = report.groups!.find((g) => g.key === '2026-01-15');
    expect(day1?.totals.input).toBe(100);
    const day2 = report.groups!.find((g) => g.key === '2026-01-16');
    expect(day2?.totals.input).toBe(200);
  });

  it('skips superseded and pruned messages', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await appendMsg(store, conv.id, {
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
    });
    const msg1 = await appendMsg(store, conv.id, {
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'first',
      usage: USAGE_GPT4O,
    });
    // Manually mark the first assistant message as superseded
    await store.updateMessage(conv.id, msg1.id, { status: 'superseded' });
    await appendMsg(store, conv.id, {
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'second',
      usage: USAGE_CLAUDE,
    });

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(1); // Only the non-superseded one
    expect(report.totals.input).toBe(200); // CLAUDE
  });

  it('includes compacted messages', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await appendMsg(store, conv.id, {
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
    });
    const msg = await appendMsg(store, conv.id, {
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'compacted',
      usage: USAGE_GPT4O,
    });
    await store.updateMessage(conv.id, msg.id, { status: 'compacted' });

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100);
  });

  it('ignores messages without usage', async () => {
    const storage = new MemoryStorage();
    const store = new FileConversationStore(storage);
    const conv = await store.create({ schemaVersion: '2.0', activeBranchHead: '', messages: {} });
    await appendMsg(store, conv.id, {
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
    });
    await appendMsg(store, conv.id, {
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'no usage',
    });
    await appendMsg(store, conv.id, {
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'with usage',
      usage: USAGE_GPT4O,
    });

    const query = new UsageQuery(store);
    const report = await query.query({});

    expect(report.totals.messageCount).toBe(1);
    expect(report.totals.input).toBe(100);
  });
});
