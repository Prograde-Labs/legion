import { ref } from 'vue';

// Client-side unread state (spec §4.1): ConversationMeta carries no unread field and
// the backend tool scope is frozen, so read tracking is a web-only affordance —
// per-conversation "last read" timestamps persisted in localStorage. ISO strings
// compare lexicographically, so `updatedAt > lastRead` is a valid ordering check.
const STORAGE_KEY = 'legion-last-read';

function readStored(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Module-scoped singleton: one map shared by every caller, read from localStorage
// once at module init.
const lastRead = ref<Record<string, string>>(readStored());

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lastRead.value));
  } catch {
    // Storage unavailable (quota/private mode): keep the in-memory map only.
  }
}

export function useReadState(): {
  isUnread(conversationId: string, updatedAt: string): boolean;
  markRead(conversationId: string): void;
  __resetForTests(): void;
} {
  return {
    isUnread(conversationId: string, updatedAt: string): boolean {
      return updatedAt > (lastRead.value[conversationId] ?? '');
    },
    markRead(conversationId: string): void {
      lastRead.value[conversationId] = new Date().toISOString();
      persist();
    },
    __resetForTests(): void {
      lastRead.value = {};
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore storage failures in environments without storage.
      }
    },
  };
}
