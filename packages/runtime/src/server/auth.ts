import { SignJWT, jwtVerify } from 'jose';

export type JwtSecret = Uint8Array;

export async function signToken(participantId: string, secret: JwtSecret): Promise<string> {
  return new SignJWT({ sub: participantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
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
