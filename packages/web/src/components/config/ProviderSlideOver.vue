<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ProviderConfig, ProviderUsageSummary } from '@legion-collective/types';
import SlideOver from '../common/SlideOver.vue';
import { useLegionApi } from '../../composables/useLegionApi.js';
import { friendlyToolError } from '../../composables/friendlyToolError.js';

interface AuthStatus {
  signedIn: boolean;
  email?: string;
  plan?: string;
  accountId?: string;
  expiresAt?: number;
  expired?: boolean;
}

interface LoginStart {
  flowId: string;
  providerName: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

type LoginPollResult =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'expired' }
  | {
      status: 'complete';
      providerName: string;
      priority: number;
      account: { email?: string; plan?: string };
    };

const props = defineProps<{
  open: boolean;
  provider: ProviderConfig | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { execute } = useLegionApi();

const name = ref('');
const type = ref<ProviderConfig['type']>('openai-compatible');
const baseUrl = ref('');
const apiKey = ref('');
const priority = ref(10);
const saving = ref(false);
const error = ref<string | null>(null);
const apiKeyPlaceholder = ref('');

const auth = ref<AuthStatus | null>(null);
const usage = ref<ProviderUsageSummary | null>(null);
const usageError = ref<string | null>(null);
const login = ref<LoginStart | null>(null);
const loginStatus = ref<'idle' | 'starting' | 'waiting' | 'complete'>('idle');
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let loginGeneration = 0;

const isCodex = computed(() => type.value === 'codex');

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function cancelLogin() {
  loginGeneration++;
  stopPolling();
  login.value = null;
  loginStatus.value = 'idle';
}

async function refreshUsage() {
  usageError.value = null;
  try {
    usage.value = await execute<ProviderUsageSummary>('openai_usage', {
      providerName: name.value,
    });
  } catch (err) {
    usage.value = null;
    usageError.value = friendlyToolError(err);
  }
}

async function refreshAuth() {
  if (!name.value) {
    auth.value = null;
    usage.value = null;
    return;
  }
  try {
    auth.value = await execute<AuthStatus>('openai_auth_status', { providerName: name.value });
  } catch {
    auth.value = { signedIn: false };
  }
  if (auth.value?.signedIn) await refreshUsage();
  else usage.value = null;
}

function schedulePoll() {
  stopPolling();
  const seconds = Math.max(5, login.value?.intervalSeconds ?? 5);
  pollTimer = setTimeout(() => void pollLogin(), seconds * 1000);
}

async function pollLogin() {
  if (!login.value) return;
  const generation = loginGeneration;
  try {
    const result = await execute<LoginPollResult>('openai_login_poll', {
      flowId: login.value.flowId,
    });
    if (generation !== loginGeneration || !login.value) return;
    if (result.status === 'pending') {
      login.value.intervalSeconds = result.intervalSeconds;
      schedulePoll();
      return;
    }
    if (result.status === 'complete') {
      loginStatus.value = 'complete';
      login.value = null;
      await refreshAuth();
      emit('saved');
      return;
    }
    loginStatus.value = 'idle';
    login.value = null;
    error.value = 'The sign-in code expired. Start again.';
  } catch (err) {
    if (generation !== loginGeneration) return;
    loginStatus.value = 'idle';
    login.value = null;
    error.value = friendlyToolError(err);
  }
}

async function startLogin() {
  cancelLogin();
  const generation = loginGeneration;
  error.value = null;
  loginStatus.value = 'starting';
  try {
    const result = await execute<LoginStart>('openai_login_start', {
      providerName: name.value,
      priority: priority.value,
    });
    if (generation !== loginGeneration) return;
    login.value = result;
    loginStatus.value = 'waiting';
    schedulePoll();
  } catch (err) {
    if (generation !== loginGeneration) return;
    loginStatus.value = 'idle';
    error.value = friendlyToolError(err);
  }
}

async function logout() {
  error.value = null;
  try {
    await execute('openai_logout', { providerName: name.value });
    auth.value = { signedIn: false };
    usage.value = null;
    loginStatus.value = 'idle';
    emit('saved');
  } catch (err) {
    error.value = friendlyToolError(err);
  }
}

function copyCode() {
  if (!login.value) return;
  void navigator.clipboard?.writeText(login.value.userCode).catch(() => undefined);
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      cancelLogin();
      return;
    }
    error.value = null;
    usageError.value = null;
    auth.value = null;
    usage.value = null;
    login.value = null;
    loginStatus.value = 'idle';
    name.value = props.provider?.name ?? '';
    type.value = props.provider?.type ?? 'openai-compatible';
    baseUrl.value = props.provider?.baseUrl ?? '';
    priority.value = props.provider?.priority ?? 10;
    apiKey.value = '';
    apiKeyPlaceholder.value = props.provider?.apiKey ? '••••••••' : '';
    if (type.value === 'codex') void refreshAuth();
  },
);

watch(type, (next) => {
  if (next !== 'codex') cancelLogin();
  if (next === 'codex' && props.open) void refreshAuth();
});

onBeforeUnmount(cancelLogin);

