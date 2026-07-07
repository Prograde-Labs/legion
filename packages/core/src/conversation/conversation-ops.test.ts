import {
  createConversation,
  appendMessage,
  getActiveChain,
  editMessage,
  pruneMessage,
  compactRange,
  validateConversation,
} from './conversation-ops.js';

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

describe('conversation-ops: prune', () => {
  it('marks the node pruned and rolls head back when pruning the head', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const firstId = conv.activeBranchHead;
    conv = appendMessage(conv, {
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'two',
    });
    const headId = conv.activeBranchHead;

    conv = pruneMessage(conv, headId, 'operator-1');

    expect(conv.messages[headId].status).toBe('pruned');
    expect(conv.messages[headId].prunedBy).toBe('operator-1');
    expect(conv.messages[headId].prunedAt).toBeDefined();
    expect(conv.activeBranchHead).toBe(firstId);
    expect(getActiveChain(conv).map((m) => m.content)).toEqual(['one']);
  });

  it('excludes descendants of a pruned middle node from the chain', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const midId = conv.activeBranchHead;
    conv = appendMessage(conv, {
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'two',
    });
    // Prune the middle node; head stays at 'two' but chain cannot route through pruned parent.
    conv = pruneMessage(conv, midId, 'op');
    expect(getActiveChain(conv).map((m) => m.content)).toEqual([]);
  });
});

describe('conversation-ops: compaction', () => {
  it('replaces a contiguous range with a summary node', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'm1' });
    const id1 = conv.activeBranchHead;
    conv = appendMessage(conv, {
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'm2',
    });
    const id2 = conv.activeBranchHead;
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'm3' });
    const id3 = conv.activeBranchHead;

    conv = compactRange(conv, [id1, id2], 'summary of m1+m2');

    // m1 and m2 are compacted
    expect(conv.messages[id1].status).toBe('compacted');
    expect(conv.messages[id2].status).toBe('compacted');

    // a summary node exists with parentId = parent of first compacted (null here)
    const summary = Object.values(conv.messages).find((m) => m.type === 'summary');
    expect(summary).toBeDefined();
    expect(summary!.parentId).toBeNull();
    expect(summary!.compacts).toEqual([id1, id2]);

    // m3 now points at the summary node
    expect(conv.messages[id3].parentId).toBe(summary!.id);

    // active chain is [summary, m3]
    expect(getActiveChain(conv).map((m) => m.content)).toEqual(['summary of m1+m2', 'm3']);
  });
});

describe('conversation-ops: invariants', () => {
  it('passes for a well-formed conversation', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    conv = appendMessage(conv, {
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'two',
    });
    expect(validateConversation(conv)).toEqual([]);
  });

  it('allows compacted messages to remain roots after compacting from the start', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const id1 = conv.activeBranchHead;
    conv = appendMessage(conv, {
      senderId: 'a',
      recipientId: 'u',
      role: 'assistant',
      content: 'two',
    });
    const id2 = conv.activeBranchHead;

    conv = compactRange(conv, [id1, id2], 'summary');

    expect(validateConversation(conv)).toEqual([]);
  });

  it('flags a dangling parentId', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const id = conv.activeBranchHead;
    conv.messages[id] = { ...conv.messages[id], parentId: 'ghost' };
    const errors = validateConversation(conv);
    expect(errors.some((e) => e.includes('ghost'))).toBe(true);
  });

  it('flags a missing activeBranchHead reference', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    conv.activeBranchHead = 'nope';
    expect(validateConversation(conv).some((e) => e.includes('activeBranchHead'))).toBe(true);
  });

  it('flags multiple roots', () => {
    let conv = createConversation();
    conv = appendMessage(conv, { senderId: 'u', recipientId: 'a', role: 'user', content: 'one' });
    const extra = { ...conv.messages[conv.activeBranchHead], id: 'root2', parentId: null };
    conv.messages['root2'] = extra;
    expect(validateConversation(conv).some((e) => e.includes('root'))).toBe(true);
  });
});
