import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useReadState } from './useReadState.js';

describe('useReadState', () => {
  beforeEach(() => {
    useReadState().__resetForTests();
  });

  it('reports never-read conversations as unread', () => {
    expect(useReadState().isUnread('c1', '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('markRead clears the unread state for that conversation', () => {
    const state = useReadState();
    expect(state.isUnread('c1', '2026-01-01T00:00:00Z')).toBe(true);
    state.markRead('c1');
    expect(state.isUnread('c1', '2026-01-01T00:00:00Z')).toBe(false);
    // Other conversations remain unread.
    expect(state.isUnread('c2', '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('persists read state to localStorage and round-trips on reload', async () => {
    useReadState().markRead('c1');
    const raw = localStorage.getItem('legion-last-read');
    expect(raw).toBeTruthy();
    // Simulate a page reload: a fresh module instance re-reads localStorage at init.
    vi.resetModules();
    const { useReadState: reloaded } = await import('./useReadState.js');
    expect(reloaded().isUnread('c1', '2026-01-01T00:00:00Z')).toBe(false);
    expect(reloaded().isUnread('c2', '2026-01-01T00:00:00Z')).toBe(true);
  });
});
