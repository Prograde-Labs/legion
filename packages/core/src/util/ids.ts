import { randomBytes, randomUUID } from 'node:crypto';

function random5(): string {
  return randomBytes(4).toString('hex').slice(0, 5);
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
