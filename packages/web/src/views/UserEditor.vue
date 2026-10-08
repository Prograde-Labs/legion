<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useAuth } from '../composables/useAuth.js';
import { useParticipants } from '../composables/useParticipants.js';
import ToolPolicyEditor, {
  type ToolOverride,
} from '../components/participants/ToolPolicyEditor.vue';
import ApprovalAuthorityEditor from '../components/common/ApprovalAuthorityEditor.vue';

const props = defineProps<{ participantId: string | 'new' }>();

const emit = defineEmits<{ saved: [id: string]; retired: [] }>();

const { execute } = useLegionApi();
const auth = useAuth();
const { participants } = useParticipants();

const name = ref('');
const operator = ref(false);
const overrides = ref<ToolOverride[]>([]);
const availableTools = ref<string[]>([]);
const authority = ref<{ tools?: Record<string, boolean> | '*' } | null>(null);
const newPassword = ref('');
const confirmPassword = ref('');
const loaded = ref<Record<string, unknown> | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const confirmingRetire = ref(false);

function overridesToToolsMap(list: ToolOverride[]): Record<string, 'auto' | 'requires_approval'> {
  return Object.fromEntries(
    list
      .filter((o) => o.enabled)
      .map((o) => [o.tool, o.requireApproval ? 'requires_approval' : 'auto']),
  );
}

async function load(): Promise<void> {
  error.value = null;
  newPassword.value = '';
  confirmPassword.value = '';
  if (props.participantId === 'new') {
    loaded.value = null;
    name.value = '';
    operator.value = false;
    overrides.value = [];
    authority.value = null;
    return;
  }
  try {
    const p = await execute<Record<string, unknown>>('get_participant', {
      id: props.participantId,
    });
    loaded.value = p;
    name.value = String(p['name'] ?? '');
    operator.value = Boolean(p['operator']);
    const toolsMap = (p['tools'] ?? {}) as Record<string, string>;
    overrides.value = Object.entries(toolsMap).map(([tool, policy]) => ({
      tool,
      source: 'built-in',
      enabled: true,
      requireApproval: policy === 'requires_approval',
    }));
    const a = p['approvalAuthority'] as { tools?: Record<string, boolean> | '*' } | null;
    authority.value = a ?? null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
  void execute<string[]>('list_tools', {})
    .then((tools) => {
      availableTools.value = tools;
      overrides.value = [
        ...overrides.value,
        ...tools
          .filter((t) => !overrides.value.some((o) => o.tool === t))
          .map((t) => ({ tool: t, source: 'built-in', enabled: false, requireApproval: false })),
      ];
    })
    .catch(() => {});
}

watch(
  () => props.participantId,
  () => void load(),
  { immediate: true },
);

const identities = computed(() => {
  const list = (loaded.value?.['identities'] ?? []) as Array<{
    connector: string;
    externalId: string;
  }>;
  return list.map((i) => `${i.connector}: ${i.externalId}`);
});

const isSelf = computed(() => props.participantId === auth.participantId.value);
const isProtected = computed(() => Boolean(loaded.value?.['protected']));
const isLastActiveOperator = computed(() => {
  if (!operator.value) return false;
  const activeOperators = participants.value.filter(
    (p) => p.type === 'user' && (p as { operator?: boolean }).operator && p.status === 'active',
  );
  return activeOperators.length <= 1;
});
const retireDisabled = computed(() => isSelf.value || isLastActiveOperator.value);
const retireTitle = computed(() =>
  isSelf.value
    ? 'cannot retire yourself'
    : isLastActiveOperator.value
      ? 'last active operator'
      : '',
);

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    if (props.participantId === 'new') {
      const id =
        name.value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'user';
      await execute('create_user', {
        id,
        name: name.value,
        operator: operator.value,
        tools: overridesToToolsMap(overrides.value),
      });
      if (newPassword.value.length >= 8 && newPassword.value === confirmPassword.value) {
        await execute('set_credential', { participantId: id, secret: newPassword.value });
      }
      emit('saved', id);
    } else {
      await execute('modify_user', {
        id: props.participantId,
        name: name.value,
        operator: operator.value,
        tools: overridesToToolsMap(overrides.value),
      });
      if (newPassword.value.length >= 8 && newPassword.value === confirmPassword.value) {
        await execute('set_credential', {
          participantId: props.participantId,
          secret: newPassword.value,
        });
      }
      emit('saved', props.participantId);
    }
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

const passwordValid = computed(
  () =>
    newPassword.value.length === 0 ||
    (newPassword.value.length >= 8 && newPassword.value === confirmPassword.value),
);

async function retire(): Promise<void> {
  if (!confirmingRetire.value) {
    confirmingRetire.value = true;
    return;
  }
  busy.value = true;
  try {
    await execute('retire_agent', { id: props.participantId });
    emit('retired');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
    confirmingRetire.value = false;
  }
}
</script>

<template>
  <form class="mx-auto flex max-w-2xl flex-col gap-3 p-4 text-sm" @submit.prevent="save">
    <div
      v-if="error"
      data-test="user-error"
      class="rounded border border-line px-2 py-1 text-xs text-danger"
    >
      {{ error }}
    </div>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Name</span>
      <input
        v-model="name"
        name="name"
        data-test="user-name"
        class="rounded border border-line bg-surface px-2 py-1"
      />
    </label>
    <label class="flex items-center gap-2 text-xs">
      <input v-model="operator" type="checkbox" name="operator" data-test="operator" />
      Operator
    </label>
    <div v-if="identities.length" data-test="identities" class="flex flex-col gap-1 text-xs">
      <span class="text-faint">Identities (read-only)</span>
      <code v-for="i in identities" :key="i" class="font-mono text-muted">{{ i }}</code>
    </div>
    <div v-if="availableTools.length" class="flex flex-col gap-1">
      <span class="text-xs text-faint">Tool policies</span>
      <ToolPolicyEditor
        :available-tools="availableTools"
        :overrides="overrides"
        @update:overrides="overrides = $event"
      />
    </div>
    <div class="flex flex-col gap-1 rounded-md border border-line p-2">
      <span class="text-xs text-faint">Approval authority</span>
      <ApprovalAuthorityEditor v-model="authority" :available-tools="availableTools" />
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-xs text-faint">Password (leave empty to keep unchanged)</span>
      <input
        v-model="newPassword"
        type="password"
        name="new-password"
        autocomplete="new-password"
        class="rounded border border-line bg-surface px-2 py-1"
      />
      <input
        v-model="confirmPassword"
        type="password"
        name="confirm-password"
        autocomplete="new-password"
        class="rounded border border-line bg-surface px-2 py-1"
      />
      <span v-if="!passwordValid" class="text-xs text-danger">min 8 chars and must match</span>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="submit"
        data-test="save"
        :disabled="busy || !passwordValid"
        class="rounded bg-accent-soft px-3 py-1 font-medium text-accent"
      >
        Save
      </button>
      <button
        v-if="participantId !== 'new' && !isProtected"
        type="button"
        data-test="retire"
        :disabled="busy || retireDisabled"
        :title="retireTitle"
        class="rounded border border-line px-3 py-1 text-danger disabled:opacity-50"
        @click="retire"
      >
        {{ confirmingRetire ? 'Confirm retire' : 'Retire' }}
      </button>
    </div>
  </form>
</template>
