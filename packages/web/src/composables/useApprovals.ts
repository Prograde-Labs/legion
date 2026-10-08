import { computed, ref, type ComputedRef } from 'vue';

// TODO(task-12): TEMPORARY stub — Task 12 replaces this file wholesale
// (KEEPING the `__setPendingForTests` helper name).
interface PendingApproval {
  conversationId: string;
  approvalId?: string;
}

// Single module-scoped pending list; count/oldest/by-conversation are all derived.
const pending = ref<PendingApproval[]>([]);

const pendingCount: ComputedRef<number> = computed(() => pending.value.length);
const oldest: ComputedRef<PendingApproval | null> = computed(() => pending.value[0] ?? null);
const pendingByConversation: ComputedRef<Map<string, number>> = computed(() => {
  const map = new Map<string, number>();
  for (const p of pending.value) {
    map.set(p.conversationId, (map.get(p.conversationId) ?? 0) + 1);
  }
  return map;
});

export function useApprovals(): {
  pendingCount: ComputedRef<number>;
  oldest: ComputedRef<PendingApproval | null>;
  pendingByConversation: ComputedRef<Map<string, number>>;
  __setPendingForTests(list: Array<PendingApproval>): void;
} {
  return {
    pendingCount,
    oldest,
    pendingByConversation,
    __setPendingForTests(list: Array<PendingApproval>): void {
      pending.value = list;
    },
  };
}
