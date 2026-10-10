import { useLocalStorage } from '@vueuse/core';
import { computed } from 'vue';

interface AuthState {
  token: string | null;
  participantId: string | null;
  expiresAt: number | null;
}

const token = useLocalStorage<string | null>('legion-token', null);
const participantId = useLocalStorage<string | null>('legion-participant-id', null);
const expiresAt = useLocalStorage<number | null>('legion-expires-at', null);

/** Decode the `exp` claim from a JWT payload (base64url). Returns null on failure. */
function decodeJwtExp(jwt: string): number | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Resolve the effective expiry: stored expiresAt, or JWT decode fallback, or null. */
function resolveExpiry(tokenVal: string | null, storedExpiry: number | null): number | null {
  if (storedExpiry !== null) return storedExpiry;
  if (tokenVal) return decodeJwtExp(tokenVal);
  return null;
}

export function useAuth() {
  const isAuthenticated = computed(() => {
    if (!token.value) return false;
    const exp = resolveExpiry(token.value, expiresAt.value);
    if (exp === null) return false; // no usable expiry → treat as expired
    return Date.now() < exp * 1000;
  });

  async function login(name: string, password: string): Promise<void> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (!res.ok) throw new Error('Invalid credentials');
    const data = (await res.json()) as Partial<AuthState>;
    token.value = data.token ?? null;
    participantId.value = data.participantId ?? null;
    expiresAt.value = data.expiresAt ?? null;
  }

  function logout(): void {
    token.value = null;
    participantId.value = null;
    expiresAt.value = null;
  }

  function getToken(): string | null {
    return token.value;
  }

  return { isAuthenticated, participantId, expiresAt, login, logout, getToken };
}
