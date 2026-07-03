import { SignJWT, jwtVerify } from 'jose';

export type JwtSecret = Uint8Array;

export async function signToken(
  participantId: string,
  secret: JwtSecret,
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const expiresAt = iat + 8 * 3600;
  const token = await new SignJWT({ sub: participantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime(expiresAt)
    .sign(secret);
  return { token, expiresAt };
}

export async function verifyToken(
  token: string,
  secret: JwtSecret,
): Promise<{ participantId: string }> {
  const { payload } = await jwtVerify(token, secret);
  if (typeof payload.sub !== 'string') {
    throw new Error('Invalid token: missing sub');
  }
  return { participantId: payload.sub };
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}
