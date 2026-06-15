import { randomBytes, randomUUID } from 'node:crypto';

function random5(): string {
  // 3 bytes → 6 hex chars; take first 5 (20 bits of entropy)
  return randomBytes(3).toString('hex').slice(0, 5);
}

export function createConversationId(): string {
  return `conv-${Date.now()}-${random5()}`;
}

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
