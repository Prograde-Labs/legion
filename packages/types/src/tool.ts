export type JSONSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolResultStatus = 'success' | 'error' | 'pending_approval' | 'rejected';

export interface ToolResult {
  status: ToolResultStatus;
  data?: unknown;
  error?: string;
  /** Set on status:'pending_approval' — the PendingApprovalRegistry key. */
  approvalId?: string;
  /** Set on status:'rejected' — the approver's explanation. */
  message?: string;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  result: ToolResult;
}

export interface ArgScope {
  /** When true, the argument must be present (and non-null). Default: absent passes. */
  required?: boolean;
  /** Exact string match against one of the listed values. */
  enum?: string[];
  /** JavaScript regular expression source, validated when the policy is set. */
  pattern?: string;
  /** String length bounds. */
  minLength?: number;
  maxLength?: number;
  /** Numeric bounds. */
  min?: number;
  max?: number;
  /**
   * Path containment. Relative prefixes resolve against workspaceRoot;
   * absolute prefixes are used as-is.
   */
  pathPrefix?: string;
}

/** Scope keyed by top-level argument name. */
export type ToolScope = Record<string, ArgScope>;

export type ToolPolicy =
  'auto' | 'requires_approval' | { policy: 'auto' | 'requires_approval'; scope?: ToolScope };

/**
 * Normalizes the legacy string form and the object form to a single shape.
 * `undefined` means the tool is absent from the participant's map (hidden).
 */
export function normalizeToolPolicy(
  policy: ToolPolicy | undefined,
): { policy: 'auto' | 'requires_approval'; scope?: ToolScope } | undefined {
  if (policy === undefined) return undefined;
  if (typeof policy === 'string') return { policy };
  return policy;
}

export interface ApprovalAuthority {
  // Tools this participant may approve on behalf of others.
  // '*' means any tool. Specific entries override the wildcard.
  tools?: Record<string, boolean> | '*';
  // Participant ids this authority applies to ('*' = any requester).
  participants?: string[] | '*';
}
