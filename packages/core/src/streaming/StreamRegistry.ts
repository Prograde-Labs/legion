/**
 * Transport-internal stream lifecycle tracker. Holds one AbortController per
 * active stream. Never exposed to ToolRegistry callers or tool authors.
 */
export class StreamRegistry {
  private streams = new Map<string, { connectionId: string; abort: AbortController }>();

  /**
   * Register a new stream. Returns an AbortSignal the tool generator can
   * poll or pass to AsyncQueue.next() to detect cancellation.
   */
  register(streamId: string, connectionId: string): AbortSignal {
    const controller = new AbortController();
    this.streams.set(streamId, { connectionId, abort: controller });
    return controller.signal;
  }

  /**
   * Cancel a specific stream. Returns false if not found (already done or unknown).
   */
  cancel(streamId: string): boolean {
    const entry = this.streams.get(streamId);
    if (!entry) return false;
    entry.abort.abort();
    this.streams.delete(streamId);
    return true;
  }

  /**
   * Cancel all streams for a connection — called on WS socket close.
   */
  cancelAll(connectionId: string): void {
    for (const [streamId, entry] of this.streams) {
      if (entry.connectionId === connectionId) {
        entry.abort.abort();
        this.streams.delete(streamId);
      }
    }
  }
}
