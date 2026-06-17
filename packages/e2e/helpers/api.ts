import type { APIRequestContext } from '@playwright/test';

export interface LoginResult {
  token: string;
  participantId: string;
}

export interface MeResult {
  id: string;
  name: string;
  type: string;
  operator: boolean;
  tools: string[];
  approvalAuthority: string | null;
}

export interface ExecuteResult<T = unknown> {
  result: { status: string; data?: T; error?: string };
  conversationId: string;
}

export interface HealthResult {
  status: string;
}

export class ApiClient {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string,
  ) {}

  async login(name: string, password: string): Promise<LoginResult> {
    const res = await this.request.post(`${this.baseUrl}/api/auth/login`, {
      data: { name, password },
    });
    if (!res.ok()) throw new Error(`Login failed: ${res.status()} ${await res.text()}`);
    return res.json() as Promise<LoginResult>;
  }

  async me(token: string): Promise<MeResult> {
    const res = await this.request.get(`${this.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok()) throw new Error(`/me failed: ${res.status()} ${await res.text()}`);
    return res.json() as Promise<MeResult>;
  }

  async execute<T = unknown>(
    token: string,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<ExecuteResult<T>> {
    const res = await this.request.post(`${this.baseUrl}/api/execute`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { tool, args },
    });
    if (!res.ok()) throw new Error(`execute(${tool}) failed: ${res.status()} ${await res.text()}`);
    return res.json() as Promise<ExecuteResult<T>>;
  }

  async health(): Promise<HealthResult> {
    const res = await this.request.get(`${this.baseUrl}/api/health`);
    if (!res.ok()) throw new Error(`health failed: ${res.status()}`);
    return res.json() as Promise<HealthResult>;
  }

  /** Raw request with no auth — for testing 401 paths. */
  async executeRaw(
    tool: string,
    args: Record<string, unknown> = {},
    token?: string,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await this.request.post(`${this.baseUrl}/api/execute`, {
      headers,
      data: { tool, args },
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
  }
}
