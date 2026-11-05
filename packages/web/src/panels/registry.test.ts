import { describe, expect, it, beforeEach } from 'vitest';
import { useDock, lookupPanel } from './registry.js';

describe('panel registry', () => {
  it('falls back to ToolDetailPanel for unregistered tools', () => {
    expect(lookupPanel('mystery_tool').component.name).toBeDefined();
    expect(lookupPanel('mystery_tool')).toEqual(lookupPanel('another_unknown'));
  });
});

describe('useDock', () => {
  beforeEach(() => {
    localStorage.clear();
    useDock().__resetForTests();
  });

  it('open() dedupes by id and focuses the existing tab', () => {
    const dock = useDock();
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    expect(dock.tabs.value.length).toBe(1);
    expect(dock.activeId.value).toBe('tool-detail:a');
  });

  it('close() removes a tab and picks a neighbor as active', () => {
    const dock = useDock();
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    dock.open({ kind: 'tool-detail', title: 'B', icon: 'T', payload: { tool: 'b' } });
    dock.close('tool-detail:b');
    expect(dock.tabs.value.length).toBe(1);
    expect(dock.activeId.value).toBe('tool-detail:a');
  });

  it('reorder() moves tabs', () => {
    const dock = useDock();
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    dock.open({ kind: 'tool-detail', title: 'B', icon: 'T', payload: { tool: 'b' } });
    dock.reorder(1, 0);
    expect(dock.tabs.value[0].id).toBe('tool-detail:b');
  });

  it('restores persisted tabs when switching to a conversation', () => {
    localStorage.setItem(
      'legion-dock-c1',
      JSON.stringify({
        tabs: [
          {
            id: 'tool-detail:a',
            kind: 'tool-detail',
            title: 'A',
            icon: 'T',
            payload: { tool: 'a' },
          },
        ],
        activeId: 'tool-detail:a',
        width: 500,
      }),
    );
    const dock = useDock();
    dock.setConversation('c1');
    expect(dock.tabs.value).toHaveLength(1);
    expect(dock.activeId.value).toBe('tool-detail:a');
    expect(dock.width.value).toBe(500);
  });

  it('falls back to the first tab when the persisted activeId is stale', () => {
    localStorage.setItem(
      'legion-dock-c1',
      JSON.stringify({
        tabs: [
          {
            id: 'tool-detail:a',
            kind: 'tool-detail',
            title: 'A',
            icon: 'T',
            payload: { tool: 'a' },
          },
        ],
        activeId: 'tool-detail:gone',
        width: 500,
      }),
    );
    const dock = useDock();
    dock.setConversation('c1');
    expect(dock.activeId.value).toBe('tool-detail:a');
  });

  it('starts empty when persisted tabs is not an array', () => {
    localStorage.setItem(
      'legion-dock-c1',
      JSON.stringify({ tabs: { bad: true }, activeId: 'tool-detail:a', width: 500 }),
    );
    const dock = useDock();
    dock.setConversation('c1');
    expect(dock.tabs.value).toEqual([]);
    expect(dock.activeId.value).toBeNull();
  });

  it('starts empty when the persisted state is corrupted', () => {
    localStorage.setItem('legion-dock-c1', '{not json');
    const dock = useDock();
    dock.setConversation('c1');
    expect(dock.tabs.value).toEqual([]);
    expect(dock.activeId.value).toBeNull();
  });

  it('persists the active tab as it changes', () => {
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    dock.open({ kind: 'tool-detail', title: 'B', icon: 'T', payload: { tool: 'b' } });
    expect(JSON.parse(localStorage.getItem('legion-dock-c1')!).activeId).toBe('tool-detail:b');
  });

  it('persists state per conversation', () => {
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    expect(JSON.parse(localStorage.getItem('legion-dock-c1')!)).toEqual(
      expect.objectContaining({ tabs: [expect.objectContaining({ id: 'tool-detail:a' })] }),
    );
  });
});
