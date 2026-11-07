import { normalizeToolPolicy } from '@legion-collective/types';
import type { ApprovalAuthority, ToolPolicy } from '@legion-collective/types';
import { evaluateScope } from './ArgumentScope.js';

export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'requires_approval' | 'hidden' | 'scope';
  /** Human-readable detail for reason 'scope'. */
  detail?: string;
}

export class AuthEngine {
  authorize(
    _participantId: string,
    tool: string,
    args: unknown,
    participantPolicies?: Record<string, ToolPolicy>,
    ctx?: { workspaceRoot: string },
  ): AuthResult {
    const policy = normalizeToolPolicy(participantPolicies?.[tool]);
    if (!policy) return { authorized: false, reason: 'hidden' };

    if (policy.scope) {
      if (!ctx) {
        return {
          authorized: false,
          reason: 'scope',
          detail: 'argument scope unavailable: workspaceRoot missing',
        };
      }
      const scopeResult = evaluateScope(tool, args, policy.scope, ctx);
      if (!scopeResult.ok) {
        return {
          authorized: false,
          reason: 'scope',
          detail: `argument scope violation: ${tool}.${scopeResult.arg} ${scopeResult.reason}`,
        };
      }
    }

    if (policy.policy === 'auto') return { authorized: true, reason: 'auto' };
    return { authorized: false, reason: 'requires_approval' };
  }

  hasAuthority(
    authority: ApprovalAuthority | undefined,
    requesterId: string,
    tool: string,
    _args: unknown,
  ): boolean {
    if (!authority) return false;

    const participantsOk =
      authority.participants === '*' ||
      (Array.isArray(authority.participants) && authority.participants.includes(requesterId));
    if (!participantsOk) return false;

    if (authority.tools === '*') return true;
    if (authority.tools && typeof authority.tools === 'object') {
      return authority.tools[tool] === true;
    }
    return false;
  }
}
