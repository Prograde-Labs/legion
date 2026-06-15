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

export type ToolPolicy = 'auto' | 'deny' | 'requires_approval';

export interface ApprovalAuthority {
  // Tools this participant may approve on behalf of others.
  // '*' means any tool. Specific entries override the wildcard.
  tools?: Record<string, boolean> | '*';
  // Participant ids this authority applies to ('*' = any requester).
  participants?: string[] | '*';
}
