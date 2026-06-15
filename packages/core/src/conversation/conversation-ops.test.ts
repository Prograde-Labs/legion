import { createConversation, appendMessage, getActiveChain, editMessage } from './conversation-ops.js';

describe('conversation-ops: creation and active chain', () => {
  it('createConversation seeds an empty thread with no head', () => {
    const conv = createConversation();
    expect(conv.id).toMatch(/^conv-\d+-[a-z0-9]{5}$/);
    expect(conv.schemaVersion).toBe('2.0');
    expect(conv.activeBranchHead).toBe('');
    expect(conv.messages).toEqual({});
  });

  it('appendMessage links to the current head and advances it', () => {
    let conv = createConversation();
    conv = appendMessage(conv, {
      senderId: 'user-1',
      recipientId: 'agent-1',
      role: 'user',
      content: 'hello',
    });
    const rootId = conv.activeBranchHead;
    expect(conv.messages[rootId].parentId).toBeNull();

    conv = appendMessage(conv, {
      senderId: 'agent-1',
      recipientId: 'user-1',
      role: 'assistant',
      content: 'hi back',
    });
    const headId = conv.activeBranchHead;
    expect(conv.messages[headId].parentId).toBe(rootId);
  });

  it('getActiveChain returns messages root-first', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    conv = appendMessage(conv, {
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'two',
    });
    const chain = getActiveChain(conv);
    expect(chain.map((m) => m.content)).toEqual(['one', 'two']);
  });
});

describe('conversation-ops: edit + re-run', () => {
  it('supersedes the original and links the edit to the same parent', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'orig' });
    const originalId = conv.activeBranchHead;

    conv = editMessage(conv, originalId, 'edited');
    const editId = conv.activeBranchHead;

    expect(conv.messages[originalId].status).toBe('superseded');
    expect(conv.messages[originalId].supersededBy).toBe(editId);
    expect(conv.messages[editId].editOf).toBe(originalId);
    expect(conv.messages[editId].parentId).toBe(conv.messages[originalId].parentId);
    expect(conv.messages[editId].content).toBe('edited');
  });

  it('excludes the superseded node from the active chain', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'orig' });
    const originalId = conv.activeBranchHead;
    conv = editMessage(conv, originalId, 'edited');
    const chain = getActiveChain(conv);
    expect(chain.map((m) => m.content)).toEqual(['edited']);
  });

  it('throws ConversationNotFoundError for a missing message', () => {
    const conv = createConversation();
    expect(() => editMessage(conv, 'nonexistent', 'x')).toThrow('nonexistent');
  });
});