async function save() {
  saving.value = true;
  error.value = null;
  try {
    const payload: ProviderConfig = {
      name: name.value,
      type: type.value,
      priority: priority.value,
    };
    if (type.value !== 'codex') {
      if (baseUrl.value) payload.baseUrl = baseUrl.value;
      if (apiKey.value) {
        payload.apiKey = apiKey.value;
      } else if (props.provider?.apiKey) {
        payload.apiKey = props.provider.apiKey;
      }
    }
    await execute('save_provider', payload);
    emit('saved');
    emit('close');
  } catch (err) {
    error.value = friendlyToolError(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SlideOver
    :open="open"
    :title="provider ? 'Edit provider' : 'Add provider'"
    @close="emit('close')"
  >
    <div class="p-5 space-y-4">
      <p v-if="error" data-test="provider-error" role="alert" class="text-xs text-danger">
        {{ error }}
      </p>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Name</label
        >
        <input
          v-model="name"
          data-test="provider-name"
          :readonly="!!provider"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink font-mono outline-none"
        />
        <p class="text-[10px] text-faint mt-1">Cannot change after creation.</p>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Type</label
        >
        <select
          v-model="type"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink"
        >
          <option value="openai-compatible">openai-compatible</option>
          <option value="openai-responses">openai-responses</option>
          <option value="codex">codex</option>
        </select>
      </div>
      <div v-if="type !== 'codex'">
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Base URL</label
        >
        <input
          v-model="baseUrl"
          data-test="provider-base-url"
          placeholder="https://api.openai.com/v1"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink font-mono outline-none"
        />
      </div>
      <div v-if="type !== 'codex'">
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >API Key</label
        >
        <input
          v-model="apiKey"
          data-test="provider-api-key"
          type="password"
          :placeholder="apiKeyPlaceholder || 'sk-...'"
          class="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink font-mono outline-none"
        />
        <p v-if="provider?.apiKey" class="text-[10px] text-faint mt-1">
          Leave blank to keep existing key.
        </p>
      </div>
      <div v-if="isCodex" data-test="codex-panel" class="border border-line rounded p-3 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-[10px] uppercase tracking-widest text-muted font-semibold"
            >ChatGPT plan</span
          >
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
            class="text-[10px] text-accent"
            >Manage usage</a
          >
        </div>

        <template v-if="auth?.signedIn && loginStatus !== 'waiting'">
          <div data-test="codex-account" class="text-xs text-ink">
            Signed in as {{ auth.email ?? 'ChatGPT account' }}
            <span v-if="auth.plan" class="text-muted"> · {{ auth.plan }}</span>
          </div>
          <div v-if="usageError" data-test="codex-usage-error" class="text-[10px] text-warning">
            Usage unavailable — {{ usageError }}
          </div>
          <div v-else-if="usage" class="space-y-1">
            <div
              v-for="w in usage.windows"
              :key="w.label"
              data-test="codex-usage-window"
              class="flex justify-between text-[10px] text-muted"
            >
              <span>{{ w.label }}</span>
              <span>
                {{ w.remainingPercent === null ? '—' : `${w.remainingPercent}% remaining` }}
              </span>
            </div>
            <p v-if="usage.windows.length === 0" class="text-[10px] text-faint">
              No usage windows reported.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              data-test="codex-refresh-usage"
              @click="refreshUsage"
              class="text-[10px] px-2 py-1 border border-line rounded text-muted"
            >
              Refresh usage
            </button>
            <button
              data-test="codex-sign-out"
              @click="logout"
              class="text-[10px] px-2 py-1 border border-line rounded text-danger"
            >
              Sign out
            </button>
            <button
              data-test="codex-re-sign-in"
              @click="startLogin"
              :disabled="!name"
              class="text-[10px] px-2 py-1 border border-line rounded text-accent"
            >
              Re-sign in
            </button>
          </div>
        </template>

        <template v-else-if="loginStatus === 'waiting' && login">
          <p class="text-xs text-ink">
            Open
            <a
              :href="login.verificationUrl"
              target="_blank"
              rel="noreferrer"
              data-test="codex-verification-url"
              class="text-accent"
              >{{ login.verificationUrl }}</a
            >
            and enter this code:
          </p>
          <div class="flex items-center gap-2">
            <code data-test="codex-user-code" class="text-sm font-mono text-ink">{{
              login.userCode
            }}</code>
            <button
              data-test="codex-copy-code"
              @click="copyCode"
              class="text-[10px] px-2 py-1 border border-line rounded text-muted"
            >
              Copy
            </button>
          </div>
          <p class="text-[10px] text-faint">Waiting for approval…</p>
        </template>

        <template v-else>
          <p class="text-[10px] text-muted">
            Sign in to draw inference from your ChatGPT plan instead of API billing.
          </p>
          <button
            data-test="codex-sign-in"
            @click="startLogin"
            :disabled="!name || loginStatus === 'starting'"
            class="text-xs px-3 py-1.5 bg-accent text-on-accent font-bold rounded disabled:opacity-50"
          >
            {{ loginStatus === 'starting' ? 'Starting…' : 'Sign in with OpenAI' }}
          </button>
          <p v-if="!name" class="text-[10px] text-faint">Enter a provider name first.</p>
        </template>
      </div>

      <div>
        <label class="text-[10px] uppercase tracking-widest text-muted font-semibold block mb-1"
          >Priority</label
        >
        <input
          v-model.number="priority"
          type="number"
          min="1"
          class="w-20 bg-bg border border-line rounded px-3 py-1.5 text-sm text-ink outline-none"
        />
        <p class="text-[10px] text-faint mt-1">
          Lower number = higher priority (used for auto-routing).
        </p>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end gap-2 px-5 py-3">
        <button
          @click="emit('close')"
          class="text-xs px-3 py-1.5 border border-line text-muted rounded"
        >
          Cancel
        </button>
        <button
          data-test="provider-save"
          @click="save"
          :disabled="saving"
          class="text-xs px-3 py-1.5 bg-accent text-on-accent font-bold rounded disabled:opacity-50"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </template>
  </SlideOver>
</template>
