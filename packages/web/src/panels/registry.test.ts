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

  it('persists state per conversation', () => {
    const dock = useDock();
    dock.setConversation('c1');
    dock.open({ kind: 'tool-detail', title: 'A', icon: 'T', payload: { tool: 'a' } });
    expect(JSON.parse(localStorage.getItem('legion-dock-c1')!)).toEqual(
      expect.objectContaining({ tabs: [expect.objectContaining({ id: 'tool-detail:a' })] }),
    );
  });
});
