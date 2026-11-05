/**
 * Security headers applied to every HTTP response, including SSE streams that
 * bypass Fastify's onSend hook. connect-src allows the WebSocket transport
 * (`ws:`/`wss:`); style-src allows the inline styles Vue/Tailwind emit at runtime.
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:",
} as const;

/** Apply the headers through any setter, e.g. reply.header or reply.raw.setHeader. */
export function applySecurityHeaders(setHeader: (name: string, value: string) => void): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    setHeader(name, value);
  }
}
