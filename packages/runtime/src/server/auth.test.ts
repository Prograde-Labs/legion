import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from './auth.js';

describe('signToken', () => {
  const secret = new Uint8Array(32);

  it('returns token and expiresAt (~8h from now)', async () => {
    const { token, expiresAt } = await signToken('p1', secret);
    expect(typeof token).toBe('string');
    expect(typeof expiresAt).toBe('number');
    const now = Math.floor(Date.now() / 1000);
    expect(expiresAt).toBeGreaterThan(now + 7 * 3600);
    expect(expiresAt).toBeLessThan(now + 9 * 3600);
  });

  it('token expiresAt matches the JWT exp claim', async () => {
    const { token, expiresAt } = await signToken('p2', secret);
    const { participantId } = await verifyToken(token, secret);
    expect(participantId).toBe('p2');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    expect(payload.exp).toBe(expiresAt);
  });
});
