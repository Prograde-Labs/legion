<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useLegionApi } from '../composables/useLegionApi.js';
import { useAuth } from '../composables/useAuth.js';
import { useToolAccess } from '../composables/useToolAccess.js';
import { friendlyToolError } from '../composables/friendlyToolError.js';
import ToolPolicyEditor, {
  type ToolOverride,
} from '../components/participants/ToolPolicyEditor.vue';
import MiddlewareEditor from '../components/participants/MiddlewareEditor.vue';
import type {
  MiddlewareDefinitionInfo,
  SkillInfo,
} from '../components/participants/middleware-ui-types.js';
import ApprovalAuthorityEditor from '../components/common/ApprovalAuthorityEditor.vue';
import type { MiddlewareInstanceConfig } from '@legion-collective/types';

const props = defineProps<{ participantId: string | 'new' }>();

const emit = defineEmits<{ saved: [id: string]; retired: [] }>();

const { execute } = useLegionApi();
const auth = useAuth();
const toolAccess = useToolAccess();
// Save covers create (new) or modify (existing); retire and authority-save are
// separate affordances with their own tools.
const canSave = computed(() => {
  // Middleware is only written through set_participant_middleware, and only when
  // the caller can invoke it. Block save on invalid config that would be written;
  // a caller who cannot change middleware can still save (it is preserved).
  if (canSetMiddleware.value && middlewareErrors.value.length > 0) return false;
  return props.participantId === 'new'
    ? toolAccess.can('create_agent') === 'auto' && modelText.value.trim().length > 0
    : toolAccess.can('modify_agent') === 'auto' && modelText.value.trim().length > 0;
});
const canRetire = computed(() => toolAccess.can('retire_agent') === 'auto');
const canSetAuthority = computed(() => toolAccess.can('set_approval_authority') === 'auto');
const canSetMiddleware = computed(() => toolAccess.can('set_participant_middleware') === 'auto');

const name = ref('');
const modelText = ref('');
const systemPrompt = ref('');
const maxIterations = ref(20);
const overrides = ref<ToolOverride[]>([]);
const availableTools = ref<string[]>([]);
const modelOptions = ref<{ provider: string; model: { id: string; name?: string } }[]>([]);
const middleware = ref<MiddlewareInstanceConfig[]>([]);
const middlewareDefinitions = ref<MiddlewareDefinitionInfo[]>([]);
const middlewareErrors = ref<string[]>([]);
const skills = ref<SkillInfo[]>([]);
const credentialKeys = ref<string[]>([]);
const authorityModel = ref<{
  tools?: Record<string, boolean> | '*';
  participants?: string[] | '*';
} | null>(null);
const loaded = ref<{ protected?: boolean } | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const confirmingRetire = ref(false);

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'agent'
  );
}

function overridesToToolsMap(list: ToolOverride[]): Record<string, 'auto' | 'requires_approval'> {
  return Object.fromEntries(
    list
      .filter((o) => o.enabled)
      .map((o) => [o.tool, o.requireApproval ? 'requires_approval' : 'auto']),
  );
}

