import type {
  ParticipantConfig,
  ConversationData,
  MessageData,
  ToolResult,
  WorkspaceConfig,
} from './index.js';

describe('domain type shapes', () => {
  it('accepts a representative agent participant', () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      type: 'agent',
      tools: { communicate: 'auto' },
      systemPrompt: 'You are helpful.',
      model: { provider: 'openai-compatible', model: 'gpt-4o-mini' },
    } satisfies ParticipantConfig;
    expect(agent.type).toBe('agent');
  });

  it('accepts a representative conversation with a keyed message map', () => {
    const root: MessageData = {
      id: 'm1',
      parentId: null,
      conversationId: 'conv-1',
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hi',
      status: 'active',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const conv = {
      id: 'conv-1',
      schemaVersion: '2.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      activeBranchHead: 'm1',
      messages: { m1: root },
    } satisfies ConversationData;
    expect(conv.messages.m1.parentId).toBeNull();
  });

  it('accepts a tool result and workspace config', () => {
    const ok: ToolResult = { status: 'success', data: 42 };
    const cfg = { version: '2' } satisfies WorkspaceConfig;
    expect(ok.status).toBe('success');
    expect(cfg.version).toBe('2');
  });
});
