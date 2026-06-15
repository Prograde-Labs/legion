import type { ApprovalAuthority, ToolPolicy } from '@legion/types';

export interface AuthEngineOptions {
  toolPolicies?: Record<string, ToolPolicy>;
  defaultPolicy?: ToolPolicy;
}

export interface AuthResult {
  authorized: boolean;
  reason?: 'auto' | 'deny' | 'requires_approval';
}

const BUILTIN_DEFAULT: ToolPolicy = 'requires_approval';

export class AuthEngine {
  private toolPolicies: Record<string, ToolPolicy>;
  private defaultPolicy?: ToolPolicy;

  constructor(options: AuthEngineOptions = {}) {
    this.toolPolicies = options.toolPolicies ?? {};
    this.defaultPolicy = options.defaultPolicy;
  }

  private resolvePolicy(
    tool: string,
    participantPolicies?: Record<string, ToolPolicy>,
  ): ToolPolicy {
    if (participantPolicies && tool in participantPolicies) return participantPolicies[tool];
    if (tool in this.toolPolicies) return this.toolPolicies[tool];
    if (this.defaultPolicy) return this.defaultPolicy;
    return BUILTIN_DEFAULT;
  }

  authorize(
    _participantId: string,
    tool: string,
    _args: unknown,
    participantPolicies?: Record<string, ToolPolicy>,
  ): AuthResult {
    const policy = this.resolvePolicy(tool, participantPolicies);
    switch (policy) {
      case 'auto':
        return { authorized: true, reason: 'auto' };
      case 'deny':
        return { authorized: false, reason: 'deny' };
      case 'requires_approval':
      default:
        return { authorized: false, reason: 'requires_approval' };
    }
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