async function load(): Promise<void> {
  error.value = null;
  // Reset lists owned by this editor so switching participants cannot show the
  // previous participant's skills/keys or a stale middleware validation error.
  middlewareErrors.value = [];
  skills.value = [];
  credentialKeys.value = [];
  if (props.participantId === 'new') {
    loaded.value = null;
    return;
  }
  try {
    const p = await execute<Record<string, unknown>>('get_participant', {
      id: props.participantId,
    });
    loaded.value = p;
    name.value = String(p['name'] ?? '');
    const model = p['model'] as { model?: string } | undefined;
    modelText.value = model?.model ?? '';
    systemPrompt.value = String(p['systemPrompt'] ?? '');
    maxIterations.value = Number(p['maxIterations'] ?? 20);
    const toolsMap = (p['tools'] ?? {}) as Record<string, string>;
    overrides.value = Object.entries(toolsMap).map(([tool, policy]) => ({
      tool,
      source: 'built-in',
      enabled: true,
      requireApproval: policy === 'requires_approval',
    }));
    middleware.value = (p['middleware'] as MiddlewareInstanceConfig[]) ?? [];
    // Approval authority carries both tool approvals and participant approvals;
    // keep `participants` so saving authority round-trips it instead of erasing it.
    const authority = p['approvalAuthority'] as {
      tools?: Record<string, boolean> | '*';
      participants?: string[] | '*';
    } | null;
    authorityModel.value = authority
      ? {
          tools: authority.tools === '*' ? '*' : (authority.tools ?? {}),
          ...(authority.participants === undefined ? {} : { participants: authority.participants }),
        }
      : null;
  } catch (err) {
    error.value = friendlyToolError(err);
  }
  void execute<{ tools: string[]; callerPolicy: Record<string, string> }>('list_tools', {})
    .then(({ tools }) => {
      availableTools.value = tools;
      overrides.value = [
        ...overrides.value.filter((o) => tools.includes(o.tool) || o.enabled),
        ...tools
          .filter((t) => !overrides.value.some((o) => o.tool === t))
          .map((t) => ({ tool: t, source: 'built-in', enabled: false, requireApproval: false })),
      ];
    })
    .catch(() => {});
  void execute<{ provider: string; model: { id: string; name?: string } }[]>('list_models', {})
    .then((models) => (modelOptions.value = models))
    .catch(() => {});
  void execute<{ definitions: MiddlewareDefinitionInfo[] }>('list_middleware', {})
    .then((data) => (middlewareDefinitions.value = data.definitions))
    .catch(() => {});
  // Skill names feed the builtin:skills selector; credential key names feed
  // schema fields marked credential-reference. Both are convenience lists, so a
  // failed fetch leaves them empty rather than failing the whole editor.
  void execute<{ skills: SkillInfo[] }>('list_skills', {})
    .then((data) => (skills.value = data.skills ?? []))
    .catch(() => {});
  // list_secrets is self-or-operator only. An editor opened by a non-operator for
  // another participant is denied here; that must not break editing the agent.
  void execute<{ participantId: string; keys: string[] }>('list_secrets', {
    participantId: props.participantId,
  })
    .then((data) => (credentialKeys.value = data.keys ?? []))
    .catch(() => {});
}

