import { randomUUID } from 'node:crypto';
import { ProviderError } from '../errors/LegionError.js';
import { buildAuth } from './CodexAuthStore.js';
import type { CodexAuthStore } from './CodexAuthStore.js';
import {
  exchangeAuthorizationCode,
  getClientId,
  pollDeviceCode,
  requestDeviceCode,
} from './codex-auth.js';

const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface LoginStartResult {
  flowId: string;
  providerName: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

export type LoginPollResult =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'expired' }
  | {
      status: 'complete';
      providerName: string;
      priority: number;
      account: { email?: string; plan?: string };
    };

interface PendingLogin {
  flowId: string;
  providerName: string;
  priority: number;
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
  verificationUrl: string;
}

export class CodexLoginManager {
  private readonly flows = new Map<string, PendingLogin>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly authStore: CodexAuthStore) {}

  cancel(providerName: string): void {
    this.generations.set(providerName, (this.generations.get(providerName) ?? 0) + 1);
    for (const [id, flow] of this.flows) {
      if (flow.providerName === providerName) this.flows.delete(id);
    }
  }

  async start(providerName: string, priority: number): Promise<LoginStartResult> {
    if (!PROVIDER_NAME_PATTERN.test(providerName)) {
      throw new ProviderError('Invalid provider name');
    }

    const generation = this.generations.get(providerName) ?? 0;
    const code = await requestDeviceCode(getClientId());
    if ((this.generations.get(providerName) ?? 0) !== generation) {
      throw new ProviderError('Login cancelled');
    }
    const flow: PendingLogin = {
      flowId: randomUUID(),
      providerName,
      priority,
      deviceAuthId: code.deviceAuthId,
      userCode: code.userCode,
      intervalSeconds: code.intervalSeconds,
      expiresAt: code.expiresAt,
      verificationUrl: code.verificationUrl,
    };
    this.flows.set(flow.flowId, flow);

    return {
      flowId: flow.flowId,
      providerName,
      verificationUrl: flow.verificationUrl,
      userCode: flow.userCode,
      intervalSeconds: flow.intervalSeconds,
      expiresAt: new Date(flow.expiresAt * 1000).toISOString(),
    };
  }

  async poll(flowId: string): Promise<LoginPollResult> {
    const flow = this.flows.get(flowId);
    if (!flow) return { status: 'expired' };

    if (Math.floor(Date.now() / 1000) >= flow.expiresAt) {
      this.flows.delete(flowId);
      return { status: 'expired' };
    }

    const tokens = await pollDeviceCode({
      deviceAuthId: flow.deviceAuthId,
      userCode: flow.userCode,
    });
    if (this.flows.get(flowId) !== flow) return { status: 'expired' };
    if (!tokens) return { status: 'pending', intervalSeconds: flow.intervalSeconds };

    const clientId = getClientId();
    const exchanged = await exchangeAuthorizationCode({
      clientId,
      code: tokens.authorizationCode,
      codeVerifier: tokens.codeVerifier,
    });
    const auth = buildAuth(exchanged, clientId);
    const saved = await this.authStore.saveIfActive(
      flow.providerName,
      auth,
      () => this.flows.get(flowId) === flow,
    );
    if (!saved || this.flows.get(flowId) !== flow) return { status: 'expired' };
    this.flows.delete(flowId);

    return {
      status: 'complete',
      providerName: flow.providerName,
      priority: flow.priority,
      account: { email: auth.email, plan: auth.plan },
    };
  }
}
