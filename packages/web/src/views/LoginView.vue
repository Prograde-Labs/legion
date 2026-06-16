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
  <div class="bg-navy-950 min-h-screen flex items-center justify-center">
    <div class="w-80">
      <div class="text-center mb-8">
        <div
          class="w-10 h-10 bg-cyan-400 rounded-lg inline-flex items-center justify-center text-navy-950 font-black text-xl mb-3"
        >
          L
        </div>
        <h1 class="text-slate-100 text-xl font-bold">Legion</h1>
        <p class="text-navy-400 text-xs mt-1">Management console</p>
      </div>
      <div class="bg-navy-800 border border-navy-600 rounded-xl p-7">
        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="text-navy-400 text-xs uppercase tracking-wider font-semibold block mb-1"
              >Name</label
            >
            <input
              v-model="name"
              type="text"
              autocomplete="username"
              class="w-full bg-navy-900 border border-navy-600 rounded-md px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
            />
          </div>
          <div>
            <label class="text-navy-400 text-xs uppercase tracking-wider font-semibold block mb-1"
              >Password</label
            >
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              class="w-full bg-navy-900 border border-navy-600 rounded-md px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
            />
            <p v-if="error" class="text-red-400 text-xs mt-1">{{ error }}</p>
          </div>
          <button
            type="submit"
            :disabled="loading"
            class="w-full bg-cyan-400 text-navy-950 font-bold text-sm py-2.5 rounded-md mt-2 hover:opacity-90 disabled:opacity-50"
          >
            {{ loading ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
      </div>
      <p class="text-center text-navy-600 text-xs mt-4 leading-relaxed">
        First run? The bootstrap password was<br />printed to process stdout on startup.
      </p>
    </div>
  </div>
</template>
