import { computed, ref } from 'vue';
import { useLegionApi } from './useLegionApi.js';

export interface PendingApproval {
  approvalId: string;
  conversationId: string;
  requesterId: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: string;
}

const pending = ref<PendingApproval[]>([]);
/** Bumped on reset so an in-flight refresh cannot repopulate the store after logout. */
let generation = 0;
/** Monotonic refresh id: only the newest issued request may apply its snapshot. */
let refreshRequestId = 0;

export function useApprovals() {
  const pendingCount = computed(() => pending.value.length);
  const pendingByConversation = computed(() => {
    const map = new Map<string, number>();
    for (const p of pending.value) {
      map.set(p.conversationId, (map.get(p.conversationId) ?? 0) + 1);
    }
    return map;
  });
  const oldest = computed(() => pending.value[0] ?? null);

  async function refresh(): Promise<void> {
    const requestGeneration = generation;
    const requestId = ++refreshRequestId;
    const { execute } = useLegionApi();
    const list = await execute<PendingApproval[]>('list_pending_approvals', {});
    if (requestGeneration !== generation) return; // reset while in flight — stale identity
    // An older request landing last must not clobber a newer snapshot.
    if (requestId !== refreshRequestId) return;
    pending.value = list;
  }

  /** Drop the previous identity's approvals on logout. */
  function reset(): void {
    generation += 1;
    pending.value = [];
  }

  /** Merge a live activity chunk into the pending list. */
  function ingest(type: string, data: Record<string, unknown>): void {
    if (type === 'approval:requested') {
      const approvalId = data['approvalId'];
      if (typeof approvalId !== 'string') return;
      if (pending.value.some((p) => p.approvalId === approvalId)) return;
      pending.value = [
        ...pending.value,
        {
          approvalId,
          conversationId: String(data['conversationId'] ?? ''),
          requesterId: String(data['participantId'] ?? ''),
          tool: String(data['tool'] ?? ''),
          args: (data['args'] as Record<string, unknown> | undefined) ?? {},
          createdAt: new Date().toISOString(),
        },
      ];
      // The stream event omits args; refresh the authoritative list.
      void refresh().catch(() => {});
      return;
    }
    if (type === 'approval:resolved') {
      const approvalId = data['approvalId'];
      if (typeof approvalId !== 'string') return;
      pending.value = pending.value.filter((p) => p.approvalId !== approvalId);
    }
  }

  return {
    pending,
    pendingCount,
    pendingByConversation,
    oldest,
    refresh,
    reset,
    ingest,
    removeLocal(approvalId: string): void {
      pending.value = pending.value.filter((p) => p.approvalId !== approvalId);
    },
    __setPendingForTests(list: Array<Partial<PendingApproval> & { conversationId: string }>): void {
      pending.value = list.map((p) => ({
        approvalId: p.approvalId ?? `test-${Math.random().toString(36).slice(2)}`,
        conversationId: p.conversationId,
        requesterId: p.requesterId ?? 'test',
        tool: p.tool ?? 'test',
        args: p.args ?? {},
        createdAt: p.createdAt ?? new Date(0).toISOString(),
      }));
    },
  };
}
