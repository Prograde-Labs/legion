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
let initialized = false;

function handleEvent(type: string, data: Record<string, unknown>): void {
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
        args: {},
        createdAt: new Date().toISOString(),
      },
    ];
  } else if (type === 'approval:resolved') {
    const approvalId = data['approvalId'];
    if (typeof approvalId !== 'string') return;
    pending.value = pending.value.filter((p) => p.approvalId !== approvalId);
  }
}

export function useApprovals() {
  if (!initialized) {
    initialized = true;
    const { onEvent } = useLegionApi();
    onEvent('approval:requested', (data) =>
      handleEvent('approval:requested', data as Record<string, unknown>),
    );
    onEvent('approval:resolved', (data) =>
      handleEvent('approval:resolved', data as Record<string, unknown>),
    );
  }

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
    const { execute } = useLegionApi();
    const list = await execute<PendingApproval[]>('list_pending_approvals', {});
    pending.value = list;
  }

  return {
    pending,
    pendingCount,
    pendingByConversation,
    oldest,
    refresh,
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
    __handleEventForTests(type: string, data: Record<string, unknown>): void {
      handleEvent(type, data);
    },
  };
}
// TODO(task-12): stub replaced by full implementation (spec §4.5) — live WS + refresh
