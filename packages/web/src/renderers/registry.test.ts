import { describe, expect, it } from 'vitest';
import { lookupRenderer, registerRenderer } from './registry.js';
import JsonRenderer from './JsonRenderer.vue';
import SearchResultRenderer from './SearchResultRenderer.vue';

describe('renderer registry', () => {
  it('resolves exact tool names', () => {
    expect(lookupRenderer('communicate')).not.toBe(JsonRenderer); // TextResultRenderer
  });

  it('resolves MCP patterns', () => {
    expect(lookupRenderer('mcp__web-search__search')).toBe(SearchResultRenderer);
  });

  it('falls back to JsonRenderer for unknown tools', () => {
    expect(lookupRenderer('totally_unknown_tool')).toBe(JsonRenderer);
  });

  it('registerRenderer entries win over defaults (unshifted)', () => {
    const Fake = { template: '<div />' };
    registerRenderer(/^communicate$/, Fake);
    expect(lookupRenderer('communicate')).toBe(Fake);
  });
});
