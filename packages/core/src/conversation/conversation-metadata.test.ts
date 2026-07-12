import type { ConversationData, MessageData } from '@legion/types';
import {
  applyConversationMutation,
  conversationMatchesFilter,
  getConversationEventMetadata,
  getConversationStatus,
  resolveConversationTitle,
} from './conversation-metadata.js';

function conversation(overrides: Partial<ConversationData> = {}): ConversationData {
  return {
    id: 'conversation-1',
    schemaVersion: '2.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    activeBranchHead: '',
    messages: {},
    ...overrides,
  };
}

function message(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: 'message-1',
    parentId: null,
    conversationId: 'conversation-1',
    senderId: 'participant-1',
    recipientId: 'participant-2',
    role: 'user',
    content: 'hello',
    status: 'active',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('conversation metadata', () => {
  it('normalizes defaults and resolves participant titles before shared titles', () => {
    const input = conversation({
      title: 'Shared',
      titles: { 'participant-1': 'Personal' },
      origin: { kind: 'participant', participantId: 'participant-1' },
      parentConversationId: 'parent-1',
      parentToolCallId: 'tool-call-1',
      messages: {
        one: message(),
        two: message({ id: 'message-2', senderId: 'participant-2', recipientId: 'participant-3' }),
      },
    });

    expect(getConversationStatus(input)).toBe('active');
    expect(resolveConversationTitle(input, 'participant-1')).toBe('Personal');
    expect(resolveConversationTitle(input, 'participant-2')).toBe('Shared');

    const metadata = getConversationEventMetadata(input);
    expect(metadata).toEqual({
      id: 'conversation-1',
      title: 'Shared',
      titles: { 'participant-1': 'Personal' },
      status: 'active',
      tags: [],
      origin: { kind: 'participant', participantId: 'participant-1' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      participants: ['participant-1', 'participant-2', 'participant-3'],
      parentConversationId: 'parent-1',
      parentToolCallId: 'tool-call-1',
    });
  });

  it('isolates mutable metadata records from the source conversation', () => {
    const input = conversation({
      titles: { 'participant-1': 'Personal' },
      origin: { kind: 'middleware', participantId: 'participant-1' },
    });

    const metadata = getConversationEventMetadata(input);
    metadata.titles!['participant-1'] = 'Changed';
    Object.assign(metadata.origin!, { participantId: 'participant-2' });

    expect(input.titles).toEqual({ 'participant-1': 'Personal' });
    expect(input.origin).toEqual({ kind: 'middleware', participantId: 'participant-1' });
  });

  it('adds unique case-sensitive tags and applies removals atomically', () => {
    const input = conversation({ tags: ['A', 'a', 'remove'] });

    const result = applyConversationMutation(input, {
      addTags: ['A', 'B', 'B'],
      removeTags: ['remove'],
    });

    expect(result.tags).toEqual(['A', 'a', 'B']);
    expect(input.tags).toEqual(['A', 'a', 'remove']);
  });

  it('applies first-write-wins independently to shared and participant titles', () => {
    const input = conversation({ title: 'Existing shared' });
    const shared = applyConversationMutation(input, {
      title: { scope: 'shared', value: 'Replacement' },
      titleMode: 'first_write_wins',
    });
    const participant = applyConversationMutation(shared, {
      title: { scope: 'participant', participantId: 'participant-1', value: 'Personal' },
      titleMode: 'first_write_wins',
    });

    expect(participant.title).toBe('Existing shared');
    expect(participant.titles).toEqual({ 'participant-1': 'Personal' });
    expect(() =>
      applyConversationMutation(input, {
        title: { scope: 'participant', value: 'Invalid' },
      }),
    ).toThrow('participantId');
  });

  it('matches all requested tags and defaults lifecycle filtering to active top-level threads', () => {
    const active = getConversationEventMetadata(
      conversation({
        tags: ['one', 'two'],
        messages: { one: message() },
      }),
    );
    const archived = { ...active, status: 'archived' as const };
    const subthread = { ...active, parentConversationId: 'parent-1' };

    expect(conversationMatchesFilter(active, { tags: ['one', 'two'] })).toBe(true);
    expect(conversationMatchesFilter(active, { tags: ['one', 'missing'] })).toBe(false);
    expect(conversationMatchesFilter(active, { participantId: 'participant-2' })).toBe(true);
    expect(conversationMatchesFilter(active, { since: active.updatedAt })).toBe(true);
    expect(conversationMatchesFilter(archived, {})).toBe(false);
    expect(conversationMatchesFilter(archived, { status: 'all' })).toBe(true);
    expect(conversationMatchesFilter(subthread, {})).toBe(false);
    expect(conversationMatchesFilter(subthread, { includeSubThreads: true })).toBe(true);
  });

  it('compares since timestamps by epoch and rejects invalid filters', () => {
    const input = conversation({ updatedAt: '2026-01-02T00:00:00.000Z' });

    expect(conversationMatchesFilter(input, { since: '2026-01-02T00:00:00Z' })).toBe(true);
    expect(conversationMatchesFilter(input, { since: '2026-01-01T19:00:00.001-05:00' })).toBe(
      false,
    );
    expect(conversationMatchesFilter(input, { since: 'not-a-timestamp' })).toBe(false);
  });

  it('replaces only the addressed middleware state namespace', () => {
    const input = conversation({
      middlewareState: {
        'participant-1': { first: { old: true }, sibling: 'keep' },
        'participant-2': { first: 'keep' },
      },
    });

    const result = applyConversationMutation(input, {
      middlewareState: {
        participantId: 'participant-1',
        instanceId: 'first',
        value: { replacement: true },
      },
      status: 'archived',
    });

    expect(result.middlewareState).toEqual({
      'participant-1': { first: { replacement: true }, sibling: 'keep' },
      'participant-2': { first: 'keep' },
    });
    expect(result.status).toBe('archived');
    expect(input.middlewareState?.['participant-1']?.first).toEqual({ old: true });
    expect(result.middlewareState?.['participant-2']).toBe(
      input.middlewareState?.['participant-2'],
    );
  });

  it('isolates stored middleware state from later source mutations', () => {
    const value = { nested: { enabled: true } };
    const result = applyConversationMutation(conversation(), {
      middlewareState: {
        participantId: 'participant-1',
        instanceId: 'first',
        value,
      },
    });

    value.nested.enabled = false;

    expect(result.middlewareState?.['participant-1']?.first).toEqual({
      nested: { enabled: true },
    });
  });
});
