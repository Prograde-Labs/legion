import { useLocalStorage } from '@vueuse/core';
import { computed, ref } from 'vue';

interface AuthState {
  token: string | null;
  participantId: string | null;
  expiresAt: number | null;
}

const token = useLocalStorage<string | null>('legion-token', null);
const participantId = ref<string | null>(null);
const expiresAt = ref<number | null>(null);

export function useAuth() {
  const isAuthenticated = computed(
    () => !!token.value && (expiresAt.value === null || Date.now() < expiresAt.value * 1000),
  );

  async function login(name: string, password: string): Promise<void> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (!res.ok) throw new Error('Invalid credentials');
    const data = (await res.json()) as AuthState;
    token.value = data.token;
    participantId.value = data.participantId;
    expiresAt.value = data.expiresAt;
  }

  function logout(): void {
    token.value = null;
    participantId.value = null;
    expiresAt.value = null;
  }

  function getToken(): string | null {
    return token.value;
  }

  return { isAuthenticated, participantId, login, logout, getToken };
}
