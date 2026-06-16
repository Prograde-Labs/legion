import { describe, expect, it } from 'vitest';
import { lookupRenderer, registerRenderer } from './index.js';

describe('renderer registry', () => {
  it('returns JsonRenderer for unknown tool', () => {
    const r = lookupRenderer('some_unknown_tool');
    expect(r.name).toBe('JsonRenderer');
  });

  it('returns registered renderer for matching pattern', () => {
    registerRenderer(/^mcp__web-search__/, { name: 'SearchResultRenderer' } as any);
    const r = lookupRenderer('mcp__web-search__search');
    expect(r.name).toBe('SearchResultRenderer');
  });

  it('matches more specific pattern over catch-all', () => {
    const r = lookupRenderer('mcp__filesystem__list_dir');
    expect(r.name).toBe('FileTreeRenderer');
  });
});
