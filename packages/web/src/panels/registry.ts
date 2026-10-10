import { ref, watch } from 'vue';
import type { Component, Ref } from 'vue';
import ToolDetailPanel from './ToolDetailPanel.vue';
import CommunicatePanel from './CommunicatePanel.vue';

// Re-exported for ChatView dock wiring (slice 13b): the communicate entry lives
// here, so consumers import the component from the registry too.
export { CommunicatePanel };

export interface DockTab {
  id: string;
  kind: 'tool-detail' | 'communicate';
  title: string;
  icon: string;
  payload: Record<string, unknown>;
}

export interface PanelEntry {
  component: Component;
  title: (payload: Record<string, unknown>) => string;
}

const panels = new Map<string, PanelEntry>();

// Hoisted so repeated lookups return the same entry (test compares two fallback lookups with toEqual).
const fallbackPanel: PanelEntry = {
  component: ToolDetailPanel,
  title: (p) => String(p['tool'] ?? 'tool'),
};

export function registerPanel(toolName: string, entry: PanelEntry): void {
  panels.set(toolName, entry);
}

export function lookupPanel(toolName: string): PanelEntry {
  return panels.get(toolName) ?? fallbackPanel;
}

registerPanel('communicate', {
  component: CommunicatePanel,
  title: (p) => `@${String(p['conversationId'] ?? 'chat')}`,
});

// ---- Dock state (module-scoped, per-conversation persisted) ----

const tabs = ref<DockTab[]>([]);
const activeId = ref<string | null>(null);
const width = ref(420);
const isOpen = ref(false);
const conversationId = ref<string | null>(null);

function storageKey(): string {
  return `legion-dock-${conversationId.value ?? 'none'}`;
}

function persist(): void {
  if (conversationId.value === null) return;
  localStorage.setItem(
    storageKey(),
    JSON.stringify({ tabs: tabs.value, activeId: activeId.value, width: width.value }),
  );
}

function restore(): void {
  tabs.value = [];
  activeId.value = null;
  if (conversationId.value === null) return;
  const raw = localStorage.getItem(storageKey());
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as { tabs?: DockTab[]; activeId?: string | null; width?: number };
    tabs.value = saved.tabs ?? [];
    activeId.value = saved.activeId ?? tabs.value[0]?.id ?? null;
    if (saved.width !== undefined) width.value = saved.width;
  } catch {
    // corrupted state: start empty
  }
}

watch([tabs, width], persist, { deep: true, flush: 'sync' });

export function useDock() {
  function setConversation(id: string | null): void {
    if (conversationId.value === id) return;
    conversationId.value = id;
    restore();
  }

  function open(tab: Omit<DockTab, 'id'> & { id?: string }): void {
    const id =
      tab.id ??
      `${tab.kind}:${String(tab.payload['tool'] ?? tab.payload['conversationId'] ?? 'tab')}`;
    const existing = tabs.value.find((t) => t.id === id);
    if (existing) {
      activeId.value = id;
    } else {
      tabs.value = [...tabs.value, { ...tab, id }];
      activeId.value = id;
    }
    isOpen.value = true;
  }

  function close(id: string): void {
    const index = tabs.value.findIndex((t) => t.id === id);
    if (index < 0) return;
    const next = [...tabs.value];
    next.splice(index, 1);
    tabs.value = next;
    if (activeId.value === id) {
      activeId.value = next[Math.min(index, next.length - 1)]?.id ?? null;
    }
    if (next.length === 0) isOpen.value = false;
  }

  function reorder(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= tabs.value.length || to >= tabs.value.length)
      return;
    const next = [...tabs.value];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    tabs.value = next;
  }

  return {
    tabs: tabs as Ref<DockTab[]>,
    activeId,
    open,
    isOpen,
    close,
    reorder,
    width,
    setConversation,
    __resetForTests(): void {
      tabs.value = [];
      activeId.value = null;
      isOpen.value = false;
      conversationId.value = null;
      width.value = 420;
    },
  };
}

export type DockApi = ReturnType<typeof useDock>;
