import type { ApprovalAuthority, ToolPolicy } from '@legion-collective/types';

export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'requires_approval' | 'hidden';
}

export class AuthEngine {
  authorize(
    _participantId: string,
    tool: string,
    _args: unknown,
    participantPolicies?: Record<string, ToolPolicy>,
  ): AuthResult {
    const policy = participantPolicies?.[tool];
    if (policy === 'auto') return { authorized: true, reason: 'auto' };
    if (policy === 'requires_approval') return { authorized: false, reason: 'requires_approval' };
    return { authorized: false, reason: 'hidden' };
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
