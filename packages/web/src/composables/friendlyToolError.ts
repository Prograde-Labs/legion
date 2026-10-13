// Maps a denied tool result ('hidden' policy verdict from POST /api/execute) to
// human text so residual catch sites render a quiet no-op instead of leaking
// the literal policy string. Real errors pass through unchanged.
const DENIED = 'You do not have access to this action.';

export function friendlyToolError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.trim().toLowerCase() === 'hidden' ? DENIED : msg;
}
