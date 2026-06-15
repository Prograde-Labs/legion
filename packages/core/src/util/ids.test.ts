import { createId, createConversationId, nowIso } from './ids.js';

describe('id utilities', () => {
  it('createConversationId matches conv-<timestamp>-<random5>', () => {
    const id = createConversationId();
    expect(id).toMatch(/^conv-\d+-[a-f0-9]{5}$/);
  });

  it('createId prefixes and stays unique across calls', () => {
    const a = createId('msg');
    const b = createId('msg');
    expect(a).toMatch(/^msg-/);
    expect(a).not.toBe(b);
  });

  it('nowIso returns a parseable ISO timestamp', () => {
    const iso = nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});
