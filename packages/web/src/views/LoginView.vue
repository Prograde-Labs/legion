<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../composables/useAuth.js';

const name = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const { login } = useAuth();

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await login(name.value, password.value);
    await router.push('/participants');
  } catch {
    error.value = 'Incorrect name or password.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-bg">
    <div class="w-80">
      <div class="mb-8 text-center">
        <div
          class="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent font-black text-on-accent"
        >
          L
        </div>
        <h1 class="text-xl font-bold text-ink">Legion</h1>
        <p class="mt-1 text-xs text-muted">Management console</p>
      </div>
      <div class="rounded-xl border border-line bg-surface p-7">
        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted"
              >Name</label
            >
            <input
              v-model="name"
              type="text"
              autocomplete="username"
              class="w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink outline-none focus:border-accent/40"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted"
              >Password</label
            >
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              class="w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink outline-none focus:border-accent/40"
            />
            <p v-if="error" class="mt-1 text-xs text-danger">{{ error }}</p>
          </div>
          <button
            type="submit"
            :disabled="loading"
            class="mt-2 w-full rounded-md bg-accent py-2.5 text-sm font-bold text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {{ loading ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
      </div>
      <p class="mt-4 text-center text-xs leading-relaxed text-faint">
        First run? The bootstrap password was<br />printed to process stdout on startup.
      </p>
    </div>
  </div>
</template>
