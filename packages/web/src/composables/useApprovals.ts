import { ref, type Ref } from 'vue';

// TODO(task-12): TEMPORARY stub — Task 12 replaces this file wholesale
// (KEEPING the `__setPendingForTests` helper name).
const pendingCount: Ref<number> = ref(0);
const oldest: Ref<{ conversationId: string } | null> = ref(null);

export function useApprovals(): {
  pendingCount: Ref<number>;
  oldest: Ref<{ conversationId: string } | null>;
  __setPendingForTests(list: Array<{ conversationId: string }>): void;
} {
  return {
    pendingCount,
    oldest,
    __setPendingForTests(list: Array<{ conversationId: string }>): void {
      pendingCount.value = list.length;
      oldest.value = list.length > 0 ? (list[0] ?? null) : null;
    },
  };
}
