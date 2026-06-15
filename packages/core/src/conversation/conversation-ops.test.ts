import { createConversation, appendMessage, getActiveChain } from './conversation-ops.js';

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