watch(
  () => props.participantId,
  () => void load(),
  { immediate: true },
);

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    if (props.participantId === 'new') {
      const result = await execute<{ id: string }>('create_agent', {
        id: slugify(name.value),
        name: name.value,
        systemPrompt: systemPrompt.value,
        model: { model: modelText.value },
        tools: overridesToToolsMap(overrides.value),
        maxIterations: maxIterations.value,
      });
      // modify_agent/create_agent have no middleware parameter — middleware goes
      // through set_participant_middleware (final-review B2 fix; same two-phase
      // save as the legacy ParticipantSlideOver: non-atomic, both retryable).
      // Skip it when the caller cannot invoke it, so save does not end in a
      // misleading error after the participant write already landed.
      if (canSetMiddleware.value) {
        await execute('set_participant_middleware', {
          participantId: result.id,
          middleware: middleware.value,
        });
      }
      emit('saved', result.id);
    } else {
      await execute('modify_agent', {
        id: props.participantId,
        name: name.value,
        systemPrompt: systemPrompt.value,
        model: { model: modelText.value },
        tools: overridesToToolsMap(overrides.value),
        maxIterations: maxIterations.value,
      });
      if (canSetMiddleware.value) {
        await execute('set_participant_middleware', {
          participantId: props.participantId,
          middleware: middleware.value,
        });
      }
      emit('saved', props.participantId);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function saveAuthority(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await execute('set_approval_authority', {
      participantId: props.participantId,
      authority: authorityModel.value ?? { tools: {} },
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

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

const groupedModels = computed(() => {
  const groups = new Map<string, { id: string; label: string }[]>();
  for (const entry of modelOptions.value) {
    const id = entry.model.id;
    const list = groups.get(entry.provider) ?? [];
    list.push({ id, label: entry.model.name ?? id });
    groups.set(entry.provider, list);
  }
  // Keep an unknown existing model selectable rather than silently dropping it.
  if (
    modelText.value &&
    ![...groups.values()].some((list) => list.some((m) => m.id === modelText.value))
  ) {
    groups.set('current', [{ id: modelText.value, label: modelText.value }]);
  }
  return [...groups.entries()];
});
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-3 p-4 text-sm">
    <div
      v-if="error"
      data-test="editor-error"
      class="rounded border border-line px-2 py-1 text-xs text-danger"
    >
      {{ error }}
    </div>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Name</span>
      <input
        v-model="name"
        data-test="agent-name"
        class="rounded border border-line bg-surface px-2 py-1"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Model</span>
      <select
        v-if="groupedModels.length"
        v-model="modelText"
        data-test="agent-model"
        class="rounded border border-line bg-surface px-2 py-1"
      >
        <optgroup v-for="[provider, models] in groupedModels" :key="provider" :label="provider">
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
        </optgroup>
      </select>
      <input
        v-else
        v-model="modelText"
        data-test="agent-model"
        class="rounded border border-line bg-surface px-2 py-1"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">System prompt</span>
      <textarea
        v-model="systemPrompt"
        data-test="agent-system-prompt"
        rows="5"
        class="rounded border border-line bg-surface px-2 py-1"
        >{{ systemPrompt }}</textarea>
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Max iterations</span>
      <input
        v-model.number="maxIterations"
        type="number"
        data-test="agent-max-iterations"
        class="rounded border border-line bg-surface px-2 py-1"
      />
    </label>
    <div v-if="availableTools.length" class="flex flex-col gap-1">
      <span class="text-xs text-faint">Tool policies</span>
      <ToolPolicyEditor
        :available-tools="availableTools"
        :overrides="overrides"
        @update:overrides="overrides = $event"
      />
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-xs text-faint">Middleware</span>
      <MiddlewareEditor
        v-model="middleware"
        :definitions="middlewareDefinitions"
        :skills="skills"
        :credential-keys="credentialKeys"
        @validation="middlewareErrors = $event"
      />
      <p v-if="!canSetMiddleware" data-test="middleware-readonly" class="text-xs text-muted">
        You do not have permission to change middleware; the existing configuration is preserved.
      </p>
    </div>
    <div class="flex flex-col gap-1 rounded-md border border-line p-2">
      <span class="text-xs text-faint">Approval authority</span>
      <ApprovalAuthorityEditor v-model="authorityModel" :available-tools="availableTools" />
      <button
        v-if="canSetAuthority"
        type="button"
        data-test="authority-save"
        :disabled="busy"
        class="self-start rounded bg-accent-soft px-3 py-1 text-xs text-accent"
        @click="saveAuthority"
      >
        Save authority
      </button>
    </div>
    <div class="flex items-center gap-2">
      <button
        v-if="canSave"
        type="button"
        data-test="agent-save"
        :disabled="busy"
        class="rounded bg-accent-soft px-3 py-1 font-medium text-accent"
        @click="save"
      >
        Save
      </button>
      <button
        v-if="canRetire && loaded && participantId !== 'new' && !loaded?.['protected']"
        type="button"
        data-test="agent-retire"
        :disabled="busy || participantId === auth.participantId.value"
        class="rounded border border-line px-3 py-1 text-danger disabled:opacity-50"
        @click="retire"
      >
        {{ confirmingRetire ? 'Confirm retire' : 'Retire' }}
      </button>
    </div>
  </div>
</template>
