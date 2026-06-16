import type { Component } from 'vue';
import FileTreeRenderer from './FileTreeRenderer.vue';
import JsonRenderer from './JsonRenderer.vue';
import SearchResultRenderer from './SearchResultRenderer.vue';

export interface RendererEntry {
  pattern: RegExp;
  component: Component;
}

const registry: RendererEntry[] = [
  { pattern: /^mcp__web-search__/, component: SearchResultRenderer },
  { pattern: /^mcp__filesystem__list_/, component: FileTreeRenderer },
  { pattern: /^mcp__filesystem__read_/, component: JsonRenderer },
  { pattern: /.*/, component: JsonRenderer },
];

export function registerRenderer(pattern: RegExp, component: Component) {
  registry.unshift({ pattern, component });
}

export function lookupRenderer(toolName: string): Component {
  return registry.find((r) => r.pattern.test(toolName))?.component ?? JsonRenderer;
}
