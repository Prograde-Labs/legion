<script setup lang="ts">
import { computed, ref } from 'vue';
import SlideOver from '../components/common/SlideOver.vue';
import { useAuth } from '../composables/useAuth.js';
import { useLegionApi } from '../composables/useLegionApi.js';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [boolean] }>();

const { participantId, expiresAt } = useAuth();
const { execute, logout } = useLegionApi();

const newPassword = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const success = ref(false);
const error = ref<string | null>(null);

const tooShort = computed(() => newPassword.value.length > 0 && newPassword.value.length < 8);
const mismatch = computed(
  () => confirmPassword.value.length > 0 && newPassword.value !== confirmPassword.value,
);
const canSubmit = computed(
  () =>
    newPassword.value.length >= 8 &&
    newPassword.value === confirmPassword.value &&
    !submitting.value,
);

const expiryLabel = computed(() =>
  expiresAt.value === null ? '—' : new Date(expiresAt.value * 1000).toLocaleString(),
);

async function submit(): Promise<void> {
  error.value = null;
  success.value = false;
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    await execute('set_credential', {
      participantId: participantId.value,
      secret: newPassword.value,
    });
    success.value = true;
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>
<template>
  <SlideOver title="Account" :open="open" @close="emit('update:open', false)">
    <div class="space-y-5 p-5 text-sm text-ink">
      <section class="space-y-1 opacity-80">
        <p>
          <span class="font-medium">Participant:</span>
          {{ participantId ?? '—' }}
        </p>
        <p>
          <span class="font-medium">Token expires:</span>
          {{ expiryLabel }}
        </p>
      </section>

      <form class="space-y-3" @submit.prevent="submit">
        <h3 class="font-semibold">Change password</h3>
        <label class="block space-y-1">
          <span>New password</span>
          <input
            v-model="newPassword"
            type="password"
            data-test="account-new-password"
            class="w-full rounded-md border border-line bg-surface px-2 py-1.5"
          />
        </label>
        <p v-if="tooShort" class="text-xs text-danger">Must be at least 8 characters.</p>
        <label class="block space-y-1">
          <span>Confirm password</span>
          <input
            v-model="confirmPassword"
            type="password"
            data-test="account-confirm-password"
            class="w-full rounded-md border border-line bg-surface px-2 py-1.5"
          />
        </label>
        <p v-if="mismatch" class="text-xs text-danger">Passwords do not match.</p>
        <p v-if="success" data-test="account-success" class="text-xs text-success">
          Password updated.
        </p>
        <p v-if="error" data-test="account-error" class="text-xs text-danger">
          {{ error }}
        </p>
        <button
          type="submit"
          data-test="account-submit"
          :disabled="!canSubmit"
          class="rounded-md bg-accent-soft px-3 py-1.5 font-medium text-accent hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ submitting ? 'Saving…' : 'Change password' }}
        </button>
      </form>

      <button
        type="button"
        data-test="account-logout"
        class="rounded-md border border-line px-3 py-1.5 hover:bg-surface"
        @click="logout()"
      >
        Logout
      </button>
    </div>
  </SlideOver>
</template>
