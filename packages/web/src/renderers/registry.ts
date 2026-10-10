import type { Component } from 'vue';
import JsonRenderer from './JsonRenderer.vue';
import FileTreeRenderer from './FileTreeRenderer.vue';
import SearchResultRenderer from './SearchResultRenderer.vue';
import TextResultRenderer from './TextResultRenderer.vue';

export interface RendererEntry {
  pattern: RegExp;
  component: Component;
}
const registry: RendererEntry[] = [
  { pattern: /^communicate$/, component: TextResultRenderer }, // sub-chat handled by panel, Task 13
  { pattern: /^mcp__web-search__/, component: SearchResultRenderer },
  { pattern: /^mcp__filesystem__list_/, component: FileTreeRenderer },
  { pattern: /^mcp__filesystem__read_/, component: JsonRenderer },
];
export function registerRenderer(pattern: RegExp, component: Component): void {
  registry.unshift({ pattern, component });
}
export function lookupRenderer(toolName: string): Component {
  return registry.find((r) => r.pattern.test(toolName))?.component ?? JsonRenderer;
}
