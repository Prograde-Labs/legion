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
import {
  normalizeToolPolicy,
  type JSONSchema,
  type MiddlewareInstanceConfig,
  type ToolPolicy,
} from '@legion-collective/types';

const props = defineProps<{ participantId: string | 'new' }>();

const emit = defineEmits<{ saved: [id: string]; retired: [] }>();

const { execute } = useLegionApi();
const auth = useAuth();
const toolAccess = useToolAccess();
// Tool-policy management is authorized by the caller's own tool policy, not an
// operator flag, so every caller that can save the agent can edit its policies.
// Declared before `canSave`, which reads both, so the computed has no
// forward reference to a later `const`.
const middlewareErrors = ref<string[]>([]);
const canSetMiddleware = computed(() => toolAccess.can('set_participant_middleware') === 'auto');
// Save covers create (new) or modify (existing); retire and authority-save are
// separate affordances with their own tools.
const canSave = computed(() => {
  // Middleware is only written through set_participant_middleware, and only when
  // the caller can invoke it. Block save on invalid config that would be written;
  // a caller who cannot change middleware can still save (it is preserved).
  if (canSetMiddleware.value && middlewareErrors.value.length > 0) return false;
  return props.participantId === 'new'
    ? toolAccess.can('create_agent') === 'auto' && isModelSelectionValid()
    : toolAccess.can('modify_agent') === 'auto' && isModelSelectionValid();
});
const canRetire = computed(() => toolAccess.can('retire_agent') === 'auto');
const canSetAuthority = computed(() => toolAccess.can('set_approval_authority') === 'auto');

const name = ref('');
const modelText = ref('');
const systemPrompt = ref('');
const maxIterations = ref(20);
const truncationRetries = ref(0);
const overrides = ref<ToolOverride[]>([]);
const availableTools = ref<string[]>([]);
const toolParameters = ref<Record<string, JSONSchema>>({});
const modelOptions = ref<{ provider: string; model: { id: string; name?: string } }[]>([]);
const middleware = ref<MiddlewareInstanceConfig[]>([]);
const middlewareDefinitions = ref<MiddlewareDefinitionInfo[]>([]);
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

function overridesToToolsMap(list: ToolOverride[]): Record<string, ToolPolicy> {
  return Object.fromEntries(
    list
      .filter((o) => o.enabled)
      .map((o) => {
        const policy = o.requireApproval ? 'requires_approval' : 'auto';
        return [
          o.tool,
          o.scope && Object.keys(o.scope).length > 0 ? { policy, scope: o.scope } : policy,
        ];
      }),
  );
}

async function load(): Promise<void> {
  error.value = null;
  // Reset lists owned by this editor so switching participants cannot show the
  // previous participant's skills/keys or a stale middleware validation error.
  middlewareErrors.value = [];
  skills.value = [];
  credentialKeys.value = [];
  overrides.value = [];
  toolParameters.value = {};
  middleware.value = [];
  authorityModel.value = null;
  if (props.participantId === 'new') {
    loaded.value = null;
    name.value = '';
    modelText.value = '';
    systemPrompt.value = '';
    maxIterations.value = 20;
    truncationRetries.value = 0;
  } else {
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
      truncationRetries.value = Number(p['truncationRetries'] ?? 0);
      const toolsMap = (p['tools'] ?? {}) as Record<string, ToolPolicy>;
      overrides.value = Object.entries(toolsMap).flatMap(([tool, value]) => {
        const normalized = normalizeToolPolicy(value);
        if (!normalized) return [];
        return [
          {
            tool,
            source: 'built-in',
            enabled: true,
            requireApproval: normalized.policy === 'requires_approval',
            ...(normalized.scope ? { scope: normalized.scope } : {}),
          },
        ];
      });
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
            ...(authority.participants === undefined
              ? {}
              : { participants: authority.participants }),
          }
        : null;
    } catch (err) {
      error.value = friendlyToolError(err);
    }
  }
  // Convenience lists are loaded for new AND existing agents: a new agent needs
  // the model picker and middleware definitions too. Only credential keys stay
  // gated to an existing participant (list_secrets needs a real target).
  void execute<{
    tools: string[];
    callerPolicy: Record<string, unknown>;
    parameters?: Record<string, JSONSchema>;
  }>('list_tools', {})
    .then((data) => {
      const tools = Array.isArray(data?.tools) ? data.tools : [];
      availableTools.value = tools;
      toolParameters.value = data?.parameters ?? {};
      overrides.value = [
        ...overrides.value.filter((o) => tools.includes(o.tool) || o.enabled),
        ...tools
          .filter((t) => !overrides.value.some((o) => o.tool === t))
          .map((t) => ({ tool: t, source: 'built-in', enabled: false, requireApproval: false })),
      ];
    })
    .catch(() => {});
  void execute<{ provider: string; model: { id: string; name?: string } }[]>('list_models', {})
    .then((models) => (modelOptions.value = Array.isArray(models) ? models : []))
    .catch(() => {});
  void execute<{ definitions: MiddlewareDefinitionInfo[] }>('list_middleware', {})
    .then(
      (data) =>
        (middlewareDefinitions.value = Array.isArray(data?.definitions) ? data.definitions : []),
    )
    .catch(() => {});
  // Skill names feed the builtin:skills selector; credential key names feed
  // schema fields marked credential-reference. Both are convenience lists, so a
  // failed fetch leaves them empty rather than failing the whole editor.
  void execute<{ skills: SkillInfo[] }>('list_skills', {})
    .then((data) => (skills.value = data.skills ?? []))
    .catch(() => {});
  // list_secrets is self-or-operator only. An editor opened by a non-operator for
  // another participant is denied here; that must not break editing the agent.
  // New agents have no participant to list secrets for, so skip the call.
  if (props.participantId !== 'new') {
    void execute<{ participantId: string; keys: string[] }>('list_secrets', {
      participantId: props.participantId,
    })
      .then((data) => (credentialKeys.value = data.keys ?? []))
      .catch(() => {});
  }
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
        truncationRetries: truncationRetries.value,
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
        truncationRetries: truncationRetries.value,
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

// When the provider list is known, only a listed id (or the synthetic "current"
// group for an unknown existing model) is a valid save target. Empty options
// mean discovery failed/unavailable, so fall back to the free-text input.
function isModelSelectionValid(): boolean {
  if (modelText.value.trim().length === 0) return false;
  if (modelOptions.value.length === 0) return true;
  return groupedModels.value.some(([, models]) => models.some((m) => m.id === modelText.value));
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
    <label class="flex flex-col gap-1">
      <span class="text-xs text-faint">Truncation retries</span>
      <input
        v-model.number="truncationRetries"
        type="number"
        min="0"
        step="1"
        data-test="agent-truncation-retries"
        class="rounded border border-line bg-surface px-2 py-1"
      />
      <span class="text-[10px] text-muted">
        Re-request a generation that stops at max_tokens before producing content.
      </span>
    </label>
    <div v-if="availableTools.length" class="flex flex-col gap-1">
      <span class="text-xs text-faint">Tool policies</span>
      <ToolPolicyEditor
        :available-tools="availableTools"
        :parameters="toolParameters"
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
      <ApprovalAuthorityEditor
        v-if="participantId !== 'new'"
        v-model="authorityModel"
        :available-tools="availableTools"
      />
      <p v-else data-test="authority-new-note" class="text-xs text-muted">
        Save the agent first, then configure approval authority.
      </p>
      <button
        v-if="canSetAuthority && participantId !== 'new'"
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
