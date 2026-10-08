<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PendingApproval } from '../composables/useApprovals.js';
import { useLegionApi } from '../composables/useLegionApi.js';

const props = defineProps<{ approval: PendingApproval }>();

const emit = defineEmits<{ resolved: [approved: boolean] }>();

const { execute } = useLegionApi();

const reason = ref('');
const showReason = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const argsSummary = computed(() => {
  const json = JSON.stringify(props.approval.args);
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
});

async function decide(approved: boolean): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await execute('approval_response', {
      approvalId: props.approval.approvalId,
      approved,
      ...(reason.value ? { message: reason.value } : {}),
    });
    emit('resolved', approved);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    data-test="approval-card"
    class="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-muted"
        >Approval requested by
        <span class="font-mono text-ink">{{ approval.requesterId }}</span></span
      >
    </div>
    <div class="mt-1 flex items-center gap-2">
      <span
        data-test="approval-tool"
        class="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-xs text-accent"
        >{{ approval.tool }}</span
      >
      <code data-test="approval-args" class="truncate font-mono text-xs text-faint">{{
        argsSummary
      }}</code>
    </div>
    <div v-if="showReason" class="mt-2">
      <textarea
        v-model="reason"
        data-test="approval-reason"
        placeholder="Optional reason…"
        class="min-h-12 w-full rounded border border-line bg-surface px-2 py-1 text-xs outline-none"
      />
    </div>
    <div v-if="error" data-test="approval-error" class="mt-2 text-xs text-danger">
      {{ error }}
    </div>
    <div class="mt-2 flex items-center gap-2">
      <button
        type="button"
        data-test="approval-approve"
        :disabled="busy"
        class="rounded bg-accent-soft px-3 py-1 text-xs font-medium text-accent hover:bg-surface"
        @click="decide(true)"
      >
        Approve
      </button>
      <button
        type="button"
        data-test="approval-reject"
        :disabled="busy"
        class="rounded border border-line px-3 py-1 text-xs text-danger hover:bg-surface"
        @click="decide(false)"
      >
        Reject
      </button>
      <button
        type="button"
        data-test="approval-reason-toggle"
        class="ml-auto text-xs text-faint hover:text-accent"
        @click="showReason = !showReason"
      >
        {{ showReason ? 'Hide reason' : 'Add reason' }}
      </button>
    </div>
  </div>
</template>
