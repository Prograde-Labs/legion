import { useAuth } from './useAuth.js';
import { router } from '../router/index.js';
import type { ToolResult } from '@legion/types';

export function useExecute() {
  const { getToken, logout } = useAuth();

  async function execute<T>(tool: string, args: unknown = {}): Promise<T> {
    const res = await fetch('/api/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken() ?? ''}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    if (res.status === 401) {
      logout();
      router.push('/login');
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { result: ToolResult };
    if (data.result.status === 'error') {
      throw new Error(data.result.error ?? 'Tool error');
    }
    return data.result.data as T;
  }

  return { execute };
}
